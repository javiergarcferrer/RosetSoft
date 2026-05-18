import { useMemo, useState } from 'react';
import { Shield, Users as UsersIcon, Check, X, UserCheck, Mail, UserPlus, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import Modal from '../../components/Modal.jsx';
import { DebouncedInput } from '../../components/DebouncedInput.jsx';
import { inviteUser } from '../../lib/invite.js';

/**
 * Admin-only users management.
 *
 * The 'team' profile is a shared settings holder, not a real user — it's
 * filtered out of every list and count on this page. Real users (admin /
 * employee) are split into "Pendientes" (active=false, awaiting approval)
 * and "Activos". Soft delete only: a deactivated user becomes "pending"
 * again, never gone.
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

  // Three buckets, identified by (active, lastSignInAt):
  //
  //   invited     — active=false, lastSignInAt=null. Admin sent an
  //                 invitation, but the invitee has never clicked the
  //                 magic link. ensureDefaultProfile() promotes these
  //                 to active=true on first sign-in, so this bucket
  //                 self-empties as the invitees accept.
  //
  //   active      — active=true. Has signed in at least once and is
  //                 currently part of the team. Counts toward
  //                 commissions, shows up everywhere employees do.
  //
  //   deactivated — active=false, lastSignInAt is set. The admin
  //                 disabled them after they joined. Kept around so
  //                 historical commission reports still resolve names,
  //                 but rendered in a muted "Inactivos" section at
  //                 the bottom.
  const invited     = sorted.filter((p) => !p.active && !p.lastSignInAt);
  const active      = sorted.filter((p) => p.active);
  const deactivated = sorted.filter((p) => !p.active && p.lastSignInAt);

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
              deactivated.length > 0 ? `${deactivated.length} desactivados` : null,
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
          description="Los usuarios que inicien sesión aparecerán aquí pendientes de aprobación."
        />
      ) : (
        <div className="space-y-6">
          {invited.length > 0 && (
            <section className="card overflow-hidden">
              <header className="px-5 py-3 border-b border-ink-100 bg-blue-50 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-blue-700">Invitaciones enviadas</h2>
                  <span className="inline-flex items-center rounded-md bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                    {invited.length}
                  </span>
                </div>
                <p className="hidden sm:block text-xs text-blue-700/80">
                  Aún no han iniciado sesión con el enlace del correo.
                </p>
              </header>
              <ul className="divide-y divide-ink-100">
                {invited.map((p) => (
                  <ActiveRow
                    key={p.id}
                    profile={p}
                    isSelf={p.id === currentProfile.id}
                    invitePending
                  />
                ))}
              </ul>
            </section>
          )}

          <section className="card overflow-hidden">
            <header className="px-5 py-3 border-b border-ink-100 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink-900">Activos</h2>
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
                    isSelf={p.id === currentProfile.id}
                  />
                ))}
              </ul>
            )}
          </section>

          {deactivated.length > 0 && (
            <section className="card overflow-hidden opacity-80">
              <header className="px-5 py-3 border-b border-ink-100 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-ink-700">Desactivados</h2>
                <span className="badge">{deactivated.length}</span>
              </header>
              <ul className="divide-y divide-ink-100">
                {deactivated.map((p) => (
                  <ActiveRow
                    key={p.id}
                    profile={p}
                    isSelf={p.id === currentProfile.id}
                  />
                ))}
              </ul>
            </section>
          )}
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
      <span className="inline-flex items-center rounded-md bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
        Administrador
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-700">
      Empleado
    </span>
  );
}

function ActivePill({ active }) {
  return active ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" aria-hidden />
      Activo
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600">
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

function ActiveRow({ profile, isSelf, invitePending }) {
  async function setRole(role) {
    if (role === profile.role) return;
    await db.profiles.update(profile.id, { role, updatedAt: Date.now() });
  }

  async function setCommission(raw) {
    const pct = clampPct(raw);
    if (pct === (profile.commission_pct ?? 0)) return;
    await db.profiles.update(profile.id, {
      commission_pct: pct,
      updatedAt: Date.now(),
    });
  }

  async function toggleActive() {
    if (isSelf) return; // defensive — button is disabled too
    // Whichever direction we're flipping in, ask first. Misclicks
    // would have visible consequences (locked-out employee, or
    // unexpected re-activation of a former hire).
    const verb = profile.active ? 'Desactivar' : 'Reactivar';
    const consequence = profile.active
      ? 'Perderá acceso al sistema hasta que lo reactives.'
      : 'Volverá a tener acceso con su rol y comisión actuales.';
    if (!confirm(`¿${verb} a "${profile.name || profile.email}"? ${consequence}`)) return;
    await db.profiles.update(profile.id, {
      active: !profile.active,
      updatedAt: Date.now(),
    });
  }

  async function cancelInvite() {
    if (!confirm(`¿Cancelar la invitación a "${profile.name || profile.email}"? Se eliminará el registro; tendrás que invitarlo de nuevo si cambias de opinión.`)) return;
    await db.profiles.delete(profile.id);
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {/* Identity */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Avatar name={profile.name} email={profile.email} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className="font-medium text-sm truncate">
                {profile.name || profile.email || 'Sin nombre'}
              </span>
              {isSelf && (
                <span className="text-[11px] text-ink-500">(tú)</span>
              )}
              {invitePending && (
                <span className="inline-flex items-center rounded-md bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                  Sin aceptar
                </span>
              )}
            </div>
            {profile.email && profile.name && (
              <div className="text-xs text-ink-500 truncate">{profile.email}</div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-2 sm:flex sm:items-center gap-3">
          <div className="sm:w-40">
            <div className="label sm:hidden">Rol</div>
            <select
              className="input py-1.5"
              value={profile.role === 'admin' ? 'admin' : 'employee'}
              onChange={(e) => setRole(e.target.value)}
              aria-label="Rol del usuario"
            >
              <option value="employee">Empleado</option>
              <option value="admin">Administrador</option>
            </select>
            <div className="hidden sm:block mt-1">
              <RolePill role={profile.role} />
            </div>
          </div>

          <div>
            <div className="label sm:hidden">Comisión</div>
            <div className="relative">
              <DebouncedInput
                type="number"
                inputMode="decimal"
                min="0"
                max="50"
                step="0.5"
                className="input py-1.5 pr-7 tabular-nums w-24"
                value={profile.commission_pct ?? 0}
                onCommit={setCommission}
                aria-label="Comisión"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-500">%</span>
            </div>
          </div>

          <div className="col-span-2 sm:col-span-1 flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
            <div className="flex flex-col items-start sm:items-end gap-1">
              <ActivePill active={profile.active} />
              <span className="text-[11px] text-ink-500">
                {profile.lastSignInAt
                  ? <>Última sesión {fmtUpdated(profile.lastSignInAt)}</>
                  : invitePending
                    ? 'Sin iniciar sesión todavía'
                    : <>Actualizado {fmtUpdated(profile.updatedAt)}</>}
              </span>
            </div>

            {invitePending ? (
              <button
                type="button"
                onClick={cancelInvite}
                title="Cancelar invitación"
                className="btn-ghost text-red-600 hover:bg-red-50"
              >
                <X size={14} /> Cancelar invitación
              </button>
            ) : (
              <button
                type="button"
                onClick={toggleActive}
                disabled={isSelf}
                title={isSelf
                  ? 'No puedes desactivar tu propia cuenta'
                  : (profile.active ? 'Desactivar usuario' : 'Reactivar usuario')}
                className={`btn-ghost disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${
                  profile.active
                    ? 'text-red-600 hover:bg-red-50'
                    : 'text-emerald-700 hover:bg-emerald-50'
                }`}
              >
                <X size={14} /> {profile.active ? 'Desactivar' : 'Reactivar'}
              </button>
            )}
          </div>
        </div>
      </div>
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

// `Check` is imported but kept here intentionally to allow future use in
// approval confirmation flows; ignore the unused-import lint locally.
void Check;

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
