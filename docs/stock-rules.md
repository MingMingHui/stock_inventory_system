# Stock rules: FIFO selection and automatic obsolete

Implemented in [`…009_stock_auto_obsolete_and_fifo.sql`](../supabase/migrations/20261001000009_stock_auto_obsolete_and_fifo.sql). These rules are enforced in the database, so the web app, the Telegram bot and any script behave the same way.

## Terms

- **Product (item):** item code + description + brand + category. `BAT-CHARGE` "Battery Charging" for *Car Battery Kecil* and for *Car Battery Besar* are different products, because they have different prices and partner rules.
- **Stock batch (Stock Master row):** one purchase of a product, with its own purchase date, cost, agreed price and quantity.
- **Duplicated stock:** several batches of the same product with different purchase dates. Batches are **never merged**; each stays individually traceable through `stock_adjustments` and `audit_logs`.

## FIFO (earliest purchase first)

The default order for batches of the same product is:

```text
purchase_date ASC, undated batches last, then creation time
```

| Where | Behaviour |
|---|---|
| Stock Master | Within the chosen sort, batches of the same item are listed earliest purchase first. When an item has several active batches, the oldest is marked **"FIFO: use first"** and the others "FIFO n of m". |
| Web sale form | Search results list each item's batches in FIFO order; the oldest shows **"oldest batch — sell first"**. |
| Telegram `/sale`, `/stock_adjust` | Batches are listed oldest first, and the first is marked ⭐. For sales, only batches that still have stock are offered. |
| Database | `stock_items_view.fifo_rank` (1 = oldest active batch) and `active_batch_count`; `tg_list_batches()` returns FIFO order. |

FIFO is the **default, not a lock**. The user can always pick another valid batch explicitly. The system never moves stock between batches silently.

## Automatic obsolete rule

Applied by a trigger after every insert, quantity change or purchase-date change of a batch:

1. Take the **earliest active dated batch** of the product.
2. If its quantity is **0** **and** a **newer active batch** (later purchase date) exists, mark it `OBSOLETE` with `obsolete_remarks = 'auto-rule obsolete'`.
3. Repeat with the next earliest batch. Stop at the first batch that has stock, or when no newer batch exists.

Example:

| Purchase date | Qty | Result |
|---|---|---|
| 2026-01-01 | 0 | **OBSOLETE** (auto-rule obsolete) |
| 2026-02-01 | 10 | ACTIVE |
| 2026-03-01 | 5 | ACTIVE |

| Case | Result |
|---|---|
| Older batch has stock | stays ACTIVE |
| Newer batch is empty, older has stock | nothing retired; the newest batch is never retired because of an older one |
| Several leading empty batches | all of them are retired, oldest first |
| Selling the oldest batch down to 0 while a newer batch exists | retired automatically in the same transaction as the sale |
| Service items (`-1` in Excel) and undated batches | ignored by the rule |

### Remarks and history

`stock_items.obsolete_remarks` records why a batch is obsolete:

| Value | Meaning |
|---|---|
| `auto-rule obsolete` | retired by the database rule |
| `manual` | marked obsolete by a user |
| empty | imported as obsolete from Excel (`Obsolete = 1`) |

Existing `notes` are **not** overwritten. Quantities and history are untouched. The audit log records each change: who or what caused it, and old and new values.

### Reactivation

If stock is **returned** to a batch that the rule retired (for example, a voided sale), it is reactivated automatically and the remark is cleared. Batches obsoleted **manually** are never reactivated automatically. Restoring an auto-retired batch by hand while it is still empty only lasts until the rule next runs for that product. To keep it, receive stock into it.

## Line-level void and stock

Voiding a sale line returns **only that line's** quantity to **its own** batch, in one transaction. The void also writes a `sale_void` adjustment and an audit row. Imported Excel sales never reduced stock, so voiding them changes no quantities.

## Concurrency

- Sales lock the affected batch rows. Web and Telegram sales of the same batch are serialized, and the database re-checks availability at commit time, so stock is never oversold.
- Adjustments carry the quantity the user saw (`expected_quantity`). If it changed meanwhile, the change is refused ("refresh and try again").
