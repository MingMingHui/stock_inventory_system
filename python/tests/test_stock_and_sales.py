"""Stock, sales and settlement behaviour through the public database functions."""

from __future__ import annotations

import json
import threading
from datetime import date
from decimal import Decimal as D

import psycopg
import pytest

from conftest import ADMIN_ID, USER_ID, acting_as, fails


def items(*lines) -> str:
    return json.dumps([{"stock_item_id": str(s), "quantity": q, "actual_price": p} for s, q, p in lines])


def qty(db, stock_id) -> int:
    return db.execute("select quantity from public.stock_items where id = %s", (stock_id,)).fetchone()[0]


# ---------------------------------------------------------------------------
# Stock
# ---------------------------------------------------------------------------
def test_user_receives_stock_and_history_is_recorded(db, catalog):
    with acting_as(db, USER_ID):
        row = db.execute("select previous_quantity, new_quantity, quantity_change, created_by_label "
                         "from public.adjust_stock(%s, 'receive', 5, 'Delivery from supplier')",
                         (catalog["battery"],)).fetchone()
    assert row == (10, 15, 5, "user@example.com")
    assert qty(db, catalog["battery"]) == 15


def test_stock_check_sets_counted_quantity(db, catalog):
    with acting_as(db, USER_ID):
        db.execute("select public.adjust_stock(%s, 'stock_check', 8, 'Month-end count', 10)", (catalog["battery"],))
    assert qty(db, catalog["battery"]) == 8
    last_checked = db.execute("select last_checked_at from public.stock_items where id = %s",
                              (catalog["battery"],)).fetchone()[0]
    assert last_checked is not None


def test_stale_expected_quantity_is_rejected(db, catalog):
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.SerializationFailure, match="changed from 9 to 10"):
            db.execute("select public.adjust_stock(%s, 'amendment', 7, 'fix', 9)", (catalog["battery"],))
    assert qty(db, catalog["battery"]) == 10


@pytest.mark.parametrize("adj_type, amount", [("receive", 0), ("receive", -3), ("stock_check", -1), ("sale", 1)])
def test_invalid_adjustments_rejected(db, catalog, adj_type, amount):
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.InvalidParameterValue):
            db.execute("select public.adjust_stock(%s, %s, %s, 'x')", (catalog["battery"], adj_type, amount))


def test_adjustment_requires_reason(db, catalog):
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.InvalidParameterValue, match="reason"):
            db.execute("select public.adjust_stock(%s, 'receive', 1, '   ')", (catalog["battery"],))


def test_low_stock_and_status(db, catalog):
    statuses = dict(db.execute("select id, status from public.stock_items_view").fetchall())
    assert statuses[catalog["battery"]] == "ACTIVE"          # 10 > default 1
    assert statuses[catalog["charging"]] == "ACTIVE"         # non-stock service item
    assert statuses[catalog["old_tyre"]] == "OBSOLETE"
    with acting_as(db, USER_ID):
        db.execute("select public.set_stock_min_quantity(%s, 5)", (catalog["tyre"],))
    assert db.execute("select status from public.stock_items_view where id = %s",
                      (catalog["tyre"],)).fetchone()[0] == "LOW_STOCK"   # 3 <= 5
    with acting_as(db, USER_ID):
        db.execute("select public.adjust_stock(%s, 'stock_check', 0, 'none left')", (catalog["tyre"],))
    assert db.execute("select status from public.stock_items_view where id = %s",
                      (catalog["tyre"],)).fetchone()[0] == "OUT_OF_STOCK"


def test_add_stock_item_creates_product_and_history(db, catalog):
    with acting_as(db, USER_ID):
        new_id = db.execute(
            "select public.add_stock_item(%s, ' tyre-2054517 ', 'Car Tyre  205/45R17', 'Sonix UHP', 'pcs', false, "
            "'2026-09-01', 168, 230, 4)", (catalog["Car Tyre"],)).fetchone()[0]
    item_code, description, quantity = db.execute(
        "select item_code, description, quantity from public.stock_items_view where id = %s", (new_id,)).fetchone()
    assert (item_code, description, quantity) == ("TYRE-2054517", "Car Tyre 205/45R17", 4)
    assert db.execute("select adjustment_type::text, new_quantity from public.stock_adjustments "
                      "where stock_item_id = %s", (new_id,)).fetchall() == [("initial", 4)]


def test_obsolete_is_soft(db, catalog):
    with acting_as(db, USER_ID):
        db.execute("select public.set_stock_obsolete(%s, true)", (catalog["tyre"],))
    assert db.execute("select is_obsolete, obsolete_at is not null from public.stock_items where id = %s",
                      (catalog["tyre"],)).fetchone() == (True, True)
    with acting_as(db, USER_ID):
        db.execute("select public.set_stock_obsolete(%s, false)", (catalog["tyre"],))
    assert db.execute("select is_obsolete from public.stock_items where id = %s", (catalog["tyre"],)).fetchone()[0] is False


# ---------------------------------------------------------------------------
# Sales
# ---------------------------------------------------------------------------
def test_create_sale_calculates_decrements_and_records(db, catalog):
    with acting_as(db, USER_ID):
        sale_id = db.execute("select public.create_sale(current_date, %s::jsonb, 'walk-in')",
                             (items((catalog["battery"], 2, 195)),)).fetchone()[0]
    line = db.execute(
        """select stock_before, stock_after, agreed_price, actual_price, unit_cost, revenue, total_cost,
                  gross_profit, rule_type::text, partner_b_rate, partner_a_share, partner_b_share, price_alert
           from public.sale_items where sale_id = %s""", (sale_id,)).fetchone()
    assert line == (10, 8, D("195.00"), D("195.00"), D("142.30"), D("390.00"), D("284.60"), D("105.40"),
                    "Fixed_Per_Unit", D("10.0000"), D("370.00"), D("20.00"), False)
    assert qty(db, catalog["battery"]) == 8
    adj = db.execute("select adjustment_type::text, previous_quantity, new_quantity, sale_item_id is not null "
                     "from public.stock_adjustments where stock_item_id = %s", (catalog["battery"],)).fetchall()
    assert adj == [("sale", 10, 8, True)]
    assert db.execute("select created_by_label from public.sales where id = %s", (sale_id,)).fetchone()[0] \
        == "user@example.com"


def test_client_supplied_prices_and_rates_are_ignored(db, catalog):
    payload = json.dumps([{"stock_item_id": str(catalog["battery"]), "quantity": 1, "actual_price": 195,
                           "agreed_price": 1, "unit_cost": 0, "partner_b_rate": 0, "partner_a_share": 195}])
    with acting_as(db, USER_ID):
        sale_id = db.execute("select public.create_sale(current_date, %s::jsonb)", (payload,)).fetchone()[0]
    assert db.execute("select agreed_price, unit_cost, partner_b_share from public.sale_items where sale_id = %s",
                      (sale_id,)).fetchone() == (D("195.00"), D("142.30"), D("10.00"))


def test_price_drop_alert_is_recorded(db, catalog):
    with acting_as(db, USER_ID):
        sale_id = db.execute("select public.create_sale(current_date, %s::jsonb)",
                             (items((catalog["battery"], 1, 170)),)).fetchone()[0]
    assert db.execute("select price_alert, price_drop_ratio from public.sale_items where sale_id = %s",
                      (sale_id,)).fetchone() == (True, D("0.1282"))


def test_preview_matches_created_sale(db, catalog):
    with acting_as(db, USER_ID):
        preview = db.execute("select revenue, partner_a_share, partner_b_share, price_alert, stock_after "
                             "from public.preview_sale_line(%s, 3, 8)", (catalog["charging"],)).fetchone()
    assert preview == (D("24.00"), D("12.00"), D("12.00"), False, None)
    assert qty(db, catalog["charging"]) == 0  # preview writes nothing


def test_non_stock_items_are_not_decremented(db, catalog):
    with acting_as(db, USER_ID):
        db.execute("select public.create_sale(current_date, %s::jsonb)", (items((catalog["charging"], 3, 8)),))
    assert qty(db, catalog["charging"]) == 0


@pytest.mark.parametrize("quantity, price, message", [
    (0, 195, "greater than zero"),
    (-2, 195, "greater than zero"),
    (1, -5, "actual price is invalid"),
    (11, 195, "only 10 in stock"),
])
def test_invalid_sales_rejected(db, catalog, quantity, price, message):
    with acting_as(db, USER_ID):
        with fails(db, psycopg.Error, match=message):
            db.execute("select public.create_sale(current_date, %s::jsonb)",
                       (items((catalog["battery"], quantity, price)),))
    assert qty(db, catalog["battery"]) == 10


def test_obsolete_and_future_sales_rejected(db, catalog):
    with acting_as(db, USER_ID):
        with fails(db, psycopg.Error, match="obsolete"):
            db.execute("select public.create_sale(current_date, %s::jsonb)", (items((catalog["old_tyre"], 1, 208)),))
        with fails(db, psycopg.Error, match="future"):
            db.execute("select public.create_sale(current_date + 1, %s::jsonb)", (items((catalog["battery"], 1, 195)),))


def test_failed_line_rolls_back_whole_sale(db, catalog):
    with acting_as(db, USER_ID):
        with fails(db, psycopg.Error, match="only 3 in stock"):
            db.execute("select public.create_sale(current_date, %s::jsonb)",
                       (items((catalog["battery"], 1, 195), (catalog["tyre"], 4, 170)),))
    assert qty(db, catalog["battery"]) == 10
    assert db.execute("select count(*) from public.sales").fetchone()[0] == 0


def test_void_sale_admin_only_and_restores_stock(db, catalog):
    with acting_as(db, USER_ID):
        sale_id = db.execute("select public.create_sale(current_date, %s::jsonb)",
                             (items((catalog["battery"], 2, 195)),)).fetchone()[0]
        with fails(db, psycopg.errors.InsufficientPrivilege, match="Administrator"):
            db.execute("select public.void_sale(%s, 'wrong item')", (sale_id,))
    with acting_as(db, ADMIN_ID):
        db.execute("select public.void_sale(%s, 'wrong item')", (sale_id,))
    assert qty(db, catalog["battery"]) == 10
    assert db.execute("select is_void, void_reason from public.sales where id = %s", (sale_id,)).fetchone() \
        == (True, "wrong item")
    # voided sales are excluded from reporting
    assert db.execute("select count(*) from public.partner_summary_by_category(current_date, current_date)"
                      ).fetchone()[0] == 0


def test_concurrent_sales_do_not_lose_updates(database_url):
    """Two sessions sell 3 and 4 of the same 10 units at the same time -> 3 left, never 6 or 7."""
    with psycopg.connect(database_url, autocommit=True) as setup:
        cat = setup.execute("insert into public.product_categories (name) values ('Concurrency Test') "
                            "returning id").fetchone()[0]
        setup.execute("insert into public.partner_rules (category_id, rule_type, partner_b_rate, "
                      "partner_a_rate_is_leftover, effective_from) values (%s, 'Fixed_Per_Unit', 1, true, '2025-01-01')",
                      (cat,))
        pid = setup.execute("insert into public.products (item_code, description, category_id) "
                            "values ('CONC-1', 'Concurrency item', %s) returning id", (cat,)).fetchone()[0]
        stock_id = setup.execute("insert into public.stock_items (product_id, unit_cost, agreed_price, quantity) "
                                 "values (%s, 1, 10, 10) returning id", (pid,)).fetchone()[0]

    first_locked = threading.Event()
    errors: list[BaseException] = []

    def sell(amount: int, hold: bool) -> None:
        try:
            with psycopg.connect(database_url) as conn:
                with acting_as(conn, USER_ID):
                    conn.execute("select public.create_sale(current_date, %s::jsonb)", (items((stock_id, amount, 10)),))
                    if hold:
                        first_locked.set()
                        threading.Event().wait(0.5)  # keep the row lock while the other session queues
                conn.commit()
        except BaseException as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    t1 = threading.Thread(target=sell, args=(3, True))
    t1.start()
    assert first_locked.wait(5)
    t2 = threading.Thread(target=sell, args=(4, False))
    t2.start()
    t1.join(10)
    t2.join(10)
    assert not errors, errors

    with psycopg.connect(database_url) as check:
        assert check.execute("select quantity from public.stock_items where id = %s", (stock_id,)).fetchone()[0] == 3
        befores = sorted(r[0] for r in check.execute(
            "select stock_before from public.sale_items where stock_item_id = %s", (stock_id,)).fetchall())
        assert befores == [7, 10]


# ---------------------------------------------------------------------------
# Settlement
# ---------------------------------------------------------------------------
def _expense_setup(db):
    partner_a = db.execute("select id from public.partners where code = 'A'").fetchone()[0]
    cats = {}
    with acting_as(db, ADMIN_ID):
        for name in ("Employee Salary", "Electricity", "Rental"):
            cats[name] = db.execute("insert into public.expense_categories (name, default_partner_id) "
                                    "values (%s, %s) returning id", (name, partner_a)).fetchone()[0]
    return partner_a, cats


def test_settlement_reproduces_excel_partner_summary_formula(db, catalog):
    """Excel: Total Payment to KALI = SUM(KALI_Share) - 100 + 32.65*0.6 + 500."""
    partner_a, cats = _expense_setup(db)
    month = date(2026, 8, 1)
    with acting_as(db, USER_ID):
        db.execute("select public.create_sale('2026-08-29', %s::jsonb)", (items((catalog["battery"], 2, 195)),))
    with acting_as(db, ADMIN_ID):
        for cat, base, ratio, amount in [("Employee Salary", None, None, "-100"),
                                         ("Electricity", "32.65", "0.6", "19.59"),
                                         ("Rental", None, None, "500")]:
            db.execute("insert into public.operating_expenses (period_month, expense_category_id, partner_id, "
                       "base_amount, share_ratio, amount) values (%s, %s, %s, %s, %s, %s)",
                       (month, cats[cat], partner_a, base, ratio, amount))
    with acting_as(db, USER_ID):
        row = db.execute("select total_revenue, partner_a_share, partner_b_share, partner_a_adjustments, "
                         "partner_a_payable, partner_b_payable from public.settlement_summary(%s, %s)",
                         (month, month)).fetchone()
    assert row == (D("390.00"), D("370.00"), D("20.00"), D("419.59"), D("789.59"), D("20.00"))


def test_electricity_share_is_computed_by_the_database(db):
    partner_a, cats = _expense_setup(db)
    with acting_as(db, ADMIN_ID):
        # A client-supplied amount is ignored when a bill and ratio are given.
        amount = db.execute("insert into public.operating_expenses (period_month, expense_category_id, partner_id, "
                            "base_amount, share_ratio, amount) values ('2026-08-01', %s, %s, 32.65, 0.6, 999) "
                            "returning amount", (cats["Electricity"], partner_a)).fetchone()[0]
    assert amount == D("19.59")


def test_recurring_wages_added_once_and_on_finalize(db, catalog):
    partner_a = db.execute("select id from public.partners where code = 'A'").fetchone()[0]
    with acting_as(db, ADMIN_ID):
        db.execute("insert into public.expense_categories (name, default_partner_id, default_amount, is_recurring) "
                   "values ('Employee Salary', %s, -100, true)", (partner_a,))
        with fails(db, psycopg.errors.CheckViolation):  # recurring needs an amount
            db.execute("insert into public.expense_categories (name, is_recurring) values ('Broken', true)")
        assert db.execute("select public.apply_recurring_expenses('2026-07-01')").fetchone()[0] == 1
        assert db.execute("select public.apply_recurring_expenses('2026-07-15')").fetchone()[0] == 0  # idempotent
        snap = db.execute("select partner_a_adjustments from public.finalize_settlement('2026-06-01')").fetchone()
        assert snap == (D("-100.00"),)  # finalize applies recurring items itself
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.InsufficientPrivilege):
            db.execute("select public.apply_recurring_expenses('2026-05-01')")


def test_finalized_month_is_locked_until_reopened(db, catalog):
    partner_a, cats = _expense_setup(db)
    with acting_as(db, USER_ID):
        db.execute("select public.create_sale('2026-08-15', %s::jsonb)", (items((catalog["battery"], 1, 195)),))
        with fails(db, psycopg.errors.InsufficientPrivilege):
            db.execute("select public.finalize_settlement('2026-08-01')")
    with acting_as(db, ADMIN_ID):
        snap = db.execute("select partner_a_payable, sale_line_count from public.finalize_settlement('2026-08-01')"
                          ).fetchone()
        assert snap == (D("185.00"), 1)
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.ObjectNotInPrerequisiteState, match="finalized"):
            db.execute("select public.create_sale('2026-08-20', %s::jsonb)", (items((catalog["battery"], 1, 195)),))
    with acting_as(db, ADMIN_ID):
        with fails(db, psycopg.errors.ObjectNotInPrerequisiteState):
            db.execute("insert into public.operating_expenses (period_month, expense_category_id, partner_id, amount) "
                       "values ('2026-08-01', %s, %s, 500)", (cats["Rental"], partner_a))
        db.execute("select public.reopen_settlement('2026-08-01', 'late invoice')")
    with acting_as(db, USER_ID):
        db.execute("select public.create_sale('2026-08-20', %s::jsonb)", (items((catalog["battery"], 1, 195)),))


def test_rule_overlap_rejected(db, catalog):
    with acting_as(db, ADMIN_ID):
        with fails(db, psycopg.errors.ExclusionViolation, match="overlapping"):
            db.execute("insert into public.partner_rules (category_id, rule_type, partner_b_rate, "
                       "partner_a_rate_is_leftover, effective_from) values (%s, 'Fixed_Per_Unit', 12, true, '2026-09-01')",
                       (catalog["Car Tyre"],))
        # Proper versioning: close the old rule, then add the new one.
        db.execute("update public.partner_rules set effective_to = '2026-08-31' where category_id = %s",
                   (catalog["Car Tyre"],))
        db.execute("insert into public.partner_rules (category_id, rule_type, partner_b_rate, "
                   "partner_a_rate_is_leftover, effective_from) values (%s, 'Fixed_Per_Unit', 12, true, '2026-09-01')",
                   (catalog["Car Tyre"],))
    with acting_as(db, USER_ID):
        old = db.execute("select partner_b_share from public.preview_sale_line(%s, 1, 170, '2026-08-15')",
                         (catalog["tyre"],)).fetchone()[0]
        new = db.execute("select partner_b_share from public.preview_sale_line(%s, 1, 170, '2026-09-15')",
                         (catalog["tyre"],)).fetchone()[0]
    assert (old, new) == (D("10.00"), D("12.00"))


def test_shared_50_rule_must_use_half_rates(db, catalog):
    with acting_as(db, ADMIN_ID):
        with fails(db, psycopg.errors.CheckViolation):
            db.execute("update public.partner_rules set partner_b_rate = 0.6 where category_id = %s",
                       (catalog["Car Battery Besar"],))
