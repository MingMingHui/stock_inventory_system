"""Database connection helpers. Credentials come only from environment variables."""

from __future__ import annotations

import os
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"
SHIM_FILE = REPO_ROOT / "supabase" / "tests" / "supabase_shim.sql"

ENV_VAR = "DATABASE_URL"


def database_url() -> str:
    url = os.environ.get(ENV_VAR, "").strip()
    if not url:
        raise SystemExit(
            f"{ENV_VAR} is not set. Use the Supabase *direct* or *session pooler* connection string, e.g.\n"
            f"  {ENV_VAR}=postgresql://postgres.<project-ref>:<password>@<host>:5432/postgres\n"
            "Never commit this value. See docs/user-management.md."
        )
    return url


def connect(url: str | None = None, *, actor: str) -> psycopg.Connection:
    """Open a connection and label it so audit_logs can attribute the changes."""
    conn = psycopg.connect(url or database_url(), autocommit=False)
    with conn.cursor() as cur:
        cur.execute("select set_config('app.actor', %s, false)", (actor,))
    conn.commit()
    return conn


def migration_files() -> list[Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


def apply_sql_file(conn: psycopg.Connection, path: Path) -> None:
    with conn.cursor() as cur:
        cur.execute(path.read_text(encoding="utf-8"))
