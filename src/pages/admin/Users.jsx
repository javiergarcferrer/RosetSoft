import { useMemo, useState } from 'react';
import { Shield, Users as UsersIcon, Check, X, Mail, UserPlus, Loader2, Trash2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import Modal from '../../components/Modal.jsx';
import { DebouncedInput } from '../../components/DebouncedInput.jsx';
import { inviteUser, deleteUser } from '../../lib/invite.js';

/**
 * Admin-only users management.
 *
 * The 'team' profile is a shared settings holder, not a real user — it's
 * filtered out of every list and count on this page. Real users (admin /
 * employee) live in one of two buckets:
 *
 *   invitados   — invitation sent, never accepted (active=false,
 *                 last_sign_in_at=null). Cancelling here hard-deletes
 *                 both the auth.users row and the profile row.
 *   activos     — currently working on the team (signed in at least
 *                 once, active=true).
 *
 * "Eliminar usuario" is a true hard-delete: the auth.users row goes
 * (via the delete-user Edge Function) and the profile row goes too
 * (via the on_auth_user_deleted cascade trigger in migration
 * 20260518150000, with a belt-and-suspenders explicit delete in the
 * function). Quote attribution via quotes.created_by_user_id falls
 * back to NULL — the commissions report skips quotes with no
 * resolvable creator, which is the right outcome when the dealer is
 * no longer with the team.
 *
 * Names, roles, and commission percentages are editable inline; the
 * profile row is the source of truth on the dealer side and RLS
 * allows authenticated team members to write each other's rows. The
 * `updated_at` column gets bumped automatically by the
 * profiles_set_updated_at Postgres trigger, so the client never has
 * to stamp it.
 */
export default function AdminUsers() {
  const { currentProfile, refreshProfiles } = useApp();
  const { session } = useAuth();
  const isAdmin = currentProfile?.role === 'admin';
  const [inviteOpen, setInviteOpen] = useState(false);

  // Always run the live query — early-return below would short-circuit the
  // hook and React would complain about a changing hook count if the role
  // flips at runtime (e.g. a profile refresh after this page mounts).
  const { data: profiles, loaded } = useLiveQueryStatus(
    () => db.profiles.toArray(),
    [],
    [],
  );

  const realProfiles = useMemo(
    () => (profiles || []).filter((p) => p.role !== 'team'),
    [profiles],
  );

  // Active first, then by name — keeps the "who's working today" rows at
  // the top of any non-grouped reads of this list.
  const sorted = useMemo(() => {
    const copy = [...realProfiles];
    copy.sort((a, b) => {
      if (!!b.active !== !!a.active) return b.active ? 1 : -1;
      return (a.name || a.email || '').localeCompare(b.name || b.email || '');
    });
    return copy;
  }, [realProfiles]);

  // Two buckets, identified by (active, lastSignInAt):
  //
  //   invited  — active=false, lastSignInAt=null. Admin sent an
  //              invitation, but the invitee has never clicked the
  //              magic link. ensureDefaultProfile() promotes these
  //              to active=true on first sign-in, so this bucket
  //              self-empties as the invitees accept.
  //
  //   active   — active=true. Has signed in at least once and is
  //              currently part of the team. Counts toward
  //              commissions, shows up everywhere employees do.
  //
  // There is no "deactivated" bucket: deletion is symmetric (auth row
  // gone ↔ profile row gone), so a user who's been removed simply
  // disappears from this list entirely. To bring someone back, send
  // them a fresh invite.
  const invited = sorted.filter((p) => !p.active && !p.lastSignInAt);
  const active  = sorted.filter((p) => p.active);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Usuarios" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Solo administradores pueden gestionar usuarios."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Usuarios"
        subtitle={loaded
          ? [
              `${active.length} activos`,
              invited.length > 0 ? `${invited.length} invitación${invited.length === 1 ? '' : 'es'} sin aceptar` : null,
            ].filter(Boolean).join(' · ')
          : ' '}
        actions={
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="btn-primary"
          >
            <UserPlus size={14} /> Invitar usuario
          </button>
        }
      />

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        session={session}
        onInvited={() => refreshProfiles()}
      />

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={4} /></div>
      ) : realProfiles.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="Sin usuarios"
          description="Invita a tu equipo con el botón “Invitar usuario”."
        />
      ) : (
        <div className="space-y-6">
          {invited.length > 0 && (
            <section className="card overflow-hidden">
              <header className="card-header">
                <div className="flex items-center gap-2">
                  <h2>Invitaciones enviadas</h2>
                  <span className="status-pill status-pill-sent">
                    {invited.length}
                  </span>
                </div>
                <p className="hidden sm:block text-xs text-ink-500">
                  Aún no han iniciado sesión con el enlace del correo.
                </p>
              </header>
              <ul className="divide-y divide-ink-100">
                {invited.map((p) => (
                  <ActiveRow
                    key={p.id}
                    profile={p}
                    session={session}
                    isSelf={p.id === currentProfile.id}
                    invitePending
                    onChanged={() => refreshProfiles()}
                  />
                ))}
              </ul>
            </section>
          )}

          <section className="card overflow-hidden">
            <header className="card-header">
              <h2>Activos</h2>
              <span className="badge">{active.length}</span>
            </header>
            {active.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-ink-500">
                Aún no hay usuarios activos.
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {active.map((p) => (
                  <ActiveRow
                    key={p.id}
                    profile={p}
                    session={session}
                    isSelf={p.id === currentProfile.id}
                    onChanged={() => refreshProfiles()}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Row components                                                            */
/* -------------------------------------------------------------------------- */

function Avatar({ name, email }) {
  const seed = (name || email || '?').trim();
  const initials = seed
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-ink-100 text-ink-700 text-xs font-semibold shrink-0"
    >
      {initials}
    </span>
  );
}

function RolePill({ role }) {
  if (role === 'admin') {
    return (
      <span className="badge-brand">
        Administrador
      </span>
    );
  }
  return (
    <span className="badge">
      Empleado
    </span>
  );
}

function ActivePill({ profile }) {
  if (profile.active) {
    return (
      <span className="status-pill status-pill-active">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
        Activo
      </span>
    );
  }
  // active=false reaches the row only via the "invited" bucket now —
  // deactivation hard-deletes, so there's no "former employee" tombstone
  // state anymore. The pill stays as "Pendiente" until first sign-in.
  return (
    <span className="status-pill status-pill-inactive">
      <span className="w-1.5 h-1.5 rounded-full bg-ink-400" aria-hidden />
      Pendiente
    </span>
  );
}

function fmtUpdated(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString('es-DO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

/**
 * Last-sign-in timestamp rendered to the minute, in 12-hour format.
 * Example output: "18 may, 8:26 a. m." — exactly what the dealer
 * asked for when they said "show last active sessions to the minute".
 *
 * We deliberately use es-DO locale + hour12:true so the AM/PM marker
 * stays Spanish. Falls back to the bare date if the browser refuses
 * the locale (defensive — modern engines support es-DO).
 */
function fmtSessionAt(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleString('es-DO', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return new Date(ts).toLocaleString();
  }
}

/**
 * Short relative-time companion to fmtSessionAt — "hace 3 min",
 * "hace 2 horas", "hace 4 días", or null when the timestamp is more
 * than ~30 days ago (the absolute time tells the story at that point).
 * Useful as a secondary line so the admin sees both "8:26 a. m." and
 * "hace 12 min" at a glance.
 */
function fmtSessionAgo(ts) {
  if (!ts) return null;
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 0) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60)        return 'hace unos segundos';
  const min = Math.floor(sec / 60);
  if (min < 60)        return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24)         return `hace ${hr} ${hr === 1 ? 'hora' : 'horas'}`;
  const day = Math.floor(hr / 24);
  if (day < 30)        return `hace ${day} ${day === 1 ? 'día' : 'días'}`;
  return null;
}

function ActiveRow({ profile, session, isSelf, invitePending, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function setName(raw) {
    const name = (raw || '').trim();
    if (!name || name === (profile.name || '')) return;
    // updated_at is bumped by the profiles_set_updated_at trigger; no
    // need to stamp it from the client.
    await db.profiles.update(profile.id, { name });
  }

  async function setRole(role) {
    if (role === profile.role) return;
    await db.profiles.update(profile.id, { role });
  }

  async function setCommission(raw) {
    const pct = clampPct(raw);
    if (pct === (profile.commission_pct ?? 0)) return;
    await db.profiles.update(profile.id, { commission_pct: pct });
  }

  // Hard-delete: removes the auth.users row (so the user can't sign
  // in or recover their password) AND the profile row (so they
  // disappear from this page entirely). Quote attribution on
  // historical quotes becomes NULL via the FK's `on delete set null`;
  // the commissions report skips them, which is the correct outcome.
  async function remove() {
    if (isSelf) return;
    const isInvite = invitePending;
    const label = profile.name || profile.email || 'este usuario';
    const confirmText = isInvite
      ? `¿Cancelar la invitación a “${label}”?\n\n` +
        `Se eliminará el registro y el enlace del correo dejará de funcionar.`
      : `¿Eliminar a “${label}”?\n\n` +
        `Su cuenta de Supabase y su perfil se borrarán por completo. ` +
        `Las cotizaciones que creó se mantienen, pero sin atribución. ` +
        `Para volver a darle acceso tendrás que invitarlo de nuevo.`;
    if (!confirm(confirmText)) return;
    setError(null); setBusy(true);
    try {
      await deleteUser({ session, id: profile.id });
      // Refresh from the AppContext caller so the row disappears from
      // every list, count, and dropdown on the page within one tick.
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'No se pudo eliminar el usuario.');
      setBusy(false);
    }
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {/* Identity — name is inline-editable; the email below is the
            stable handle (it's the auth.users key and can't be
            changed from this page). */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Avatar name={profile.name} email={profile.email} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <DebouncedInput
                type="text"
                value={profile.name || ''}
                onCommit={setName}
                className="font-medium text-sm bg-transparent border-0 px-0 py-0 focus:outline-none focus:ring-0 focus:bg-ink-50 focus:px-1 focus:rounded -mx-0 rounded transition-colors min-w-0 w-full max-w-[220px]"
                placeholder={profile.email || 'Sin nombre'}
                aria-label="Nombre del usuario"
                autoComplete="off"
                spellCheck={false}
              />
              {isSelf && (
                <span className="text-[11px] text-ink-500 flex-shrink-0">(tú)</span>
              )}
              {invitePending && (
                <span className="status-pill status-pill-sent flex-shrink-0">
                  Sin aceptar
                </span>
              )}
            </div>
            {profile.email && (
              <div className="text-xs text-ink-500 truncate">{profile.email}</div>
            )}
          </div>
        </div>

        {/* Controls — single flex-wrap row at every width. The previous
            "grid-on-mobile / flex-on-sm" split made the role select and
            its decorative pill stack on top of the avatar at certain
            widths because the grid item kept rendering the pill
            beneath the select. One flat layout dodges that entirely
            and reads consistently from phone to desktop. */}
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <select
            className="input py-1.5 w-36"
            value={profile.role === 'admin' ? 'admin' : 'employee'}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Rol del usuario"
          >
            <option value="employee">Empleado</option>
            <option value="admin">Administrador</option>
          </select>

          <div className="relative">
            <DebouncedInput
              type="number"
              inputMode="decimal"
              min="0"
              max="50"
              step="0.5"
              className="input py-1.5 pr-7 tabular-nums w-20"
              value={profile.commission_pct ?? 0}
              onCommit={setCommission}
              aria-label="Comisión"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-500">%</span>
          </div>

          <div className="flex items-center gap-3 sm:gap-4 flex-1 sm:flex-initial justify-end">
            <div className="flex flex-col items-start sm:items-end gap-0.5">
              <ActivePill profile={profile} />
              {/* When lastSignInAt is set, we render the precise
                  clock time ("18 may, 8:26 a. m.") + a short
                  relative tag underneath ("hace 12 min"). The dealer
                  asked specifically for "to the minute" — this is
                  it. When the user has never signed in we say so
                  explicitly so the admin can tell at a glance which
                  invitations are still outstanding. */}
              {profile.lastSignInAt ? (
                <>
                  <span className="text-[11px] text-ink-700 tabular-nums">
                    Última sesión · {fmtSessionAt(profile.lastSignInAt)}
                  </span>
                  {fmtSessionAgo(profile.lastSignInAt) && (
                    <span className="text-[10px] text-ink-400">
                      {fmtSessionAgo(profile.lastSignInAt)}
                    </span>
                  )}
                </>
              ) : invitePending ? (
                <span className="text-[11px] text-ink-500">
                  Sin iniciar sesión todavía
                </span>
              ) : (
                <span className="text-[11px] text-ink-500">
                  Actualizado {fmtUpdated(profile.updatedAt)}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={remove}
              disabled={isSelf || busy}
              title={isSelf
                ? 'No puedes eliminar tu propia cuenta'
                : invitePending
                  ? 'Cancelar invitación y eliminar el registro'
                  : 'Eliminar de Supabase Auth y borrar el perfil'}
              className="btn-ghost text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              {busy
                ? <><Loader2 size={14} className="animate-spin" /> Eliminando…</>
                : invitePending
                  ? <><X size={14} /> Cancelar invitación</>
                  : <><Trash2 size={14} /> Eliminar</>}
            </button>
          </div>
        </div>
      </div>
      {error && (
        <div role="alert" className="mt-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </div>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function clampPct(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 50) return 50;
  // Round to one decimal to match the 0.5 step without surfacing FP noise
  // ("12.500000001%") if the input parses oddly on some locales.
  return Math.round(n * 10) / 10;
}

// `Check` and `RolePill` are imported / defined for future use; ignore
// the unused-import lint locally.
void Check;
void RolePill;

// ---------------------------------------------------------------------------
// InviteModal — admin posts here to send a Supabase invite email and
// pre-create the matching profile row. Wraps the `invite-user` Edge
// Function call from lib/invite.js with form state, validation, and
// inline error rendering so the admin sees what went wrong (already-
// invited email, missing service-role secret on the function, etc.)
// without a console dive.
// ---------------------------------------------------------------------------
function InviteModal({ open, onClose, session, onInvited }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('employee');
  const [pct, setPct] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  function reset() {
    setName(''); setEmail(''); setRole('employee'); setPct(10);
    setError(null); setSuccess(null); setBusy(false);
  }

  async function submit() {
    setError(null); setSuccess(null);
    if (!name.trim() || !email.trim()) {
      setError('Nombre y correo son obligatorios.');
      return;
    }
    setBusy(true);
    try {
      await inviteUser({
        session,
        email: email.trim(),
        name: name.trim(),
        role,
        commissionPct: clampPct(pct),
      });
      setSuccess(`Invitación enviada a ${email.trim()}. Recibirá un correo con un enlace para entrar.`);
      onInvited?.();
      // Auto-close after a beat so the admin sees the success message
      // before the modal disappears.
      setTimeout(() => { onClose?.(); reset(); }, 1400);
    } catch (e) {
      setError(e?.message || 'No se pudo enviar la invitación.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) { onClose?.(); reset(); } }}
      title="Invitar usuario"
      size="md"
      footer={
        <>
          <button
            type="button"
            onClick={() => { onClose?.(); reset(); }}
            disabled={busy}
            className="btn-ghost"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="btn-primary disabled:opacity-60 disabled:cursor-wait"
          >
            {busy
              ? <><Loader2 size={14} className="animate-spin" /> Enviando…</>
              : <><Mail size={14} /> Enviar invitación</>}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-500">
          El usuario recibirá un correo con un enlace para crear su contraseña.
          Al iniciar sesión, ya tendrá el rol y la comisión que asignes aquí.
        </p>

        <div>
          <div className="label">Nombre completo</div>
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoCapitalize="words"
            autoComplete="name"
            placeholder="María Peña"
          />
        </div>

        <div>
          <div className="label">Correo electrónico</div>
          <input
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="maria@example.com"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="label">Rol</div>
            <select
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="employee">Empleado</option>
              <option value="admin">Administrador</option>
            </select>
          </div>
          <div>
            <div className="label">Comisión (%)</div>
            <input
              type="number"
              min="0"
              max="50"
              step="0.5"
              className="input tabular-nums"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
            {error}
          </div>
        )}
        {success && (
          <div role="status" className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
            {success}
          </div>
        )}
      </div>
    </Modal>
  );
}
