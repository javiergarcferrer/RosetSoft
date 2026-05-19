import { forwardRef, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

// Local-state-backed input that commits to onCommit either ~delay ms after
// typing stops, or on blur — whichever comes first. Decouples the input from
// the (network-backed) remote value so each keystroke doesn't await a write.

function useDebouncedField<E extends HTMLInputElement | HTMLTextAreaElement>(
  remote: string | number | null | undefined,
  onCommit: (value: string) => void,
  delay: number,
) {
  const initial = remote == null ? '' : String(remote);
  const [local, setLocal] = useState<string>(initial);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef<string>(initial);

  useEffect(() => {
    const next = remote == null ? '' : String(remote);
    if (!focused.current && next !== local) {
      setLocal(next);
      lastSent.current = next;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function commit(v: string) {
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
    onChange: (e: ChangeEvent<E>) => {
      const v = e.target.value;
      setLocal(v);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => commit(v), delay);
    },
  };
}

export interface DebouncedInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string | number | null | undefined;
  onCommit: (value: string) => void;
  delay?: number;
}

export const DebouncedInput = forwardRef<HTMLInputElement, DebouncedInputProps>(
  function DebouncedInput({ value, onCommit, delay = 400, ...rest }, ref) {
    const field = useDebouncedField<HTMLInputElement>(value, onCommit, delay);
    return <input ref={ref} {...rest} {...field} />;
  },
);

export interface DebouncedTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string | number | null | undefined;
  onCommit: (value: string) => void;
  delay?: number;
}

export const DebouncedTextarea = forwardRef<HTMLTextAreaElement, DebouncedTextareaProps>(
  function DebouncedTextarea({ value, onCommit, delay = 400, ...rest }, ref) {
    const field = useDebouncedField<HTMLTextAreaElement>(value, onCommit, delay);
    return <textarea ref={ref} {...rest} {...field} />;
  },
);
