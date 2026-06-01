import { useMemo, useState } from 'react';
import { Shield, BookText, Search } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { buildChartIndex, chartRoots, ACCOUNT_CLASS_NAMES } from '../../core/accounting/index.js';

/**
 * Catálogo de cuentas — the read-only chart of accounts (seeded from the
 * advisor's DGII IR-2-aligned plan). A collapsible tree in catálogo order;
 * searching flattens to matching code/name. Title accounts are muted, postable
 * leaves are emphasized (only leaves take postings). Self-gates on the
 * accounting/admin role.
 */
const CLASS_TONE = {
  1: 'bg-sky-100 text-sky-700',
  2: 'bg-amber-100 text-amber-700',
  3: 'bg-violet-100 text-violet-700',
  4: 'bg-emerald-100 text-emerald-700',
  5: 'bg-rose-100 text-rose-700',
  6: 'bg-orange-100 text-orange-700',
};

function AccountNode({ node, index, depth }) {
  const [open, setOpen] = useState(depth < 2);
  const children = index.childrenByParent.get(node.code) || [];
  const hasChildren = children.length > 0;
  return (
    <div>
      <div
        className={`flex items-center gap-2 py-1.5 border-b border-ink-50 ${hasChildren ? 'cursor-pointer' : ''}`}
        style={{ paddingLeft: `${depth * 18}px` }}
        onClick={hasChildren ? () => setOpen((v) => !v) : undefined}
      >
        <span className="text-ink-400 w-3 text-xs">{hasChildren ? (open ? '▾' : '▸') : ''}</span>
        <code className="text-xs text-ink-500 tabular-nums">{node.code}</code>
        <span className={node.isPostable ? 'text-sm text-ink-800' : 'text-sm font-semibold text-ink-900'}>
          {node.name}
        </span>
        {node.isPostable && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-400">imputable</span>
        )}
      </div>
      {open && hasChildren && children.map((c) => (
        <AccountNode key={c.code} node={c} index={index} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function ChartOfAccounts() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';

  const accountsQ = useLiveQueryStatus(
    () => db.accounts.where('profileId').equals(profileId || 'team').toArray(),
    [profileId], [],
  );
  const [q, setQ] = useState('');

  const index = useMemo(() => buildChartIndex(accountsQ.data), [accountsQ.data]);
  const roots = useMemo(() => chartRoots(index), [index]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    return accountsQ.data
      .filter((a) => a.code.includes(needle) || (a.name || '').toLowerCase().includes(needle))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [q, accountsQ.data]);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Catálogo de cuentas" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const total = accountsQ.data.length;
  const leaves = accountsQ.data.filter((a) => a.isPostable).length;

  return (
    <>
      <PageHeader
        title="Catálogo de cuentas"
        subtitle={accountsQ.loaded ? `${total} cuentas · ${leaves} imputables · ${total - leaves} de título` : ' '}
      />

      <div className="relative mb-4 max-w-md">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por código o nombre…"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
        />
      </div>

      {!accountsQ.loaded ? (
        <ListLoading />
      ) : total === 0 ? (
        <EmptyState icon={BookText} title="Catálogo vacío"
          description="El catálogo de cuentas aún no se ha sembrado." />
      ) : matches ? (
        <div className="card p-4">
          {matches.length === 0 ? (
            <p className="text-sm text-ink-500 py-6 text-center">Sin coincidencias para “{q}”.</p>
          ) : matches.map((a) => (
            <div key={a.code} className="flex items-center gap-3 py-1.5 border-b border-ink-50">
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${CLASS_TONE[a.class] || 'bg-ink-100 text-ink-600'}`}>
                {ACCOUNT_CLASS_NAMES[a.class] || a.class}
              </span>
              <code className="text-xs text-ink-500 tabular-nums">{a.code}</code>
              <span className={a.isPostable ? 'text-sm text-ink-800' : 'text-sm font-semibold'}>{a.name}</span>
              {a.isPostable && <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-400">imputable</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="card p-4 space-y-4">
          {roots.map((root) => (
            <div key={root.code}>
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${CLASS_TONE[root.class] || 'bg-ink-100 text-ink-600'}`}>
                  {ACCOUNT_CLASS_NAMES[root.class] || root.class}
                </span>
              </div>
              <AccountNode node={root} index={index} depth={0} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
