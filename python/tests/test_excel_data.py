"""Excel parsing and import tests.

Normaliser tests always run. Workbook tests need data/Workshop_Stocklist_2026.xlsx
(git-ignored, so they are skipped in CI). The round-trip test also needs
TEST_DATABASE_URL.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal as D

import psycopg
import pytest

from scripts import import_excel, validate_import
from workshop.excel_source import (
    DEFAULT_WORKBOOK,
    clean_brand,
    clean_text,
    month_end,
    read_workbook,
    to_date,
    to_decimal,
    to_int,
)

needs_workbook = pytest.mark.skipif(not DEFAULT_WORKBOOK.exists(), reason="workbook not present (git-ignored)")


# ---------------------------------------------------------------------------
# Normalisers
# ---------------------------------------------------------------------------
def test_clean_text_trims_and_collapses():
    assert clean_text("  Car Tyre  155/70R12 ") == "Car Tyre 155/70R12"
    assert clean_text("   ") is None
    assert clean_text(None) is None


def test_brand_nil_means_no_brand():
    assert clean_brand("NIL") is None
    assert clean_brand("ChuanShi ") == "ChuanShi"


def test_money_is_decimal_rounded_half_up():
    assert to_decimal(142.3) == D("142.30")
    assert to_decimal(43 / 24) == D("1.79")
    assert to_decimal(0.125) == D("0.13")
    assert to_decimal("") is None
    with pytest.raises(ValueError):
        to_decimal("LEFTOVER")


def test_integers_reject_fractions():
    assert to_int(3.0) == 3
    assert to_int(-1) == -1
    with pytest.raises(ValueError):
        to_int(2.5)


def test_dates():
    assert to_date(datetime(2026, 8, 29)) == date(2026, 8, 29)
    assert to_date("30/05/2026") == date(2026, 5, 30)  # Sales_Log_202605 stores Checked_Date as text
    assert month_end(2026, 2) == date(2026, 2, 28)


# ---------------------------------------------------------------------------
# Workbook structure
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def workbook():
    if not DEFAULT_WORKBOOK.exists():
        pytest.skip("workbook not present")
    return read_workbook()


@needs_workbook
def test_workbook_has_no_errors(workbook):
    assert workbook.errors == [], [str(e) for e in workbook.errors]


@needs_workbook
def test_expected_sheets(workbook):
    for sheet in ("Stock_Master", "Partner_Summary", "Partner_Rule_Table", "KALI_Inventory_List"):
        assert sheet in workbook.sheet_names
    # Only the August log is imported (decision 2026-09-30).
    assert [s.name for s in workbook.sales_sheets] == ["Sales_Log_202608"]
    assert len(workbook.sales_sheets[0].rows) == 14


@needs_workbook
def test_partner_rules(workbook):
    rules = {r.category: r for r in workbook.rules}
    assert len(rules) == 22
    assert (rules["Car Tyre"].rule_type, rules["Car Tyre"].partner_b_rate, rules["Car Tyre"].partner_a_rate) \
        == ("Fixed_Per_Unit", D("10.0000"), None)
    assert rules["Car Tyre Strip"].rule_type == "Fixed_Per_Job"
    assert rules["Car Tyre Strip"].partner_a_rate == D("0.5000")
    assert rules["Used Car Tyre"].rule_type == "Shared_50"


@needs_workbook
def test_stock_master(workbook):
    assert len(workbook.stock) == 106
    assert sum(r.is_obsolete for r in workbook.stock) == 34
    assert sum(r.is_non_stock for r in workbook.stock) == 6
    assert all(r.quantity >= 0 for r in workbook.stock)


@needs_workbook
def test_partner_summary(workbook):
    s = workbook.summary
    assert s.period == date(2026, 8, 1)
    assert s.grand_total == (D("140.00"), D("1475.00"))
    assert s.total_payment_to_partner_a == D("1894.59")
    assert {a.expense_category: a.amount for a in s.adjustments} == {
        "Employee Salary": D("-100.00"), "Electricity": D("19.59"), "Rental": D("500.00")}


# ---------------------------------------------------------------------------
# Import round trip
# ---------------------------------------------------------------------------
@needs_workbook
def test_import_then_validate_has_no_discrepancies(database_url, workbook):
    with psycopg.connect(database_url) as conn:
        stats, _notes = import_excel.run_import(conn, workbook, replace=True)
        assert stats["partner_rules"] == 23  # 22 from Excel + Car Tyre Strip Shared_50 from 2026-09-01
        assert stats["stock_items"] == 106
        assert stats["stock_snapshots"] == sum(1 for r in workbook.stock if r.snapshots)
        assert stats["sale_lines"] == 14

        rules = conn.execute(
            """select r.rule_type::text, r.effective_from, r.effective_to from public.partner_rules r
               join public.product_categories c on c.id = r.category_id
               where c.name = 'Car Tyre Strip' order by r.effective_from""").fetchall()
        assert rules == [("Fixed_Per_Job", date(2025, 1, 1), date(2026, 8, 31)),
                         ("Shared_50", date(2026, 9, 1), None)]
        recurring = conn.execute("select name, default_amount from public.expense_categories where is_recurring"
                                 ).fetchall()
        assert recurring == [("Employee Salary", D("-100.00"))]

        findings: list[validate_import.Finding] = []
        with conn.cursor() as cur:
            validate_import.check_rules(cur, workbook, findings)
            validate_import.check_stock(cur, workbook, findings)
            validate_import.check_inventory(cur, workbook, findings)
            validate_import.check_sales(cur, workbook, findings)
            validate_import.check_summary(cur, workbook, findings)
        conn.rollback()
    discrepancies = [str(f) for f in findings if f.kind == "DISCREPANCY"]
    assert discrepancies == []
