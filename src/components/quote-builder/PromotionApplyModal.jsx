import { useEffect, useMemo, useState } from 'react';
import { Tag, Check, Loader2 } from 'lucide-react';
import Modal from '../Modal.jsx';
import { isPricedLine } from '../../lib/constants.js';
import {
  isPromoActive,
  isPromoExpired,
  sortPromotions,
  suggestEligibleLineIds,
  lineIsDealerFunded,
} from '../../lib/promotions.js';

/**
 * Apply a marketing promotion to the open quote.
 *
 * Pick a promo, confirm which lines it applies to (pre-checked from the
 * keyword/reference suggestion since the data is free-text), and apply — which
 * writes the promo's discount onto each checked line's lineDiscountPct and
 * stamps quote.promotionId. "Quitar" reverses it (clears the matching
 * discounts + the stamp).
 */
export default function PromotionApplyModal({ open, onClose, promotions, quote, lines, onApply, onRemove }) {
  const sorted = useMemo(() => sortPromotions(promotions), [promotions]);
  const pricedLines = useMemo(() => (lines || []).filter(isPricedLine), [lines]);

  const [selectedId, setSelectedId] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  // On open, default the selection: the already-applied promo, else the first
  // active one, else the first in the list.
  useEffect(() => {
    if (!open) return;
    const active = sorted.find((p) => isPromoActive(p));
    setSelectedId(quote?.promotionId || active?.id || sorted[0]?.id || null);
    setBusy(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = sorted.find((p) => p.id === selectedId) || null;

  // Recompute the suggested line set whenever the selected promo changes.
  useEffect(() => {
    if (!open || !selected) { setChecked(new Set()); return; }
    setChecked(new Set(suggestEligibleLineIds(pricedLines, selected)));
  }, [open, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(id) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function apply() {
    if (!selected || checked.size === 0) return;
    setBusy(true);
    try {
      await onApply(selected, [...checked]);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await onRemove();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const appliedId = quote?.promotionId || null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Aplicar promoción"
      size="md"
      footer={
        <>
          {appliedId && (
            <button type="button" onClick={remove} disabled={busy} className="btn-ghost text-ink-500 hover:text-red-600">
              Quitar promoción
            </button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="btn-ghost">Cerrar</button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || !selected || checked.size === 0}
            className="btn-primary disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Aplicar a {checked.size} {checked.size === 1 ? 'línea' : 'líneas'}
          </button>
        </>
      }
    >
      {sorted.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-ink-500">
          No hay promociones. Créalas en <b>Administración › Promociones</b>.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Promo selector */}
          <div className="space-y-1.5">
            <div className="label">Promoción</div>
            {sorted.map((p) => {
              const active = isPromoActive(p);
              const expired = isPromoExpired(p);
              const isSel = p.id === selectedId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={`w-full text-left rounded-md border px-3 py-2.5 flex items-center gap-2.5 transition-colors ${
                    isSel ? 'border-ink-900 bg-ink-50' : 'border-ink-200 hover:bg-ink-50'
                  }`}
                >
                  <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0 ${
                    isSel ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-500'
                  }`}>
                    <Tag size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink-900 truncate">{p.name || 'Sin nombre'}</span>
                      {p.code && <span className="font-mono text-[11px] text-ink-500">{p.code}</span>}
                    </span>
                    <span className="text-[11px] text-ink-500">
                      {p.discountPct || 0}% ·{' '}
                      {p.isEnabled === false
                        ? 'desactivada'
                        : expired ? 'vencida' : active ? 'activa' : 'programada'}
                      {p.id === appliedId ? ' · aplicada' : ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Eligible-line checklist */}
          {selected && (
            <div>
              <div className="label">Líneas a las que aplica</div>
              {pricedLines.length === 0 ? (
                <div className="text-sm text-ink-500 px-1 py-3">Esta cotización no tiene líneas con precio.</div>
              ) : (
                <div className="max-h-[40vh] overflow-y-auto -mx-1 space-y-0.5">
                  {pricedLines.map((l) => {
                    const on = checked.has(l.id);
                    const dealerFull = lineIsDealerFunded(l, selected);
                    const currentPct = Number(l.lineDiscountPct) || 0;
                    return (
                      <label
                        key={l.id}
                        className={`flex items-center gap-2.5 rounded-md px-3 py-2 mx-1 cursor-pointer transition-colors ${
                          on ? 'bg-brand-50' : 'hover:bg-ink-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(l.id)}
                          className="w-4 h-4 rounded border-ink-300 flex-shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="text-sm text-ink-900 truncate block">
                            {l.name || l.reference || l.family || 'Sin nombre'}
                          </span>
                          <span className="text-[11px] text-ink-500">
                            {[l.reference, l.family].filter(Boolean).join(' · ') || '—'}
                            {currentPct > 0 ? ` · actual ${currentPct}%` : ''}
                            {dealerFull ? ' · asumes 20%' : ''}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="text-[11px] text-ink-500 mt-2 px-1">
                Aplica {selected.discountPct || 0}% de descuento a las líneas marcadas (sobrescribe el descuento por línea actual).
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
