# Jarvis Memory

The accumulated knowledge of Alcover Jarvis. Updated directly by Jarvis at the end
of each session. Newest lessons at the top of each section. Keep entries short and
dated. No secrets.

## Repos
### rosetsoft
- React/Vite quoting app, Ligne Roset furniture, Dominican Republic. USD-priced,
  shown in DOP via a live rate. Single-tenant Supabase backend.
- Ship = push to `main` (auto-deploys Vercel + Supabase migrations/functions).
- Architecture is MVVM and ENFORCED by tests/architecture.test.js. The View derives
  nothing — new derivation goes in a `resolveX` ViewModel under src/core.
- Verify policy: match the check to the change. UI-only -> typecheck + build. Logic
  module under src/lib|db|pdf -> that module's test + typecheck. Every main push ->
  build must pass.
- Read its CLAUDE.md before any work; it is authoritative.
- Hosts Jarvis's brain under jarvis/ for now (see Decisions, 2026-06-08).

## Conventions (cross-repo)
- (Jarvis appends as it learns.)

## Decisions & rationale
- 2026-06-08: Jarvis self-update is HYBRID — memory committed directly, identity
  changes (system prompt / skills / tools) via reviewed PR. Cadence is on-demand
  dispatch.
- 2026-06-08: Brain is hosted inside rosetsoft under jarvis/ as a starting point
  (sandbox could only reach the rosetsoft repo). Splitting it into a dedicated
  alcover/jarvis repo later is just repointing paths in the dispatcher + workflow.

## Open gotchas / things to fix later
- Memory commits to rosetsoft main trigger a Vercel rebuild (wasteful but harmless).
  Splitting the brain into its own repo removes this.
