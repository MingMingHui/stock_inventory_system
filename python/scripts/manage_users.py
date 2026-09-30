"""Maintain the authorized-user allow-list (public.authorized_users).

Usage (from python/, with DATABASE_URL set — see docs/user-management.md):

    python scripts/manage_users.py add user@example.com user [--name "Display Name"]
    python scripts/manage_users.py add admin@example.com admin
    python scripts/manage_users.py set-role user@example.com admin
    python scripts/manage_users.py disable user@example.com
    python scripts/manage_users.py enable user@example.com
    python scripts/manage_users.py list

All statements are parameterised. Every change is written to audit_logs with the
actor "manage_users.py (<os user>)". The database refuses to disable or demote
the last active admin.
"""

from __future__ import annotations

import argparse
import getpass
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg  # noqa: E402

from workshop.db import connect  # noqa: E402

ROLES = ("admin", "user")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalise_email(value: str) -> str:
    email = value.strip().lower()
    if not EMAIL_RE.match(email):
        raise argparse.ArgumentTypeError(f"not a valid email address: {value!r}")
    return email


def cmd_add(cur, args) -> str:
    cur.execute(
        """insert into public.authorized_users (email, display_name, role, is_active)
           values (%s, %s, %s, true)
           on conflict (email) do update
             set role = excluded.role,
                 display_name = coalesce(excluded.display_name, public.authorized_users.display_name),
                 is_active = true
           returning (xmax = 0) as inserted""",
        (args.email, args.name, args.role),
    )
    inserted = cur.fetchone()[0]
    return f"{'Added' if inserted else 'Updated'} {args.email} as {args.role} (active)."


def _update(cur, sql: str, params: tuple, email: str) -> None:
    cur.execute(sql, params)
    if cur.rowcount == 0:
        raise SystemExit(f"No authorized user with email {email}.")


def cmd_set_role(cur, args) -> str:
    _update(cur, "update public.authorized_users set role = %s where email = %s", (args.role, args.email), args.email)
    return f"{args.email} is now {args.role}."


def cmd_enable(cur, args) -> str:
    _update(cur, "update public.authorized_users set is_active = true where email = %s", (args.email,), args.email)
    return f"Enabled {args.email}."


def cmd_disable(cur, args) -> str:
    _update(cur, "update public.authorized_users set is_active = false where email = %s", (args.email,), args.email)
    return f"Disabled {args.email}. Their existing session loses access immediately (RLS checks every request)."


def cmd_list(cur, _args) -> str:
    cur.execute(
        "select email, coalesce(display_name, ''), role::text, is_active, updated_at "
        "from public.authorized_users order by role, email"
    )
    rows = cur.fetchall()
    if not rows:
        return "No authorized users."
    width = max(len(r[0]) for r in rows)
    lines = [f"{'EMAIL':<{width}}  {'ROLE':<5}  {'ACTIVE':<6}  {'UPDATED':<16}  NAME"]
    for email, name, role, active, updated in rows:
        lines.append(f"{email:<{width}}  {role:<5}  {'yes' if active else 'no':<6}  "
                     f"{updated:%Y-%m-%d %H:%M}  {name}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add", help="add or re-activate a user")
    add.add_argument("email", type=normalise_email)
    add.add_argument("role", choices=ROLES)
    add.add_argument("--name", help="display name")
    add.set_defaults(func=cmd_add)

    role = sub.add_parser("set-role", help="change a user's role")
    role.add_argument("email", type=normalise_email)
    role.add_argument("role", choices=ROLES)
    role.set_defaults(func=cmd_set_role)

    for name, func in (("enable", cmd_enable), ("disable", cmd_disable)):
        p = sub.add_parser(name, help=f"{name} a user")
        p.add_argument("email", type=normalise_email)
        p.set_defaults(func=func)

    sub.add_parser("list", help="list users").set_defaults(func=cmd_list)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    conn = connect(actor=f"manage_users.py ({getpass.getuser()})")
    try:
        with conn.cursor() as cur:
            message = args.func(cur, args)
        conn.commit()
    except psycopg.errors.CheckViolation as exc:
        conn.rollback()
        print(f"Refused: {exc.diag.message_primary}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
