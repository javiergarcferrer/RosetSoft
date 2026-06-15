# Meta permission scopes — WhatsApp + Instagram

RosetSoft's Meta surface is now **two independent integrations**:

- **WhatsApp Business** — unchanged. Sends/receives messages (CRM inbox +
  campaigns) via `wa-send` / `wa-webhook`, on the token the dealer onboarded
  through Embedded Signup (write-only `whatsapp_config`).
- **Instagram** — connected DIRECTLY via **Instagram Business Login** (no
  Facebook Page, no `pages_*`). `meta-social` runs the OAuth round-trip, keeps
  the long-lived IG user token server-side (write-only `meta_social_config`) and
  talks to `graph.instagram.com`.

The old **Facebook Pages / Ads / Business** surface was **removed** (no Page
publishing/insights, no ad management, no catalogs, no `pages_*` / `ads_*` /
`business_management`). The two integrations may share one Meta app or run as
two — the Instagram webhook (`meta-webhook`) verifies against either app secret.

Legend: ✅ wired today · ⬜ headroom (could be requested later).

## WhatsApp Business — `wa-send`, `wa-webhook`, CRM inbox/campaigns
| Scope | Status | What it backs |
|---|---|---|
| `whatsapp_business_messaging` | ✅ | Send/receive WhatsApp messages (CRM inbox + campaign sends). |
| `whatsapp_business_management` | ✅ | Manage the WABA: message templates, phone numbers, registration. |
| `whatsapp_business_manage_events` | 🟡 | WhatsApp conversational/marketing analytics events. |
| `paid_marketing_messages` | ⬜ | Paid WhatsApp marketing messages → future paid campaign tier. |

## Instagram — `meta-social` (Instagram API with Instagram Login)
| Scope | Status | What it backs |
|---|---|---|
| `instagram_business_basic` | ✅ | OAuth identity + read the account (username, name, bio, follower/follow/media counts, picture) and the media grid. Resolves the IG user id every other call uses. |
| `instagram_business_content_publish` | ✅ | Publish from device upload — feed image, Reel, image/video Story, 2–10 carousels (`/media` → `/media_publish`), plus alt text, collaborators (≤3) and first-comment automation. Backs the Marketing composer and the scheduler (`ig-publish-worker`). |
| `instagram_business_manage_comments` | ✅ | Read + reply + hide/unhide + delete comments (Marketing triage + Studio moderation), and the realtime comment/mention feed (`subscribeWebhooks` → `/{ig-user}/subscribed_apps` → `meta-webhook` → `ig_events`). |
| `instagram_business_manage_insights` | ✅ | Account insights (reach, follower growth, profile-link taps, views/engagement totals, reach by follower type), per-post insights, follower demographics (gender/age/country/city), the content-publishing quota. |
| `instagram_business_manage_messages` | ⬜ | Instagram DMs → an Instagram thread in the CRM inbox (not wired yet). |

## OAuth flow (Instagram Business Login)
1. Admin pastes the **Instagram App ID + App Secret** in Configuración →
   Instagram (stored write-only via `meta-social` `saveApp`).
2. "Conectar Instagram" → `meta-social` `authorize` builds the consent URL at
   `https://www.instagram.com/oauth/authorize` with the scopes above + a one-shot
   CSRF `state`; the browser is redirected there.
3. Instagram redirects to the function's GET callback
   (`${SUPABASE_URL}/functions/v1/meta-social`, registered as the OAuth redirect
   URI), which exchanges the `code` → short-lived → **60-day long-lived** token
   (`api.instagram.com/oauth/access_token` then `graph.instagram.com/access_token`),
   persists it, and bounces back to the app.
4. Tokens auto-refresh inside the last 7 days of their window
   (`graph.instagram.com/refresh_access_token`); they never reach the browser.

## Account requirements
- The Instagram account must be a **professional** account (Business or
  Creator). It does **not** need to be linked to a Facebook Page.
- App Review is still required for advanced access to the four
  `instagram_business_*` scopes; the review screencast shows the Instagram Login
  consent — no `pages_show_list` (or any `pages_*`) anywhere.

### Dropped vs the old Facebook-linked model
Hashtag search and Shopping product tagging depended on the Facebook
Page/Catalog model and are **not** available under Instagram Login. Everything
else (publish, comments, insights, demographics, stories, mentions) carried over.

### Notes for future loops
- WhatsApp is a separate integration and was left fully intact — don't fold IG
  changes into `wa-*` or `whatsapp_config`.
- The IG token + the app credentials live in `meta_social_config` (write-only);
  never surface them client-side or log them.
- The legacy Facebook/Page/Ads columns on `meta_social_config` are retained but
  unused (additive migration — no pasted credential is ever erased).
