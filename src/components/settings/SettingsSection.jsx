import { ChevronDown } from 'lucide-react';

/**
 * One collapsible section of the Configuración page. Native <details> with a
 * shared `name`, so the page behaves as a true accordion (opening a section
 * closes the rest — browsers without `name` support simply allow several
 * open). Collapsed by default: the page reads as a clean index and delicate
 * config stays tucked away until deliberately opened. Content stays mounted
 * while closed, so form state and effects (e.g. the WhatsApp webhook ping)
 * are unaffected.
 */
export default function SettingsSection({ title, children }) {
  return (
    <details className="card overflow-hidden" name="settings-section">
      <summary className="px-5 py-3.5 min-h-12 flex items-center justify-between gap-3 cursor-pointer select-none hover:bg-ink-50/60 active:bg-ink-50 transition-colors">
        <h2 className="font-semibold text-sm text-ink-900 inline-flex items-center gap-2 min-w-0">{title}</h2>
        <ChevronDown size={15} className="disclosure-chevron text-ink-400 shrink-0" aria-hidden />
      </summary>
      <div className="card-pad pt-4 border-t border-ink-100">{children}</div>
    </details>
  );
}
