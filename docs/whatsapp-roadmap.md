# WhatsApp feature roadmap — toward full WhatsApp Business parity

Goal (user, 2026-06-12): "a clone of the official application with access to all
features", inside ALCOVER's chat surfaces. This doc is the durable memory of
that loop: what exists, what the API allows, what's queued. Update it every
iteration (check items off, re-prioritize) — don't re-derive it.

## Coordination rule (active)
A parallel branch is doing a "complete WhatsApp implementation" (user notice,
2026-06-12; not yet pushed). Until it lands in `main`:
- **Do NOT edit**: `src/pages/Chats.jsx`, `src/pages/Difusion.jsx`,
  `src/components/whatsapp/*`, `src/components/settings/WhatsAppCard.jsx`,
  `src/lib/whatsapp.js`, `src/core/crm/*`, `supabase/functions/wa-*`,
  `tests/whatsapp.test.js`, or add `wa_*` migrations.
- Each iteration: `git fetch origin --prune`, diff remote branches for wa-file
  changes, and re-audit `main` — the branch may land features below; check them
  off instead of re-building them.
- New-file-only work is safe meanwhile.

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

### 🟢 Buildable now (scopes suffice) — the backlog
P1 — chat parity (per-message actions & composer):
1. Send **reactions** (`type:reaction`, emoji on long-press/hover menu).
2. Send **quoted replies** (`context.message_id`; needs reply-target state in
   composer + `context` passthrough in wa-send).
3. **Typing indicator + auto-read** on thread open/compose (wa-send already
   accepts `markRead.typing`; UI never sends it).
4. **Voice notes**: record (MediaRecorder, audio/ogg;codecs=opus) → send as
   audio. Render side exists.
5. **Stickers**: render inbound webp stickers properly (today: generic kind),
   send static stickers.
6. **Interactive messages**: reply buttons (≤3), list menus (≤10), CTA-URL
   buttons. Webhook already parses the replies — only the send side missing.
7. **Location**: send (map-pick or fixed store location); render inbound pin
   on a map link (today: text only).
8. **Contacts (vCard)** send — e.g. share the assigned salesperson card.
P2 — business-app productivity:
9. **Quick replies** (canned responses, `/shortcut` in composer; new table).
10. **Labels** on conversations + filter chips (new table; CRM-local — Cloud
    API has no label sync).
11. **Archive / pin / mark-unread** conversation actions (local columns).
12. **Business profile editor** in Settings (about, address, email, website,
    vertical, photo — `/{phone-id}/whatsapp_business_profile`).
13. Template richness: **media headers** (IMAGE/DOCUMENT) + **buttons**
    (quick-reply / URL / phone / copy-code) in create + send.
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
