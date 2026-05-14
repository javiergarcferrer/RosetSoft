import { useEffect, useRef, useState } from 'react';
import { subscribeInvalidate } from './database.js';

/**
 * Drop-in replacement for `dexie-react-hooks`' useLiveQuery, backed by the
 * Supabase shim. Refetches when any mutation calls `invalidate()` from
 * `database.js` or when `deps` change.
 *
 * The third arg is the default value returned while the first fetch is in
 * flight — matching the dexie-react-hooks signature.
 */
export function useLiveQuery(asyncFn, deps = [], defaultValue) {
  const [value, setValue] = useState(defaultValue);
  const fnRef = useRef(asyncFn);
  fnRef.current = asyncFn;

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const r = await Promise.resolve(fnRef.current());
        if (active) setValue(r);
      } catch (e) {
        if (active) console.error('useLiveQuery error:', e);
      }
    };
    run();
    const unsub = subscribeInvalidate(run);
    return () => {
      active = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}
