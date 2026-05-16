import { useEffect, useRef, useState } from 'react';
import { Container as ContainerIcon, ChevronDown, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { currentStage, STAGE_BY_KEY } from '../../lib/containerStages.js';

/**
 * Chip showing the container this quote is pinned to. Click opens a small
 * popover listing all open containers (only "filling" stages — past that
 * point a container shouldn't accept new quotes), plus "Sin contenedor" and
 * a link to create one.
 *
 * Containers that aren't in the FILLING stage still render (so users can see
 * what they have today) but are visually dimmed and disabled — pinning a
 * quote to an "in transit" container would silently break the dispatch
 * pipeline.
 */
export default function ContainerChip({ profileId, containerId, onChange }) {
  const containers = useLiveQuery(
    () => db.containers.where('profileId').equals(profileId || '').reverse().sortBy('updatedAt'),
    [profileId],
    [],
  );
  const current = containers.find((c) => c.id === containerId) || null;
  const [open, setOpen] = useState(false);
  const popRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e) {
      if (popRef.current && !popRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = current
    ? `#${current.number}${current.name ? ` · ${current.name}` : ''}`
    : 'Sin contenedor';

  return (
    <div className="relative" ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors
          ${current
            ? 'border-ink-200 bg-white text-ink-900 hover:border-ink-400'
            : 'border-dashed border-ink-300 text-ink-500 hover:border-ink-500 hover:text-ink-900'}`}
        title={label}
      >
        <ContainerIcon size={12} />
        <span className="max-w-[200px] truncate">{label}</span>
        <ChevronDown size={12} className="text-ink-400" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 right-0 sm:left-0 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-ink-200 bg-white shadow-pop">
          <div className="px-2 py-2 max-h-80 overflow-y-auto">
            <Row
              icon={null}
              label="Sin contenedor"
              selected={!containerId}
              onClick={() => { onChange(null); setOpen(false); }}
            />
            {containers.length > 0 && <div className="my-1 border-t border-ink-100" />}
            {containers.map((c) => {
              const stage = currentStage(c);
              const isFilling = stage === 'filling';
              const stageLbl = STAGE_BY_KEY[stage]?.label || stage;
              return (
                <Row
                  key={c.id}
                  label={`#${c.number}${c.name ? ` · ${c.name}` : ''}`}
                  hint={stageLbl}
                  disabled={!isFilling && c.id !== containerId}
                  selected={c.id === containerId}
                  onClick={() => { onChange(c.id); setOpen(false); }}
                />
              );
            })}
          </div>
          <div className="border-t border-ink-100 px-2 py-1.5">
            <Link
              to="/containers"
              onClick={() => setOpen(false)}
              className="block w-full text-left rounded px-2 py-1.5 text-xs text-ink-500 hover:bg-ink-50 hover:text-ink-900"
            >
              Administrar contenedores →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, hint, selected, disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-full text-left rounded px-2 py-1.5 flex items-center gap-2 text-sm transition-colors
        ${disabled ? 'text-ink-300 cursor-not-allowed' : 'hover:bg-ink-50'}
        ${selected ? 'bg-ink-100 font-medium' : ''}`}
    >
      <span className="w-4 flex-shrink-0">{selected && <Check size={14} className="text-brand-600" />}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="text-[10px] text-ink-500 flex-shrink-0">{hint}</span>}
    </button>
  );
}
