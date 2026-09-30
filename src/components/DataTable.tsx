import type { ReactNode } from 'react';

export interface Column<T, S extends string = string> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Server-side sort column; omit for unsortable columns. */
  sortKey?: S;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

interface DataTableProps<T, S extends string> {
  caption: string;
  columns: Column<T, S>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  emptyMessage: string;
  sort?: { column: S; ascending: boolean };
  onSort?: (column: S) => void;
  rowClassName?: (row: T) => string | undefined;
}

export function DataTable<T, S extends string = string>({
  caption,
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  emptyMessage,
  sort,
  onSort,
  rowClassName,
}: DataTableProps<T, S>) {
  return (
    <div className="table-wrap" aria-busy={loading}>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => {
              const sorted = sort && col.sortKey && sort.column === col.sortKey;
              const ariaSort = sorted ? (sort.ascending ? 'ascending' : 'descending') : undefined;
              return (
                <th key={col.key} scope="col" className={`align-${col.align ?? 'left'}`} aria-sort={ariaSort}>
                  {col.sortKey && onSort ? (
                    <button type="button" className="sort-button" onClick={() => onSort(col.sortKey as S)}>
                      {col.header}
                      <span aria-hidden="true" className="sort-indicator">
                        {sorted ? (sort.ascending ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {error ? (
            <tr>
              <td colSpan={columns.length} className="table-message table-error" role="alert">
                {error}
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="table-message">
                {loading ? 'Loading…' : emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className={rowClassName?.(row)}>
                {columns.map((col) => (
                  <td key={col.key} className={`align-${col.align ?? 'left'} ${col.className ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {loading && rows.length > 0 && <div className="table-loading" aria-hidden="true" />}
    </div>
  );
}
