"""Read and normalise data/Workshop_Stocklist_2026.xlsx.

The workbook is opened read-only twice: once for cached values and once for
formulas (formulas are only used to flag suspicious cells). Nothing is written
back to the file.

See docs/excel-data-model.md for the sheet-by-sheet mapping.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from openpyxl import load_workbook
from openpyxl.worksheet.worksheet import Worksheet

DEFAULT_WORKBOOK = Path(__file__).resolve().parents[2] / "data" / "Workshop_Stocklist_2026.xlsx"

RULE_TYPES = ("Fixed_Per_Unit", "Fixed_Per_Job", "Fixed_Per_Service", "Shared_50")
NON_STOCK_QUANTITY = -1  # Excel sentinel for service / non-stock items
NO_BRAND = "NIL"

REQUIRED_SHEETS = ("Partner_Rule_Table", "Stock_Master", "KALI_Inventory_List", "Partner_Summary")
SALES_LOG_PATTERN = re.compile(r"^Sales_Log_(\d{4})(\d{2})$")

# Only the August 2026 log is imported (business decision, 2026-09-30). Earlier
# monthly logs and the legacy sheets (KALI_Stock, Stock_Archiv, Stock_Master_01,
# Stock_Master_Pricelist) are not read.
IMPORT_SALES_SHEET = "Sales_Log_202608"

# Stock_Master snapshot column imported as the August month-end count.
SNAPSHOT_COLUMNS: dict[str, date] = {
    "Qty_29082026": date(2026, 8, 29),
}

# Sales_Log header names changed month to month.
SALES_QTY_HEADERS = ("Quantity_Sold", "Current_Sales_Quantity", "sales", "Current_Sales")

# Partner_Summary adjustment labels -> expense category (documented assumption).
EXPENSE_LABELS: dict[str, str] = {
    "gaji anol": "Employee Salary",
    "bil api": "Electricity",
    "rental": "Rental",
}

CENT = Decimal("0.01")


# ---------------------------------------------------------------------------
# Value normalisation
# ---------------------------------------------------------------------------
def clean_text(value: Any) -> str | None:
    """Trim and collapse internal whitespace; empty -> None."""
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def clean_brand(value: Any) -> str | None:
    text = clean_text(value)
    return None if text is None or text.upper() == NO_BRAND else text


def to_decimal(value: Any, places: Decimal = CENT) -> Decimal | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, bool):
        raise ValueError(f"expected a number, got {value!r}")
    try:
        number = Decimal(str(value).strip()) if isinstance(value, str) else Decimal(repr(value))
    except InvalidOperation as exc:
        raise ValueError(f"expected a number, got {value!r}") from exc
    return number.quantize(places, rounding=ROUND_HALF_UP)


def to_int(value: Any) -> int | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    number = to_decimal(value, Decimal("0.0001"))
    assert number is not None
    if number != number.to_integral_value():
        raise ValueError(f"expected a whole number, got {value!r}")
    return int(number)


def to_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
            try:
                return datetime.strptime(value.strip(), fmt).date()
            except ValueError:
                continue
    raise ValueError(f"expected a date, got {value!r}")


def month_end(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------
@dataclass
class Issue:
    level: str  # "error" | "warning"
    location: str
    message: str

    def __str__(self) -> str:
        return f"[{self.level.upper()}] {self.location}: {self.message}"


@dataclass
class PartnerRule:
    ref: str
    category: str
    rule_type: str
    partner_b_rate: Decimal
    partner_a_rate: Decimal | None  # None = LEFTOVER
    notes: str | None


@dataclass(frozen=True)
class ProductKey:
    item_code: str
    description: str
    brand: str | None
    category: str

    def lookup(self) -> tuple[str, str, str, str]:
        return (self.item_code, self.description.lower(), (self.brand or "").lower(), self.category.lower())


@dataclass
class StockRow:
    ref: str
    row: int
    legacy_id: int | None
    product: ProductKey
    is_non_stock: bool
    quantity: int
    unit_cost: Decimal
    agreed_price: Decimal
    purchased_date: date | None
    is_obsolete: bool
    snapshots: dict[date, tuple[str, int]] = field(default_factory=dict)
    unit: str | None = None


@dataclass
class InventoryRow:
    ref: str
    name: str
    brand: str | None
    quantity: int


@dataclass
class SalesRow:
    ref: str
    sheet: str
    row: int
    sale_date: date
    product: ProductKey
    purchased_date: date | None
    unit_cost: Decimal
    agreed_price: Decimal
    actual_price: Decimal
    quantity: int
    stock_before: int | None
    stock_after: int | None
    checked_date: date | None
    # Cached Excel results, used only for validation
    excel_revenue: Decimal | None
    excel_cost: Decimal | None
    excel_gross_profit: Decimal | None
    excel_rule_type: str | None
    excel_partner_a_share: Decimal | None
    excel_partner_b_share: Decimal | None


@dataclass
class SalesSheet:
    name: str
    period: date  # first day of month
    header_row: int
    rows: list[SalesRow]
    non_sale_rows: int


@dataclass
class SummaryAdjustment:
    ref: str
    label: str
    expense_category: str
    amount: Decimal
    base_amount: Decimal | None
    share_ratio: Decimal | None


@dataclass
class PartnerSummary:
    period: date
    by_category: dict[str, tuple[Decimal, Decimal]]  # category -> (A.L_Share, KALI_Share)
    grand_total: tuple[Decimal, Decimal]
    adjustments: list[SummaryAdjustment]
    total_payment_to_partner_a: Decimal | None


@dataclass
class Workbook:
    path: Path
    sheet_names: list[str]
    rules: list[PartnerRule]
    stock: list[StockRow]
    inventory: list[InventoryRow]
    sales_sheets: list[SalesSheet]
    summary: PartnerSummary | None
    issues: list[Issue]

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "warning"]


# ---------------------------------------------------------------------------
# Sheet helpers
# ---------------------------------------------------------------------------
def _header_map(ws: Worksheet, row: int) -> dict[str, int]:
    headers: dict[str, int] = {}
    for col in range(1, ws.max_column + 1):
        text = clean_text(ws.cell(row, col).value)
        if text and text not in headers:
            headers[text] = col
    return headers


def _find_header_row(ws: Worksheet, marker: str, max_scan: int = 10) -> int | None:
    for row in range(1, max_scan + 1):
        for col in range(1, min(ws.max_column, 30) + 1):
            if clean_text(ws.cell(row, col).value) == marker:
                return row
    return None


def _require(headers: dict[str, int], names: tuple[str, ...], where: str, issues: list[Issue]) -> bool:
    missing = [n for n in names if n not in headers]
    for name in missing:
        issues.append(Issue("error", where, f"required column '{name}' not found"))
    return not missing


class _Reader:
    """Collects conversion errors as issues instead of raising."""

    def __init__(self, issues: list[Issue]):
        self.issues = issues

    def convert(self, fn, value: Any, location: str, *, level: str = "error"):
        try:
            return fn(value)
        except ValueError as exc:
            self.issues.append(Issue(level, location, str(exc)))
            return None


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------
def _parse_rules(ws: Worksheet, issues: list[Issue]) -> list[PartnerRule]:
    headers = _header_map(ws, 1)
    needed = ("Product Type", "Rule Type", "Partner B Rate (Amin)", "Partner A Rate (KaLi Motor)", "Notes")
    if not _require(headers, needed, "Partner_Rule_Table!1", issues):
        return []
    reader = _Reader(issues)
    rules: list[PartnerRule] = []
    seen: dict[str, str] = {}
    for r in range(2, ws.max_row + 1):
        category = clean_text(ws.cell(r, headers["Product Type"]).value)
        if not category:
            continue
        ref = f"Partner_Rule_Table!R{r}"
        rule_type = clean_text(ws.cell(r, headers["Rule Type"]).value)
        if rule_type not in RULE_TYPES:
            issues.append(Issue("error", ref, f"unknown rule type {rule_type!r}"))
            continue
        b_rate = reader.convert(lambda v: to_decimal(v, Decimal("0.0001")),
                                ws.cell(r, headers["Partner B Rate (Amin)"]).value, ref)
        raw_a = ws.cell(r, headers["Partner A Rate (KaLi Motor)"]).value
        a_rate = None
        if clean_text(raw_a) and str(raw_a).strip().upper() != "LEFTOVER":
            a_rate = reader.convert(lambda v: to_decimal(v, Decimal("0.0001")), raw_a, ref)
        if b_rate is None:
            issues.append(Issue("error", ref, "Partner B rate is missing"))
            continue
        key = category.lower()
        if key in seen:
            issues.append(Issue("error", ref, f"duplicate category {category!r} (also {seen[key]})"))
            continue
        seen[key] = ref
        rules.append(PartnerRule(ref, category, rule_type, b_rate, a_rate,
                                 clean_text(ws.cell(r, headers["Notes"]).value)))
    return rules


def _parse_stock(ws: Worksheet, wf: Worksheet, issues: list[Issue]) -> list[StockRow]:
    header_row = _find_header_row(ws, "Item_Code")
    if header_row is None:
        issues.append(Issue("error", "Stock_Master", "header row with 'Item_Code' not found"))
        return []
    headers = _header_map(ws, header_row)
    needed = ("ID", "Item_Code", "Description", "Brand", "Category", "Current_Quantity",
              "Cost (RM)", "Selling_Price (RM)", "Purchased_Date", "Obsolete")
    if not _require(headers, needed, f"Stock_Master!{header_row}", issues):
        return []
    for name in SNAPSHOT_COLUMNS:
        if name not in headers:
            issues.append(Issue("warning", "Stock_Master", f"snapshot column '{name}' not found"))

    reader = _Reader(issues)
    rows: list[StockRow] = []
    for r in range(header_row + 1, ws.max_row + 1):
        code = clean_text(ws.cell(r, headers["Item_Code"]).value)
        if not code:
            continue
        ref = f"Stock_Master!R{r}"
        g = lambda name: ws.cell(r, headers[name]).value  # noqa: E731
        description = clean_text(g("Description"))
        category = clean_text(g("Category"))
        if not description or not category:
            issues.append(Issue("error", ref, "description and category are required"))
            continue
        qty = reader.convert(to_int, g("Current_Quantity"), ref)
        cost = reader.convert(to_decimal, g("Cost (RM)"), ref)
        price = reader.convert(to_decimal, g("Selling_Price (RM)"), ref)
        purchased = reader.convert(to_date, g("Purchased_Date"), ref, level="warning")
        if qty is None or cost is None or price is None:
            issues.append(Issue("error", ref, "quantity, cost and selling price are required"))
            continue
        if g("Purchased_Date") in (None, ""):
            issues.append(Issue("warning", ref, "Purchased_Date is blank"))
        if isinstance(wf.cell(r, headers["Cost (RM)"]).value, str) and str(
                wf.cell(r, headers["Cost (RM)"]).value).startswith("="):
            issues.append(Issue("warning", ref,
                                f"Cost is a formula {wf.cell(r, headers['Cost (RM)']).value!r}; cached value {cost} used"))
        is_non_stock = qty == NON_STOCK_QUANTITY
        if qty < 0 and not is_non_stock:
            issues.append(Issue("error", ref, f"negative quantity {qty}"))
            continue
        obsolete_raw = g("Obsolete")
        snapshots: dict[date, tuple[str, int]] = {}
        for name, snap_date in SNAPSHOT_COLUMNS.items():
            if name in headers:
                snap = reader.convert(to_int, ws.cell(r, headers[name]).value, f"{ref}:{name}", level="warning")
                if snap is not None:
                    snapshots[snap_date] = (name, snap)
        rows.append(StockRow(
            ref=ref,
            row=r,
            legacy_id=reader.convert(to_int, g("ID"), ref, level="warning"),
            product=ProductKey(code.upper(), description, clean_brand(g("Brand")), category),
            is_non_stock=is_non_stock,
            quantity=0 if is_non_stock else qty,
            unit_cost=cost,
            agreed_price=price,
            purchased_date=purchased,
            is_obsolete=to_int(obsolete_raw) == 1 if obsolete_raw not in (None, "") else False,
            snapshots=snapshots,
        ))
    return rows


def _parse_inventory(ws: Worksheet, issues: list[Issue]) -> list[InventoryRow]:
    headers = _header_map(ws, 1)
    if not _require(headers, ("Machine/Equipment", "Brand/Color", "Quantity"), "KALI_Inventory_List!1", issues):
        return []
    reader = _Reader(issues)
    rows: list[InventoryRow] = []
    for r in range(2, ws.max_row + 1):
        name = clean_text(ws.cell(r, headers["Machine/Equipment"]).value)
        if not name:
            continue
        ref = f"KALI_Inventory_List!R{r}"
        qty = reader.convert(to_int, ws.cell(r, headers["Quantity"]).value, ref)
        if qty is None or qty < 0:
            issues.append(Issue("error", ref, "quantity must be a whole number >= 0"))
            continue
        rows.append(InventoryRow(ref, name, clean_text(ws.cell(r, headers["Brand/Color"]).value), qty))
    return rows


def _parse_sales_sheet(name: str, ws: Worksheet, wf: Worksheet, issues: list[Issue]) -> SalesSheet | None:
    match = SALES_LOG_PATTERN.match(name)
    assert match
    year, month = int(match.group(1)), int(match.group(2))
    header_row = _find_header_row(ws, "Item_Code")
    if header_row is None:
        issues.append(Issue("error", name, "header row with 'Item_Code' not found"))
        return None
    headers = _header_map(ws, header_row)
    qty_header = next((h for h in SALES_QTY_HEADERS if h in headers), None)
    if qty_header is None:
        issues.append(Issue("error", name, f"no quantity-sold column (looked for {', '.join(SALES_QTY_HEADERS)})"))
        return None
    needed = ("Item_Code", "Description", "Brand", "Category", "Current_Quantity", "Cost (RM)",
              "Selling_Price (RM)", "Actual_Selling_Price")
    if not _require(headers, needed, f"{name}!{header_row}", issues):
        return None

    reader = _Reader(issues)
    rows: list[SalesRow] = []
    non_sale = 0
    qty_col = headers[qty_header]
    price_col = headers["Actual_Selling_Price"]

    # Descriptions by (code, brand, category) within this sheet, to repair rows
    # where the description cell was left blank.
    known_descriptions: dict[tuple, set[str]] = {}
    for r in range(header_row + 1, ws.max_row + 1):
        code = clean_text(ws.cell(r, headers["Item_Code"]).value)
        desc = clean_text(ws.cell(r, headers["Description"]).value)
        if code and desc:
            key = (code.upper(), clean_brand(ws.cell(r, headers["Brand"]).value),
                   clean_text(ws.cell(r, headers["Category"]).value))
            known_descriptions.setdefault(key, set()).add(desc)

    for r in range(header_row + 1, ws.max_row + 1):
        code = clean_text(ws.cell(r, headers["Item_Code"]).value)
        if not code:
            continue
        ref = f"{name}!R{r}"
        g = lambda h: ws.cell(r, headers[h]).value if h in headers else None  # noqa: E731
        qty = reader.convert(to_int, g(qty_header), ref)
        if qty is None or qty == 0:
            non_sale += 1
            continue
        if qty < 0:
            issues.append(Issue("error", ref, f"negative quantity sold {qty}"))
            continue
        description = clean_text(g("Description"))
        category = clean_text(g("Category"))
        if not description and category:
            candidates = known_descriptions.get((code.upper(), clean_brand(g("Brand")), category), set())
            if len(candidates) == 1:
                description = next(iter(candidates))
                issues.append(Issue("warning", ref, f"Description blank; {description!r} taken from the same item code"))
        if not description or not category:
            issues.append(Issue("error", ref, "description and category are required"))
            continue
        agreed = reader.convert(to_decimal, g("Selling_Price (RM)"), ref)
        actual = reader.convert(to_decimal, g("Actual_Selling_Price"), ref)
        cost = reader.convert(to_decimal, g("Cost (RM)"), ref)
        if actual is None:
            issues.append(Issue("warning", ref, f"Actual_Selling_Price blank; agreed price {agreed} used"))
            actual = agreed
        if agreed is None and actual is not None:
            issues.append(Issue("warning", ref, f"Selling_Price blank; actual price {actual} used as agreed price"))
            agreed = actual
        if cost is None:
            issues.append(Issue("warning", ref, "Cost (RM) blank; 0 used"))
            cost = Decimal("0.00")
        if agreed is None or actual is None:
            issues.append(Issue("error", ref, "selling price is required"))
            continue
        price_formula = wf.cell(r, price_col).value
        qty_letter = ws.cell(r, qty_col).column_letter
        multiplies_qty = rf"(\*\s*\$?{qty_letter}\$?{r}\b|\b\$?{qty_letter}\$?{r}\s*\*)"
        if isinstance(price_formula, str) and re.search(multiplies_qty, price_formula):
            issues.append(Issue("warning", ref,
                                f"Actual_Selling_Price formula {price_formula!r} multiplies by the quantity; "
                                f"revenue in Excel is therefore price x qty^2"))
        current = reader.convert(to_int, g("Current_Quantity"), ref, level="warning")
        after = reader.convert(to_int, g("After_Sales_Quantity"), ref, level="warning")
        non_stock = current == NON_STOCK_QUANTITY
        rows.append(SalesRow(
            ref=ref, sheet=name, row=r,
            sale_date=month_end(year, month),
            product=ProductKey(code.upper(), description, clean_brand(g("Brand")), category),
            purchased_date=reader.convert(to_date, g("Purchased_Date"), ref, level="warning"),
            unit_cost=cost, agreed_price=agreed, actual_price=actual, quantity=qty,
            stock_before=None if non_stock else current,
            stock_after=None if non_stock else after,
            checked_date=reader.convert(to_date, g("Checked_Date"), ref, level="warning"),
            excel_revenue=reader.convert(to_decimal, g("Revenue_Per_Sales"), ref, level="warning"),
            excel_cost=reader.convert(to_decimal, g("Cost_Per_Sale"), ref, level="warning"),
            excel_gross_profit=reader.convert(to_decimal, g("Gross_Profit"), ref, level="warning"),
            excel_rule_type=clean_text(g("RuleType")),
            excel_partner_a_share=reader.convert(to_decimal, g("KALI_Share"), ref, level="warning"),
            excel_partner_b_share=reader.convert(to_decimal, g("A.L_Share"), ref, level="warning"),
        ))
    return SalesSheet(name, date(year, month, 1), header_row, rows, non_sale)


def _parse_summary(ws: Worksheet, wf: Worksheet, issues: list[Issue]) -> PartnerSummary | None:
    header = None
    for r in range(1, ws.max_row + 1):
        for c in range(1, ws.max_column + 1):
            if clean_text(ws.cell(r, c).value) == "SUM of A.L_Share":
                header = (r, c)
                break
        if header:
            break
    if header is None:
        issues.append(Issue("error", "Partner_Summary", "'SUM of A.L_Share' header not found"))
        return None
    hr, b_col = header
    cat_col, a_col = b_col - 1, b_col + 1
    period_raw = ws.cell(hr - 1, b_col).value
    period = to_date(period_raw) if period_raw else None
    if period is None:
        issues.append(Issue("error", f"Partner_Summary!R{hr - 1}", "period date not found above the summary"))
        return None
    period = period.replace(day=1)

    reader = _Reader(issues)
    by_category: dict[str, tuple[Decimal, Decimal]] = {}
    grand: tuple[Decimal, Decimal] | None = None
    adjustments: list[SummaryAdjustment] = []
    total_payment = None
    r = hr + 1
    while r <= ws.max_row:
        label = clean_text(ws.cell(r, cat_col).value)
        b_val = ws.cell(r, b_col).value
        a_val = ws.cell(r, a_col).value
        ref = f"Partner_Summary!R{r}"
        if grand is None:
            if label == "Grand Total":
                grand = (to_decimal(b_val) or Decimal(0), to_decimal(a_val) or Decimal(0))
            elif label:
                by_category[label] = (reader.convert(to_decimal, b_val, ref) or Decimal(0),
                                      reader.convert(to_decimal, a_val, ref) or Decimal(0))
        else:
            text = clean_text(b_val)
            if text and text.lower().startswith("total payment"):
                total_payment = reader.convert(to_decimal, a_val, ref)
            elif text and a_val is not None:
                amount = reader.convert(to_decimal, a_val, ref)
                if amount is None:
                    r += 1
                    continue
                base = ratio = None
                formula = wf.cell(r, a_col).value
                m = re.fullmatch(r"=\s*([0-9.]+)\s*\*\s*([0-9.]+)\s*", str(formula)) if formula else None
                if m:
                    base, ratio = Decimal(m.group(1)), Decimal(m.group(2))
                category = EXPENSE_LABELS.get(text.lower())
                if category is None:
                    category = text
                    issues.append(Issue("warning", ref, f"unmapped adjustment label {text!r}; used as category name"))
                adjustments.append(SummaryAdjustment(ref, text, category, amount, base, ratio))
        r += 1
    if grand is None:
        issues.append(Issue("error", "Partner_Summary", "'Grand Total' row not found"))
        return None
    return PartnerSummary(period, by_category, grand, adjustments, total_payment)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def read_workbook(path: Path = DEFAULT_WORKBOOK, sales_sheet: str = IMPORT_SALES_SHEET) -> Workbook:
    if not path.exists():
        raise FileNotFoundError(f"Workbook not found: {path}")
    values = load_workbook(path, data_only=True, read_only=False)
    formulas = load_workbook(path, data_only=False, read_only=False)
    issues: list[Issue] = []

    for sheet in REQUIRED_SHEETS:
        if sheet not in values.sheetnames:
            issues.append(Issue("error", path.name, f"required sheet '{sheet}' is missing"))
    if not SALES_LOG_PATTERN.match(sales_sheet):
        raise ValueError(f"{sales_sheet!r} is not a Sales_Log_YYYYMM sheet name")
    sales_names = [sales_sheet] if sales_sheet in values.sheetnames else []
    if not sales_names:
        issues.append(Issue("error", path.name, f"sales sheet '{sales_sheet}' is missing"))

    def both(name: str) -> tuple[Worksheet, Worksheet] | None:
        return (values[name], formulas[name]) if name in values.sheetnames else None

    rules = _parse_rules(values["Partner_Rule_Table"], issues) if both("Partner_Rule_Table") else []
    stock = _parse_stock(*both("Stock_Master"), issues) if both("Stock_Master") else []
    inventory = _parse_inventory(values["KALI_Inventory_List"], issues) if both("KALI_Inventory_List") else []
    sales = [s for n in sales_names if (s := _parse_sales_sheet(n, values[n], formulas[n], issues))]
    summary = _parse_summary(*both("Partner_Summary"), issues) if both("Partner_Summary") else None
    if summary and sales and summary.period != sales[0].period:
        issues.append(Issue("error", "Partner_Summary",
                            f"summary period {summary.period} does not match {sales[0].name}"))

    rule_categories = {r.category.lower() for r in rules}
    for row in stock:
        if row.product.category.lower() not in rule_categories:
            issues.append(Issue("error", row.ref, f"category {row.product.category!r} has no partner rule"))
    for sheet in sales:
        for row in sheet.rows:
            if row.product.category.lower() not in rule_categories:
                issues.append(Issue("error", row.ref, f"category {row.product.category!r} has no partner rule"))

    return Workbook(path, list(values.sheetnames), rules, stock, inventory, sales, summary, issues)
