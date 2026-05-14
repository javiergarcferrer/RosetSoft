import { useEffect } from 'react';
import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-2 sm:p-4">
      <div className="fixed inset-0 bg-ink-900/40" onClick={onClose} />
      <div className={`relative w-full ${widths[size] || widths.md} bg-white rounded-lg shadow-2xl border border-ink-100 flex flex-col max-h-[90vh]`}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-100">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-900 p-1">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 flex-1">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-ink-100 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
