# Deployment

Production is **GitHub Pages** (frontend) plus the **Supabase Free Tier** (database, auth).

## 1. Supabase project

1. Create a project at supabase.com and note the **Project URL** and **anon public key** (Project Settings → API).
2. Apply the migrations using **one** of:
   - Supabase CLI: `supabase link --project-ref <ref>`, then `supabase db push`
   - SQL Editor: run each file in `supabase/migrations/` in order (001 → 006)
3. Configure Google sign-in and URLs (see [authentication.md](authentication.md)). Disable email sign-ups.
4. Import the workbook (see [data-import.md](data-import.md)).

> Do **not** run `supabase/tests/supabase_shim.sql` or `supabase/seed.sql` on production. They are for local tests and development.

## 2. GitHub repository settings

- **Settings → Pages → Source:** *GitHub Actions*.
- **Settings → Secrets and variables → Actions → New repository secret:**
  - `VITE_SUPABASE_URL` = `https://<ref>.supabase.co`
  - `VITE_SUPABASE_ANON_KEY` = the anon public key

The anon key is designed to be public and ends up in the built JavaScript. It grants nothing beyond what RLS allows. Storing it as a secret just keeps it out of logs. **Never** add the service-role key or the database password to GitHub.

## 3. Workflows

| Workflow | Trigger | Steps |
|---|---|---|
| [`ci.yml`](../.github/workflows/ci.yml) | pull requests (and called by deploy) | **web:** `npm ci`, typecheck, lint, unit tests, build · **database:** Postgres 16 service, migrations + RLS + calculation tests (`pytest`) |
| [`deploy.yml`](../.github/workflows/deploy.yml) | push to `main`, manual | runs CI → build with production secrets and `VITE_BASE_PATH=/<repo>/` → upload → deploy to Pages |

A failing test stops the deployment, because `build` depends on `test`.

The site is published at `https://mingminghui.github.io/stock_inventory_system/`. Routes use the hash (`#/stock`), so deep links and refreshes work on GitHub Pages without a 404 workaround.

## 4. Later schema changes

1. Add a new file `supabase/migrations/<timestamp>_<name>.sql`. Never edit a migration that has already been applied.
2. Run `pytest` locally or in CI; the tests apply every migration to a fresh database.
3. `supabase db push`.
