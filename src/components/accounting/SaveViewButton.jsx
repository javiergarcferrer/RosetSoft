import { useLocation } from 'react-router-dom';
import { Bookmark } from 'lucide-react';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';

/** Save the current report (path + query) as a named view under Vistas guardadas. */
export default function SaveViewButton({ defaultName }) {
  const { profileId } = useApp();
  const scope = profileId || 'team';
  const loc = useLocation();
  async function save() {
    const name = window.prompt('Nombre de la vista guardada:', defaultName || '');
    if (!name || !name.trim()) return;
    await db.savedReports.put({ id: newId(), profileId: scope, name: name.trim(), path: loc.pathname, search: loc.search || '', createdAt: Date.now() });
    window.alert('Vista guardada en Informes › Vistas guardadas.');
  }
  return <button type="button" onClick={save} className="btn-ghost"><Bookmark size={14} /> Guardar vista</button>;
}
