import { useCallback, useState } from 'react';
import type { PageRequest } from '../services/api';

/** Page + sort state for a server-paginated table. Changing sort returns to page 1. */
export function useTableState<S extends string>(initial: { column: S; ascending: boolean }, pageSize = 25) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(initial);

  const toggleSort = useCallback((column: S) => {
    setSort((s) => (s.column === column ? { column, ascending: !s.ascending } : { column, ascending: true }));
    setPage(1);
  }, []);

  const request: PageRequest<S> = { page, pageSize, sort };
  const key = `${page}|${pageSize}|${sort.column}|${sort.ascending}`;
  return { page, setPage, sort, toggleSort, request, key, pageSize };
}
