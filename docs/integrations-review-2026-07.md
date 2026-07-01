# Integrations review & roadmap — Gmail · Instagram · DGII e-CF · Security

_Prepared 2026-07-01. Scope: a full review of the three external-integration
surfaces the owner asked about, the research behind the best features to build,
what was implemented in this pass, and what remains — separating **repo-shippable
work** from **work that needs the owner's credentials / third-party setup**._

> **Headline:** all three subsystems are already **mature and production-grade** —
> this was not a greenfield build. The right work is targeted gap-filling,
> security hardening, and test coverage, verified against the repo's own signals
> (`npm run test` / `typecheck` / `build`). The high-risk integration internals
> (DGII tax transmission, OAuth token flows, Meta webhooks) live in Deno Edge
> Functions that **cannot be locally typechecked or tested against the live
> external APIs from the sandbox**, so changes there were kept surgical and
> obviously-correct; everything requiring live-API verification is called out
> below rather than shipped blind.

---

## 1. What already exists (baseline map)

### Gmail (`google-api` fn + `core/crm` VMs + `gmail_messages`)
Full OAuth (offline refresh token in write-only `google_oauth_config`), inbox
mirror, intent-based categories, compose/reply with ES/EN signatures, mailbox
actions (star/archive/trash/read), attachments, a Facturas tab, and Drive
browse/upload. Pure VMs in `core/crm/views/gmailInbox.js`, pinned by
`tests/gmailInbox.test.js`.

### Instagram / Meta (`meta-social`, `meta-webhook`, `ig-publish-worker`, `meta-receipts`)
Instagram-Login OAuth (no FB Page), publish (feed/Reel/Story/carousel),
scheduler (pg_cron worker), Direct inbox, comment/mention webhook feed, a full
Ads/Marketing board, and a rich analytics Studio (`core/jarvis/igStudio.js`,
`social.js`) already pulling `reach`, `views`, `accounts_engaged`,
`total_interactions`, `follower_count`, `follower_demographics`,
`profile_links_taps`, per-post/Reel/Story insights, and a best-time heatmap.

### DGII e-CF (`ecf-send` + `fe-autenticacion/recepcion/aprobacioncomercial`)
The **most complete** subsystem: seed/semilla auth → XAdES sign → recepción →
status by trackId → commercial approval, RFCE conversion for type-32 consumo,
receptor inbox (inbound e-CF + acuse + commercial approval), 606/607 TXT
builders, atomic e-NCF sequence assignment, write-only `.p12` cert store. Pinned
by `tests/ecf.test.js`, `tests/dgiiFormats.test.js`, `tests/ecfCommercial.test.js`.

---

## 2. Shipped in this pass (all green: 1219 tests, typecheck, build)

| # | Change | Files | Verified by |
|---|--------|-------|-------------|
| 1 | **e-CF pre-transmit validator** — the full DGII CA4404 checklist as one pure function returning *every* issue at once (RNC lengths, e-NCF/type match, sequence expiry, totals & ITBIS reconciliation, buyer-required-by-type, nota-crédito 30-day ITBIS rule, item cross-checks). Stops a sale from burning an e-NCF on a comprobante DGII would reject. | `src/lib/accounting/ecfValidation.ts` | `tests/ecfValidation.test.js` (18) |
| 2 | **RFCE QR host fix** — type-32 (consumo) QR now points at `fc.dgii.gov.do/{env}/consultatimbrefc` with the reduced 4-param set (was wrongly on `ecf.dgii.gov.do` with buyer/date params → a dead scan on the printed consumo invoice). | `src/lib/accounting/ecf.ts` | `tests/ecf.test.js` |
| 3 | **IG audience business KPIs** — engagement rate by reach AND by followers, reach rate, discovery %, views-per-reach, benchmark banding (calibrated for the low-engagement furniture vertical), content-format performance (Reels vs feed), and audience concentration (top-country / top-3 / home-market / dominant age). Pure over data already fetched; every ratio divide-guarded. | `src/core/jarvis/igStudio.js` | `tests/igAudienceKpis.test.js` (9) |
| 4 | **Gmail invoice sender-trust gate (BEC defense)** — `resolveInvoiceTrust` reads Gmail's `Authentication-Results` (DMARC) + a supplier allow-list; auto-trust **only** on `dmarc=pass` + known domain, `suspect` on failed auth, else human review. The `From` display name is never trusted. Wired into the Facturas list + the sync now stores the header. | `src/core/crm/views/gmailInbox.js`, `supabase/functions/google-api/index.ts`, `supabase/migrations/20260914000000_gmail_auth_results.sql` | `tests/gmailInvoiceTrust.test.js` (8) |
| 5 | **Security hardening** — `meta-webhook` verify token now **fails closed** (no guessable hardcoded default); the `.p12` signing key is written owner-only (`mode 0o600`) in all four DGII functions. | `supabase/functions/meta-webhook`, `ecf-send`, `fe-*` | manual review (Deno) |

---

## 3. Research digest (sourced; full citations in the session log)

### Gmail
- **Incremental sync via `history.list` + persisted `historyId`** is the single
  biggest efficiency/correctness win — replaces the current 180-day re-list. Fall
  back to a full sync on HTTP 404 (history window is ~7 days).
- **Push via `users.watch` + Pub/Sub** only if near-real-time is needed; a 1–5 min
  `history.list` poll is simpler and well within the 250 units/user/sec quota.
- **Least-privilege scopes:** `gmail.modify` + `gmail.send` (avoid full
  `mail.google.com`). All read/modify scopes are **restricted** → require Google
  app verification + annual **CASA** assessment **unless** the app is marked
  **Internal** to a Workspace domain (the single-dealer escape hatch).
- **Token death traps:** OAuth consent in "Testing" → refresh token expires every
  7 days; move the app to **In production**. Catch `invalid_grant` → surface a
  "Reconnect Gmail" action (don't retry).
- **Invoice-fraud (BEC):** never trust the `From` name; gate on DMARC alignment +
  supplier allow-list (shipped as #4 above); never auto-update a payee's bank
  details from a parsed email.

### Instagram (Graph API v22, 2024–2025)
- **`impressions` is dead** (all versions after 2025-04-21) → use **`views`**;
  legacy `audience_*` demographics removed (Dec 2023) → use
  `follower_demographics`/`engaged_audience_demographics` (`metric_type=total_value`,
  `timeframe`, `breakdown=age|gender|city|country`). The code already uses the
  modern metrics — keep denominators on `views`, not impressions.
- **Best analytics to add next:** `online_followers` (hourly, `period=lifetime`)
  for a *true* best-time heatmap (today it's inferred from post-engagement
  timing); account-level save/share aggregation; a profile→follow→bio-link
  conversion funnel; custom date ranges.
- **Gates:** 100-follower minimum for `online_followers`/`follower_count`/
  demographics; ~48h data latency; account-timezone; 30-day `since`/`until` cap.

### DGII e-CF (Ley 32-23; formats v1.0/v1.6)
- **RD$250,000** is the type-32 threshold (confirmed): below → RFCE on
  `fc.dgii.gov.do/{env}/recepcionfc` (synchronous accept/reject, **no trackId**);
  at/above → full e-CF with buyer RNC on `ecf.dgii.gov.do`.
- **Estados:** 0 No encontrado · 1 Aceptado · 2 Rechazado (reissue with a NEW
  e-NCF; never reuse) · 3 En Proceso (poll) · 4 Aceptado Condicional (valid).
- **Security code** = first 6 chars of the XML `<SignatureValue>` hash; QR uses
  **two hosts** by type (fixed in #2). **RSA-SHA256 / SHA-256 / enveloped XML-DSig.**
- **Mandatory calendar (with prórrogas):** grandes nacionales 15-May-2024 (in
  force); grandes locales + medianos **15-Nov-2025**; pequeños/micro **15-Nov-2026**.
- **Rejection causes (CA4404):** suspended emisor, confection/encoding errors,
  invalid/expired cert, unauthorized/expired e-NCF sequence, duplicate e-NCF,
  totals not reconciling, altered-after-signing. (#1 enforces the checkable ones.)

---

## 4. Roadmap — repo-shippable, prioritized (not yet done)

Each is a self-contained unit; the ⚠️ ones touch Deno functions that need
live-API verification (DGII CerteCF / Gmail / Meta) before trusting in prod.

1. **Surface the new VMs in the UI** — render the audience-KPI strip
   (`resolveAudienceKpis`) in the Instagram Audience board, and the invoice
   trust badge (`row.trust`) in the Facturas list. (Pure View wiring; build-verified.)
2. **⚠️ Gmail incremental `historyId` sync** — add `settings.gmail_history_id`,
   switch `gmailSync` to `history.list` with a full-sync fallback on 404. Big
   efficiency win; ship behind the fallback so worst case = today's behavior.
3. **⚠️ Gmail `invalid_grant` → reconnect** — detect it on refresh, stamp
   `settings.google_needs_reauth`, surface a "Reconnect Gmail" prompt.
4. **⚠️ IG `online_followers`** — fetch (`period=lifetime`) in `meta-social`,
   project a real best-time heatmap in `igStudio.js` (VM half is testable).
5. **Receptor inbox UI** — the `fe-recepcion`/`fe-aprobacioncomercial` backends +
   `receptorInbox` VM exist; build the page to view received e-CF and send/track
   commercial approvals.
6. **⚠️ e-CF status auto-polling** — a small worker (like `ig-publish-worker`)
   that polls `consultaestado` by trackId until terminal, updating
   `sales_postings.ecf_status`; plus a manual "check status" action.
7. **Wire the validator into Facturación** — call `validateEcfPayload` before
   `sendEcf` and show the issue panel; block on errors, warn on warnings.
8. **`email_campaigns` UI** — the table exists with no send UI (Difusión → Correo).
9. Remaining security hardening (explicit empty-secret guards in both webhooks;
   `certReport` RNC redaction on DGII rejection) — low severity, left out of this
   pass to avoid unverifiable edits to live signing/webhook code.

---

## 5. ⚠️ Requires the owner's action (cannot be done from code)

These are genuine third-party/credential steps — not deploy mechanics — so they
can't be shipped by a `main` push:

- **`META_WEBHOOK_VERIFY_TOKEN` env var** — now that the webhook fails closed,
  set this (a strong random string) in the Supabase project's Edge Function env,
  and the same value in the Meta App Dashboard → Instagram → Webhooks. Until set,
  a *new* webhook subscription handshake will 403 (existing event delivery is
  unaffected — it's HMAC-verified separately).
- **Gmail OAuth app → "In production"** (or **Internal** to your Workspace
  domain) so refresh tokens don't expire every 7 days; budget for **CASA** if the
  app stays External with restricted scopes.
- **DGII CerteCF certification** — the e-CF flows (incl. the RFCE host fix #2 and
  the validator #1) should be exercised end-to-end against DGII **CerteCF** with
  the real `.p12` before relying on them in production. Confirm the three items
  the research left flagged against the live DGII v1.6 PDF: exact token TTL,
  polling SLA, and endpoint casing.
- **e-NCF sequence ranges** — upload the DGII-authorized ranges per type in
  _Secuencias e-NCF_; upload the `.p12` + password + environment in _Configuración
  contable_.
- **Supplier allow-list for invoice trust** — provide the list of known supplier
  domains (e.g. `ligne-roset.com`) so `resolveInvoiceTrust` can auto-trust their
  invoices; everything else routes to review.

---

_This document is the durable memory of the review; the money/tax invariants it
introduced are pinned in `tests/ecfValidation.test.js`, `tests/igAudienceKpis.test.js`,
and `tests/gmailInvoiceTrust.test.js`._
