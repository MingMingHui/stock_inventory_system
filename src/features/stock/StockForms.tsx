import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { CheckboxField, SelectField, TextField } from '../../components/ui';
import { today } from '../../lib/dates';
import { toUserMessage } from '../../lib/errors';
import { formatQuantity } from '../../lib/format';
import { isMoney, isWholeNumber, parseNumber } from '../../lib/numbers';
import { addStockItem, adjustStock, setMinQuantity, updateStockDetails } from '../../services/stock';
import type { ProductCategory, StockItem } from '../../types/database';

interface FormShellProps {
  title: string;
  error: string | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  children: React.ReactNode;
}

function FormShell({ title, error, busy, submitLabel, onSubmit, onClose, children }: FormShellProps) {
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={onSubmit} className="form-grid" noValidate>
        {children}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function useSubmit(onSaved: () => void, fallback: string) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (e) {
      setError(toUserMessage(e, fallback));
      setBusy(false);
    }
  }
  return { error, setError, busy, submit };
}

// ---------------------------------------------------------------------------
export function AddStockForm({
  categories,
  onClose,
  onSaved,
}: {
  categories: ProductCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState('');
  const [itemCode, setItemCode] = useState('');
  const [description, setDescription] = useState('');
  const [brand, setBrand] = useState('');
  const [unit, setUnit] = useState('pcs');
  const [isNonStock, setIsNonStock] = useState(false);
  const [purchasedDate, setPurchasedDate] = useState(today());
  const [unitCost, setUnitCost] = useState('');
  const [agreedPrice, setAgreedPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [minQuantity, setMinQty] = useState('');
  const [notes, setNotes] = useState('');
  const { error, setError, busy, submit } = useSubmit(onSaved, 'Unable to add the stock item.');

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const cost = parseNumber(unitCost);
    const price = parseNumber(agreedPrice);
    const qty = isNonStock ? 0 : parseNumber(quantity);
    const min = parseNumber(minQuantity);
    if (!categoryId) return setError('Choose a product category.');
    if (!itemCode.trim() || !description.trim()) return setError('Item code and description are required.');
    if (!isMoney(cost) || !isMoney(price)) return setError('Cost and agreed price must be amounts like 12.50.');
    if (!isWholeNumber(qty)) return setError('Quantity must be a whole number, zero or more.');
    if (min !== null && !isWholeNumber(min)) return setError('Minimum quantity must be a whole number.');
    if (purchasedDate > today()) return setError('The purchase date cannot be in the future.');
    void submit(() =>
      addStockItem({
        categoryId,
        itemCode,
        description,
        brand,
        unit,
        isNonStock,
        purchasedDate,
        unitCost: cost,
        agreedPrice: price,
        quantity: qty,
        minQuantity: min,
        notes,
      }),
    );
  }

  return (
    <FormShell title="Add stock" error={error} busy={busy} submitLabel="Add stock" onSubmit={onSubmit} onClose={onClose}>
      <SelectField label="Product category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
        <option value="">Choose…</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Item code (SKU)"
        value={itemCode}
        onChange={(e) => setItemCode(e.target.value)}
        required
        maxLength={60}
        hint="An existing code + description + brand adds a new batch of that product."
      />
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={200} />
      <TextField label="Brand" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
      <TextField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} />
      <CheckboxField
        label="Service / non-stock item"
        checked={isNonStock}
        onChange={setIsNonStock}
        hint="e.g. battery charging or tyre change — quantity is not tracked."
      />
      <TextField label="Purchase date" type="date" value={purchasedDate} onChange={(e) => setPurchasedDate(e.target.value)} max={today()} />
      <TextField label="Unit cost (RM)" inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} required />
      <TextField label="Agreed selling price (RM)" inputMode="decimal" value={agreedPrice} onChange={(e) => setAgreedPrice(e.target.value)} required />
      {!isNonStock && (
        <>
          <TextField label="Quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          <TextField
            label="Minimum quantity"
            inputMode="numeric"
            value={minQuantity}
            onChange={(e) => setMinQty(e.target.value)}
            hint="Blank = use the default low-stock threshold."
          />
        </>
      )}
      <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
const ADJUSTMENTS = {
  receive: { label: 'Receive new stock', qtyLabel: 'Quantity received', verb: 'adds to' },
  stock_check: { label: 'Stock check (physical count)', qtyLabel: 'Counted quantity', verb: 'replaces' },
  amendment: { label: 'Amend / correct quantity', qtyLabel: 'Correct quantity', verb: 'replaces' },
} as const;
type AdjustmentKind = keyof typeof ADJUSTMENTS;

export function AdjustStockForm({ item, onClose, onSaved }: { item: StockItem; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<AdjustmentKind>('stock_check');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const { error, setError, busy, submit } = useSubmit(onSaved, 'Unable to save stock quantity. Please try again.');
  const qty = parseNumber(quantity);
  const resulting = qty === null || Number.isNaN(qty) ? null : kind === 'receive' ? item.quantity + qty : qty;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isWholeNumber(qty, { min: kind === 'receive' ? 1 : 0 }))
      return setError(kind === 'receive' ? 'Enter how many units were received (1 or more).' : 'Enter a whole number, zero or more.');
    if (!reason.trim()) return setError('Enter a reason for this change.');
    // expected quantity = what the user saw; the database rejects the change if it moved meanwhile.
    void submit(() => adjustStock(item.id, kind, qty, reason, item.quantity));
  }

  return (
    <FormShell title={`Adjust ${item.item_code}`} error={error} busy={busy} submitLabel="Save" onSubmit={onSubmit} onClose={onClose}>
      <p className="muted">
        {item.description} — current quantity <strong>{formatQuantity(item.quantity)}</strong>
      </p>
      <SelectField label="Type of change" value={kind} onChange={(e) => setKind(e.target.value as AdjustmentKind)}>
        {Object.entries(ADJUSTMENTS).map(([value, meta]) => (
          <option key={value} value={value}>
            {meta.label}
          </option>
        ))}
      </SelectField>
      <TextField
        label={ADJUSTMENTS[kind].qtyLabel}
        inputMode="numeric"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        required
        hint={`This ${ADJUSTMENTS[kind].verb} the current quantity.`}
      />
      {resulting !== null && (
        <p className="muted" aria-live="polite">
          New quantity: <strong>{formatQuantity(resulting)}</strong> (change {resulting - item.quantity >= 0 ? '+' : ''}
          {resulting - item.quantity})
        </p>
      )}
      <label className="field">
        <span>
          Reason <span className="required" aria-hidden="true">*</span>
        </span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </label>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
export function MinQuantityForm({ item, onClose, onSaved }: { item: StockItem; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(item.min_quantity === null ? '' : String(item.min_quantity));
  const { error, setError, busy, submit } = useSubmit(onSaved, 'Unable to save the minimum quantity.');

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const min = parseNumber(value);
    if (min !== null && !isWholeNumber(min)) return setError('Enter a whole number, zero or more, or leave blank.');
    void submit(() => setMinQuantity(item.id, min));
  }

  return (
    <FormShell title={`Minimum quantity — ${item.item_code}`} error={error} busy={busy} submitLabel="Save" onSubmit={onSubmit} onClose={onClose}>
      <TextField
        label="Minimum quantity"
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        hint={`LOW STOCK shows when quantity ≤ minimum. Blank uses the default (currently ${item.effective_min_quantity}${item.min_quantity === null ? '' : ' for this item'}).`}
      />
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
export function StockDetailsForm({ item, onClose, onSaved }: { item: StockItem; onClose: () => void; onSaved: () => void }) {
  const [purchasedDate, setPurchasedDate] = useState(item.purchased_date ?? '');
  const [unitCost, setUnitCost] = useState(String(item.unit_cost));
  const [agreedPrice, setAgreedPrice] = useState(String(item.agreed_price));
  const [notes, setNotes] = useState(item.notes ?? '');
  const { error, setError, busy, submit } = useSubmit(onSaved, 'Unable to save the stock details.');

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const cost = parseNumber(unitCost);
    const price = parseNumber(agreedPrice);
    if (!isMoney(cost) || !isMoney(price)) return setError('Cost and agreed price must be amounts like 12.50.');
    void submit(() => updateStockDetails(item.id, { purchasedDate, unitCost: cost, agreedPrice: price, notes }));
  }

  return (
    <FormShell title={`Edit ${item.item_code}`} error={error} busy={busy} submitLabel="Save" onSubmit={onSubmit} onClose={onClose}>
      <p className="muted">
        Price and cost changes apply to future sales only; past sales keep the values they were recorded with. All changes
        are audited.
      </p>
      <TextField label="Purchase date" type="date" value={purchasedDate} onChange={(e) => setPurchasedDate(e.target.value)} />
      <TextField label="Unit cost (RM)" inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} required />
      <TextField label="Agreed selling price (RM)" inputMode="decimal" value={agreedPrice} onChange={(e) => setAgreedPrice(e.target.value)} required />
      <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
    </FormShell>
  );
}
