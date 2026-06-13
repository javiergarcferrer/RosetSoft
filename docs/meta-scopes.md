# Meta (Facebook / Instagram / WhatsApp / Threads) permission scopes

The permission surface granted to our Meta app's system user. **One Meta system
user runs everything** — WhatsApp, the FB Page, the linked IG business account,
the ad account, and the owned product catalogs all hang off the single
long-lived token (`whatsapp_config.access_token`, reused write-only by
`meta_social_config`). So these scopes are shared across `wa-send` / `wa-webhook`
and `meta-social`, not split per function.

Legend: ✅ wired today · 🟡 supporting/partial · ⬜ headroom (granted, not yet used in code).

## WhatsApp Business — `wa-send`, `wa-webhook`, CRM inbox/campaigns
| Scope | Status | What it backs |
|---|---|---|
| `whatsapp_business_messaging` | ✅ | Send/receive WhatsApp messages (the CRM inbox + campaign sends). |
| `whatsapp_business_management` | ✅ | Manage the WABA: message templates, phone numbers, registration. |
| `whatsapp_business_manage_events` | 🟡 | WhatsApp conversational/marketing analytics events. |
| `paid_marketing_messages` | ⬜ | Paid WhatsApp marketing messages → future paid campaign tier. |

## Facebook Pages — `meta-social` (publish + insights + discovery)
| Scope | Status | What it backs |
|---|---|---|
| `pages_show_list` | ✅ | `me/accounts` Page discovery in `link` mode. |
| `pages_manage_posts` | ✅ | Page feed posts + scheduled posts (`/{page}/feed`, `scheduled_posts`). |
| `pages_read_engagement` | ✅ | Page profile + daily engagement/reach insights in the snapshot. |
| `read_insights` | ✅ | Underpins the Page + IG insights reads. |
| `pages_read_user_content` | 🟡 | Read user comments/posts on the Page (server can; the IG-first Marketing UI doesn't surface FB). |
| `pages_manage_engagement` | ⬜ | Like/comment/moderate as the Page (server `replyComment` supports it; not surfaced). |
| `pages_manage_metadata` | 🟡 | Page settings + webhook subscriptions. |
| `pages_messaging` | ⬜ | Messenger send/receive → Messenger thread in the CRM. |
| `pages_utility_messaging` | ⬜ | Messenger utility/templated messages. |
| `pages_manage_ads` | 🟡 | Page-level ad management (complements the Marketing API below). |

## Instagram — `meta-social`
| Scope | Status | What it backs |
|---|---|---|
| `instagram_basic` | ✅ | Read the linked IG business account (username, counts). |
| `instagram_content_publish` | ✅ | IG feed posts, Reels, video/image Stories + carousels (`/media` → `/media_publish`, video containers polled). |
| `instagram_manage_comments` | ✅ | Read + reply + hide/unhide + delete IG comments (Marketing triage + Studio per-post moderation). |
| `instagram_manage_insights` | ✅ | IG reach / follower / profile-view / per-post insights, the Studio's **follower demographics** (gender/age/country/city) and **hashtag search** (discovery). |
| `instagram_manage_contents` | ⬜ | Manage existing IG content (newer edit/management surface). |
| `instagram_manage_messages` | ⬜ | IG DMs → Instagram thread in the CRM inbox. |
| `instagram_shopping_tag_products` | ⬜ | Tag Shopify catalog products in IG posts. |

## Ads & Business — `meta-social` snapshot + campaign control (Marketing API)
| Scope | Status | What it backs |
|---|---|---|
| `ads_read` | ✅ | Read ad-account + per-campaign insights (spend/reach/results, 28d). |
| `ads_management` | ✅ | Pause/resume campaigns (`setCampaignStatus`, confirm-gated). |
| `business_management` | ✅ | `me/businesses` + owned product catalogs (counts for drift flags). |
| `catalog_management` | 🟡 | Product catalogs — read today; write/feed is headroom. |
| `leads_retrieval` | ⬜ | Pull lead-gen form submissions → CRM leads. |
| `manage_app_solution` | ⬜ | Tech-provider / managed app-solution onboarding. |

## Creator / branded content — headroom
| Scope | Status | What it backs |
|---|---|---|
| `facebook_branded_content_ads_brand` | ⬜ | FB branded-content ads as the brand. |
| `instagram_branded_content_brand` | ⬜ | IG branded-content collabs as the brand. |
| `instagram_branded_content_ads_brand` | ⬜ | Promote IG branded content as the brand. |

## Other surfaces — headroom
| Scope | Status | What it backs |
|---|---|---|
| `publish_video` | 🟡 | IG Reels/video are live (via `instagram_content_publish`). The server can also post FB Page Reels (`/video_reels`), but the IG-first Marketing UI doesn't surface FB publishing. |
| `threads_business_basic` | ⬜ | Threads read/post for the business account. |

### Notes for future loops
- New Meta feature → check the scope is already in this list before assuming a
  re-consent is needed; most publishing/insights/ads paths are already granted.
- The token is server-side and write-only (`meta_social_config` /
  `whatsapp_config`) — never surface it client-side or log it.
- A WhatsApp-sourced `meta_social_config` row stores empty token sentinels and
  re-reads the live `whatsapp_config` token per call, so a WhatsApp re-connect
  heals the social panel by itself (see `meta-social/index.ts`).
