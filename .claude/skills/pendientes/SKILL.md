---
name: pendientes
description: Work through the in-app developer backlog. Use when the owner says "revisa los pendientes", "work the todos", "drena la cola", or otherwise asks you to action the items they typed into the bug console (the `dev_todos` Supabase table). Reads pending entries, fixes each at its recorded route, ships, and marks it done.
---

# Drain the dev backlog (`dev_todos`)

The owner types change requests / bug reports into the admin **bug console**
(the 🐛 button → "Pendientes" tab) from their phone. Each row persists to the
`dev_todos` table with the **route** of the screen they were on. This skill
turns that queue into shipped fixes.

## 1. Read the queue
Use the Supabase MCP. The project is **RosetSoft** (`list_projects` → ref
`jwgrjrjlhaedfathltxc`). Query the open items, oldest first:

```sql
select id, text, route, created_at
from dev_todos
where profile_id = 'team' and done = false
order by created_at asc;
```

If the queue is empty, say so and stop.

## 2. Reconcile, then work each item
Run the repo's operating loop (see `CLAUDE.md`) BEFORE touching code:
`git fetch origin main` + `git status` — a parallel session may have moved main.

For **each** pending todo, smallest-diff first:
1. **Locate** — map its `route` to the file. The app is HashRouter; the route is
   the in-app path. e.g. `/accounting/facturacion` → `src/pages/accounting/Facturacion.jsx`,
   `/accounting/compras-gastos` → `ComprasGastos.jsx`, `/jarvis` → `src/pages/Jarvis.jsx`.
   Grep the route in `src/App.jsx` (or the router) to confirm the component, then
   read it. A null/blank route means the item predates route-stamping — infer
   from the text or ask.
2. **Fix** — make the change following the codebase's MVVM + theming rules
   (`CLAUDE.md`): theme tokens (no flat color literals), the `Modal` primitive
   for overlays, safe-area insets for fixed chrome, `min-w-0` so figures stay
   responsive — the same conventions an earlier review flagged.
3. **Verify** — the ONE signal matched to the change (`CLAUDE.md` inner loops):
   UI → `npm run typecheck` + `npm run build`; a logic module → its test +
   typecheck. Never report done on red.
4. **Ship** — push per the active branch policy (default: `main` is the deploy
   lever). Rebase onto `origin/main` if it moved; one focused commit per item.
5. **Mark done** — only after it's verified + shipped:

```sql
update dev_todos set done = true, done_at = now(), updated_at = now()
where id = '<id>';
```

## 3. When NOT to auto-fix
A terse phone-typed todo can be ambiguous ("arregla el botón"). If the intent or
the target is unclear, or the fix would be a large refactor / touch money or
fiscal logic, **do not guess** — leave it `done = false` and ask the owner with
enough context to answer in one line. Wrong-but-shipped is worse than asked.

## 4. Report
End with a crisp summary: which items shipped (with the commit), which you left
open and why. Keep it short — the `dev_todos` rows are the durable record.
