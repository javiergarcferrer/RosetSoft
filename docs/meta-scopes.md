# Meta permission scopes — WhatsApp + Instagram

RosetSoft's Meta surface is now **two independent integrations**:

- **WhatsApp Business** — unchanged. Sends/receives messages (CRM inbox +
  campaigns) via `wa-send` / `wa-webhook`, on the token the dealer onboarded
  through Embedded Signup (write-only `whatsapp_config`).
- **Instagram** — connected DIRECTLY via **Instagram Business Login** (no
  Facebook Page, no `pages_*`). `meta-social` runs the OAuth round-trip, keeps
  the long-lived IG user token server-side (write-only `meta_social_config`) and
  talks to `graph.instagram.com`.

The old **Facebook Pages** surface was **removed** (no Page publishing/insights,
no IG/FB Shopping catalogs, no `pages_*` / `business_management`). The **one**
Facebook-side
piece that stays is **Instagram ad management** — Meta exposes ad reads +
pause/resume only through the **Marketing API** (`graph.facebook.com`), which the
Instagram-Login token can't touch, so it rides the **Business/system-user token**
(reused from `whatsapp_config`) on an ad account. The two integrations may share
one Meta app or run as two — the Instagram webhook (`meta-webhook`) verifies
against either app secret.

Legend: ✅ wired today · ⬜ headroom (could be requested later).

## WhatsApp Business — `wa-send`, `wa-webhook`, CRM inbox/campaigns
| Scope | Status | What it backs |
|---|---|---|
| `whatsapp_business_messaging` | ✅ | Send/receive WhatsApp messages (CRM inbox + campaign sends). |
| `whatsapp_business_management` | ✅ | Manage the WABA: message templates, phone numbers, registration. |
| `catalog_management` | ✅ | The in-chat **Commerce catalog** — browse the connected catalog's products (`GET /{catalog_id}/products`) and send product / "view catalog" messages (`wa-send`). The System User token must carry it alongside the two WhatsApp scopes (`wa-send` validates this and errors otherwise). |
| `whatsapp_business_manage_events` | 🟡 | WhatsApp conversational/marketing analytics events. |
| `paid_marketing_messages` | ⬜ | Paid WhatsApp marketing messages → future paid campaign tier. |

## Instagram — `meta-social` (Instagram API with Instagram Login)
| Scope | Status | What it backs |
|---|---|---|
| `instagram_business_basic` | ✅ | OAuth identity + read the account (username, name, bio, follower/follow/media counts, picture) and the media grid. Resolves the IG user id every other call uses. |
| `instagram_business_content_publish` | ✅ | Publish from device upload — feed image, Reel, image/video Story, 2–10 carousels (`/media` → `/media_publish`), plus alt text, collaborators (≤3) and first-comment automation. Backs the Marketing composer and the scheduler (`ig-publish-worker`). |
| `instagram_business_manage_comments` | ✅ | Read + reply + hide/unhide + delete comments (Marketing triage + Studio moderation), and the realtime comment/mention feed (`subscribeWebhooks` → `/{ig-user}/subscribed_apps` → `meta-webhook` → `ig_events`). |
| `instagram_business_manage_insights` | ✅ | Account insights (reach, follower growth, profile-link taps, views/engagement totals, reach by follower type), per-post insights, follower demographics (gender/age/country/city), the content-publishing quota. |
| `instagram_business_manage_messages` | ✅ | **Instagram Direct (DM) inbox** — receive DMs via `meta-webhook` (object=instagram, `messaging[]` → `ig_messages`) and reply within Meta's 24h window via `meta-social` `igSendDm`. The CRM inbox's second channel, beside WhatsApp. Requested in the OAuth consent scopes. |

## Instagram ads — `meta-social` (Marketing API, Business token)
Instagram ad management has **no Instagram-Login path** — it needs the Marketing
API on `graph.facebook.com`, a Facebook **ad account**, and a **Business/system-
user token** (reused from `whatsapp_config`; the ad account must be assigned to
that system user in Meta Business Manager). This is the only Facebook dependency
that remains.

| Scope | Status | What it backs |
|---|---|---|
| `ads_read` | ✅ | Read ad-account + per-campaign insights (spend/reach/results, 28d) — the JARVIS social-pulse ad KPIs + ads↔sales weeks. |
| `ads_management` | ✅ | Pause/resume campaigns (`setCampaignStatus`, confirm-gated) — the Marketing campaigns panel. |

These two are NOT in the Instagram-Login OAuth consent (that token can't do ads);
they ride the Business token, and are reviewed on the Marketing-API track
("Ads Management Standard Access" → Advanced for production rate limits, +
Business Verification).

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
- App Review is required for advanced access to the five `instagram_business_*`
  scopes; the screencast shows the Instagram Login consent — no `pages_*`
  anywhere. The ad scopes (`ads_read`/`ads_management`) are reviewed separately on
  the Marketing-API track and need a Facebook ad account + Business Verification.

### Dropped vs the old Facebook-linked model
Hashtag search and Shopping product tagging depended on the Facebook
Page/Catalog model and are **not** available under Instagram Login. Everything
else (publish, comments, insights, demographics, stories, mentions) carried over.

### Notes for future loops
- WhatsApp is a separate integration and was left fully intact — don't fold IG
  changes into `wa-*` or `whatsapp_config`.
- The IG token + the app credentials live in `meta_social_config` (write-only);
  never surface them client-side or log them.
- The legacy `page_*` columns on `meta_social_config` are retained but unused;
  `access_token`/`ad_account_id` ARE used (the Business token + ad account for the
  Marketing-API ads). No pasted credential is ever erased.
