import { useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Square, CheckSquare, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';

/**
 * Shared dev backlog — the owner types a change/TODO here from the phone; the
 * developer reads it (it's in the DB, table `dev_todos`) and checks it off as
 * it ships. Pending first, done collapsed at the bottom and struck through.
 */
export default function DevTodos() {
  const { profileId } = useApp();
  const scope = profileId || 'team';
  const inputRef = useRef(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const todosQ = useLiveQueryStatus(() => db.devTodos.where('profileId').equals(scope).toArray(), [scope], []);
  const { pending, done } = useMemo(() => {
    const rows = (todosQ.data || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { pending: rows.filter((t) => !t.done), done: rows.filter((t) => t.done) };
  }, [todosQ.data]);

  async function add() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await db.devTodos.put({ id: newId(), profileId: scope, text: t, done: false, createdAt: Date.now(), updatedAt: Date.now() });
      setText('');
      inputRef.current?.focus(); // keep typing the next one
    } finally {
      setBusy(false);
    }
  }
  const toggle = (t) => db.devTodos.update(t.id, { done: !t.done, doneAt: !t.done ? Date.now() : null, updatedAt: Date.now() });
  const remove = (t) => db.devTodos.delete(t.id);

  const Item = ({ t }) => (
    <li className="flex items-start gap-2 px-4 py-2 border-b border-ink-100">
      <button type="button" onClick={() => toggle(t)} className="shrink-0 mt-0.5 text-ink-400 hover:text-ink-700" aria-label={t.done ? 'Marcar pendiente' : 'Marcar hecho'}>
        {t.done ? <CheckSquare size={16} className="text-emerald-600" /> : <Square size={16} />}
      </button>
      <span className={`min-w-0 flex-1 text-sm break-words ${t.done ? 'text-ink-400 line-through' : 'text-ink-800'}`}>{t.text}</span>
      <button type="button" onClick={() => remove(t)} className="shrink-0 btn-icon text-ink-300 hover:text-rose-600" aria-label="Eliminar"><Trash2 size={14} /></button>
    </li>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-100 shrink-0">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="Escribe un pendiente y Enter…"
          className="input py-1.5 text-sm flex-1 min-w-0"
          autoFocus
        />
        <button type="button" onClick={add} disabled={!text.trim() || busy} className="btn-primary text-sm shrink-0 disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Añadir
        </button>
      </div>
      {!todosQ.loaded ? (
        <div className="flex-1 flex items-center justify-center text-ink-400"><Loader2 size={18} className="animate-spin" /></div>
      ) : (pending.length === 0 && done.length === 0) ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center text-ink-400 p-8">
          <CheckSquare size={26} className="mb-2 opacity-50" />
          <div className="text-sm">Sin pendientes.</div>
          <div className="text-xs mt-1">Lo que escribas aquí lo leo y lo marco al hacerlo.</div>
        </div>
      ) : (
        <ul className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {pending.map((t) => <Item key={t.id} t={t} />)}
          {done.length > 0 && (
            <li className="px-4 pt-3 pb-1 eyebrow-xs text-ink-400">Hechos ({done.length})</li>
          )}
          {done.map((t) => <Item key={t.id} t={t} />)}
        </ul>
      )}
    </div>
  );
}
