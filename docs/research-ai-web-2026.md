# RosetSoft — best-practice roadmap (2025–2026 research)

Synthesis of a five-angle deep-research sweep (in-app AI, front-end performance,
UX/accessibility, Supabase security, and PWA/testing/dev-workflow) mapped onto
*this* codebase. The app is already mature — much of the canonical advice is
present. This doc records what's **done**, what's a **safe quick win**, and what
needs a **product decision** before building, with the source that backs each
claim.

Legend: ✅ already in the codebase · ⚡ shipped on this branch · 🟢 safe next step
· 🟡 bigger / needs direction.

---

## 1. Already solid (don't re-litigate)

- ✅ **Lazy-loading discipline** — Leaflet, react-pdf, pdf.js, opus-recorder are
  all behind `safeDynamicImport`; none leak into the initial bundle. (verified
  against the build output: `reactpdf`/`leaflet`/`pdf` are separate chunks).
- ✅ **Theming** — semantic CSS-variable tokens (`--ink/brand/surface/canvas`),
  frozen light ramp, `.dark` overrides, anti-FOUC head script. This *is* the
  three-tier token pattern the design-system research recommends.
  ([Mavik Labs — Tailwind v4 tokens](https://www.maviklabs.com/blog/design-tokens-tailwind-v4-2026/))
- ✅ **Focus & motion** — `:focus-visible` ring (brand, 2px/2px offset),
  `prefers-reduced-motion` blocks, keyboard-aware `scroll-padding`. Meets WCAG
  2.2 §2.4.13 Focus Appearance. ([allaccessible.org](https://www.allaccessible.org/blog/wcag-22-complete-guide-2025))
- ✅ **iOS PWA** — `viewport-fit=cover`, explicit `apple-touch-icon`,
  `is-standalone` shell-height fix. Matches the iOS PWA checklist.
  ([MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide))
- ✅ **AI uplink model** — `claude-chat` defaults to `claude-opus-4-8` (current),
  verifies the caller's JWT, keeps the key server-side, byte-stable system
  prompt. Note: evergreen aliases are gone; pin model ids and watch deprecations.
  ([Anthropic models](https://platform.claude.com/docs/en/about-claude/models/overview))
- ✅ **Architecture fitness functions** — `tests/architecture.test.js` already
  enforces the MVVM/Deno-wall boundaries that `dependency-cruiser` would.
  ([Xebia](https://xebia.com/blog/taking-frontend-architecture-serious-with-dependency-cruiser/))
- ✅ **Single-tenant RLS** — `for all to authenticated using(true)` is *by design*
  here; credential tables are deny-all + `save_*` SECURITY DEFINER RPCs. The
  advisor's `rls_policy_always_true` / `rls_enabled_no_policy` notices are
  expected for this model, **not** bugs — do not "fix" them.

## 2. Shipped on this branch ⚡

- ⚡ **Covering indexes** for 46 relational FKs (advisor lint 0001). `profile_id`
  FKs excluded — single value, an index can't help.
  ([Supabase RLS perf](https://supabase.com/docs/guides/database/postgres/row-level-security))
- ⚡ **`search_path` pinned** on 5 functions (advisor lint 0011).
- ⚡ **Security headers** in `vercel.json` (nosniff, Referrer-Policy,
  Permissions-Policy that *keeps* mic + geolocation for self).
  ([Hardening Vercel](https://dev.to/pocketportfolio/hardening-a-vercel-app-csp-cors-and-service-workers-that-dont-bite-1k2m))
- ⚡ **Vendor chunk split** — `@supabase/supabase-js` + `lucide-react` get their
  own hashed chunks; the main `index` chunk dropped 1,024 → 769 KB and the
  vendors now cache across deploys.
  ([manual chunks for caching](https://soledadpenades.com/posts/2025/use-manual-chunks-with-vite-to-facilitate-dependency-caching/))

## 3. Safe next steps 🟢 (additive, verifiable, no product call needed)

- 🟢 **Accessible names on icon-only controls** — sweep for `<button>`/`role`
  elements whose only child is a lucide icon with no `aria-label`. Additive,
  build-verified. (in progress on this branch)
- 🟢 **`Content-Security-Policy` (Report-Only first)** — add a report-only CSP so
  violations surface without breaking the SPA; promote to enforcing once clean.
  Needs `connect-src` for `*.supabase.co` + `wss:`, `img-src` for the Shopify
  CDN, and `'unsafe-inline'` for the anti-FOUC head script (or hash it).
  ([Vercel headers](https://vibeappscanner.com/security-issue/vercel-insecure-headers))
- 🟢 **`rollup-plugin-visualizer`** as a `build:analyze` script — make bundle
  regressions visible before tuning chunks further.
  ([visualizer](https://github.com/btd/rollup-plugin-visualizer))
- 🟢 **`web-vitals` beacon** — ship real-user LCP/INP/CLS per route (Lighthouse
  is lab-only). ([web.dev](https://web.dev/blog/lcp-and-inp-are-now-baseline-newly-available))
- 🟢 **Storage hardening** — confirm `images`/`pricelist` buckets disable
  anonymous *listing* (advisor `public_bucket_allows_listing`) while keeping
  object reads public. ([Storage access control](https://supabase.com/docs/guides/storage/security/access-control))

## 4. Bigger bets 🟡 (worth doing — but pick the order, they need a decision)

- 🟡 **List virtualization** (`@tanstack/react-virtual`) for the ledger, WhatsApp
  inbox, and long quote/order tables (>~80 rows). New dep + render changes.
  ([TanStack Virtual](https://dev.to/dev_tom/virtualisation-with-tanstack-virtual-2md5))
- 🟡 **INP polish** — `useDeferredValue`/`scheduler.yield()` on the big
  search/filter inputs. ([CWV 2026](https://dev.to/benriemer/core-web-vitals-in-2026-the-practical-fixes-for-inp-lcp-and-cls-that-actually-work-4ef0))
- 🟡 **React Compiler 1.0** (stable Oct 2025) via the Babel plugin — automatic
  memoization. Adopt incrementally. ([react.dev](https://react.dev/blog/2025/10/07/react-compiler-1))
- 🟡 **ESLint flat config + `jsx-a11y` + `typescript-eslint` strict** wired into
  CI (`no-floating-promises` is the highest-ROI rule for the Supabase async
  surface). Will surface a backlog on first run. ([typescript-eslint](https://typescript-eslint.io/users/configs/))
- 🟡 **Prompt caching + Batch API** for AI cost: cache the JARVIS system+history
  prefix (needs ≥1024 tokens to hit); move nightly/non-interactive AI work
  (draft replies, ledger anomaly scan) to the 50%-cheaper Batch API.
  ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))
- 🟡 **New AI features** (all should be human-in-the-loop, never auto-send):
  WhatsApp **draft** replies (Haiku, structured output, one-click approve);
  ledger **anomaly digest** (nightly Batch, Sonnet); **NL→tool-call** for JARVIS
  (never NL→raw SQL). ([OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/))
- 🟡 **RAG** over quotes/orders/WhatsApp via `pgvector` (`halfvec`, HNSW) +
  hybrid search (RRF) — only pays off at scale; for single records pass rows
  directly. Keep DGII/payroll data local, never in an external prompt.
  ([Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search))

## 5. Hard rules to keep (anti-patterns, verified)

- Never auto-send AI-drafted customer messages — always one-click human approval.
- Never NL→raw SQL from an LLM; route through parameterized tool calls.
- Never feed raw DGII/NCF/payroll data to an external model; aggregate first.
- Never `loading="lazy"` the LCP image; never top-level-import Leaflet/pdf libs.
- Never edit `:root` light values to fix dark mode; fix in `.dark`.
- Never back-date a migration; never UPDATE/DELETE a credential table in one.
