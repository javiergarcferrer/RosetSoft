# WhatsApp feature roadmap — toward full WhatsApp Business parity

Goal (user, 2026-06-12): "a clone of the official application with access to all
features", inside ALCOVER's chat surfaces. This doc is the durable memory of
that loop: what exists, what the API allows, what's queued. Update it every
iteration (check items off, re-prioritize) — don't re-derive it.

## Coordination rule
The parallel "complete WhatsApp implementation" branch **landed in `main` as
`007c6fe`** (2026-06-12 03:29 UTC) — the hard file ban is lifted. Standing
practice for every iteration (parallel sessions remain a fact here): `git
fetch origin --prune`, scan unmerged remote branches for WhatsApp-file diffs
before editing those files, and re-audit `main` first — land features by
checking them off, not re-building them.

## Scopes we hold (constrain everything)
- Cloud API token (System User): `whatsapp_business_messaging` +
  `whatsapp_business_management` — messaging of every type, media, templates,
  phone-number + WABA management, business profile, QR codes, analytics.
- NOT held / not applicable: `whatsapp_business_manage_events`, catalog scopes
  (no Meta commerce catalog connected), Calling API (beta access not granted),
  Marketing API.
- One number, Cloud API hosted; single `'team'` tenant.

## Status matrix

### ✅ Already shipped (verified in code, 2026-06-12)
- Inbox: conversation list (search, unread badges, last-msg + ticks preview),
  split-pane ⇄ phone nav, new-chat picker from CRM, 10s poll refresh.
- Thread: day separators, status ticks (sending→read, failed+reason in
  Spanish), media render in+out (image/video/audio inline, docs as chips,
  Storage-mirrored), quoted-reply **rendering**, reaction **rendering**,
  Click-to-WhatsApp ad referral chip, template-tagged bubbles.
- Composer: free text, attach-any-file (≤24MB, caption), approved-template
  picker (vars + preview, first-name default), 24h-window banner.
- Read receipts both directions (local badge + blue ticks via API).
- Templates: list/create/delete (TEXT header/body/footer, vars + examples,
  quality score) — Difusión page.
- Broadcasts: named campaigns ≤300 recipients, per-recipient logs, counters.
- Quote weave: send link (template) / PDF (document), thread embedded in the
  quote editor, chats on CRM cards.
- Webhook: HMAC-verified, all inbound types parsed, media persisted at
  delivery, async status errors translated, phone→customer/professional link,
  self-healing app+WABA subscription.
- (007c6fe) Send **reactions** (emoji row on bubbles, remove supported) and
  **quoted replies** (bubble action + composer preview, context on text/media).
- (007c6fe) **Quick-reply button** messages (text + ≤3 buttons, 20 chars).
- (007c6fe) **Business profile editor** in Settings (about/description/
  address/email/website via wa-send).
- (007c6fe) Quote templates with the link on a **URL button**; template picker
  in Settings stores name+lang+vars+button metadata; dynamic-button templates
  excluded from campaigns.

### 🟢 Buildable now (scopes suffice) — the backlog
P1 — chat parity (per-message actions & composer):
1. ~~Send reactions~~ ✅ 007c6fe.
2. ~~Send quoted replies~~ ✅ 007c6fe.
3. ~~Typing indicator + auto-read~~ ✅ it.2 (typing throttled 20s from the
   composer via `markRead.typing`; auto-read existed in both hosts).
4. ~~Voice notes~~ ✅ it.2 (mic on empty composer → MediaRecorder ogg-opus/
   m4a/aac; webm-only browsers hide the mic; ships via the media path).
5. **Stickers**: render inbound webp stickers properly (today: generic kind),
   send static stickers.
6. **Interactive messages, rest**: list menus (≤10 rows) + CTA-URL free-form
   messages (quick-reply buttons ✅ 007c6fe; webhook parses all replies).
7. **Location**: send (map-pick or fixed store location); render inbound pin
   on a map link (today: text only).
8. **Contacts (vCard)** send — e.g. share the assigned salesperson card.
P2 — business-app productivity:
9. **Quick replies** (canned responses, `/shortcut` in composer; new table).
10. **Labels** on conversations + filter chips (new table; CRM-local — Cloud
    API has no label sync).
11. **Archive / pin / mark-unread** conversation actions (local columns).
12. ~~Business profile editor~~ ✅ 007c6fe (photo + vertical still open).
13. Template richness, rest: **media headers** (IMAGE/DOCUMENT) + quick-reply/
    phone/copy-code buttons (URL buttons ✅ 007c6fe).
14. **Greeting / away auto-replies** (webhook-side, business-hours aware —
    official app's "herramientas de mensajería").
15. Global **message search** (today only conversation-name search).
P3 — growth & ops:
16. **QR codes / wa.me deep links** with prefilled text (`message_qrdls`).
17. Campaign **scheduling** + >300 chunking + retry of failed recipients.
18. **Conversation analytics** (WABA analytics edges; volume, by category) +
    messaging-limit tier surfaced in Settings.
19. **WhatsApp Flows** (forms in-chat: delivery scheduling, lead capture) —
    heavier: flow JSON builder + publish + flow webhook.
20. Per-teammate **chat assignment** notes (CRM-local).

### 🟡 Possible only with extra setup (park until asked)
- **Catalog / product messages / carts** — needs a Meta commerce catalog +
  `catalog_management`; our catalog lives in Shopify (two stores) — a feed
  bridge is a project of its own.
- **Calling API** (voice in-chat) — beta, per-number enablement by Meta.
- **Payments** — not available in DO market.

### 🔴 Impossible on Cloud API (don't promise: official-app-only)
- Groups, Communities, Channels, Status/Stories.
- Edit / delete-for-everyone of sent messages; disappearing messages; view-once.
- Device-style E2E backup, linked devices, consumer calls.

## Iteration log
- 2026-06-12 · audit + this roadmap; code work deferred (coordination rule).
- 2026-06-12 · 007c6fe landed mid-iteration — matrix updated, ban lifted. Next
  iteration starts at P1 #3 (typing/auto-read) then #4 (voice notes).
- 2026-06-12 · it.2: typing indicator + voice notes, both inside ChatThread so
  inbox/contact-cards/quote editor inherit them; wa-send learns audio/mp4→m4a.
  Next: #5 stickers, #6 list menus + CTA-URL.
