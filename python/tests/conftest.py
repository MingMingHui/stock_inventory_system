"""Test fixtures.

Database tests need TEST_DATABASE_URL pointing at a PostgreSQL *server* where the
connecting role may create databases, e.g.

    TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

Each test session creates a throw-away database, applies the Supabase test shim
plus every migration, and drops it afterwards. Tests are skipped when the
variable is not set.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg  # noqa: E402
from psycopg import sql  # noqa: E402
from psycopg.conninfo import conninfo_to_dict, make_conninfo  # noqa: E402

from workshop.db import SHIM_FILE, apply_sql_file, migration_files  # noqa: E402

ADMIN_ID = uuid.UUID("00000000-0000-0000-0000-00000000000a")
USER_ID = uuid.UUID("00000000-0000-0000-0000-00000000000b")
OUTSIDER_ID = uuid.UUID("00000000-0000-0000-0000-00000000000c")
UNVERIFIED_ID = uuid.UUID("00000000-0000-0000-0000-00000000000d")
DISABLED_ID = uuid.UUID("00000000-0000-0000-0000-00000000000e")

ACCOUNTS = {
    ADMIN_ID: ("admin@example.com", True),
    USER_ID: ("user@example.com", True),
    OUTSIDER_ID: ("outsider@gmail.com", True),
    UNVERIFIED_ID: ("unverified@example.com", False),
    DISABLED_ID: ("disabled@example.com", True),
}


def _server_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL not set; database tests skipped")
    return url


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    server = _server_url()
    name = f"wssms_test_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(server, autocommit=True) as admin:
        admin.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    params = conninfo_to_dict(server)
    params["dbname"] = name
    url = make_conninfo(**params)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            apply_sql_file(conn, SHIM_FILE)
            for path in migration_files():
                apply_sql_file(conn, path)
            for uid, (email, confirmed) in ACCOUNTS.items():
                conn.execute(
                    "insert into auth.users (id, email, email_confirmed_at) values (%s, %s, %s)",
                    (uid, email, "2026-01-01" if confirmed else None),
                )
            conn.execute(
                """insert into public.authorized_users (email, display_name, role, is_active) values
                   ('admin@example.com', 'Admin', 'admin', true),
                   ('user@example.com', 'User', 'user', true),
                   ('unverified@example.com', 'Unverified', 'user', true),
                   ('disabled@example.com', 'Disabled', 'user', false)"""
            )
            # The bootstrap admin from migration 006 is disabled so the tests control
            # exactly which admins exist.
            conn.execute("update public.authorized_users set is_active = false "
                         "where email = 'kalimotormalihah@gmail.com'")
        yield url
    finally:
        with psycopg.connect(server, autocommit=True) as admin:
            admin.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name)))


@pytest.fixture
def db(database_url: str) -> Iterator[psycopg.Connection]:
    """Superuser connection inside a transaction that is rolled back after the test."""
    with psycopg.connect(database_url) as conn:
        yield conn
        conn.rollback()


@contextmanager
def acting_as(conn: psycopg.Connection, user_id: uuid.UUID | None):
    """Run statements as `authenticated` (or `anon` when user_id is None) with a Supabase-style JWT."""
    role = "anon" if user_id is None else "authenticated"
    claims = {"role": role} if user_id is None else {"sub": str(user_id), "role": role}
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(role)))
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps(claims),))
    try:
        yield conn
    finally:
        conn.execute("reset role")
        conn.execute("select set_config('request.jwt.claims', '', true)")


@contextmanager
def fails(conn: psycopg.Connection, exc: type[Exception] = psycopg.Error, match: str | None = None):
    """Expect the enclosed statement to fail; keeps the surrounding transaction usable."""
    conn.execute("savepoint expect_failure")
    with pytest.raises(exc, match=match):
        yield
    conn.execute("rollback to savepoint expect_failure")


@pytest.fixture
def catalog(db: psycopg.Connection) -> dict:
    """Minimal catalog built from real Excel rules (Partner_Rule_Table) and Stock_Master rows."""
    ids: dict = {}
    rules = [
        ("Car Tyre", "Fixed_Per_Unit", "10", None),
        ("Car Battery", "Fixed_Per_Unit", "10", None),
        ("Car Battery Besar", "Shared_50", "0.5", "0.5"),
        ("Car Tyre Strip", "Fixed_Per_Job", "0.5", "0.5"),
        ("Car Tyre Change Cust", "Fixed_Per_Service", "6", None),
    ]
    for name, rule_type, b_rate, a_rate in rules:
        cat = db.execute("insert into public.product_categories (name) values (%s) returning id", (name,)).fetchone()[0]
        ids[name] = cat
        db.execute(
            """insert into public.partner_rules
                 (category_id, rule_type, partner_b_rate, partner_a_rate, partner_a_rate_is_leftover, effective_from)
               values (%s, %s, %s, %s, %s, '2025-01-01')""",
            (cat, rule_type, b_rate, a_rate, a_rate is None),
        )

    def stock(code, desc, category, qty, cost, price, non_stock=False, obsolete=False):
        pid = db.execute(
            """insert into public.products (item_code, description, category_id, is_non_stock)
               values (%s, %s, %s, %s) returning id""",
            (code, desc, ids[category], non_stock),
        ).fetchone()[0]
        return db.execute(
            """insert into public.stock_items (product_id, unit_cost, agreed_price, quantity, is_obsolete, obsolete_at)
               values (%s, %s, %s, %s, %s, case when %s then now() end) returning id""",
            (pid, cost, price, qty, obsolete, obsolete),
        ).fetchone()[0]

    ids["battery"] = stock("BAT-NS40", "NS40ZL", "Car Battery", 10, "142.30", "195.00")
    ids["tyre"] = stock("TYRE-1756514", "Car Tyre 175/65R14", "Car Tyre", 3, "110.00", "170.00")
    ids["charging"] = stock("BAT-CHARGE", "Battery Charging", "Car Battery Besar", 0, "0", "8.00", non_stock=True)
    ids["old_tyre"] = stock("TYRE-1955015", "Car Tyre 195/50R15", "Car Tyre", 1, "123.00", "208.00", obsolete=True)
    return ids
