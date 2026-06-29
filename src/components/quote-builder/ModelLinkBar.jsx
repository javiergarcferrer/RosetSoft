import { userMessageFor } from '../../lib/errorMessages.js';
import { useState } from 'react';
import { ExternalLink, Link2, X } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { fetchModelFabrics, saveModelFabrics, clearModelFabrics } from '../../lib/lrModelFabrics.js';

/**
 * Link a product to its Ligne Roset product page, capturing the fabrics it
 * actually offers so the material picker can restrict to in-grade AND offered.
 *
 * `root` is the storage key in `model_fabrics`:
 *   • a SKU family root for a simple model — the link persists per model across
 *     every quote.
 *   • a compound line's id — one link governs EVERY component within (the
 *     components inherit this link's fabric allowlist).
 *
 * `record` is the live `model_fabrics` row for that key (null when unlinked).
 * When no link exists it shows a paste-URL input + "Vincular"; once linked it
 * shows "Ver en Ligne Roset" (+ the fabric count) with refresh / remove.
 */
export default function ModelLinkBar({ root, record }) {
  const { profileId } = useApp();
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function link() {
    const clean = url.trim();
    if (!clean || busy) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetchModelFabrics(clean);
      await saveModelFabrics(root, profileId, res);
      setUrl('');
      setEditing(false);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await clearModelFabrics(root);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }

  if (record?.sourceUrl && !editing) {
    return (
      <div className="my-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={record.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand-700 hover:underline font-medium shrink-0"
          >
            <ExternalLink size={12} /> Ver en Ligne Roset
          </a>
          {record.patternNames?.length > 0 && (
            <span className="text-ink-400 shrink-0">· {record.patternNames.length} telas disponibles</span>
          )}
          <span className="inline-flex items-center gap-1 sm:ml-auto flex-shrink-0">
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className="inline-flex items-center rounded-md px-1.5 min-h-7 coarse:min-h-11 text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors disabled:opacity-40">Actualizar</button>
            <button type="button" onClick={unlink} disabled={busy} className="inline-flex items-center rounded-md px-1.5 min-h-7 coarse:min-h-11 text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors disabled:opacity-40">{busy ? 'Quitando…' : 'Quitar'}</button>
          </span>
        </div>
        {err && <div className="text-[11px] text-red-600 mt-1">{err}</div>}
      </div>
    );
  }

  // Unlinked + not editing → a single quiet affordance instead of the old
  // permanently-expanded paste-URL bar, which burned a full row of dead
  // space on EVERY unlinked piece (the dealer's screenshots). The input
  // appears only when asked for.
  if (!editing) {
    return (
      <div className="my-1.5">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="chip-action"
          title="Pega el enlace de Ligne Roset de este modelo para filtrar las telas a las que realmente ofrece"
        >
          <Link2 size={11} className="opacity-70" aria-hidden />
          Vincular con Ligne Roset
        </button>
      </div>
    );
  }

  return (
    <div className="my-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-0" style={{ minWidth: '10rem' }}>
          <Link2 size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); link(); } }}
            placeholder="Pega el enlace de Ligne Roset de este modelo…"
            className="input pl-8 text-xs py-1.5 w-full"
            autoFocus
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button type="button" onClick={link} disabled={busy || !url.trim()} className="btn-primary text-xs disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
            {busy ? 'Vinculando…' : 'Vincular'}
          </button>
          <button type="button" onClick={() => { setEditing(false); setUrl(''); setErr(''); }} className="btn-ghost text-xs" aria-label="Cancelar">
            <X size={13} />
          </button>
        </div>
      </div>
      {err && <div className="text-[11px] text-red-600 mt-1">{err}</div>}
    </div>
  );
}
