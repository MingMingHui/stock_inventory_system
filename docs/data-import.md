# Excel data import

The import loads `data/Workshop_Stocklist_2026.xlsx` into an **empty** database once, after the migrations. From then on, the database is the source of truth.

## What is imported

Partner rules, Stock_Master (current stock + the 29 Aug 2026 count), KALI_Inventory_List, **Sales_Log_202608** and the August Partner_Summary adjustments. Earlier monthly logs and legacy sheets are not imported (decision 2026-09-30). The full mapping is in [excel-data-model.md](excel-data-model.md).

## Steps

```bash
cd python
pip install -r requirements.txt           # in a virtual environment
export DATABASE_URL='postgresql://…'      # see user-management.md; never commit

python scripts/import_excel.py --dry-run  # 1. parse + validate the workbook only
python scripts/import_excel.py            # 2. import (refuses if products already exist)
python scripts/validate_import.py         # 3. compare Excel ↔ database, exit code 1 on discrepancies
```

`--replace` wipes business data (not users or settings) and re-imports. `--skip-invalid` imports even when rows have errors; they are listed and skipped, never silently dropped.

## Behaviour

- **One transaction:** the import either completes or changes nothing.
- **Validation:** required sheets and columns, data types, duplicate rules, and categories without a rule.
- **Normalisation:** trimmed text, `NIL` → no brand, `-1` → service item, cached values for formula cells.
- **Recalculation:** August sale lines are recalculated by `calculate_sale_line()`. `validate_import.py` compares every line and the Partner_Summary totals with Excel.
- **Traceability:** every imported row keeps `legacy_ref` (e.g. `Stock_Master!R42`, `Sales_Log_202608!R7`), and the audit log records the actor `import_excel.py`.

## Output from the real workbook (2026-09-30)

```text
Import completed

Partner rules:        23      (22 from Excel + Car Tyre Strip Shared_50 from 2026-09-01)
Categories:           22
Products:             78
Stock records:        106
Stock snapshots:      73
Inventory records:    6
Sales (monthly logs): 1
Sale lines:           14
Expense categories:   3
Operating expenses:   3

Warnings: 11
Errors: 0
```

The warnings are listed in full on screen:
- `Stock_Master!R21` has a formula for its cost (`=320/2`).
- `Stock_Master!R97` has no purchase date.
- The Car Tyre Strip rule changes on 2026-09-01.
- Eight August lines match several purchase batches and are linked to the product only.

`validate_import.py` result: **PASS, 0 discrepancies**. The August payable to KaLi Motor is 1894.59, the same as Excel.

## Tests

```bash
cd python
export TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/postgres'   # a throw-away server
pytest -q
```

The data tests (workbook structure + import round trip) run automatically when the workbook is present. The workbook is git-ignored, so CI skips them.
