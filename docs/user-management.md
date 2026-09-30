# User management

Users are Google accounts on the allow-list (`public.authorized_users`). Admins can manage them in two ways:

- **In the app:** Admin → Users (add, change role, enable or disable).
- **From a terminal:** `python/scripts/manage_users.py`, using a direct database connection. Use this to recover access, or before any admin exists.

## Script setup

```bash
cd python
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

Set the connection string **in the environment only**, never in a file that is committed:

```bash
# Supabase Dashboard → Project Settings → Database → Connection string (session pooler or direct)
export DATABASE_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'      # macOS/Linux
$env:DATABASE_URL = 'postgresql://postgres.<ref>:<password>@<host>:5432/postgres'      # PowerShell
```

## Commands

```bash
python scripts/manage_users.py list
python scripts/manage_users.py add user@example.com user --name "Workshop Staff"
python scripts/manage_users.py add admin@example.com admin
python scripts/manage_users.py set-role user@example.com admin
python scripts/manage_users.py disable user@example.com
python scripts/manage_users.py enable user@example.com
```

`add` re-activates and updates an existing entry. Emails are lower-cased and validated.

## Rules enforced by the database

- The last active administrator cannot be disabled, demoted or deleted. The script prints `Refused: …`.
- Disabling a user takes effect on their **next request**, because every query re-checks the allow-list.
- Every change is recorded in `audit_logs`. The actor is `manage_users.py (<os user>)` for the script, or the admin's email for the app.
- All SQL is parameterised.
