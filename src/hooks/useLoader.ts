import { useCallback, useEffect, useRef, useState } from 'react';
import { toUserMessage } from '../lib/errors';

interface LoaderState<T> {
  key: string | null;
  data: T | undefined;
  error: string | null;
}

/**
 * Loads data whenever `key` changes (build the key from every input the loader
 * uses). Stale responses from earlier keys are ignored, so fast typing or quick
 * filter changes never show out-of-date results.
 */
export function useLoader<T>(load: () => Promise<T>, key: string, fallbackError = 'Unable to load data.') {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const [version, setVersion] = useState(0);
  const requestKey = `${key}#${version}`;
  const [state, setState] = useState<LoaderState<T>>({ key: null, data: undefined, error: null });

  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (data) => {
        if (!cancelled) setState({ key: requestKey, data, error: null });
      },
      (error: unknown) => {
        if (!cancelled) setState((s) => ({ key: requestKey, data: s.data, error: toUserMessage(error, fallbackError) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [requestKey, fallbackError]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data: state.data, error: state.error, loading: state.key !== requestKey, reload };
}
