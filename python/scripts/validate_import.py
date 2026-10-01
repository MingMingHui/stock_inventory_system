"""Compare the Excel workbook with the database and report discrepancies.

Usage (from python/, with DATABASE_URL set):

    python scripts/validate_import.py            # summary + discrepancies
    python scripts/validate_import.py --verbose  # also list every known Excel-formula difference

Checks
  1. Partner rules      — every Excel rule exists with the same type and rates
  2. Stock              — every Stock_Master row: quantity, cost, price, obsolete flag
  3. Inventory          — every KALI_Inventory_List row
  4. Sales lines        — database calculation vs Excel cached values, per line
  5. Partner summary    — per-category shares and "Total Payment to KALI"

Differences caused by the documented Excel formula defects (docs/business-rules.md)
are reported as KNOWN; anything else is a DISCREPANCY and makes the exit code 1.
"""

from __future__ import annotations

import argparse
import calendar
import sys
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workshop.db import connect  # noqa: E402
from workshop.excel_source import DEFAULT_WORKBOOK, Workbook, read_workbook  # noqa: E402

ZERO = Decimal("0.00")
TOLERANCE = Decimal("0.01")


@dataclass
class Finding:
    kind: str  # "DISCREPANCY" | "KNOWN"
    location: str
    message: str

    def __str__(self) -> str:
        return f"[{self.kind}] {self.location}: {self.message}"


def _eq(a: Decimal | None, b: Decimal | None) -> bool:
    return abs((a or ZERO) - (b or ZERO)) <= TOLERANCE


def check_rules(cur, wb: Workbook, out: list[Finding]) -> int:
    # Compare with the rules in force on the last day of the imported month; later
    # rule versions are business decisions made after the workbook.
    as_of = wb.sales_sheets[0].rows[0].sale_date if wb.sales_sheets and wb.sales_sheets[0].rows else None
    cur.execute(
        """select c.name, r.rule_type::text, r.partner_b_rate, r.partner_a_rate
           from public.partner_rules r join public.product_categories c on c.id = r.category_id
           where r.is_active
             and (%(d)s::date is null or (r.effective_from <= %(d)s and (r.effective_to is null or r.effective_to >= %(d)s)))""",
        {"d": as_of},
    )
    db = {row[0].lower(): row[1:] for row in cur.fetchall()}
    for rule in wb.rules:
        got = db.get(rule.category.lower())
        if got is None:
            out.append(Finding("DISCREPANCY", rule.ref, f"rule for {rule.category!r} missing in database"))
        elif (got[0], got[1], got[2]) != (rule.rule_type, rule.partner_b_rate, rule.partner_a_rate):
            out.append(Finding("DISCREPANCY", rule.ref, f"Excel {rule.rule_type}/{rule.partner_b_rate}/"
                                                        f"{rule.partner_a_rate} vs database {got}"))
    return len(wb.rules)


AUTO_OBSOLETE = "auto-rule obsolete"


def check_stock(cur, wb: Workbook, out: list[Finding]) -> int:
    cur.execute("select legacy_ref, quantity, unit_cost, agreed_price, is_obsolete, obsolete_remarks "
                "from public.stock_items")
    db = {row[0]: row[1:] for row in cur.fetchall() if row[0]}
    for row in wb.stock:
        got = db.get(row.ref)
        expected = (row.quantity, row.unit_cost, row.agreed_price, row.is_obsolete)
        if got is None:
            out.append(Finding("DISCREPANCY", row.ref, "stock row missing in database"))
            continue
        actual, remarks = tuple(got[:4]), got[4]
        if actual == expected:
            continue
        if actual[:3] == expected[:3] and actual[3] and not expected[3] and remarks == AUTO_OBSOLETE:
            # Database rule (docs/stock-rules.md): an older empty batch with a newer batch is obsolete.
            out.append(Finding("KNOWN", row.ref, "retired by the auto-obsolete rule (Excel still shows it active)"))
        else:
            out.append(Finding("DISCREPANCY", row.ref, f"Excel {expected} vs database {actual} "
                                                       "(qty, cost, price, obsolete)"))
    return len(wb.stock)


def check_inventory(cur, wb: Workbook, out: list[Finding]) -> int:
    cur.execute("select legacy_ref, name, quantity from public.inventory_items")
    db = {row[0]: row[1:] for row in cur.fetchall() if row[0]}
    for item in wb.inventory:
        if db.get(item.ref) != (item.name, item.quantity):
            out.append(Finding("DISCREPANCY", item.ref, f"Excel {(item.name, item.quantity)} vs database {db.get(item.ref)}"))
    return len(wb.inventory)


def check_sales(cur, wb: Workbook, out: list[Finding]) -> int:
    cur.execute(
        """select legacy_ref, revenue, total_cost, gross_profit, rule_type::text, partner_a_share, partner_b_share
           from public.sale_items where legacy_ref is not null"""
    )
    db = {row[0]: row[1:] for row in cur.fetchall()}
    count = 0
    for sheet in wb.sales_sheets:
        for row in sheet.rows:
            count += 1
            got = db.get(row.ref)
            if got is None:
                out.append(Finding("DISCREPANCY", row.ref, "sale line missing in database"))
                continue
            revenue, cost, gp, rule_type, a_share, b_share = got
            if row.excel_rule_type and row.excel_rule_type != rule_type:
                out.append(Finding("DISCREPANCY", row.ref, f"rule type Excel {row.excel_rule_type} vs {rule_type}"))
            if not _eq(revenue, row.excel_revenue):
                out.append(Finding("DISCREPANCY", row.ref, f"revenue Excel {row.excel_revenue} vs database {revenue}"))
            if not _eq(cost, row.excel_cost):
                if row.excel_cost is not None and _eq(row.excel_cost, row.agreed_price * row.quantity):
                    out.append(Finding("KNOWN", row.ref, f"Excel Cost_Per_Sale uses selling price "
                                                         f"({row.excel_cost}); database uses cost ({cost})"))
                else:
                    out.append(Finding("DISCREPANCY", row.ref, f"cost Excel {row.excel_cost} vs database {cost}"))
            if row.excel_gross_profit is None:
                out.append(Finding("KNOWN", row.ref, f"Excel Gross_Profit not computed (broken AND() array "
                                                     f"formula); database {gp}"))
            elif not _eq(gp, row.excel_gross_profit):
                expected_bug = row.excel_cost is not None and _eq(row.excel_gross_profit,
                                                                  (row.excel_revenue or ZERO) - row.excel_cost)
                out.append(Finding("KNOWN" if expected_bug else "DISCREPANCY", row.ref,
                                   f"gross profit Excel {row.excel_gross_profit} vs database {gp}"))
            if not _eq(a_share, row.excel_partner_a_share) or not _eq(b_share, row.excel_partner_b_share):
                out.append(Finding("DISCREPANCY", row.ref,
                                   f"shares A/B Excel {row.excel_partner_a_share}/{row.excel_partner_b_share} "
                                   f"vs database {a_share}/{b_share}"))
    return count


def check_summary(cur, wb: Workbook, out: list[Finding]) -> int:
    summary = wb.summary
    if summary is None:
        out.append(Finding("DISCREPANCY", "Partner_Summary", "not parsed"))
        return 0
    last_day = summary.period.replace(day=calendar.monthrange(summary.period.year, summary.period.month)[1])
    cur.execute("select category_name, partner_b_share, partner_a_share "
                "from public.partner_summary_by_category(%s, %s)", (summary.period, last_day))
    db = {row[0]: (row[1], row[2]) for row in cur.fetchall()}
    for category, (b_share, a_share) in summary.by_category.items():
        got = db.get(category, (ZERO, ZERO))
        if not (_eq(got[0], b_share) and _eq(got[1], a_share)):
            out.append(Finding("DISCREPANCY", f"Partner_Summary {category}",
                               f"A.L/KALI Excel {b_share}/{a_share} vs database {got[0]}/{got[1]}"))
    cur.execute("select partner_b_share, partner_a_share, partner_a_payable from public.settlement_summary(%s, %s)",
                (summary.period, summary.period))
    b_total, a_total, a_payable = cur.fetchone()
    if not (_eq(b_total, summary.grand_total[0]) and _eq(a_total, summary.grand_total[1])):
        out.append(Finding("DISCREPANCY", "Partner_Summary Grand Total",
                           f"Excel {summary.grand_total} vs database {(b_total, a_total)}"))
    if summary.total_payment_to_partner_a is not None and not _eq(a_payable, summary.total_payment_to_partner_a):
        out.append(Finding("DISCREPANCY", "Partner_Summary Total Payment to KALI",
                           f"Excel {summary.total_payment_to_partner_a} vs database {a_payable}"))
    return len(summary.by_category) + 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    wb = read_workbook(args.workbook)
    findings: list[Finding] = []
    conn = connect(actor="validate_import.py")
    try:
        with conn.cursor() as cur:
            checked = {
                "Partner rules": check_rules(cur, wb, findings),
                "Stock rows": check_stock(cur, wb, findings),
                "Inventory rows": check_inventory(cur, wb, findings),
                "Sale lines": check_sales(cur, wb, findings),
                "Summary figures": check_summary(cur, wb, findings),
            }
    finally:
        conn.close()

    discrepancies = [f for f in findings if f.kind == "DISCREPANCY"]
    known = [f for f in findings if f.kind == "KNOWN"]
    print("Validation: Excel vs database\n")
    for label, n in checked.items():
        print(f"{label + ':':<18}{n} checked")
    if discrepancies:
        print("\nDiscrepancies:")
        for f in discrepancies:
            print(f"  {f}")
    if known:
        print(f"\nKnown Excel formula differences: {len(known)}" + ("" if args.verbose else " (use --verbose to list)"))
        if args.verbose:
            for f in known:
                print(f"  {f}")
    print(f"\nResult: {'PASS' if not discrepancies else 'FAIL'} "
          f"({len(discrepancies)} discrepancies, {len(known)} known differences)")
    return 1 if discrepancies else 0


if __name__ == "__main__":
    raise SystemExit(main())
