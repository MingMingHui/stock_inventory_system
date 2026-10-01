# Deployment

Production is:
- **GitHub Pages** for the frontend
- the **Supabase Free Tier** for the database, auth and the Telegram Edge Function

## 1. Supabase project

1. Create a project at supabase.com and note the **Project URL** and **anon public key** (Project Settings → API).
2. Apply the migrations in order (001 → 011) using **one** of:
   - Supabase CLI: `supabase link --project-ref <ref>`, then `supabase db push`
   - SQL Editor: run each file in `supabase/migrations/`
3. Configure Google sign-in and URLs (see [authentication.md](authentication.md)). Disable email sign-ups.
4. Import the workbook (see [data-import.md](data-import.md)).
5. Optional, for the Telegram bot: follow [telegram-integration.md → Setup](telegram-integration.md#setup). In short:
   - deploy `supabase/functions/telegram-webhook` with `--no-verify-jwt`
   - set its three secrets
   - run `telegram_setup.py webhook`

> Do **not** run `supabase/tests/supabase_shim.sql` or `supabase/seed.sql` on production. They are for local tests and development.

### Production project `sywmicrngyvojjdayhhc`

Migrations 001–006 were applied in the SQL Editor, so Supabase's migration history does not list them; 007 onwards were applied with the Supabase MCP `apply_migration` tool. Before using `supabase db push` for the first time, mark the earlier ones as applied:

```bash
supabase migration repair --status applied 20260930000001 20260930000002 20260930000003 20260930000004 20260930000005 20260930000006
```

## 2. GitHub repository settings

- **Settings → Pages → Source:** *GitHub Actions*.
- **Settings → Secrets and variables → Actions → New repository secret:**
  - `VITE_SUPABASE_URL` = `https://<ref>.supabase.co`
  - `VITE_SUPABASE_ANON_KEY` = the anon public key

The anon key is designed to be public and ends up in the built JavaScript. It grants nothing beyond what RLS allows. Storing it as a secret just keeps it out of logs. **Never** add the service-role key, the database password or Telegram secrets to GitHub. Telegram secrets belong in Supabase Edge Function secrets only.

## 3. Workflows

| Workflow | Trigger | Steps |
|---|---|---|
| [`ci.yml`](../.github/workflows/ci.yml) | pull requests (and called by deploy) | **web:** `npm ci`, typecheck, lint, unit tests (app + Telegram bot logic), build · **edge-functions:** `deno check` of the webhook · **database:** PostgreSQL 17 service; migrations, RLS, calculations, Telegram and analytics tests (`pytest`) |
| [`deploy.yml`](../.github/workflows/deploy.yml) | push to `main`, manual | runs CI → build with production secrets and `VITE_BASE_PATH=/<repo>/` → upload → deploy to Pages |

A failing test stops the deployment, because `build` depends on `test`.

The Edge Function is **not** deployed by GitHub Actions; that would need a Supabase access token in GitHub. Deploy it with the Supabase CLI, or the Supabase MCP / dashboard, whenever `supabase/functions/` changes.

The site is published at `https://mingminghui.github.io/stock_inventory_system/`. Routes use the hash (`#/stock`), so deep links and refreshes work on GitHub Pages without a 404 workaround.

## 4. Order for a release that changes the database

1. Apply new migrations to Supabase **first**. They are additive, so the currently deployed frontend keeps working.
2. Deploy the Edge Function if it changed.
3. Push to `main`; GitHub Actions tests, builds and deploys the frontend.

## 5. Later schema changes

1. Add a new file `supabase/migrations/<timestamp>_<name>.sql`. Never edit a migration that has already been applied.
2. Run `pytest` locally or in CI; the tests apply every migration to a fresh database.
3. `supabase db push`.
