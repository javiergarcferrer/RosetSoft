# Skill: UI/UX polish pass

A repeatable loop for making a screen feel finished. Refinement over rewrites — adjust
existing components and design tokens, match the existing visual language.

## Loop (smallest meaningful improvement first)
1. Look at the current state — render the screen, note what's rough.
2. Make ONE focused improvement.
3. Verify — typecheck + build, re-render, capture before/after where it helps.
4. Repeat until the bar is met, then open a PR with before/after screenshots.

## Checklist (the axes of polish)
- Spacing & alignment: consistent scale, nothing cramped or floating.
- Typography: clear hierarchy and rhythm; no orphaned sizes/weights.
- Color & contrast: meets WCAG AA for text on background.
- States: explicit loading, empty, and error states — never a blank flash.
- Focus & keyboard: every interactive element reachable, visible focus ring.
- Responsive: usable and not clipped at 375px width.
- Motion: purposeful, fast, non-janky; respects reduced-motion.
- Copy: concise, consistent voice, correct money/locale formatting.

## Guardrails
- Respect the repo's architecture (e.g. rosetsoft MVVM — the View derives nothing;
  new derivation goes in a resolveX ViewModel).
- Keep each PR scoped to one screen/flow so it stays reviewable.
