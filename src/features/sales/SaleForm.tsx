import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { Alert, Money, SearchInput, TextField } from '../../components/ui';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useLoader } from '../../hooks/useLoader';
import { today } from '../../lib/dates';
import { toUserMessage } from '../../lib/errors';
import { describeRule, formatDate, formatMoney, formatQuantity, priceAlertMessage } from '../../lib/format';
import { isMoney, isWholeNumber, parseNumber } from '../../lib/numbers';
import { createSale, previewSaleLine } from '../../services/sales';
import { searchSellableStock } from '../../services/stock';
import type { SalePreview, StockItem } from '../../types/database';

interface Line {
  item: StockItem;
  quantity: number;
  actualPrice: number;
  preview: SalePreview;
}

export function SaleForm({ onClose, onSaved }: { onClose: () => void; onSaved: (priceAlerts: number) => void }) {
  const [saleDate, setSaleDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lines.length === 0) return setError('Add at least one product.');
    if (!saleDate || saleDate > today()) return setError('The sale date cannot be in the future.');
    setBusy(true);
    setError(null);
    try {
      await createSale(
        saleDate,
        lines.map((l) => ({ stockItemId: l.item.id, quantity: l.quantity, actualPrice: l.actualPrice })),
        notes,
      );
      onSaved(lines.filter((l) => l.preview.price_alert).length);
    } catch (e) {
      setError(toUserMessage(e, 'Unable to record the sale. Please try again.'));
      setBusy(false);
    }
  }

  return (
    <Modal title="Record sale" onClose={onClose} wide>
      <form onSubmit={submit} className="sale-form" noValidate>
        <div className="form-row">
          <TextField label="Sale date" type="date" value={saleDate} max={today()} onChange={(e) => setSaleDate(e.target.value)} required />
          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </div>

        <LineEditor saleDate={saleDate} onAdd={(line) => setLines((current) => [...current, line])} />

        <h3>Lines in this sale</h3>
        {lines.length === 0 ? (
          <p className="muted">No products added yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">Sale lines</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="align-right">Qty</th>
                  <th scope="col" className="align-right">Actual price</th>
                  <th scope="col" className="align-right">Revenue</th>
                  <th scope="col" className="align-right">Partner A</th>
                  <th scope="col" className="align-right">Partner B</th>
                  <th scope="col"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, index) => (
                  <tr key={`${l.item.id}-${index}`} className={l.preview.price_alert ? 'row-warn' : undefined}>
                    <td>
                      {l.item.item_code} — {l.item.description}
                    </td>
                    <td className="align-right">{l.quantity}</td>
                    <td className="align-right">{formatMoney(l.actualPrice)}</td>
                    <td className="align-right">{formatMoney(l.preview.revenue)}</td>
                    <td className="align-right">{formatMoney(l.preview.partner_a_share)}</td>
                    <td className="align-right">{formatMoney(l.preview.partner_b_share)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Totals are calculated by the database when the sale is saved, using the partner rule in force on the sale date.
        </p>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || lines.length === 0}>
            {busy ? 'Saving…' : `Save sale (${lines.length} line${lines.length === 1 ? '' : 's'})`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LineEditor({ saleDate, onAdd }: { saleDate: string; onAdd: (line: Line) => void }) {
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search);
  const results = useLoader(() => (term ? searchSellableStock(term) : Promise.resolve([])), term);
  const [item, setItem] = useState<StockItem | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [actualPrice, setActualPrice] = useState('');

  const qty = parseNumber(quantity);
  const price = parseNumber(actualPrice);
  const valid = item !== null && isWholeNumber(qty, { min: 1 }) && isMoney(price);
  const previewKey = useDebouncedValue(valid ? `${item.id}|${qty}|${price}|${saleDate}` : '', 250);
  const preview = useLoader<SalePreview | null>(
    () => {
      if (!previewKey) return Promise.resolve(null);
      const [id, q, p, d] = previewKey.split('|') as [string, string, string, string];
      return previewSaleLine(id, Number(q), Number(p), d);
    },
    previewKey,
    'Unable to calculate this sale.',
  );
  const current = preview.data && previewKey && !preview.loading ? preview.data : null;
  const alertText = current?.price_alert ? priceAlertMessage(current.price_drop_ratio) : null;

  function choose(stock: StockItem) {
    setItem(stock);
    setActualPrice(String(stock.agreed_price));
    setQuantity('1');
    setSearch('');
  }

  function add() {
    if (!item || !current || !valid) return;
    onAdd({ item, quantity: qty, actualPrice: price, preview: current });
    setItem(null);
    setActualPrice('');
    setQuantity('1');
  }

  return (
    <fieldset className="line-editor">
      <legend>Add a product</legend>
      {!item ? (
        <>
          <SearchInput label="Search stock by code, description, brand or category" value={search} onChange={setSearch} />
          {term && (
            <ul className="search-results" aria-live="polite">
              {results.loading && <li className="muted">Searching…</li>}
              {results.error && <li className="form-error">{results.error}</li>}
              {!results.loading && results.data?.length === 0 && <li className="muted">No sellable stock matches “{term}”.</li>}
              {results.data?.map((s) => (
                <li key={s.id}>
                  <button type="button" className="search-result" onClick={() => choose(s)}>
                    <strong>{s.item_code}</strong> {s.description}
                    {s.brand ? ` · ${s.brand}` : ''} · {s.category_name} · {formatMoney(s.agreed_price)} ·{' '}
                    {s.is_non_stock ? 'service' : `${s.quantity} in stock`}
                    {!s.is_non_stock && ` · bought ${formatDate(s.purchased_date)}`}
                    {s.fifo_rank === 1 && s.active_batch_count > 1 && <span className="fifo-first"> · oldest batch — sell first</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="selected-product">
            <div>
              <strong>{item.item_code}</strong> {item.description} {item.brand ? `· ${item.brand}` : ''}
              <div className="muted small">
                {item.category_name} · agreed price {formatMoney(item.agreed_price)} ·{' '}
                {item.is_non_stock ? 'service item' : `${formatQuantity(item.quantity)} in stock`}
              </div>
            </div>
            <button type="button" className="btn btn-small" onClick={() => setItem(null)}>
              Change
            </button>
          </div>
          <div className="form-row">
            <TextField label="Quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
            <TextField
              label="Actual selling price per item (RM)"
              inputMode="decimal"
              value={actualPrice}
              onChange={(e) => setActualPrice(e.target.value)}
              required
              hint={`Agreed price ${formatMoney(item.agreed_price)} — the agreed price itself is never changed by a sale.`}
            />
          </div>
          {!valid && <p className="muted small">Enter a whole quantity of 1 or more and a price like 12.50.</p>}
          {preview.error && previewKey && (
            <p className="form-error" role="alert">
              {preview.error}
            </p>
          )}
          {current && (
            <div className="preview" aria-live="polite">
              {alertText && <Alert tone="warning">{alertText}</Alert>}
              {current.insufficient_stock && (
                <Alert tone="error">Only {current.stock_before} in stock — this line cannot be saved.</Alert>
              )}
              <dl className="preview-grid">
                <div><dt>Stock before → after</dt><dd>{current.is_non_stock ? 'service' : `${current.stock_before} → ${current.stock_after}`}</dd></div>
                <div><dt>Revenue</dt><dd><Money value={current.revenue} strong /></dd></div>
                <div><dt>Cost</dt><dd><Money value={current.total_cost} /></dd></div>
                <div><dt>Gross profit</dt><dd><Money value={current.gross_profit} /></dd></div>
                <div><dt>Rule</dt><dd><code>{current.rule_type}</code> — B gets {describeRule(current.rule_type, current.partner_b_rate)}</dd></div>
                <div><dt>Partner A share (KaLi Motor)</dt><dd><Money value={current.partner_a_share} strong /></dd></div>
                <div><dt>Partner B share (Amin)</dt><dd><Money value={current.partner_b_share} strong /></dd></div>
              </dl>
            </div>
          )}
          <button type="button" className="btn btn-primary" onClick={add} disabled={!current || current.insufficient_stock}>
            Add to sale
          </button>
        </>
      )}
    </fieldset>
  );
}
