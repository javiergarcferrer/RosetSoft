import { useMemo, useState } from 'react';
import { Shield, Users as UsersIcon, Check, X, UserCheck } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { DebouncedInput } from '../../components/DebouncedInput.jsx';

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
  const { currentProfile } = useApp();
  const isAdmin = currentProfile?.role === 'admin';

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

  const pending = sorted.filter((p) => !p.active);
  const active = sorted.filter((p) => p.active);

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
        subtitle={loaded ? `${active.length} activos · ${pending.length} pendientes` : ' '}
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
          {pending.length > 0 && (
            <section className="card overflow-hidden">
              <header className="px-5 py-3 border-b border-ink-100 bg-amber-50 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-amber-700">Pendientes de aprobación</h2>
                  <span className="inline-flex items-center rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                    {pending.length}
                  </span>
                </div>
                <p className="hidden sm:block text-xs text-amber-700/80">
                  Asigna rol y comisión antes de aprobar.
                </p>
              </header>
              <ul className="divide-y divide-ink-100">
                {pending.map((p) => (
                  <PendingRow
                    key={p.id}
                    profile={p}
                    approvedBy={currentProfile.id}
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

/* -------------------------------------------------------------------------- */
/*  Pending row                                                               */
/* -------------------------------------------------------------------------- */

function PendingRow({ profile, approvedBy }) {
  // Inline form holds the proposed role + commission until the admin clicks
  // "Aprobar"; we don't write anything until then so a half-filled form
  // can't accidentally flip `active` on.
  const [role, setRole] = useState('employee');
  const [commission, setCommission] = useState('0');
  const [busy, setBusy] = useState(false);

  async function approve() {
    if (busy) return;
    setBusy(true);
    try {
      const pct = clampPct(commission);
      await db.profiles.update(profile.id, {
        active: true,
        role,
        commission_pct: pct,
        invited_by: approvedBy,
        updatedAt: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Avatar name={profile.name} email={profile.email} />
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">
              {profile.name || profile.email || 'Sin nombre'}
            </div>
            {profile.email && profile.name && (
              <div className="text-xs text-ink-500 truncate">{profile.email}</div>
            )}
            <div className="text-[11px] text-ink-500 mt-0.5">
              Solicitado {fmtUpdated(profile.createdAt || profile.updatedAt)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:flex sm:items-end gap-3">
          <div>
            <div className="label">Rol</div>
            <select
              className="input py-1.5"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={busy}
            >
              <option value="employee">Empleado</option>
              <option value="admin">Administrador</option>
            </select>
          </div>
          <div>
            <div className="label">Comisión</div>
            <div className="relative">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="50"
                step="0.5"
                className="input py-1.5 pr-7 tabular-nums w-24"
                value={commission}
                onChange={(e) => setCommission(e.target.value)}
                disabled={busy}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-500">%</span>
            </div>
          </div>
          <button
            type="button"
            onClick={approve}
            disabled={busy}
            className="btn-primary col-span-2 sm:col-span-1 justify-center disabled:opacity-50"
          >
            <UserCheck size={14} /> Aprobar
          </button>
        </div>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Active row                                                                */
/* -------------------------------------------------------------------------- */

function ActiveRow({ profile, isSelf }) {
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

  async function deactivate() {
    if (isSelf) return; // defensive — button is disabled too
    if (!confirm(`¿Desactivar a "${profile.name || profile.email}"? Quedará pendiente de aprobación.`)) return;
    await db.profiles.update(profile.id, {
      active: false,
      updatedAt: Date.now(),
    });
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {/* Identity */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Avatar name={profile.name} email={profile.email} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-medium text-sm truncate">
                {profile.name || profile.email || 'Sin nombre'}
              </span>
              {isSelf && (
                <span className="text-[11px] text-ink-500">(tú)</span>
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
              <ActivePill active />
              <span className="text-[11px] text-ink-500">
                Actualizado {fmtUpdated(profile.updatedAt)}
              </span>
            </div>

            <button
              type="button"
              onClick={deactivate}
              disabled={isSelf}
              title={isSelf ? 'No puedes desactivar tu propia cuenta' : 'Desactivar usuario'}
              className="btn-ghost text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <X size={14} /> Desactivar
            </button>
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
