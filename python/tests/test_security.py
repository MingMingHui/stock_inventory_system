"""Authorization tests: every check runs as a real database role with a JWT, the
same way a (possibly malicious) browser client reaches Supabase."""

from __future__ import annotations

import psycopg
import pytest

from conftest import (
    ADMIN_ID,
    DISABLED_ID,
    OUTSIDER_ID,
    UNVERIFIED_ID,
    USER_ID,
    acting_as,
    fails,
)

BUSINESS_TABLES = [
    "partner_rules", "product_categories", "products", "stock_items", "stock_adjustments",
    "inventory_items", "sales", "sale_items", "operating_expenses", "monthly_settlements", "app_settings",
]


@pytest.mark.parametrize("table", BUSINESS_TABLES + ["authorized_users", "audit_logs"])
def test_anonymous_cannot_read_anything(db, catalog, table):
    with acting_as(db, None):
        with fails(db, psycopg.errors.InsufficientPrivilege):
            db.execute(f"select count(*) from public.{table}")


def test_anonymous_cannot_call_functions(db):
    with acting_as(db, None):
        with fails(db, psycopg.errors.InsufficientPrivilege):
            db.execute("select * from public.get_my_access()")


@pytest.mark.parametrize("user_id", [OUTSIDER_ID, UNVERIFIED_ID, DISABLED_ID],
                         ids=["google-account-not-on-allow-list", "unverified-email", "disabled-user"])
def test_unauthorized_logins_see_no_data_and_cannot_write(db, catalog, user_id):
    with acting_as(db, user_id):
        assert db.execute("select * from public.get_my_access()").fetchall() == []
        for table in BUSINESS_TABLES:
            assert db.execute(f"select count(*) from public.{table}").fetchone()[0] == 0, table
        assert db.execute("select count(*) from public.stock_items_view").fetchone()[0] == 0
        with fails(db, psycopg.errors.InsufficientPrivilege, match="Not authorized"):
            db.execute("select public.create_sale(current_date, %s::jsonb)",
                       (f'[{{"stock_item_id":"{catalog["battery"]}","quantity":1,"actual_price":195}}]',))
        with fails(db, psycopg.errors.InsufficientPrivilege, match="Not authorized"):
            db.execute("select public.adjust_stock(%s, 'receive', 5, 'x')", (catalog["battery"],))


def test_authorized_roles_are_reported(db):
    with acting_as(db, ADMIN_ID):
        assert db.execute("select email, role::text from public.get_my_access()").fetchone() == ("admin@example.com", "admin")
    with acting_as(db, USER_ID):
        assert db.execute("select email, role::text from public.get_my_access()").fetchone() == ("user@example.com", "user")


def test_bootstrap_admin_matches_either_gmail_spelling(db):
    """kalimotormalihah@gmail.com is on the allow-list; Google may report the dotted spelling."""
    dotted = "00000000-0000-0000-0000-0000000000f1"
    db.execute("update public.authorized_users set is_active = true where email = 'kalimotormalihah@gmail.com'")
    db.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, 'Kalimotor.Malihah@gmail.com', now())",
               (dotted,))
    with acting_as(db, dotted):
        assert db.execute("select role::text from public.get_my_access()").fetchone() == ("admin",)
    with fails(db, psycopg.errors.UniqueViolation):
        db.execute("insert into public.authorized_users (email, role) values ('kali.motor.malihah@gmail.com', 'user')")


def test_non_gmail_addresses_match_exactly(db):
    other = "00000000-0000-0000-0000-0000000000f2"
    db.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, 'u.ser@example.com', now())", (other,))
    with acting_as(db, other):
        assert db.execute("select * from public.get_my_access()").fetchall() == []


def test_user_can_read_business_data(db, catalog):
    with acting_as(db, USER_ID):
        assert db.execute("select count(*) from public.partner_rules").fetchone()[0] == 5
        assert db.execute("select count(*) from public.stock_items_view").fetchone()[0] == 4


def test_user_cannot_read_or_change_the_allow_list(db):
    with acting_as(db, USER_ID):
        assert db.execute("select count(*) from public.authorized_users").fetchone()[0] == 0
        with fails(db, psycopg.errors.InsufficientPrivilege):  # RLS WITH CHECK violation
            db.execute("insert into public.authorized_users (email, role) values ('evil@gmail.com', 'admin')")
        cur = db.execute("update public.authorized_users set role = 'admin' where email = 'user@example.com'")
        assert cur.rowcount == 0
    assert db.execute("select role::text from public.authorized_users where email = 'user@example.com'").fetchone()[0] == "user"


def test_user_cannot_modify_partner_rules(db, catalog):
    with acting_as(db, USER_ID):
        assert db.execute("update public.partner_rules set partner_b_rate = 99").rowcount == 0
        assert db.execute("delete from public.partner_rules").rowcount == 0
        with fails(db, psycopg.errors.InsufficientPrivilege):
            db.execute("insert into public.partner_rules (category_id, rule_type, partner_b_rate, "
                       "partner_a_rate_is_leftover) values (%s, 'Fixed_Per_Unit', 1, true)", (catalog["Car Tyre"],))
    assert db.execute("select max(partner_b_rate) from public.partner_rules").fetchone()[0] == 10


def test_admin_can_modify_partner_rules_and_it_is_audited(db, catalog):
    with acting_as(db, ADMIN_ID):
        cur = db.execute("update public.partner_rules set partner_b_rate = 12 "
                         "where category_id = %s", (catalog["Car Tyre"],))
        assert cur.rowcount == 1
    actor, fields = db.execute(
        "select actor_label, changed_fields from public.audit_logs where table_name = 'partner_rules' "
        "and action = 'UPDATE' order by id desc limit 1").fetchone()
    assert actor == "admin@example.com"
    assert "partner_b_rate" in fields


def test_nobody_can_set_stock_quantity_directly(db, catalog):
    for user in (USER_ID, ADMIN_ID):
        with acting_as(db, user):
            with fails(db, psycopg.errors.InsufficientPrivilege):
                db.execute("update public.stock_items set quantity = 999 where id = %s", (catalog["battery"],))


def test_user_cannot_change_prices_but_admin_can(db, catalog):
    with acting_as(db, USER_ID):
        assert db.execute("update public.stock_items set agreed_price = 1 where id = %s",
                          (catalog["battery"],)).rowcount == 0
    with acting_as(db, ADMIN_ID):
        assert db.execute("update public.stock_items set agreed_price = 199 where id = %s",
                          (catalog["battery"],)).rowcount == 1
    assert db.execute("select agreed_price from public.stock_items where id = %s",
                      (catalog["battery"],)).fetchone()[0] == 199


def test_clients_cannot_write_sales_or_history_directly(db, catalog):
    for user in (USER_ID, ADMIN_ID):
        with acting_as(db, user):
            with fails(db, psycopg.errors.InsufficientPrivilege):
                db.execute("insert into public.sales (sale_date, created_by_label) values (current_date, 'x')")
            with fails(db, psycopg.errors.InsufficientPrivilege):
                db.execute("delete from public.stock_adjustments")
            with fails(db, psycopg.errors.InsufficientPrivilege):
                db.execute("delete from public.audit_logs")


def test_audit_log_visible_to_admin_only(db, catalog):
    db.execute("update public.stock_items set notes = 'audit me' where id = %s", (catalog["battery"],))
    with acting_as(db, USER_ID):
        assert db.execute("select count(*) from public.audit_logs").fetchone()[0] == 0
    with acting_as(db, ADMIN_ID):
        assert db.execute("select count(*) from public.audit_logs").fetchone()[0] > 0


def test_inventory_is_admin_only_for_writes(db):
    with acting_as(db, USER_ID):
        with fails(db, psycopg.errors.InsufficientPrivilege):
            db.execute("insert into public.inventory_items (name, quantity) values ('Car Jack', 1)")
    with acting_as(db, ADMIN_ID):
        db.execute("insert into public.inventory_items (name, quantity) values ('Car Jack', 4)")
    with acting_as(db, USER_ID):
        assert db.execute("update public.inventory_items set quantity = 0").rowcount == 0
        assert db.execute("select quantity from public.inventory_items where name = 'Car Jack'").fetchone()[0] == 4


def test_settings_admin_only_and_validated(db):
    with acting_as(db, USER_ID):
        assert db.execute("update public.app_settings set value = '0.5' "
                          "where key = 'price_drop_alert_threshold'").rowcount == 0
    with acting_as(db, ADMIN_ID):
        with fails(db, psycopg.errors.CheckViolation):
            db.execute("update public.app_settings set value = 'lots' where key = 'low_stock_default_threshold'")
        assert db.execute("update public.app_settings set value = '0.15' "
                          "where key = 'price_drop_alert_threshold'").rowcount == 1


def test_last_admin_cannot_be_removed(db):
    with acting_as(db, ADMIN_ID):
        with fails(db, psycopg.errors.CheckViolation, match="last active administrator"):
            db.execute("update public.authorized_users set role = 'user' where email = 'admin@example.com'")


def test_created_by_cannot_be_spoofed(db):
    # created_by is not in the column grant, so supplying it is refused; when omitted the trigger fills it.
    with acting_as(db, ADMIN_ID):
        with fails(db, psycopg.errors.InsufficientPrivilege):
            db.execute("insert into public.inventory_items (name, quantity, created_by) "
                       "values ('Air Blow Gun', 2, '00000000-0000-0000-0000-000000000000')")
        created_by = db.execute("insert into public.inventory_items (name, quantity) values ('Air Blow Gun', 2) "
                                "returning created_by").fetchone()[0]
        assert str(created_by) == str(ADMIN_ID)
