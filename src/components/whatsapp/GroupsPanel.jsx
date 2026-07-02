import { useEffect, useMemo, useState } from 'react';
import {
  Users, Search, Plus, Loader2, ArrowLeft, MessageCircle, Link2, Copy, RefreshCw,
  Archive, ArchiveRestore, Pencil, Check, X, ShieldCheck, Trash2, UserPlus,
} from 'lucide-react';
import Modal from '../Modal.jsx';
import { initials, timeLabel } from './ChatThread.jsx';
import { resolveGroupsList, resolveBroadcastAudience, displayPhone } from '../../core/crm/index.js';
import {
  listWaGroups, syncWaGroup, createWaGroup, updateWaGroup,
  getWaGroupInviteLink, manageWaGroupParticipants, setWaGroupArchived,
} from '../../lib/whatsapp.js';

/**
 * Grupos — the WhatsApp group management surface (Cloud API Groups). A modal
 * over the inbox: list every group with its roster + activity, create a group,
 * and manage one (edit subject/description, add/remove participants, copy the
 * join link, archive). All derivation is core/crm (resolveGroupsList); this
 * View calls the lib/whatsapp actions, which mirror the result server-side, then
 * onInvalidate() refreshes the live data the parent passes back in.
 *
 * Data (groups / participants / messages / customers / professionals) flows in
 * as props from Chats so the panel never double-fetches the inbox's datasets.
 */
export default function GroupsPanel({
  open, onClose, groups, participants, messages, customers, professionals,
  onOpenChat, focusGroupId = null, onInvalidate,
}) {
  const [view, setView] = useState('list'); // 'list' | 'create' | 'manage'
  const [manageId, setManageId] = useState(null);
  const [needle, setNeedle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!open) return;
    if (focusGroupId) { setManageId(focusGroupId); setView('manage'); }
    else { setView('list'); setManageId(null); }
    setNeedle(''); setError(null); setNotice(null);
  }, [open, focusGroupId]);

  const list = useMemo(
    () => resolveGroupsList(groups, participants, messages, { needle, includeArchived: true }),
    [groups, participants, messages, needle],
  );
  const manage = useMemo(() => list.find((g) => g.id === manageId) || null, [list, manageId]);

  // Wrap an action: clear banners, run, refresh, surface errors uniformly.
  async function run(fn, okNotice) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fn();
      if (res && res.ok === false) { setError(res.error || 'No se pudo completar la acción.'); return res; }
      onInvalidate?.();
      if (okNotice) setNotice(okNotice);
      return res || { ok: true };
    } catch (e) {
      setError(e?.message || 'No se pudo completar la acción.');
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  const title = view === 'create' ? 'Nuevo grupo' : view === 'manage' ? (manage?.subject || 'Grupo') : 'Grupos de WhatsApp';

  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      {/* Sub-nav: back from create/manage; refresh from Meta on the list. */}
      <div className="flex items-center justify-between mb-3 gap-2">
        {view === 'list' ? (
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
            <input
              className="input pl-9 text-sm"
              value={needle}
              onChange={(e) => setNeedle(e.target.value)}
              placeholder="Buscar grupo…"
              aria-label="Buscar grupo"
            />
          </div>
        ) : (
          <button type="button" className="btn-ghost text-sm inline-flex items-center gap-1.5" onClick={() => { setView('list'); setError(null); setNotice(null); }}>
            <ArrowLeft size={15} /> Grupos
          </button>
        )}
        {view === 'list' && (
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1.5" disabled={busy}
              onClick={() => run(() => listWaGroups(), 'Lista de grupos actualizada.')} title="Actualizar desde WhatsApp" aria-label="Actualizar desde WhatsApp">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </button>
            <button type="button" className="btn-primary text-sm inline-flex items-center gap-1.5" onClick={() => { setView('create'); setError(null); setNotice(null); }}>
              <Plus size={15} /> Nuevo
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/40 px-3 py-2 text-[12px] text-red-700 dark:text-red-200 whitespace-pre-wrap">{error}</div>
      )}
      {notice && (
        <div className="mb-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/40 px-3 py-2 text-[12px] text-emerald-800 dark:text-emerald-200">{notice}</div>
      )}

      {view === 'list' && (
        <GroupList
          list={list}
          onOpenChat={(g) => { onOpenChat?.(g.key); onClose(); }}
          onManage={(g) => { setManageId(g.id); setView('manage'); setError(null); setNotice(null); }}
        />
      )}

      {view === 'create' && (
        <CreateGroup
          customers={customers}
          professionals={professionals}
          busy={busy}
          onCancel={() => setView('list')}
          onCreate={async ({ subject, description, participants: phones }) => {
            const res = await run(() => createWaGroup({ subject, description, participants: phones }), 'Grupo creado.');
            if (res?.ok && res.groupId) { setManageId(res.groupId); setView('manage'); }
          }}
        />
      )}

      {view === 'manage' && manage && (
        <ManageGroup
          group={manage}
          customers={customers}
          professionals={professionals}
          busy={busy}
          onOpenChat={() => { onOpenChat?.(manage.key); onClose(); }}
          onSync={() => run(() => syncWaGroup(manage.id), 'Grupo sincronizado.')}
          onSaveDetails={(patch) => run(() => updateWaGroup({ groupId: manage.id, ...patch }), 'Datos del grupo actualizados.')}
          onInvite={(revoke) => run(() => getWaGroupInviteLink({ groupId: manage.id, revoke }), revoke ? 'Enlace regenerado.' : null)}
          onAdd={(phones) => run(() => manageWaGroupParticipants({ groupId: manage.id, add: phones }), 'Participante(s) agregado(s).')}
          onRemove={(phone) => run(() => manageWaGroupParticipants({ groupId: manage.id, remove: [phone] }), 'Participante eliminado.')}
          onArchive={() => run(() => setWaGroupArchived(manage.id, manage.status !== 'archived'), manage.status === 'archived' ? 'Grupo reactivado.' : 'Grupo archivado.')}
        />
      )}
      {view === 'manage' && !manage && (
        <p className="text-xs text-ink-400 text-center py-8">Este grupo ya no está disponible.</p>
      )}
    </Modal>
  );
}

function GroupList({ list, onOpenChat, onManage }) {
  if (!list.length) {
    return (
      <p className="text-xs text-ink-400 text-center px-6 py-10">
        Aún no hay grupos. Crea uno con “Nuevo”, o actualiza desde WhatsApp si ya tienes grupos en el número del negocio.
      </p>
    );
  }
  return (
    <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1 space-y-1">
      {list.map((g) => (
        <div key={g.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${g.status === 'archived' ? 'border-ink-100 bg-ink-50/40 opacity-70' : 'border-ink-100 hover:bg-ink-50/60'}`}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <Users size={16} />
          </span>
          <button type="button" onClick={() => onOpenChat(g)} className="min-w-0 flex-1 text-left">
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-sm text-ink-900 truncate">
                {g.subject}
                {g.status === 'archived' && <span className="ml-1.5 text-[10px] font-normal text-ink-400">· Archivado</span>}
              </span>
              <span className="text-[10px] text-ink-400 shrink-0 tabular-nums">{g.lastAt ? timeLabel(g.lastAt) : ''}</span>
            </span>
            <span className="block text-xs text-ink-500 truncate mt-0.5">
              {g.participantCount} participante{g.participantCount === 1 ? '' : 's'}
              {g.lastBody ? ` · ${g.lastSenderName ? `${g.lastSenderName}: ` : ''}${g.lastBody}` : ''}
            </span>
          </button>
          {g.unread > 0 && (
            <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[10px] font-bold inline-flex items-center justify-center">{g.unread}</span>
          )}
          <button type="button" onClick={() => onManage(g)} className="btn-ghost text-xs shrink-0" title="Gestionar grupo">Gestionar</button>
        </div>
      ))}
    </div>
  );
}

/** Multi-select contacts with a phone (deduped) — the participant picker shared
 *  by Create and Manage→add. */
function ContactPicker({ customers, professionals, selected, onToggle, excludePhones = [] }) {
  const [needle, setNeedle] = useState('');
  const exclude = useMemo(() => new Set(excludePhones.map((p) => String(p || '').replace(/\D/g, '').slice(-10))), [excludePhones]);
  const audience = useMemo(
    () => resolveBroadcastAudience(customers, professionals, { kind: 'all', needle }).filter((c) => !exclude.has(c.key)),
    [customers, professionals, needle, exclude],
  );
  return (
    <div>
      <div className="relative mb-2">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
        <input className="input pl-9 text-sm" value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder="Buscar contacto…" aria-label="Buscar contacto" />
      </div>
      <div className="max-h-[34vh] overflow-y-auto -mx-1 px-1 space-y-0.5">
        {audience.map((c) => {
          const on = selected.includes(c.phone);
          return (
            <button key={c.key} type="button" onClick={() => onToggle(c.phone)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 rounded-lg transition-colors ${on ? 'bg-brand-50' : 'hover:bg-ink-50'}`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-800 text-[11px] font-semibold">{initials(c.name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink-900 truncate">{c.name}</span>
                <span className="block text-[11px] text-ink-400">{displayPhone(c.phone)}{c.contactKind === 'professional' ? ' · Profesional' : ' · Cliente'}</span>
              </span>
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${on ? 'bg-brand-600 border-brand-600 text-white' : 'border-ink-300 text-transparent'}`}>
                <Check size={13} />
              </span>
            </button>
          );
        })}
        {!audience.length && <p className="text-xs text-ink-400 text-center py-6">Ningún contacto con teléfono coincide.</p>}
      </div>
    </div>
  );
}

function CreateGroup({ customers, professionals, busy, onCancel, onCreate }) {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState([]);
  const toggle = (phone) => setSelected((s) => (s.includes(phone) ? s.filter((p) => p !== phone) : [...s, phone]));
  const canCreate = subject.trim() && selected.length > 0 && !busy;
  return (
    <div className="space-y-4">
      <div>
        <div className="eyebrow-xs mb-1.5">Nombre del grupo</div>
        <input className="input w-full text-sm" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="p. ej. Proyecto Casa Cap Cana" maxLength={100} autoFocus />
      </div>
      <div>
        <div className="eyebrow-xs mb-1.5">Descripción (opcional)</div>
        <textarea className="input w-full min-h-16 text-sm" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="De qué trata el grupo…" maxLength={500} />
      </div>
      <div>
        <div className="eyebrow-xs mb-1.5">Participantes {selected.length > 0 && <span className="text-ink-400 font-normal">· {selected.length} seleccionado{selected.length === 1 ? '' : 's'}</span>}</div>
        <ContactPicker customers={customers} professionals={professionals} selected={selected} onToggle={toggle} />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-secondary text-sm" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="button" className="btn-primary text-sm inline-flex items-center gap-1.5" disabled={!canCreate}
          onClick={() => onCreate({ subject: subject.trim(), description: description.trim(), participants: selected })}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Crear grupo
        </button>
      </div>
    </div>
  );
}

function ManageGroup({ group, customers, professionals, busy, onOpenChat, onSync, onSaveDetails, onInvite, onAdd, onRemove, onArchive }) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(group.subject || '');
  const [description, setDescription] = useState(group.description || '');
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState([]);
  useEffect(() => { setSubject(group.subject || ''); setDescription(group.description || ''); }, [group.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rosterPhones = useMemo(() => (group.participants || []).map((p) => p.phone), [group.participants]);
  const copyLink = () => { if (group.inviteLink) navigator.clipboard?.writeText(group.inviteLink).catch(() => {}); };

  return (
    <div className="space-y-4">
      {/* Header card: subject/description + quick actions. */}
      <div className="rounded-lg border border-ink-100 p-3">
        {editing ? (
          <div className="space-y-2">
            <input className="input w-full text-sm" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={100} placeholder="Nombre del grupo" />
            <textarea className="input w-full min-h-14 text-sm" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Descripción" />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost text-xs" onClick={() => { setEditing(false); setSubject(group.subject || ''); setDescription(group.description || ''); }}>Cancelar</button>
              <button type="button" className="btn-primary text-xs inline-flex items-center gap-1" disabled={busy || !subject.trim()}
                onClick={async () => { await onSaveDetails({ subject: subject.trim(), description: description.trim() }); setEditing(false); }}>
                <Check size={13} /> Guardar
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Users size={18} /></span>
            <div className="min-w-0 flex-1">
              <div className="font-display font-semibold text-sm text-ink-900 truncate">{group.subject}</div>
              <div className="text-[11px] text-ink-400">{group.participantCount} participante{group.participantCount === 1 ? '' : 's'}{group.isAdmin ? ' · eres administrador' : ''}</div>
              {group.description && <p className="text-xs text-ink-600 mt-1 whitespace-pre-wrap">{group.description}</p>}
            </div>
            <button type="button" className="btn-ghost text-xs shrink-0 inline-flex items-center gap-1" onClick={() => setEditing(true)} title="Editar grupo" aria-label="Editar grupo"><Pencil size={13} /></button>
          </div>
        )}
      </div>

      {/* Quick actions row. */}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={onOpenChat}><MessageCircle size={14} /> Abrir chat</button>
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={onSync} disabled={busy}><RefreshCw size={14} /> Sincronizar</button>
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={onArchive} disabled={busy}>
          {group.status === 'archived' ? <><ArchiveRestore size={14} /> Reactivar</> : <><Archive size={14} /> Archivar</>}
        </button>
      </div>

      {/* Invite link. */}
      <div>
        <div className="eyebrow-xs mb-1.5">Enlace de invitación</div>
        {group.inviteLink ? (
          <div className="flex items-center gap-2">
            <input className="input flex-1 text-xs" value={group.inviteLink} readOnly onFocus={(e) => e.target.select()} />
            <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" onClick={copyLink} title="Copiar enlace" aria-label="Copiar enlace"><Copy size={13} /></button>
            <button type="button" className="btn-ghost text-xs inline-flex items-center gap-1" onClick={() => onInvite(true)} disabled={busy} title="Regenerar (revoca el anterior)" aria-label="Regenerar enlace (revoca el anterior)"><RefreshCw size={13} /></button>
          </div>
        ) : (
          <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={() => onInvite(false)} disabled={busy}>
            <Link2 size={14} /> Obtener enlace
          </button>
        )}
      </div>

      {/* Roster. */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="eyebrow-xs">Participantes</div>
          <button type="button" className="btn-ghost text-xs inline-flex items-center gap-1" onClick={() => { setAdding((a) => !a); setToAdd([]); }}>
            {adding ? <><X size={13} /> Cerrar</> : <><UserPlus size={13} /> Agregar</>}
          </button>
        </div>
        {adding && (
          <div className="mb-3 rounded-lg border border-ink-100 p-2.5">
            <ContactPicker customers={customers} professionals={professionals} selected={toAdd} excludePhones={rosterPhones}
              onToggle={(phone) => setToAdd((s) => (s.includes(phone) ? s.filter((p) => p !== phone) : [...s, phone]))} />
            <div className="flex justify-end pt-2">
              <button type="button" className="btn-primary text-xs inline-flex items-center gap-1" disabled={busy || !toAdd.length}
                onClick={async () => { await onAdd(toAdd); setToAdd([]); setAdding(false); }}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Agregar {toAdd.length || ''}
              </button>
            </div>
          </div>
        )}
        <div className="space-y-0.5 max-h-[34vh] overflow-y-auto -mx-1 px-1">
          {(group.participants || []).map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-ink-50/60">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-800 text-[11px] font-semibold">{initials(p.name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink-900 truncate">{p.name}{p.role === 'admin' && <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-emerald-700"><ShieldCheck size={10} /> Admin</span>}</span>
                <span className="block text-[11px] text-ink-400">{displayPhone(p.phone)}</span>
              </span>
              {group.isAdmin && (
                <button type="button" className="p-1.5 rounded text-ink-400 hover:text-red-600 hover:bg-red-50 shrink-0" disabled={busy}
                  onClick={() => onRemove(p.phone)} title="Eliminar del grupo" aria-label={`Eliminar a ${p.name}`}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
          {!(group.participants || []).length && <p className="text-xs text-ink-400 text-center py-6">Sin participantes sincronizados. Usa “Sincronizar”.</p>}
        </div>
      </div>
    </div>
  );
}
