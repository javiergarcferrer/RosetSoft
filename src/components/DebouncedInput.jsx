import { forwardRef, useEffect, useRef, useState } from 'react';

// Local-state-backed input that commits to onCommit either ~delay ms after
// typing stops, or on blur — whichever comes first. Decouples the input from
// the (network-backed) remote value so each keystroke doesn't await a write.

function useDebouncedField(remote, onCommit, delay) {
  const [local, setLocal] = useState(remote ?? '');
  const focused = useRef(false);
  const timer = useRef(null);
  const lastSent = useRef(remote ?? '');

  useEffect(() => {
    const next = remote ?? '';
    if (!focused.current && next !== local) {
      setLocal(next);
      lastSent.current = next;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function commit(v) {
    if (v === lastSent.current) return;
    lastSent.current = v;
    onCommit(v);
  }

  return {
    value: local,
    onFocus: () => { focused.current = true; },
    onBlur: () => {
      focused.current = false;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      commit(local);
    },
    onChange: (e) => {
      const v = e.target.value;
      setLocal(v);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => commit(v), delay);
    },
  };
}

export const DebouncedInput = forwardRef(function DebouncedInput(
  { value, onCommit, delay = 400, ...rest },
  ref,
) {
  const field = useDebouncedField(value, onCommit, delay);
  return <input ref={ref} {...rest} {...field} />;
});

export const DebouncedTextarea = forwardRef(function DebouncedTextarea(
  { value, onCommit, delay = 400, ...rest },
  ref,
) {
  const field = useDebouncedField(value, onCommit, delay);
  return <textarea ref={ref} {...rest} {...field} />;
});
