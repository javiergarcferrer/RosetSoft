import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Shield, Users as UsersIcon, Check, X, Mail, UserPlus, Loader2, Trash2, Pencil } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, dedupeProfilesByEmail } from '../../db/database.js';
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
  const [cleanupNote, setCleanupNote] = useState(null);

  // Always run the live query — early-return below would short-circuit the
  // hook and React would complain about a changing hook count if the role
  // flips at runtime (e.g. a profile refresh after this page mounts).
  const { data: profiles, loaded } = useLiveQueryStatus(
    () => db.profiles.toArray(),
    [],
    [],
  );

  // Once-per-mount sweep: if Postgres has any same-email duplicate
  // profile rows (a recurring symptom of the previous broken delete
  // path until migration 20260518150000 lands), clean them up here
  // so the list this page renders is the honest, one-row-per-person
  // truth. We surface a banner with the count so the admin can see
  // it happened — no silent fixes that hide history.
  const sweepRan = useRef(false);
  useEffect(() => {
    if (!isAdmin || sweepRan.current) return;
    sweepRan.current = true;
    (async () => {
      try {
        const deleted = await dedupeProfilesByEmail();
        if (deleted.length) {
          setCleanupNote(
            `Se eliminaron ${deleted.length} perfil${deleted.length === 1 ? '' : 'es'} duplicado${deleted.length === 1 ? '' : 's'} con el mismo correo.`,
          );
          await refreshProfiles();
        }
      } catch (e) {
        console.warn('[users] dedupe failed:', e);
      }
    })();
  }, [isAdmin, refreshProfiles]);

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

      {cleanupNote && (
        <div
          role="status"
          className="mb-4 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 flex items-start gap-2"
        >
          <Check size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">Limpieza automática</div>
            <div className="mt-0.5">{cleanupNote}</div>
          </div>
          <button
            type="button"
            onClick={() => setCleanupNote(null)}
            className="btn-icon -my-1.5 text-amber-700 hover:text-amber-900 hover:bg-amber-100 active:bg-amber-200"
            aria-label="Cerrar"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={4} /></div>
      ) : realProfiles.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="Sin usuarios"
          description="Invita a tu equipo con el botón “Invitar usuario”."
        />
      ) : (
        <div className="space-y-8">
          {invited.length > 0 && (
            <section>
              <SectionHeader
                title="Invitaciones enviadas"
                count={invited.length}
                tone="sent"
                hint="Aún no han iniciado sesión con el enlace del correo."
              />
              <ul className="space-y-3">
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

          <section>
            <SectionHeader title="Activos" count={active.length} />
            {active.length === 0 ? (
              <div className="rounded-xl border border-dashed border-ink-200 bg-surface px-5 py-12 text-center text-sm text-ink-400">
                Aún no hay usuarios activos.
              </div>
            ) : (
              <ul className="space-y-3">
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

/**
 * Standalone section label that sits ABOVE a stack of user cards.
 * Each user is now its own card, so the heading can't live inside a
 * shared `card-header` anymore — it floats over the stack instead.
 * Title + count on the left, an optional helper hint on the right
 * (desktop only, where there's room for it).
 */
function SectionHeader({ title, count, tone = 'default', hint }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3 px-0.5">
      <div className="flex items-center gap-2">
        <h2 className="eyebrow font-semibold text-ink-700">{title}</h2>
        <span className={tone === 'sent' ? 'status-pill status-pill-sent' : 'badge'}>
          {count}
        </span>
      </div>
      {hint && <p className="hidden sm:block text-xs text-ink-400 italic">{hint}</p>}
    </div>
  );
}

function Avatar({ name, email, role }) {
  const seed = (name || email || '?').trim();
  const initials = seed
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
  // Admins get a brand-tinted chip so the team hierarchy reads at a
  // glance — even before the eye lands on the role select. Everyone
  // else stays neutral ink. The inset ring gives the disc a crisp
  // edge against the card instead of floating as a flat blob.
  const tint = role === 'admin'
    ? 'bg-brand-100 text-brand-700 ring-brand-200/70'
    : 'bg-ink-100 text-ink-700 ring-ink-200/70';
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center w-10 h-10 rounded-full ring-1 ring-inset text-[13px] font-semibold shrink-0 ${tint}`}
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
  if (role === 'accounting') {
    return (
      <span className="badge">
        Contabilidad
      </span>
    );
  }
  return (
    <span className="badge">
      Vendedor
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
  // savedField names the column the user just edited inline — the row
  // flashes a brief "Guardado" badge next to it so it's obvious the
  // write went through. Without this, the previous design was so
  // visually quiet that the dealer assumed name editing was broken
  // and asked for it to be "fixed" three times in a row.
  const [savedField, setSavedField] = useState(null);

  // updated_at is bumped by the profiles_set_updated_at trigger; the
  // client never has to stamp it. Every inline editor routes through
  // this helper so a failed write surfaces in the row instead of
  // silently disappearing into the console.
  async function commit(patch, field) {
    setError(null);
    try {
      await db.profiles.update(profile.id, patch);
      setSavedField(field);
      setTimeout(() => {
        setSavedField((cur) => (cur === field ? null : cur));
      }, 1600);
    } catch (e) {
      setError(userMessageFor(e));
    }
  }

  async function setName(raw) {
    const name = (raw || '').trim();
    if (!name || name === (profile.name || '')) return;
    await commit({ name }, 'name');
  }

  async function setRole(role) {
    if (role === profile.role) return;
    await commit({ role }, 'role');
  }

  async function setCommission(raw) {
    // Cap at the DB's CHECK constraint (`commission_pct <= 50` from
    // migration 20260518110000). Without the explicit max here, a
    // dealer typing 80 would clamp client-side to 80 (clampPct's
    // default ceiling is 100), then the DB would reject with a
    // check_violation and the inline-edit handler would surface a
    // cryptic Postgres error. Capping at 50 keeps client + DB in
    // sync and the input's max="50" matches.
    const pct = clampPct(raw, 50);
    // The profiles list arrives through fromRow() which camelCases
    // every column — read + write both use the JS-side name. The
    // previous snake_case `commission_pct` here always read
    // undefined→0, so the input flickered back to 0 on every refetch
    // and the dealer assumed the save had failed. The write still
    // landed in the DB (toRow's snake() is idempotent on already-
    // snake_case keys) — the visual divergence was the entire bug.
    if (pct === (profile.commissionPct ?? 0)) return;
    await commit({ commissionPct: pct }, 'commission');
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
      setError(userMessageFor(e));
      setBusy(false);
    }
  }

  // Each user now lives in its own card — the dealer asked to "separate
  // the user cards", so the old hairline-divided rows-in-one-card give
  // way to a stack of standalone cards. Three visual states:
  //   self     — warm brand-tinted card so you spot your own row instantly
  //   invited  — dashed border, reads as provisional until first sign-in
  //   default  — plain white card whose border firms up on hover
  const cardClass = [
    'card card-pad transition-all duration-150',
    invitePending
      ? 'border-dashed border-ink-300 bg-ink-50/30'
      : isSelf
        ? 'border-brand-200 bg-brand-50/40 shadow-xs'
        : 'hover:shadow-soft hover:border-ink-200',
  ].join(' ');

  return (
    <li className={cardClass}>
      {/* Row layout — two sections that stack on mobile and sit
          side-by-side on lg+. Earlier the controls cluster used a
          single flex-wrap and the ActivePill collided with the name
          input + the role select truncated at w-36 ("Co... dad"
          where "Contabilidad" should have rendered). The new
          structure: Identity on top (avatar + name + email +
          status pill), Controls below (role, commission, activity
          info, delete). Each section is a self-contained flex row
          so wrap behaviour is local and predictable. */}
      <div className="flex flex-col xl:flex-row xl:items-center xl:gap-6">
        {/* Identity */}
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <Avatar name={profile.name} email={profile.email} role={profile.role} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              {/* Visibly an input at rest — light grey border + pencil
                  icon — so the admin doesn't have to guess that the
                  name is editable. The previous "transparent until
                  focused" look read as a label and the dealer kept
                  reporting that name editing didn't work.

                  The wrapper takes `flex-1 min-w-0` (with a
                  `basis-full sm:basis-auto` so it owns its own line on
                  the narrowest screens before the "(tú)"/badge chips
                  wrap beside it) so the input's `w-full` resolves
                  against the real available width instead of collapsing
                  to its content min-width — that collapse was crushing
                  the name down to "Ja"/"Te" on mobile. */}
              <div className="relative group flex-1 min-w-0 basis-full sm:basis-auto">
                <DebouncedInput
                  type="text"
                  value={profile.name || ''}
                  onCommit={setName}
                  className="font-bold text-sm bg-surface border border-ink-200 rounded-md pl-2.5 pr-7 py-1 focus:outline-none focus:ring-2 focus:ring-brand-400/40 focus:border-brand-400 hover:border-ink-300 transition-colors min-w-0 w-full max-w-[220px]"
                  placeholder={profile.email || 'Sin nombre'}
                  aria-label="Nombre del usuario"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Pencil
                  size={12}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-300 group-focus-within:text-brand-500 pointer-events-none"
                  aria-hidden
                />
              </div>
              {savedField === 'name' && (
                <span
                  role="status"
                  className="inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-1.5 py-0.5 flex-shrink-0"
                >
                  <Check size={11} /> Guardado
                </span>
              )}
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
              <div className="text-xs text-ink-500 truncate mt-1">{profile.email}</div>
            )}
          </div>
        </div>

        {/* Controls.
            Stacked into a labelled grid on mobile (each field on its
            own row with a small caption) so nothing has to compete
            for horizontal space, then collapsed back to a compact
            inline row on lg+. The previous "single flex-wrap" tried
            to do both at once and the ActivePill kept landing in
            the gap between the role select and the name — the
            screenshot the dealer sent shows "Pendiente" floating
            mid-row over the truncated name input. */}
        <div className="mt-4 pt-4 border-t border-ink-100 xl:mt-0 xl:pt-0 xl:border-t-0 grid grid-cols-2 gap-3 lg:flex lg:flex-wrap lg:items-center lg:gap-4 lg:justify-end">
          <label className="flex flex-col gap-1 lg:contents">
            <span className="eyebrow-xs lg:hidden">
              Rol
            </span>
            <select
              className="input py-1.5 w-full lg:w-44"
              value={
                profile.role === 'admin' || profile.role === 'accounting'
                  ? profile.role
                  : 'employee'
              }
              onChange={(e) => setRole(e.target.value)}
              aria-label="Rol del usuario"
            >
              <option value="employee">Vendedor</option>
              <option value="admin">Administrador</option>
              <option value="accounting">Contabilidad</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 lg:contents">
            <span className="eyebrow-xs lg:hidden">
              Comisión
            </span>
            <div className="relative">
              <DebouncedInput
                type="number"
                inputMode="decimal"
                min="0"
                max="50"
                step="0.5"
                className="input py-1.5 pr-7 tabular-nums w-full lg:w-20"
                value={profile.commissionPct ?? 0}
                onCommit={setCommission}
                aria-label="Comisión"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-500">%</span>
            </div>
          </label>

          {/* Activity status — pinned to the right on lg+, full width
              row on mobile so the timestamp doesn't get squeezed. */}
          <div className="col-span-2 lg:col-auto flex flex-col gap-0.5 lg:items-end">
            <ActivePill profile={profile} />
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

          <div className="col-span-2 lg:col-auto flex lg:justify-end">
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
        <div role="alert" className="mt-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1">
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

// `RolePill` is kept here for future use in a more compact row layout;
// ignore the unused lint locally.
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
    const trimmedEmail = email.trim();
    const trimmedName  = name.trim();
    if (!trimmedName || !trimmedEmail) {
      setError('Nombre y correo son obligatorios.');
      return;
    }
    setBusy(true);
    try {
      // Client-side pre-flight: scan the local view of profiles for
      // this email (case-insensitive) before we even hit the edge
      // function. The edge function does the same check server-side
      // and the DB has a unique-email index, but bouncing here gives
      // the admin instant feedback ("ya está registrado") and avoids
      // racing the round-trip when the orphan-cleanup hasn't run
      // yet. The supabase-js call below selects directly from
      // Postgres — no local cache.
      const lowered = trimmedEmail.toLowerCase();
      const all = await db.profiles.toArray();
      const realCollisions = all.filter(
        (p) => p.id !== 'team' && (p.email || '').toLowerCase() === lowered,
      );
      if (realCollisions.length > 0) {
        const winner = realCollisions[0];
        if (winner.active) {
          throw new Error(
            `Ya existe un usuario activo con ese correo (${winner.name || trimmedEmail}). No se puede invitar otra vez.`,
          );
        }
        throw new Error(
          `Ya existe una invitación pendiente para ${trimmedEmail}. ` +
          `Cancélala primero desde la lista si quieres re-enviarla.`,
        );
      }

      await inviteUser({
        session,
        email: trimmedEmail,
        name: trimmedName,
        role,
        commissionPct: clampPct(pct),
      });
      setSuccess(`Invitación enviada a ${trimmedEmail}. Recibirá un correo con un enlace para entrar.`);
      onInvited?.();
      // Auto-close after a beat so the admin sees the success message
      // before the modal disappears.
      setTimeout(() => { onClose?.(); reset(); }, 1400);
    } catch (e) {
      setError(userMessageFor(e));
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

        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3">
          <div>
            <div className="label">Rol</div>
            <select
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="employee">Vendedor</option>
              <option value="admin">Administrador</option>
              <option value="accounting">Contabilidad</option>
            </select>
          </div>
          <div>
            <div className="label">Comisión (%)</div>
            <input
              type="number"
              min="0"
              max="50"
              step="0.5"
              inputMode="decimal"
              enterKeyHint="done"
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
