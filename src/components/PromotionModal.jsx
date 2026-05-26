import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import Modal from './Modal.jsx';
import { db, newId } from '../db/database.js';
import { clampPct } from '../lib/pricing.js';

/**
 * Promotion create/edit modal. Opened from the Promociones admin page.
 *
 * Captures a Ligne Roset activation once (name, code, window, discount,
 * eligible keywords, dealer-funded model codes) so it can be applied to
 * quotes later. Mirrors CustomerModal's shape:
 *
 *   promotion  — null/undefined when closed; the row (or {} for "new")
 *                when open.
 *   onClose    — close handler; called on save and any non-delete close.
 *   profileId  — team profile id; stamped on new rows.
 */
export default function PromotionModal({ promotion, onClose, profileId }) {
  const open = !!promotion;
  const isNew = !promotion?.id;
  const [data, setData] = useState(null);

  if (open && data?.__id !== (promotion?.id || 'new')) {
    setData({
      __id: promotion?.id || 'new',
      name: promotion?.name || '',
      code: promotion?.code || '',
      startsAt: msToDateInput(promotion?.startsAt),
      endsAt: msToDateInput(promotion?.endsAt),
      discountPct: promotion?.discountPct ?? '',
      dealerFundedPct: promotion?.dealerFundedPct ?? '',
      dealerFullRefs: (promotion?.dealerFullRefs || []).join(', '),
      eligibleKeywords: (promotion?.eligibleKeywords || []).join(', '),
      terms: promotion?.terms || '',
      isEnabled: promotion?.isEnabled !== false,
      notes: promotion?.notes || '',
    });
  }
  if (!open || !data) return <Modal open={false} onClose={onClose} title="" />;

  function set(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function save() {
    if (!data.name.trim()) return;
    const id = promotion?.id || newId();
    await db.promotions.put({
      id,
      profileId,
      name: data.name.trim(),
      code: data.code.trim() || null,
      startsAt: dateInputToMs(data.startsAt, false),
      endsAt: dateInputToMs(data.endsAt, true),
      discountPct: clampPct(Number(data.discountPct) || 0),
      dealerFundedPct: data.dealerFundedPct === '' ? null : Number(data.dealerFundedPct),
      dealerFullRefs: parseList(data.dealerFullRefs),
      eligibleKeywords: parseList(data.eligibleKeywords),
      terms: data.terms,
      isEnabled: !!data.isEnabled,
      notes: data.notes,
      assets: promotion?.assets || [],
      createdAt: promotion?.createdAt || Date.now(),
    });
    onClose();
  }

  async function remove() {
    if (!confirm(`¿Eliminar la promoción "${data.name}"?`)) return;
    await db.promotions.delete(promotion.id);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? 'Nueva promoción' : `Editar — ${data.name || 'Promoción'}`}
      footer={
        <>
          {!isNew && (
            <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50">
              <Trash2 size={14} /> Eliminar
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="btn-ghost">Cancelar</button>
          <button onClick={save} className="btn-primary">Guardar</button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <div className="label">Nombre *</div>
          <input
            className="input"
            value={data.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Cabinetry & Bedroom Promo"
            autoCapitalize="words"
          />
        </div>
        <div>
          <div className="label">Código</div>
          <input
            className="input"
            value={data.code}
            onChange={(e) => set('code', e.target.value)}
            placeholder="BED26"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div>
          <div className="label">Descuento %</div>
          <input
            className="input"
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            value={data.discountPct}
            onChange={(e) => set('discountPct', e.target.value)}
            placeholder="20"
          />
        </div>
        <div>
          <div className="label">Inicio</div>
          <input
            className="input"
            type="date"
            value={data.startsAt}
            onChange={(e) => set('startsAt', e.target.value)}
          />
        </div>
        <div>
          <div className="label">Fin</div>
          <input
            className="input"
            type="date"
            value={data.endsAt}
            onChange={(e) => set('endsAt', e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <div className="label">Palabras clave elegibles</div>
          <input
            className="input"
            value={data.eligibleKeywords}
            onChange={(e) => set('eligibleKeywords', e.target.value)}
            placeholder="Todana, cama, gabinete, dormitorio…"
          />
          <div className="text-[11px] text-ink-500 mt-1">
            Separadas por comas. Se usan para sugerir qué líneas reciben el descuento.
          </div>
        </div>
        <div className="sm:col-span-2">
          <div className="label">Modelos donde asumes el 20% completo</div>
          <input
            className="input"
            value={data.dealerFullRefs}
            onChange={(e) => set('dealerFullRefs', e.target.value)}
            placeholder="152, 14J, 172, 18D, 10K…"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="text-[11px] text-ink-500 mt-1">
            Códigos donde Roset no cofinancia. Separados por comas.
          </div>
        </div>
        <div>
          <div className="label">Tu parte del descuento %</div>
          <input
            className="input"
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            value={data.dealerFundedPct}
            onChange={(e) => set('dealerFundedPct', e.target.value)}
            placeholder="10"
          />
        </div>
        <div className="flex items-end">
          <label className="inline-flex items-center gap-2 text-sm text-ink-800 select-none">
            <input
              type="checkbox"
              checked={data.isEnabled}
              onChange={(e) => set('isEnabled', e.target.checked)}
              className="w-4 h-4 rounded border-ink-300"
            />
            Activa
          </label>
        </div>
        <div className="sm:col-span-2">
          <div className="label">Términos</div>
          <textarea
            className="input min-h-[70px]"
            value={data.terms}
            onChange={(e) => set('terms', e.target.value)}
            placeholder="No combinable con otros descuentos. Solo órdenes nuevas. Excluye impuestos y envío."
          />
        </div>
        <div className="sm:col-span-2">
          <div className="label">Notas internas</div>
          <textarea
            className="input min-h-[60px]"
            value={data.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

/* ms ↔ <input type="date"> value, in LOCAL time so the picked calendar day
   round-trips without a timezone shift. */
function msToDateInput(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateInputToMs(str, endOfDay) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
    : new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function parseList(s) {
  return String(s || '')
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}
