/**
 * Quick-start arrangements for the Togo configurator — one tap drops a complete,
 * sensible set so a customer reaches a quote without building from a blank plan
 * (the slowest part of the end-to-end flow). Templates are defined by ROLE, matched
 * against each model's name across ES/EN/FR Togo terms, and resolved against the
 * catalogue actually available: a template only appears when every role it needs is
 * present, so it degrades gracefully on any dealer's model set. Pure → unit-tested.
 */

// Most-specific roles first (a "Loveseat" must not fall through to the generic
// "sofa" matcher).
const ROLES = [
  ['corner',   /corner|esquina|d['’]?angle|\bangle\b/i],
  ['lounge',   /lounge|m[eé]ridienne|chaise|div[aá]n|daybed/i],
  ['ottoman',  /ottoman|puff|pouf|otomana|repose|footstool/i],
  ['loveseat', /love\s*seat|loveseat|2\s*(plazas?|seater)|biplaza/i],
  ['fireside', /fireside|chauffeuse|sill[oó]n|fauteuil|armchair|1\s*plaza/i],
  ['sofa',     /sofa|sof[aá]|settee|canap[eé]|3\s*plazas?/i],
];

function roleOf(name) {
  for (const [role, re] of ROLES) if (re.test(name || '')) return role;
  return 'sofa';
}

// Each template is a list of roles (repeats allowed → the same model is placed
// more than once). compactPlaced lays them out, so order is just visual intent.
const TEMPLATES = [
  { id: 'armchair', label: 'Sillón',        roles: ['fireside'] },
  { id: 'love',     label: 'Loveseat',      roles: ['loveseat'] },
  { id: 'sofa3',    label: 'Sofá 3 plazas', roles: ['fireside', 'sofa', 'fireside'] },
  { id: 'lshape',   label: 'Sofá en L',     roles: ['fireside', 'sofa', 'corner', 'sofa'] },
  { id: 'ushape',   label: 'Sofá en U',     roles: ['corner', 'sofa', 'corner', 'sofa'] },
  { id: 'lounge',   label: 'Set lounge',    roles: ['lounge', 'sofa', 'corner'] },
];

/** Templates resolvable against `models` → `[{ id, label, pieceIds }]`. */
export function togoQuickStarts(models) {
  const byRole = new Map();
  for (const m of models || []) {
    if (!m?.id) continue;
    const r = roleOf(m.name);
    if (!byRole.has(r)) byRole.set(r, m.id);   // first model of each role wins
  }
  const out = [];
  for (const t of TEMPLATES) {
    const pieceIds = t.roles.map((r) => byRole.get(r));
    if (pieceIds.every(Boolean)) out.push({ id: t.id, label: t.label, pieceIds });
  }
  return out;
}
