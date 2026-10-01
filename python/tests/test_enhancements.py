"""Tests for the October 2026 enhancement: line-level void, auto-obsolete, FIFO,
Malaysian business date, Telegram authorization and sales analytics."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal as D

import psycopg
import pytest

from conftest import ADMIN_ID, DISABLED_ID, OUTSIDER_ID, USER_ID, acting_as, acting_as_service, fails

TG_USER = 555_000_111
TG_STRANGER = 999_000_222


def items(*lines) -> str:
    return json.dumps([{"stock_item_id": str(s), "quantity": q, "actual_price": p} for s, q, p in lines])


def qty(db, stock_id) -> int:
    return db.execute("select quantity from public.stock_items where id = %s", (stock_id,)).fetchone()[0]


def batch(db, product_id, purchased: str | None, quantity: int, cost="10", price="20"):
    return db.execute(
        "insert into public.stock_items (product_id, purchased_date, unit_cost, agreed_price, quantity) "
        "values (%s, %s, %s, %s, %s) returning id",
        (product_id, purchased, cost, price, quantity),
    ).fetchone()[0]


def product(db, category_id, code="ABC001", desc="Brake Pad", non_stock=False):
    return db.execute(
        "insert into public.products (item_code, description, category_id, is_non_stock) values (%s, %s, %s, %s) "
        "returning id", (code, desc, category_id, non_stock),
    ).fetchone()[0]


def status(db, stock_id):
    return db.execute("select is_obsolete, obsolete_remarks from public.stock_items where id = %s",
                      (stock_id,)).fetchone()


# =============================================================================
# A. Bulk sale: every line has its own void
# =============================================================================
@pytest.fixture
def bulk_sale(db, catalog):
    """One sale with 5 lines (a 'bulk insert'), each from its own batch of 10 units."""
    pid = product(db, catalog["Car Tyre"], "BULK-1", "Bulk test tyre")
    batches = [batch(db, pid, f"2026-0{m}-01", 10, "100", "150") for m in range(1, 6)]
    with acting_as(db, USER_ID):
        sale_id = db.execute("select public.create_sale(current_date, %s::jsonb)",
                             (items(*[(b, 2, 150) for b in batches]),)).fetchone()[0]
    lines = [r[0] for r in db.execute("select id from public.sale_items where sale_id = %s order by line_no",
                                      (sale_id,)).fetchall()]
    return {"sale_id": sale_id, "batches": batches, "lines": lines}


def test_bulk_sale_lines_are_individually_voidable(db, bulk_sale):
    with acting_as(db, ADMIN_ID):
        rows = db.execute("select id, is_void from public.sales_log_view where sale_id = %s order by line_no",
                          (bulk_sale["sale_id"],)).fetchall()
    assert len(rows) == 5 and all(not void for _, void in rows)
    assert [r[0] for r in rows] == bulk_sale["lines"]  # five distinct line ids


def test_voiding_line_3_only_affects_line_3(db, bulk_sale):
    third = bulk_sale["lines"][2]
    with acting_as(db, ADMIN_ID):
        db.execute("select public.void_sale_item(%s, 'wrong tyre size')", (third,))
        void_flags = db.execute("select id, is_void, void_reason from public.sales_log_view where sale_id = %s "
                                "order by line_no", (bulk_sale["sale_id"],)).fetchall()
    assert [v for _, v, _ in void_flags] == [False, False, True, False, False]
    assert void_flags[2][2] == "wrong tyre size"
    # only batch 3 got its 2 units back
    assert [qty(db, b) for b in bulk_sale["batches"]] == [8, 8, 10, 8, 8]
    assert db.execute("select is_void from public.sales where id = %s", (bulk_sale["sale_id"],)).fetchone()[0] is False
    history = db.execute("select adjustment_type::text, previous_quantity, new_quantity, sale_item_id "
                         "from public.stock_adjustments where stock_item_id = %s order by created_at",
                         (bulk_sale["batches"][2],)).fetchall()
    assert history[-1] == ("sale_void", 8, 10, third)
    line = db.execute("select voided_by_label, voided_at is not null from public.sale_items where id = %s",
                      (third,)).fetchone()
    assert line == ("admin@example.com", True)


def test_line_void_cannot_be_repeated_or_done_by_users(db, bulk_sale):
    first = bulk_sale["lines"][0]
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.InsufficientPrivilege, match="Administrator"):
            db.execute("select public.void_sale_item(%s, 'x')", (first,))
    with acting_as(db, ADMIN_ID):
        with fails(db, psycopg.errors.InvalidParameterValue, match="reason"):
            db.execute("select public.void_sale_item(%s, '  ')", (first,))
        db.execute("select public.void_sale_item(%s, 'duplicate')", (first,))
        with fails(db, psycopg.errors.InvalidParameterValue, match="already void"):
            db.execute("select public.void_sale_item(%s, 'again')", (first,))
    assert qty(db, bulk_sale["batches"][0]) == 10  # restored exactly once


def test_whole_sale_void_does_not_restore_an_already_voided_line_twice(db, bulk_sale):
    with acting_as(db, ADMIN_ID):
        db.execute("select public.void_sale_item(%s, 'one line')", (bulk_sale["lines"][2],))
        db.execute("select public.void_sale(%s, 'whole sale')", (bulk_sale["sale_id"],))
    assert [qty(db, b) for b in bulk_sale["batches"]] == [10, 10, 10, 10, 10]
    assert db.execute("select count(*) from public.sale_items where sale_id = %s and is_void",
                      (bulk_sale["sale_id"],)).fetchone()[0] == 5


def test_reports_exclude_voided_lines(db, bulk_sale):
    with acting_as(db, ADMIN_ID):
        db.execute("select public.void_sale_item(%s, 'x')", (bulk_sale["lines"][0],))
        lines, revenue = db.execute("select sale_line_count, total_revenue from public.settlement_summary("
                                    "current_date, current_date)").fetchone()
        dash = db.execute("select sale_line_count, total_revenue from public.dashboard_stats(current_date, current_date)"
                          ).fetchone()
        cat = db.execute("select line_count, revenue from public.partner_summary_by_category(current_date, current_date)"
                         ).fetchone()
    assert (lines, revenue) == (4, D("1200.00")) == dash == cat


def test_voiding_an_imported_line_does_not_change_stock(db, catalog):
    pid = product(db, catalog["Car Tyre"], "IMP-1", "Imported")
    b = batch(db, pid, "2026-08-01", 3)
    sale = db.execute("insert into public.sales (sale_date, source, created_by_label) values ('2026-08-31', "
                      "'excel_import', 'import') returning id").fetchone()[0]
    line = db.execute(
        """insert into public.sale_items (sale_id, line_no, stock_item_id, product_id, category_id, quantity,
             agreed_price, actual_price, unit_cost, revenue, total_cost, gross_profit, rule_type,
             partner_a_rate_is_leftover, partner_b_rate, partner_a_share, partner_b_share, price_alert_threshold)
           values (%s, 1, %s, %s, %s, 1, 20, 20, 10, 20, 10, 10, 'Fixed_Per_Unit', true, 10, 10, 10, 0.1)
           returning id""", (sale, b, pid, catalog["Car Tyre"])).fetchone()[0]
    with acting_as(db, ADMIN_ID):
        db.execute("select public.void_sale_item(%s, 'excel correction')", (line,))
    assert qty(db, b) == 3


# =============================================================================
# B. Automatic obsolete rule
# =============================================================================
def test_older_empty_batch_with_newer_batch_becomes_obsolete(db, catalog):
    pid = product(db, catalog["Car Tyre"])
    old = batch(db, pid, "2026-01-10", 0)
    assert status(db, old) == (False, None)  # alone: nothing newer yet
    new = batch(db, pid, "2026-03-15", 10)
    assert status(db, old) == (True, "auto-rule obsolete")
    assert status(db, new) == (False, None)
    audit = db.execute("select changed_fields from public.audit_logs where table_name = 'stock_items' "
                       "and record_id = %s and action = 'UPDATE' order by id desc limit 1", (str(old),)).fetchone()[0]
    assert "obsolete_remarks" in audit and "is_obsolete" in audit


def test_older_batch_with_stock_stays_active(db, catalog):
    pid = product(db, catalog["Car Tyre"])
    old = batch(db, pid, "2026-01-10", 4)
    new = batch(db, pid, "2026-03-15", 10)
    assert status(db, old) == (False, None) and status(db, new) == (False, None)


def test_newer_empty_batch_does_not_retire_older_active_stock(db, catalog):
    pid = product(db, catalog["Car Tyre"])
    old = batch(db, pid, "2026-01-01", 5)
    new = batch(db, pid, "2026-03-01", 0)
    assert status(db, old) == (False, None)
    assert status(db, new) == (False, None)  # newest batch is never retired by the rule


def test_multiple_duplicates_retire_leading_empty_batches_only(db, catalog):
    pid = product(db, catalog["Car Tyre"])
    b1 = batch(db, pid, "2026-01-01", 0)
    b2 = batch(db, pid, "2026-02-01", 10)
    b3 = batch(db, pid, "2026-03-01", 5)
    assert [status(db, b)[0] for b in (b1, b2, b3)] == [True, False, False]  # spec example
    b0 = batch(db, pid, "2025-12-01", 0)
    b4 = batch(db, pid, "2026-04-01", 0)
    assert [status(db, b)[0] for b in (b0, b1, b2, b3, b4)] == [True, True, False, False, False]


def test_selling_out_the_oldest_batch_retires_it_and_a_void_brings_it_back(db, catalog):
    pid = product(db, catalog["Car Tyre"], "FIFO-1", "Fifo tyre")
    oldest = batch(db, pid, "2026-01-01", 2, "100", "150")
    newer = batch(db, pid, "2026-05-01", 6, "100", "150")
    with acting_as(db, USER_ID):
        sale = db.execute("select public.create_sale(current_date, %s::jsonb)", (items((oldest, 2, 150)),)).fetchone()[0]
    assert status(db, oldest) == (True, "auto-rule obsolete")
    line = db.execute("select id from public.sale_items where sale_id = %s", (sale,)).fetchone()[0]
    with acting_as(db, ADMIN_ID):
        db.execute("select public.void_sale_item(%s, 'returned')", (line,))
    assert qty(db, oldest) == 2
    assert status(db, oldest) == (False, None)  # auto-retired batch reactivated when stock came back
    assert status(db, newer) == (False, None)


def test_manual_obsolete_is_recorded_and_not_touched_by_the_rule(db, catalog):
    pid = product(db, catalog["Car Tyre"])
    old = batch(db, pid, "2026-01-01", 3)
    batch(db, pid, "2026-02-01", 3)
    with acting_as(db, USER_ID):
        db.execute("select public.set_stock_obsolete(%s, true)", (old,))
    assert status(db, old) == (True, "manual")
    db.execute("update public.stock_items set quantity = 5 where id = %s", (old,))
    assert status(db, old) == (True, "manual")  # quantity change does not reactivate a manual obsolete
    with acting_as(db, USER_ID):
        db.execute("select public.set_stock_obsolete(%s, false)", (old,))
    assert status(db, old) == (False, None)


def test_rule_ignores_services_and_undated_batches(db, catalog):
    svc = product(db, catalog["Car Battery Besar"], "SVC-1", "Charging", non_stock=True)
    s1 = batch(db, svc, "2026-01-01", 0)
    batch(db, svc, "2026-02-01", 0)
    assert status(db, s1) == (False, None)
    pid = product(db, catalog["Car Tyre"])
    undated = batch(db, pid, None, 0)
    batch(db, pid, "2026-02-01", 4)
    assert status(db, undated) == (False, None)


# =============================================================================
# C. FIFO ordering
# =============================================================================
def test_fifo_rank_orders_by_purchase_date(db, catalog):
    pid = product(db, catalog["Car Tyre"])
    late = batch(db, pid, "2026-06-20", 20)
    early = batch(db, pid, "2026-01-05", 3)
    mid = batch(db, pid, "2026-03-10", 15)
    undated = batch(db, pid, None, 1)
    ranks = dict(db.execute("select id, fifo_rank from public.stock_items_view where product_id = %s", (pid,)).fetchall())
    assert [ranks[b] for b in (early, mid, late, undated)] == [1, 2, 3, 4]
    assert db.execute("select distinct active_batch_count from public.stock_items_view where product_id = %s",
                      (pid,)).fetchone()[0] == 4


# =============================================================================
# D. Malaysian business date
# =============================================================================
def test_business_today_is_malaysian_date(db):
    myt = db.execute("select (now() at time zone 'Asia/Kuala_Lumpur')::date").fetchone()[0]
    assert db.execute("select private.business_today()").fetchone()[0] == myt


def test_sale_dated_malaysian_today_is_accepted(db, catalog):
    with acting_as(db, USER_ID):
        db.execute("select public.create_sale(private.business_today(), %s::jsonb)", (items((catalog["battery"], 1, 195)),))


# =============================================================================
# E. Telegram
# =============================================================================
def link_user(db, user_id=USER_ID, tg=TG_USER) -> str:
    with acting_as(db, user_id):
        code = db.execute("select code from public.create_telegram_link_code()").fetchone()[0]
    with acting_as_service(db):
        db.execute("select * from public.tg_link_account(%s, %s, 'kali_staff', %s)", (code, tg, tg))
    return code


TG_FUNCTIONS = [
    ("tg_whoami", f"select * from public.tg_whoami({TG_USER})"),
    ("tg_list_categories", f"select * from public.tg_list_categories({TG_USER})"),
    ("tg_execute", f"select public.tg_execute({TG_USER}, 'x')"),
    ("tg_link_account", f"select * from public.tg_link_account('{'a' * 64}', {TG_USER}, 'x', 1)"),
]


@pytest.mark.parametrize("name, statement", TG_FUNCTIONS, ids=[n for n, _ in TG_FUNCTIONS])
def test_browser_roles_cannot_call_bot_functions(db, name, statement):
    for user in (None, USER_ID, ADMIN_ID):
        with acting_as(db, user):
            with fails(db, psycopg.errors.InsufficientPrivilege):
                db.execute(statement)


def test_link_code_is_random_hashed_single_use(db):
    with acting_as(db, USER_ID):
        code, expires, _bot = db.execute("select * from public.create_telegram_link_code()").fetchone()
    assert len(code) == 64 and all(ch in "0123456789abcdef" for ch in code)
    stored = db.execute("select code_hash from public.telegram_link_codes").fetchall()
    assert len(stored) == 1 and stored[0][0] != code  # only the hash is stored
    with acting_as_service(db):
        row = db.execute("select display_name, role::text from public.tg_link_account(%s, %s, 'kali', %s)",
                         (code, TG_USER, TG_USER)).fetchone()
        assert row == ("User", "user")
        with fails(db, psycopg.errors.InvalidParameterValue, match="TG_CODE_USED"):
            db.execute("select * from public.tg_link_account(%s, %s, 'other', 1)", (code, TG_STRANGER))
        with fails(db, psycopg.errors.InvalidParameterValue, match="TG_CODE_INVALID"):
            db.execute("select * from public.tg_link_account(%s, %s, 'other', 1)", ("f" * 64, TG_STRANGER))
        with fails(db, psycopg.errors.InvalidParameterValue, match="TG_CODE_INVALID"):
            db.execute("select * from public.tg_link_account('drop table x', %s, 'other', 1)", (TG_STRANGER,))


def test_expired_link_code_is_rejected(db):
    with acting_as(db, USER_ID):
        code = db.execute("select code from public.create_telegram_link_code()").fetchone()[0]
    db.execute("update public.telegram_link_codes set expires_at = now() - interval '1 minute'")
    with acting_as_service(db):
        with fails(db, psycopg.errors.InvalidParameterValue, match="TG_CODE_EXPIRED"):
            db.execute("select * from public.tg_link_account(%s, %s, 'kali', 1)", (code, TG_USER))


def test_unlinked_unknown_and_disabled_telegram_users_are_rejected(db):
    with acting_as_service(db):
        with fails(db, psycopg.errors.InsufficientPrivilege, match="TG_NOT_LINKED"):
            db.execute("select * from public.tg_whoami(%s)", (TG_STRANGER,))
    link_user(db)
    with acting_as_service(db):
        assert db.execute("select email, role::text from public.tg_whoami(%s)", (TG_USER,)).fetchone() == (
            "user@example.com", "user")
    db.execute("update public.authorized_users set is_active = false where email = 'user@example.com'")
    with acting_as_service(db):
        with fails(db, psycopg.errors.InsufficientPrivilege, match="TG_NOT_LINKED"):
            db.execute("select * from public.tg_whoami(%s)", (TG_USER,))


def test_service_role_without_a_linked_user_cannot_write(db, catalog):
    with acting_as_service(db):
        with fails(db, psycopg.errors.InsufficientPrivilege, match="Not authorized"):
            db.execute("select public.create_sale(current_date, %s::jsonb)", (items((catalog["battery"], 1, 195)),))


def test_browser_user_cannot_impersonate_via_acting_email(db, catalog):
    with acting_as(db, OUTSIDER_ID):
        db.execute("select set_config('app.acting_email', 'admin@example.com', true)")
        with fails(db, psycopg.errors.InsufficientPrivilege, match="Not authorized"):
            db.execute("select public.create_sale(current_date, %s::jsonb)", (items((catalog["battery"], 1, 195)),))
    with acting_as(db, DISABLED_ID):
        db.execute("select set_config('app.acting_email', 'admin@example.com', true)")
        assert db.execute("select * from public.get_my_access()").fetchall() == []


def test_bot_lists_batches_fifo_and_preview_matches_web(db, catalog):
    link_user(db)
    pid = product(db, catalog["Car Battery"], "ABC001", "Battery NS40")
    late = batch(db, pid, "2026-06-20", 20, "142.30", "195")
    early = batch(db, pid, "2026-01-05", 3, "142.30", "195")
    batch(db, pid, "2026-03-10", 15, "142.30", "195")
    with acting_as_service(db):
        rows = db.execute("select stock_item_id, purchased_date, quantity, fifo_rank from public.tg_list_batches(%s, %s)",
                          (TG_USER, pid)).fetchall()
        assert [(r[1], r[2], r[3]) for r in rows] == [(date(2026, 1, 5), 3, 1), (date(2026, 3, 10), 15, 2),
                                                      (date(2026, 6, 20), 20, 3)]
        assert rows[0][0] == early and rows[2][0] == late
        tg = db.execute("select public.tg_preview_sale(%s, %s, 2, 170, current_date)", (TG_USER, early)).fetchone()[0]
    with acting_as(db, USER_ID):
        web = db.execute("select revenue, partner_a_share, partner_b_share, price_alert, price_drop_ratio "
                         "from public.preview_sale_line(%s, 2, 170, current_date)", (early,)).fetchone()
    assert (D(str(tg["revenue"])), D(str(tg["partner_a_share"])), D(str(tg["partner_b_share"])),
            tg["price_alert"], D(str(tg["price_drop_ratio"]))) == web
    assert web == (D("340.00"), D("320.00"), D("20.00"), True, D("0.1282"))


def set_pending(db, tg, action, payload, nonce="n1"):
    state = {"nonce": nonce, "expires_at": "2999-01-01T00:00:00Z", "pending": {"action": action, "payload": payload}}
    db.execute("insert into public.telegram_sessions (telegram_user_id, state) values (%s, %s) "
               "on conflict (telegram_user_id) do update set state = excluded.state", (tg, json.dumps(state)))


def test_bot_sale_is_atomic_idempotent_and_attributed(db, catalog):
    link_user(db)
    set_pending(db, TG_USER, "sale", {"stock_item_id": str(catalog["battery"]), "quantity": 2,
                                      "actual_price": "195", "sale_date": str(date.today())})
    with acting_as_service(db):
        first = db.execute("select public.tg_execute(%s, 'n1')", (TG_USER,)).fetchone()[0]
        again = db.execute("select public.tg_execute(%s, 'n1')", (TG_USER,)).fetchone()[0]
        stale = db.execute("select public.tg_execute(%s, 'old')", (TG_USER,)).fetchone()[0]
    assert first["status"] == "ok" and first["stock_after"] == 8
    assert again == {"status": "already_done", "result": first}
    assert stale == {"status": "expired"}
    assert qty(db, catalog["battery"]) == 8
    assert db.execute("select count(*) from public.sales").fetchone()[0] == 1
    label, partner_b = db.execute("select s.created_by_label, si.partner_b_share from public.sales s "
                                  "join public.sale_items si on si.sale_id = s.id").fetchone()
    assert label == "user@example.com (Telegram)" and partner_b == D("20.00")


def test_bot_sale_rechecks_stock_and_keeps_session_on_failure(db, catalog):
    link_user(db)
    set_pending(db, TG_USER, "sale", {"stock_item_id": str(catalog["tyre"]), "quantity": 5,
                                      "actual_price": "170", "sale_date": str(date.today())})
    with acting_as_service(db):
        with fails(db, psycopg.errors.CheckViolation, match="only 3 in stock"):
            db.execute("select public.tg_execute(%s, 'n1')", (TG_USER,))
    assert qty(db, catalog["tyre"]) == 3
    assert db.execute("select state ? 'pending' from public.telegram_sessions where telegram_user_id = %s",
                      (TG_USER,)).fetchone()[0] is True


def test_bot_adjustment_uses_stale_guard(db, catalog):
    link_user(db)
    set_pending(db, TG_USER, "adjust_stock", {"stock_item_id": str(catalog["battery"]), "adjustment_type": "stock_check",
                                              "quantity": 7, "reason": "count", "expected_quantity": 9})
    with acting_as_service(db):
        with fails(db, psycopg.errors.SerializationFailure, match="changed from 9 to 10"):
            db.execute("select public.tg_execute(%s, 'n1')", (TG_USER,))
    set_pending(db, TG_USER, "adjust_stock", {"stock_item_id": str(catalog["battery"]), "adjustment_type": "receive",
                                              "quantity": 5, "reason": "delivery", "expected_quantity": 10})
    with acting_as_service(db):
        result = db.execute("select public.tg_execute(%s, 'n1')", (TG_USER,)).fetchone()[0]
    assert (result["previous_quantity"], result["new_quantity"]) == (10, 15)


def test_bot_add_stock_creates_batch_of_existing_product(db, catalog):
    link_user(db)
    pid = db.execute("select product_id from public.stock_items where id = %s", (catalog["battery"],)).fetchone()[0]
    set_pending(db, TG_USER, "add_stock", {"product_id": str(pid), "purchased_date": "2026-09-01", "quantity": 4,
                                           "unit_cost": "140", "agreed_price": "195"})
    with acting_as_service(db):
        assert db.execute("select public.tg_execute(%s, 'n1')", (TG_USER,)).fetchone()[0]["status"] == "ok"
    assert db.execute("select count(*), sum(quantity) from public.stock_items where product_id = %s",
                      (pid,)).fetchone() == (2, 14)


def test_admin_link_list_visible_to_admins_only(db):
    link_user(db)
    with acting_as(db, USER_ID):
        assert db.execute("select count(*) from public.telegram_user_links").fetchone()[0] == 0
        assert db.execute("select telegram_username from public.get_my_telegram_link()").fetchone() == ("kali_staff",)
    with acting_as(db, ADMIN_ID):
        assert db.execute("select count(*) from public.telegram_user_links").fetchone()[0] == 1
        assert db.execute("update public.telegram_user_links set is_active = false").rowcount == 1
    with acting_as_service(db):
        with fails(db, psycopg.errors.InsufficientPrivilege, match="TG_NOT_LINKED"):
            db.execute("select * from public.tg_whoami(%s)", (TG_USER,))


def test_admin_deactivation_cannot_be_bypassed_by_relinking(db):
    link_user(db)
    with acting_as(db, ADMIN_ID):
        db.execute("update public.telegram_user_links set is_active = false")
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.InsufficientPrivilege, match="deactivated by an administrator"):
            db.execute("select * from public.create_telegram_link_code()")
        db.execute("select public.unlink_my_telegram()")  # cannot remove the block
    assert db.execute("select count(*) from public.telegram_user_links where not is_active").fetchone()[0] == 1
    # the same Telegram account cannot be linked to another user either
    with acting_as(db, ADMIN_ID):
        code = db.execute("select code from public.create_telegram_link_code()").fetchone()[0]
    with acting_as_service(db):
        with fails(db, psycopg.errors.InsufficientPrivilege, match="TG_LINK_DEACTIVATED"):
            db.execute("select * from public.tg_link_account(%s, %s, 'kali', 1)", (code, TG_USER))
    with acting_as(db, ADMIN_ID):
        db.execute("update public.telegram_user_links set is_active = true")
    with acting_as_service(db):
        assert db.execute("select role::text from public.tg_whoami(%s)", (TG_USER,)).fetchone() == ("user",)


def test_duplicate_update_is_claimed_once(db):
    with acting_as_service(db):
        assert db.execute("select public.tg_claim_update(1001, %s)", (TG_USER,)).fetchone()[0] is True
        assert db.execute("select public.tg_claim_update(1001, %s)", (TG_USER,)).fetchone()[0] is False


# =============================================================================
# F. Sales analytics
# =============================================================================
@pytest.fixture
def analytics_data(db, catalog):
    """Deterministic monthly unit sales for Apr–Sep 2026 (6-month window ending September)."""
    cat = catalog["Car Tyre"]
    patterns = {
        "GROW": [1, 1, 1, 3, 3, 3],
        "DECL": [4, 4, 4, 1, 1, 1],
        "STAB": [2, 2, 2, 2, 2, 2],
        "SPOR": [0, 2, 0, 0, 0, 1],
        "OLD": [2, 1, 0, 0, 0, 0],
    }
    stock = {}
    for code in patterns:
        pid = product(db, cat, code, f"{code} tyre")
        stock[code] = batch(db, pid, "2026-01-01", 100, "50", "100")
    months = ["2026-04-15", "2026-05-15", "2026-06-15", "2026-07-15", "2026-08-15", "2026-09-15"]
    with acting_as(db, ADMIN_ID):
        for i, day in enumerate(months):
            lines = [(stock[c], units[i], 100) for c, units in patterns.items() if units[i] > 0]
            db.execute("select public.create_sale(%s, %s::jsonb)", (day, items(*lines)))
    return stock


def analyze(db, months=6):
    with acting_as(db, ADMIN_ID):
        rows = db.execute("select item_code, units, revenue, gross_profit, months_with_sales, units_recent, "
                          "monthly_units, classification, pattern from public.analytics_items('2026-09-30', %s, 3)",
                          (months,)).fetchall()
    return {r[0]: r for r in rows}


def test_item_aggregation_and_patterns(db, analytics_data):
    rows = analyze(db)
    assert rows["GROW"][1:3] == (12, D("1200.00")) and rows["GROW"][3] == D("600.00")
    assert rows["GROW"][6] == [1, 1, 1, 3, 3, 3]
    assert {code: rows[code][8] for code in ("GROW", "DECL", "STAB", "SPOR", "OLD")} == {
        "GROW": "GROWING", "DECL": "DECLINING", "STAB": "STABLE", "SPOR": "SPORADIC", "OLD": "NO RECENT SALES"}


def test_best_and_low_seller_classification(db, analytics_data):
    rows = analyze(db)
    # DECL (15 units) is the top seller and sold in 6/6 months → BEST SELLER
    assert rows["DECL"][7] == "BEST SELLER"
    # OLD: stock 97, nothing in the last 3 months, 4 months without sales, stock bought Jan → LOW SELLER
    assert rows["OLD"][7] == "LOW SELLER"
    # SPOR sold 1 unit recently but in only 2 of 6 months; 4 months without sales → LOW SELLER (≤1 recent)
    assert rows["SPOR"][7] == "LOW SELLER"
    assert rows["STAB"][7] == "NORMAL"


def test_one_zero_month_is_not_a_low_seller(db, catalog):
    pid = product(db, catalog["Car Tyre"], "GAP", "Gap tyre")
    b = batch(db, pid, "2026-01-01", 50, "50", "100")
    with acting_as(db, ADMIN_ID):
        for day in ("2026-04-10", "2026-05-10", "2026-06-10", "2026-07-10", "2026-09-10"):  # August missing
            db.execute("select public.create_sale(%s, %s::jsonb)", (day, items((b, 2, 100))))
    assert analyze(db)["GAP"][7] != "LOW SELLER"


def test_seasonal_pattern(db, catalog):
    pid = product(db, catalog["Car Tyre"], "SEAS", "Seasonal tyre")
    b = batch(db, pid, "2025-01-01", 50, "50", "100")
    with acting_as(db, ADMIN_ID):
        for day, units in (("2025-03-10", 5), ("2025-06-10", 1), ("2026-03-10", 5), ("2026-08-10", 1)):
            db.execute("select public.create_sale(%s, %s::jsonb)", (day, items((b, units, 100))))
    assert analyze(db, 6)["SEAS"][8] == "SEASONAL"


def test_monthly_and_category_aggregation(db, analytics_data):
    with acting_as(db, ADMIN_ID):
        months = db.execute("select period_month, units, revenue, line_count, avg_sale_value "
                            "from public.analytics_monthly('2026-04-01', '2026-09-30')").fetchall()
        cats = db.execute("select category_name, units, revenue, revenue_share "
                          "from public.analytics_categories('2026-04-01', '2026-09-30')").fetchall()
    assert [m[1] for m in months] == [9, 10, 7, 6, 6, 7]
    assert months[0] == (date(2026, 4, 1), 9, D("900.00"), 4, D("225.00"))
    assert cats == [("Car Tyre", 45, D("4500.00"), D("1.0000"))]


def test_voided_lines_are_excluded_from_analytics(db, analytics_data):
    line = db.execute("select si.id from public.sale_items si join public.sales s on s.id = si.sale_id "
                      "where s.sale_date = '2026-04-15' and si.stock_item_id = %s", (analytics_data["GROW"],)).fetchone()[0]
    with acting_as(db, ADMIN_ID):
        db.execute("select public.void_sale_item(%s, 'test')", (line,))
    assert analyze(db)["GROW"][6] == [0, 1, 1, 3, 3, 3]


def test_analytics_admin_only_and_validated(db, analytics_data):
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.InsufficientPrivilege, match="Administrator"):
            db.execute("select * from public.analytics_items()")
        with fails(db, psycopg.errors.InsufficientPrivilege, match="Administrator"):
            db.execute("select * from public.analytics_monthly('2026-01-01', '2026-02-01')")
    with acting_as(db, ADMIN_ID):
        with fails(db, psycopg.errors.InvalidParameterValue):
            db.execute("select * from public.analytics_items(null, 2, 1)")
