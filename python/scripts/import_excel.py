"""Import data/Workshop_Stocklist_2026.xlsx into the Supabase/PostgreSQL database.

Usage (from the python/ directory, with DATABASE_URL set):

    python scripts/import_excel.py --dry-run          # parse + validate only
    python scripts/import_excel.py                    # import into an empty database
    python scripts/import_excel.py --replace          # wipe business data, then import

The import runs in ONE transaction: it either completes fully or changes nothing.
Rows with errors are never silently skipped — the import refuses to run while the
workbook has errors, unless --skip-invalid is given (skipped rows are listed).
Imported: Partner_Rule_Table, Stock_Master (current stock + the August count),
KALI_Inventory_List, Sales_Log_202608 and the August Partner_Summary adjustments.
Earlier monthly logs and legacy sheets are intentionally not imported.
August sales are recalculated with the database function
public.calculate_sale_line(), the same code path the application uses.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workshop.db import connect  # noqa: E402
from workshop.excel_source import (  # noqa: E402
    DEFAULT_WORKBOOK,
    Issue,
    ProductKey,
    SalesRow,
    StockRow,
    Workbook,
    read_workbook,
)

ACTOR = "import_excel.py"
RULES_EFFECTIVE_FROM = date(2025, 1, 1)  # Excel has no effective date; covers the imported August data

# Business decisions made after the workbook (2026-09-30). The Excel rule stays in
# force up to the day before `effective_from`, so imported August figures still
# match the workbook; the new rule applies from September 2026.
#   category -> (rule_type, partner_b_rate, partner_a_rate, effective_from, note)
RULE_CHANGES: dict[str, tuple[str, Decimal, Decimal | None, date, str]] = {
    "Car Tyre Strip": ("Shared_50", Decimal("0.5"), Decimal("0.5"), date(2026, 9, 1),
                       "Decision 2026-09-30: Amin (Partner B) receives 50% of revenue."),
}

BUSINESS_TABLES = (
    "stock_adjustments", "sale_items", "sales", "stock_snapshots", "stock_items", "products",
    "partner_rules", "product_categories", "inventory_items", "operating_expenses",
    "expense_categories", "monthly_settlements",
)

# name -> (description, default_amount, default_share_ratio, is_recurring)
EXPENSE_CATEGORY_DEFAULTS = {
    "Employee Salary": ("Wages (Excel 'Gaji Anol'). Fixed RM100 deducted from Partner A every month.",
                        Decimal("-100.00"), None, True),
    "Electricity": ("Electricity (Excel 'Bil Api'). Enter the monthly bill; Partner A receives 60% of it.",
                    None, Decimal("0.6"), False),
    "Rental": ("Workshop rental (Excel 'Rental'). Entered monthly; RM500 in Excel.",
               Decimal("500.00"), None, False),
}


class ImportStats(Counter):
    pass


def choose_stock_item(row: SalesRow, candidates: list[tuple[StockRow, str]], issues: list[Issue]) -> str | None:
    """Pick the Stock_Master batch a historical sale line belongs to (None when ambiguous)."""
    if not candidates:
        issues.append(Issue("warning", row.ref, "no matching Stock_Master row; sale linked to product only"))
        return None
    pool = candidates
    if row.purchased_date is not None:
        dated = [c for c in pool if c[0].purchased_date == row.purchased_date]
        if dated:
            pool = dated
    if len(pool) > 1:
        priced = [c for c in pool if c[0].unit_cost == row.unit_cost and c[0].agreed_price == row.agreed_price]
        if priced:
            pool = priced
    if len(pool) == 1:
        return pool[0][1]
    issues.append(Issue("warning", row.ref,
                        f"{len(pool)} Stock_Master rows match ({', '.join(c[0].ref for c in pool)}); "
                        "sale linked to product only"))
    return None


def run_import(conn, wb: Workbook, *, replace: bool) -> tuple[ImportStats, list[Issue]]:
    stats = ImportStats()
    issues: list[Issue] = []
    with conn.cursor() as cur:
        cur.execute("select count(*) from public.products")
        existing = cur.fetchone()[0]
        if existing and not replace:
            raise SystemExit("The database already contains products. Re-run with --replace to wipe and re-import.")
        if replace:
            cur.execute("truncate " + ", ".join(f"public.{t}" for t in BUSINESS_TABLES))
            cur.execute(
                "insert into public.audit_logs (table_name, action, new_data, actor_label) "
                "values ('*', 'DELETE', jsonb_build_object('reason', 'import_excel.py --replace'), %s)",
                (ACTOR,),
            )

        # Categories and partner rules -------------------------------------------------
        category_ids: dict[str, str] = {}
        insert_rule = """insert into public.partner_rules
                           (category_id, rule_type, partner_b_rate, partner_a_rate, partner_a_rate_is_leftover,
                            notes, effective_from, effective_to)
                         values (%s, %s, %s, %s, %s, %s, %s, %s)"""
        for rule in wb.rules:
            cur.execute("insert into public.product_categories (name) values (%s) returning id", (rule.category,))
            category_id = cur.fetchone()[0]
            category_ids[rule.category.lower()] = category_id
            change = RULE_CHANGES.get(rule.category)
            effective_to = change[3] - timedelta(days=1) if change else None
            cur.execute(insert_rule, (category_id, rule.rule_type, rule.partner_b_rate, rule.partner_a_rate,
                                      rule.partner_a_rate is None, rule.notes, RULES_EFFECTIVE_FROM, effective_to))
            stats["partner_rules"] += 1
            if change:
                rule_type, b_rate, a_rate, effective_from, note = change
                cur.execute(insert_rule, (category_id, rule_type, b_rate, a_rate, a_rate is None, note,
                                          effective_from, None))
                stats["partner_rules"] += 1
                issues.append(Issue("warning", rule.ref, f"{rule.category}: Excel {rule.rule_type} rule used up to "
                                                         f"{effective_to}; {rule_type} from {effective_from} "
                                                         "(business decision)"))
        stats["categories"] = len(category_ids)

        # Products and stock items ------------------------------------------------------
        product_ids: dict[tuple, str] = {}
        non_stock_products: set[str] = set()

        def ensure_product(key: ProductKey, unit: str | None, non_stock: bool, source: str) -> str:
            lookup = key.lookup()
            if lookup not in product_ids:
                if non_stock:
                    non_stock_products.add(lookup)
                cur.execute(
                    """insert into public.products (item_code, description, brand, category_id, unit, is_non_stock)
                       values (%s, %s, %s, %s, %s, %s) returning id""",
                    (key.item_code, key.description, key.brand, category_ids[key.category.lower()], unit, non_stock),
                )
                product_ids[lookup] = cur.fetchone()[0]
                stats["products"] += 1
                if source != "Stock_Master":
                    issues.append(Issue("warning", source, f"product {key.item_code} / {key.description} "
                                                           "exists only in Sales_Log; created without stock"))
            return product_ids[lookup]

        stock_by_product: dict[str, list[tuple[StockRow, str]]] = {}
        for row in wb.stock:
            product_id = ensure_product(row.product, row.unit, row.is_non_stock, "Stock_Master")
            cur.execute(
                """insert into public.stock_items
                     (product_id, purchased_date, unit_cost, agreed_price, quantity, is_obsolete, obsolete_at,
                      legacy_ref, legacy_id)
                   values (%s, %s, %s, %s, %s, %s, case when %s then now() end, %s, %s) returning id""",
                (product_id, row.purchased_date, row.unit_cost, row.agreed_price, row.quantity,
                 row.is_obsolete, row.is_obsolete, row.ref, row.legacy_id),
            )
            stock_id = cur.fetchone()[0]
            stock_by_product.setdefault(product_id, []).append((row, stock_id))
            cur.execute(
                """insert into public.stock_adjustments
                     (stock_item_id, adjustment_type, previous_quantity, new_quantity, reason, created_by_label)
                   values (%s, 'initial', 0, %s, %s, %s)""",
                (stock_id, row.quantity, f"Imported from {row.ref}", ACTOR),
            )
            for snap_date, (column, qty) in sorted(row.snapshots.items()):
                cur.execute(
                    """insert into public.stock_snapshots (stock_item_id, snapshot_date, source_column, quantity)
                       values (%s, %s, %s, %s)""",
                    (stock_id, snap_date, column, qty),
                )
                stats["stock_snapshots"] += 1
            stats["stock_items"] += 1

        # Shared inventory --------------------------------------------------------------
        for item in wb.inventory:
            cur.execute(
                "insert into public.inventory_items (name, brand, quantity, legacy_ref) values (%s, %s, %s, %s)",
                (item.name, item.brand, item.quantity, item.ref),
            )
            stats["inventory_items"] += 1

        # Historical sales ---------------------------------------------------------------
        cur.execute("select value::numeric from public.app_settings where key = 'price_drop_alert_threshold'")
        threshold = cur.fetchone()[0]
        for sheet in wb.sales_sheets:
            cur.execute(
                """insert into public.sales (sale_date, source, notes, legacy_ref, created_by_label)
                   values (%s, 'excel_import', %s, %s, %s) returning id""",
                (sheet.rows[0].sale_date if sheet.rows else sheet.period,
                 f"Monthly sales imported from {sheet.name} ({len(sheet.rows)} lines)", sheet.name, ACTOR),
            )
            sale_id = cur.fetchone()[0]
            stats["sales"] += 1
            for line_no, row in enumerate(sheet.rows, start=1):
                product_id = ensure_product(row.product, None, row.stock_before is None, row.ref)
                stock_id = choose_stock_item(row, stock_by_product.get(product_id, []), issues)
                is_service = row.product.lookup() in non_stock_products
                cur.execute(
                    """
                    insert into public.sale_items (
                      sale_id, line_no, stock_item_id, product_id, category_id, quantity, stock_before, stock_after,
                      agreed_price, actual_price, unit_cost, revenue, total_cost, gross_profit,
                      partner_rule_id, rule_type, partner_a_rate, partner_a_rate_is_leftover, partner_b_rate,
                      partner_a_share, partner_b_share, price_drop_ratio, price_alert, price_alert_threshold,
                      legacy_ref)
                    select %(sale_id)s, %(line_no)s, %(stock_id)s, p.id, p.category_id, %(qty)s,
                           %(before)s, %(after)s, %(agreed)s, %(actual)s, %(cost)s,
                           c.revenue, c.total_cost, c.gross_profit,
                           r.id, r.rule_type, r.partner_a_rate, r.partner_a_rate_is_leftover, r.partner_b_rate,
                           c.partner_a_share, c.partner_b_share, pd.drop_ratio, pd.is_alert, %(threshold)s,
                           %(ref)s
                    from public.products p
                    join lateral (
                      select * from public.partner_rules pr
                      where pr.category_id = p.category_id and pr.is_active
                        and pr.effective_from <= %(sale_date)s
                        and (pr.effective_to is null or pr.effective_to >= %(sale_date)s)
                      order by pr.effective_from desc limit 1
                    ) r on true
                    cross join lateral public.calculate_sale_line(r.rule_type, r.partner_b_rate, %(qty)s,
                                                                  %(actual)s, %(cost)s) c
                    cross join lateral public.price_drop_check(%(agreed)s, %(actual)s, %(threshold)s) pd
                    where p.id = %(product_id)s
                    """,
                    {
                        "sale_id": sale_id, "line_no": line_no, "stock_id": stock_id, "product_id": product_id,
                        "qty": row.quantity,
                        "before": None if is_service else row.stock_before,
                        "after": None if is_service else row.stock_after,
                        "agreed": row.agreed_price, "actual": row.actual_price, "cost": row.unit_cost,
                        "threshold": threshold, "ref": row.ref, "sale_date": row.sale_date,
                    },
                )
                if cur.rowcount != 1:
                    raise RuntimeError(f"{row.ref}: no partner rule found for category {row.product.category!r}")
                stats["sale_lines"] += 1

        # Partner_Summary adjustments ------------------------------------------------------
        cur.execute("select id from public.partners where code = 'A'")
        partner_a = cur.fetchone()[0]
        expense_ids: dict[str, str] = {}
        if wb.summary:
            for order, adj in enumerate(wb.summary.adjustments, start=1):
                if adj.expense_category not in expense_ids:
                    description, default_amount, default_ratio, recurring = EXPENSE_CATEGORY_DEFAULTS.get(
                        adj.expense_category,
                        (f"Imported from Partner_Summary label '{adj.label}'.", None, None, False))
                    cur.execute(
                        """insert into public.expense_categories
                             (name, description, default_partner_id, default_amount, default_share_ratio,
                              is_recurring, sort_order)
                           values (%s, %s, %s, %s, %s, %s, %s) returning id""",
                        (adj.expense_category, description, partner_a, default_amount, default_ratio,
                         recurring, order),
                    )
                    expense_ids[adj.expense_category] = cur.fetchone()[0]
                    stats["expense_categories"] += 1
                cur.execute(
                    """insert into public.operating_expenses
                         (period_month, expense_category_id, partner_id, base_amount, share_ratio, amount,
                          description, legacy_ref)
                       values (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (wb.summary.period, expense_ids[adj.expense_category], partner_a, adj.base_amount,
                     adj.share_ratio, adj.amount, f"Excel: {adj.label}", adj.ref),
                )
                stats["operating_expenses"] += 1
    return stats, issues


def print_issues(title: str, issues: list[Issue]) -> None:
    if issues:
        print(f"\n{title}")
        for issue in issues:
            print(f"  {issue}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--dry-run", action="store_true", help="parse and validate only; no database access")
    parser.add_argument("--replace", action="store_true", help="delete existing business data before importing")
    parser.add_argument("--skip-invalid", action="store_true",
                        help="import even when rows have errors (those rows are skipped and listed)")
    args = parser.parse_args()

    wb = read_workbook(args.workbook)
    print(f"Workbook: {wb.path}")
    print(f"Sheets: {len(wb.sheet_names)}")
    print_issues("Workbook issues:", wb.issues)

    sale_lines = sum(len(s.rows) for s in wb.sales_sheets)
    print(f"\nParsed: rules={len(wb.rules)} stock={len(wb.stock)} inventory={len(wb.inventory)} "
          f"sales_sheets={len(wb.sales_sheets)} sale_lines={sale_lines}")

    if wb.errors and not args.skip_invalid:
        print(f"\nImport aborted: {len(wb.errors)} error(s). Fix the workbook or re-run with --skip-invalid.")
        return 1
    if args.dry_run:
        print("\nDry run: nothing written.")
        return 0

    conn = connect(actor=ACTOR)
    try:
        stats, import_issues = run_import(conn, wb, replace=args.replace)
        conn.commit()
    except BaseException:
        conn.rollback()
        print("\nImport failed; all changes rolled back.")
        raise
    finally:
        conn.close()

    print_issues("Import notes:", import_issues)
    warnings = len(wb.warnings) + sum(1 for i in import_issues if i.level == "warning")
    print("\nImport completed\n")
    for label, key in [("Partner rules", "partner_rules"), ("Categories", "categories"), ("Products", "products"),
                       ("Stock records", "stock_items"), ("Stock snapshots", "stock_snapshots"),
                       ("Inventory records", "inventory_items"), ("Sales (monthly logs)", "sales"),
                       ("Sale lines", "sale_lines"), ("Expense categories", "expense_categories"),
                       ("Operating expenses", "operating_expenses")]:
        print(f"{label + ':':<22}{stats[key]}")
    print(f"\nWarnings: {warnings}")
    print(f"Errors: {len(wb.errors)}{' (skipped)' if wb.errors else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
