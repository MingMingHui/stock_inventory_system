interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onPage }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span>
        {first}–{last} of {total}
      </span>
      <div className="pagination-buttons">
        <button type="button" className="btn btn-small" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          Previous
        </button>
        <span aria-current="page">
          Page {page} of {pages}
        </span>
        <button type="button" className="btn btn-small" onClick={() => onPage(page + 1)} disabled={page >= pages}>
          Next
        </button>
      </div>
    </nav>
  );
}
