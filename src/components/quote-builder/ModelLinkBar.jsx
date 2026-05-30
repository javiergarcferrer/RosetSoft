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
      setErr(e?.message || 'No se pudo vincular el modelo.');
    } finally {
      setBusy(false);
    }
  }

  if (record?.sourceUrl && !editing) {
    return (
      <div className="flex items-center gap-2 my-2 text-[11px]">
        <a
          href={record.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-brand-700 hover:underline font-medium"
        >
          <ExternalLink size={12} /> Ver en Ligne Roset
        </a>
        {record.patternNames?.length > 0 && (
          <span className="text-ink-400">· {record.patternNames.length} telas disponibles</span>
        )}
        <span className="ml-auto inline-flex items-center gap-2">
          <button type="button" onClick={() => setEditing(true)} className="text-ink-500 hover:text-ink-800">Actualizar</button>
          <button type="button" onClick={() => clearModelFabrics(root)} className="text-ink-500 hover:text-ink-800">Quitar</button>
        </span>
      </div>
    );
  }

  return (
    <div className="my-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Link2 size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); link(); } }}
            placeholder="Pega el enlace de Ligne Roset de este modelo para filtrar las telas…"
            className="input pl-8 text-xs py-1.5"
            autoFocus={editing}
          />
        </div>
        <button type="button" onClick={link} disabled={busy || !url.trim()} className="btn-primary text-xs disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
          {busy ? 'Vinculando…' : 'Vincular'}
        </button>
        {editing && (
          <button type="button" onClick={() => { setEditing(false); setUrl(''); setErr(''); }} className="btn-ghost text-xs" aria-label="Cancelar">
            <X size={13} />
          </button>
        )}
      </div>
      {err && <div className="text-[11px] text-red-600 mt-1">{err}</div>}
    </div>
  );
}
