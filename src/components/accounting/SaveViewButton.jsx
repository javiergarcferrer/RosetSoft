import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bookmark, Loader2 } from 'lucide-react';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import { userMessageFor } from '../../lib/errorMessages.js';
import Modal from '../Modal.jsx';

/** Save the current report (path + query) as a named view under Vistas guardadas. */
export default function SaveViewButton({ defaultName }) {
  const { profileId } = useApp();
  const scope = profileId || 'team';
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  // Seed the input with the suggested name each time the modal opens.
  useEffect(() => { if (open) { setName(defaultName || ''); setErr(''); setDone(false); } }, [open, defaultName]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { setErr('Escribe un nombre para la vista.'); return; }
    setErr('');
    setSaving(true);
    try {
      await db.savedReports.put({ id: newId(), profileId: scope, name: trimmed, path: loc.pathname, search: loc.search || '', createdAt: Date.now() });
      setDone(true);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost"><Bookmark size={14} /> Guardar vista</button>
      {open && (
        <Modal open onClose={() => { if (!saving) setOpen(false); }} title="Guardar vista" size="sm" footer={
          done ? (
            <button type="button" onClick={() => setOpen(false)} className="btn-primary">Listo</button>
          ) : (
            <>
              <button type="button" onClick={() => setOpen(false)} disabled={saving} className="btn-ghost">Cancelar</button>
              <button type="button" onClick={save} disabled={saving} className="btn-primary">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Bookmark size={14} />} Guardar
              </button>
            </>
          )
        }>
          {done ? (
            <p className="text-sm text-emerald-700">Vista guardada en Informes › Vistas guardadas.</p>
          ) : (
            <label className="text-sm block">
              <span className="label block">Nombre de la vista</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
                placeholder="Mi vista guardada"
                autoFocus
                className="input w-full"
              />
            </label>
          )}
          {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
        </Modal>
      )}
    </>
  );
}
