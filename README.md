# Workshop Stock & Sales

A web application for KaLi Motor's workshop. It covers:
- stock and shared equipment
- sales, with price-drop alerts
- partner revenue sharing between KaLi Motor (Partner A) and Amin (Partner B)
- monthly settlement, including wages, electricity and rental

It replaces `Workshop_Stocklist_2026.xlsx`: the workbook seeds the database once, and from then on the database is the source of truth.

- **Frontend:** React 19 + TypeScript + Vite, hosted on GitHub Pages
- **Backend:** Supabase (PostgreSQL, Row Level Security, SQL functions, Google OAuth), Free Tier
- **Tooling:** Python (Excel import, validation, user management), GitHub Actions (CI/CD)

Tabs: **Partner Rule Table · Kali Inventory List · Stock Master · Sales Log · Partner Summary**, plus an **Admin** area for administrators.

## Documentation

| Topic | |
|---|---|
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Business rules (calculations, settlement, decisions) | [docs/business-rules.md](docs/business-rules.md) |
| Database schema + ERD | [docs/database-schema.md](docs/database-schema.md) |
| Excel inspection / data model | [docs/excel-inspection.md](docs/excel-inspection.md), [docs/excel-data-model.md](docs/excel-data-model.md) |
| Data import | [docs/data-import.md](docs/data-import.md) |
| Authentication / Google OAuth | [docs/authentication.md](docs/authentication.md) |
| User management | [docs/user-management.md](docs/user-management.md) |
| Security review | [docs/security.md](docs/security.md) |
| Deployment | [docs/deployment.md](docs/deployment.md) |

## Prerequisites

- Node.js 22+ and npm
- Python 3.12+
- A Supabase project (free tier)
- A Google Cloud OAuth client
- Optional: Docker, or any PostgreSQL 16 server, for the database tests

## Local setup

```bash
npm install
cp .env.example .env.local        # then fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev                       # http://localhost:5173
```

Add `http://localhost:5173/` to the Supabase redirect URLs.

### Supabase setup (once)

1. Apply the migrations in `supabase/migrations/` (`supabase db push`, or run them in the SQL editor in order).
2. Enable Google sign-in and disable email sign-ups. See [authentication.md](docs/authentication.md).
3. The first admin, `kalimotormalihah@gmail.com`, is created by migration 006.
4. Import the workbook:

   ```bash
   cd python && python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   export DATABASE_URL='postgresql://…'                       # never commit this
   python scripts/import_excel.py --dry-run
   python scripts/import_excel.py
   python scripts/validate_import.py
   ```

### Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | browser | public; security is enforced by RLS |
| `DATABASE_URL` | Python scripts | admin database connection; local shell only |
| `TEST_DATABASE_URL` | Python tests | a throw-away PostgreSQL server |

The Supabase **service-role key is not used** and must never be added to the frontend or the repository.

## Commands

```bash
npm run dev          # development server
npm run lint         # ESLint
npm run typecheck    # TypeScript (strict)
npm test             # Vitest unit/component tests
npm run build        # production build to dist/

cd python
pytest -q            # migrations, RLS, calculations, stock/sales, Excel import (needs TEST_DATABASE_URL)
```

Local database for tests:

```bash
docker run -d --name wssms-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

## User management

Use **Admin → Users** in the app, or:

```bash
python scripts/manage_users.py add user@example.com user
python scripts/manage_users.py disable user@example.com
python scripts/manage_users.py list
```

See [user-management.md](docs/user-management.md).

## Deployment

Pushing to `main` runs all tests; if they pass, GitHub Actions builds and deploys to **https://mingminghui.github.io/stock_inventory_system/**. It needs the repository secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and Pages set to "GitHub Actions". See [deployment.md](docs/deployment.md).

## Development seed data

`supabase/seed.sql` is **development-only** data, used by `supabase start` / `supabase db reset`. All its names start with `DEV`. Production data comes only from the Excel import.
