"""Business-calculation tests using actual rows from Workshop_Stocklist_2026.xlsx.

Each case is (source cell, rule type, Partner B rate, qty, actual price, unit cost)
-> (revenue, total cost, gross profit, Partner A / KALI share, Partner B / A.L share),
with the expected values copied from the workbook's cached results.
"""

from __future__ import annotations

from decimal import Decimal as D

import pytest

EXCEL_CASES = [
    # Sales_Log_202608!R7  BAT-NS40 NS40ZL — Car Battery, Fixed_Per_Unit RM10
    ("Sales_Log_202608!R7", "Fixed_Per_Unit", "10", 2, "195", "142.30", ("390.00", "284.60", "105.40", "370.00", "20.00")),
    # Sales_Log_202608!R4  Battery Charging — Car Battery Besar, Shared_50
    ("Sales_Log_202608!R4", "Shared_50", "0.5", 3, "8", "0", ("24.00", "0.00", "24.00", "12.00", "12.00")),
    # Sales_Log_202608!R5  Battery Charging — Bike Battery, Shared_50 (odd revenue split)
    ("Sales_Log_202608!R5", "Shared_50", "0.5", 1, "3", "0", ("3.00", "0.00", "3.00", "1.50", "1.50")),
    # Sales_Log_202601!R86 Tyre Repair Strip — Car Tyre Strip, Fixed_Per_Job 0.5
    ("Sales_Log_202601!R86", "Fixed_Per_Job", "0.5", 15, "12", "1.60", ("180.00", "24.00", "156.00", "172.50", "7.50")),
    # Sales_Log_202601!R84 Change Tyre — Car Tyre Change Cust, Fixed_Per_Service RM6
    ("Sales_Log_202601!R84", "Fixed_Per_Service", "6", 11, "12", "0", ("132.00", "0.00", "132.00", "66.00", "66.00")),
    # Sales_Log_202601!R51 Car Tyre 155/70R12 — Fixed_Per_Unit RM10, discounted to 130
    ("Sales_Log_202601!R51", "Fixed_Per_Unit", "10", 2, "130", "0", ("260.00", "0.00", "260.00", "240.00", "20.00")),
    # Sales_Log_202601!R2  Battery Water — Fixed_Per_Unit RM1
    ("Sales_Log_202601!R2", "Fixed_Per_Unit", "1", 1, "4", "1.80", ("4.00", "1.80", "2.20", "3.00", "1.00")),
    # Sales_Log_202607!R41 Car Tyre 165/55R14, actual = I41 - 9 = 159 (agreed 168) — Fixed_Per_Unit RM10
    ("Sales_Log_202607!R41", "Fixed_Per_Unit", "10", 1, "159", "100", ("159.00", "100.00", "59.00", "149.00", "10.00")),
]


@pytest.mark.parametrize("ref, rule_type, b_rate, qty, actual, cost, expected", EXCEL_CASES,
                         ids=[c[0] for c in EXCEL_CASES])
def test_calculate_sale_line_matches_excel(db, ref, rule_type, b_rate, qty, actual, cost, expected):
    row = db.execute(
        "select revenue, total_cost, gross_profit, partner_a_share, partner_b_share "
        "from public.calculate_sale_line(%s, %s, %s, %s, %s)",
        (rule_type, D(b_rate), qty, D(actual), D(cost)),
    ).fetchone()
    assert row == tuple(D(v) for v in expected), ref


def test_zero_actual_price_gives_no_partner_b_fee(db):
    # Excel: IF(Actual_Selling_Price<=0, 0, ...) for A.L_Share; KALI gets Revenue - 0 = 0.
    row = db.execute(
        "select revenue, partner_a_share, partner_b_share from public.calculate_sale_line('Fixed_Per_Unit', 4, 2, 0, 0)"
    ).fetchone()
    assert row == (D("0.00"), D("0.00"), D("0.00"))


def test_shared_50_rounds_to_cents_and_shares_sum_to_revenue(db):
    row = db.execute(
        "select revenue, partner_a_share, partner_b_share from public.calculate_sale_line('Shared_50', 0.5, 1, 0.05, 0)"
    ).fetchone()
    revenue, a_share, b_share = row
    assert revenue == D("0.05")
    assert b_share == D("0.03")  # half-up rounding of 0.025
    assert a_share + b_share == revenue


def test_fixed_fee_larger_than_revenue_follows_excel(db):
    # Excel does not cap the fixed fee: KALI_Share = Revenue - A.L_Share may go negative.
    row = db.execute(
        "select partner_a_share, partner_b_share from public.calculate_sale_line('Fixed_Per_Unit', 10, 1, 5, 0)"
    ).fetchone()
    assert row == (D("-5.00"), D("10.00"))


@pytest.mark.parametrize(
    "agreed, actual, expected_ratio, expected_alert",
    [
        ("100", "90", "0.1000", True),    # exactly 10% below -> alert (<=)
        ("100", "90.01", "0.0999", False),
        ("100", "87.5", "0.1250", True),  # spec example: 12.5% below
        ("195", "190", "0.0256", False),  # Sales_Log_202606!R9 discount
        ("100", "120", "-0.2000", False),  # sold above agreed price
        ("0", "10", None, False),          # no agreed price -> no ratio, no alert
    ],
)
def test_price_drop_check(db, agreed, actual, expected_ratio, expected_alert):
    ratio, alert = db.execute(
        "select drop_ratio, is_alert from public.price_drop_check(%s, %s, 0.10)", (D(agreed), D(actual))
    ).fetchone()
    assert ratio == (None if expected_ratio is None else D(expected_ratio))
    assert alert is expected_alert
