import type { ReactNode } from 'react';

export interface FieldGroupProps {
  title?: ReactNode;
  children?: ReactNode;
  columns?: 2 | 3;
}

/**
 * Grouped form fields with a small section header. Children are arranged
 * in a 2-column grid on phones and a configurable 2- or 3-column grid on
 * sm+. Use one <FieldGroup> per conceptual section of a form so the user
 * can parse hierarchy by glancing at the section labels alone.
 *
 * Pair with <Field> for each input cell. For a free-form layout outside
 * of a group, just use <Field> directly.
 */
export function FieldGroup({ title, children, columns = 3 }: FieldGroupProps) {
  const cols = columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3';
  return (
    <div>
      {title ? (
        <div className="eyebrow-xs mb-2">
          {title}
        </div>
      ) : null}
      <div className={`grid grid-cols-2 gap-3 ${cols}`}>
        {children}
      </div>
    </div>
  );
}

export interface FieldProps {
  label?: ReactNode;
  widthClass?: string;
  children?: ReactNode;
  hint?: ReactNode;
}

/**
 * One labelled cell within a FieldGroup (or anywhere a labelled input is
 * needed). Pass `widthClass` as a grid-column span (e.g. "col-span-2"
 * or "sm:col-span-2") to widen a cell. The label uses the same uppercase
 * spec as the global .label CSS class but at a tighter weight so it sits
 * comfortably above a coarse-target input.
 */
export function Field({ label, widthClass = '', children, hint }: FieldProps) {
  return (
    <div className={widthClass}>
      <div className="text-[11px] font-medium text-ink-500 mb-1">{label}</div>
      {children}
      {hint ? <div className="text-[11px] text-ink-500 mt-1">{hint}</div> : null}
    </div>
  );
}
