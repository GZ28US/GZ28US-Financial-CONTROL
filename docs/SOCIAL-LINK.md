# SOCIAL LINK — the app and Claude on YouTube, Instagram, Facebook, TikTok, Meta Business Suite

Ordered by Márcio on 08/11/2026: «i want to link deeply all the apps we need to link, all of them, I want Claude and the app to have
deep access to them all». Built on 09/11/2026 (Orlando) by the SOCIAL LINK session, started from App Development 2.

## What is in the app (commit bd6cff6f, everything OFF)

| Piece | Where |
|---|---|
| Tokens, one row per account (sealed with AES-256-GCM, key `SOCIAL_TOKEN_KEY` in Vercel only) | table `social_auth` |
| OAuth state, single use, 30 min | table `social_oauth_states` |
| Switches (missing row = OFF) | `social.meta.enabled` · `social.youtube.enabled` · `social.tiktok.enabled` · `social.publish.enabled` |
| Connect screen (logged-in human only; switches flip here, recorded with the e-mail) | `/ca/social/connect` |
| Start → consent URL | `POST /ca/api/social/{meta,youtube,tiktok}/auth` |
| Callback (stores the sealed token, says which account consented) | `GET /ca/api/social/{meta,youtube,tiktok}/callback` |
| Read only, fixed request shapes | `GET /ca/api/social/read?what=…` (header `x-read-key` or logged-in screen) |
| Status (switches, env yes/no, accounts without tokens), health check | `GET/POST /ca/api/social/status` |
| Daily token keeper 11:13 UTC | `/ca/api/cron/social-health` |
| Migration / rollback | `MIGRATION_social_auth.sql` / `ROLLBACK_social_auth.sql` (via `node scripts/roda-sql.mjs`) |

`what=` values: `fb_page fb_posts fb_comments(id) fb_insights fb_conversations ig_profile ig_media ig_comments(id) ig_insights
ig_conversations meta_businesses yt_channel yt_videos yt_video(id) yt_comments yt_analytics tt_profile tt_videos`.
Optional: `account=` (row id, external id or @handle), `metric=`, `period=`, `since=`/`until=` (YYYY-MM-DD), `after=` (cursor).

Nothing in this step posts, replies or DMs. Writes come later behind `social.publish.enabled`, and every write still waits for Márcio's order.

## Platform by platform

### Meta: Facebook Page, Instagram Business, Messenger and IG DMs, Business Suite
- **API:** Graph API (`graph.facebook.com/v23.0`). One consent through Facebook Login covers all of it. Instagram is read through the
  linked page's token. "Business Suite" has no API of its own: it is the Business Portfolio (`business_management`) plus the page and IG assets.
- **Scopes asked:** pages_show_list, pages_read_engagement, pages_read_user_content, pages_manage_metadata, pages_manage_posts,
  pages_manage_engagement, pages_messaging, read_insights, business_management, instagram_basic, instagram_manage_comments,
  instagram_manage_insights, instagram_manage_messages, instagram_content_publish.
- **Tokens:** user token 60 days; the PAGE token taken from it **does not expire**. It dies only on a password change, a revoke or a removed role.
  The cron runs `debug_token` once a day and marks a dead token EXPIRED.
- **App Review:** **not needed for our own accounts.** An app in Development mode gets every permission for people who have a role
  on the app (admin, developer or tester), on assets they manage. App Review plus Business Verification is needed only to act on
  OTHER people's pages, or to receive webhooks from people without a role. Later, if we want DM webhooks in real time: the app must
  be Live, which means App Review for `pages_messaging` and `instagram_manage_messages`, plus Business Verification of GZ28US LLC.
- **Márcio's clicks:**
  1. developers.facebook.com → Create App → type **Business**, attached to the GZ28US Business Portfolio.
  2. Add the use cases "Manage everything on your Page", "Manage messaging & content on Instagram" and "Engage with customers on Messenger".
  3. Facebook Login → Valid OAuth Redirect URI `https://www.gz28us.com/ca/api/social/meta/callback`.
  4. Put App ID and App Secret in Vercel as `META_APP_ID` / `META_APP_SECRET` (he types them, or pastes them into the Vercel form; never in chat).
  5. On /ca/social/connect: turn `social.meta.enabled` ON → CONNECT → sign in → tick the page(s) and @gz28us.
- **DMs:** the 24-hour messaging window applies to any reply. Reading the conversation history works without review for role users.
- **The handle facebook.com/gz28us** is a Meta-side problem; the API does not solve it.

### YouTube (@gz28us, UCzfjAdu-r3QIpRXpU0W0MsQ)
- **API:** YouTube Data API v3 (channel, videos, comments, upload) and YouTube Analytics API (views, watch time, subscribers).
  YouTube has no DMs.
- **Scopes:** youtube.readonly, youtube.force-ssl (comments), youtube.upload, yt-analytics.readonly. These are "sensitive", not "restricted".
- **Uses the same Google Cloud project and OAuth client as the Gmail hookup** (`GOOGLE_CLIENT_ID/SECRET`, already in Vercel).
- **Márcio's clicks** (Google Cloud console, the project that holds the Gmail client):
  1. APIs & Services → Library → enable **YouTube Data API v3** and **YouTube Analytics API**.
  2. Credentials → the OAuth client → add the redirect URI `https://www.gz28us.com/ca/api/social/youtube/callback`.
  3. OAuth consent screen → add the four YouTube scopes. **It must be "In production"**: in "Testing", refresh tokens die after 7 days.
     Unverified + production works for our own account (the user sees the "unverified app" warning and clicks through).
  4. On /ca/social/connect: `social.youtube.enabled` ON → CONNECT → pick the **@gz28us channel** (brand account), not the personal profile.
- **Catch:** uploads from an unverified API project are locked **private** until the project passes the YouTube API compliance
  audit (a form, free, takes days to weeks). Reading, comments and analytics are not affected. Quota: 10,000 units a day; reads cost 1 unit each.

### TikTok (@gz28.v8.speedshop)
- **API:** TikTok for Developers (`open.tiktokapis.com/v2`): Login Kit, Display (user.info.*, video.list), Content Posting API
  (video.upload = send to the drafts inbox; video.publish = direct post).
- **Tokens:** access 24 h; refresh 365 days, and it **rotates** (each refresh can return a new one, which the code stores).
- **App Review:** needed for production. Until then the app runs in **Sandbox**: up to 10 target users (add @gz28.v8.speedshop) can
  connect, and any post made through an **unaudited** app is **private (SELF_ONLY)**. Public direct posts need the Content Posting audit.
  Reading (profile, stats, video list) works in Sandbox.
- **Comments and DMs:** the developers.tiktok.com APIs have **no** comment or DM reading for our account. Comments and insights for a
  Business account come from the separate **TikTok API for Business** (business-api.tiktok.com, "Accounts" product, its own approval).
  TikTok DMs have no general API.
- **Márcio's clicks:**
  1. developers.tiktok.com → log in → Manage apps → Connect an app (organisation GZ28 V8 SpeedShop USA LLC).
  2. Add products **Login Kit** and **Content Posting API**, and the scopes above. Redirect URI `https://www.gz28us.com/ca/api/social/tiktok/callback`.
     Terms and privacy URLs: gz28us.com pages. Domain verification for gz28us.com if asked.
  3. Sandbox → add @gz28.v8.speedshop as target user.
  4. Put Client key and Client secret in Vercel as `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`.
  5. /ca/social/connect: `social.tiktok.enabled` ON → CONNECT.
  6. When ready to post publicly: submit the app for review (demo video of the connect flow).
- Note: the Higgsfield connector already has its own TikTok publish path (`tiktok_connect` / `tiktok_prepare_publish`). It is a
  separate door and does not give the app reading access.

## Step 2: «do all worth it» (commit 8de13ef4, all READ ONLY, switches OFF)

New `what=` on `/ca/api/social/read`: `meta_ad_accounts`, `meta_ads_insights(id=act_…)`, `gbp_accounts`, `gbp_locations`,
`gbp_reviews(id=location)`, `gbp_insights(id=location)`, `cal_list`, `cal_events(id=calendar, default primary)`, `gads_customers`,
`gads_campaigns(id=customer)`, `ebay_purchases`. App-credential reads: `/ca/api/integrations/read?what=paypal_transactions` and
`?what=track&carrier=ups|fedex|usps&id=<number>`. Migration `MIGRATION_integrations_2.sql`, rollback `ROLLBACK_integrations_2.sql`.

### Google: Business Profile, Calendar and Google Ads (one consent on gz28us@gmail.com) · switch `social.google.enabled`
- **Business Profile API:** not open by default. Quota starts at **0**; Márcio files the access request form
  ("GBP API access request", Google Business Profile API contact form) for the Cloud project. Approval usually takes days.
  Once approved, enable: My Business Account Management, Business Information, Business Profile Performance, and My Business v4 (reviews).
  Review replies are not built; when they are, they sit behind a switch plus his OK for each reply.
- **Calendar API:** enable it; no review is needed for his own account. Reading is built. Two-way sync of the shop schedule is the next
  step, behind its own switch.
- **Google Ads API:** a **developer token** from the Ads account's API Center (it needs a *manager* account; "Basic access" is an
  application form, and the test token only reads test accounts). Env `GOOGLE_ADS_DEVELOPER_TOKEN` (+ `GOOGLE_ADS_LOGIN_CUSTOMER_ID` if
  reading through a manager). API version set by `GOOGLE_ADS_API_VERSION` (default v22; Google sunsets each version after about a year).
- Same Cloud blocker as YouTube: **the account needs 2-step verification first** (Google Cloud blocked access on 09/11).
  Consent screen must be "In production".

### Meta Ads · rides on `social.meta.enabled`
`ads_read` was added to the Meta consent. In Development mode it works for his own ad accounts (Marketing API standard access);
no review is needed for read-only use on accounts he owns.

### eBay purchases · switch `social.ebay.enabled`
- developer.ebay.com → production keyset (App ID = `EBAY_CLIENT_ID`, Cert ID = `EBAY_CLIENT_SECRET`) → User Tokens →
  create a **RuName** with "auth accepted URL" `https://www.gz28us.com/ca/api/social/ebay/callback` → `EBAY_RUNAME`.
- The buyer side is the Trading API `GetMyeBayBuying` (won/purchased items, last 60 days), which returns raw XML. Parsing it and booking
  the orders is **AutoBook's** job. eBay asks new production keysets to subscribe to (or opt out of) Marketplace Account Deletion
  notifications; opting out is allowed for an app that stores no eBay user data beyond its own tokens.

### PayPal · switch `paypal.read.enabled`
developer.paypal.com → Apps & Credentials → **Live** → create an app on the business account → enable **Transaction search** →
`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. Read: up to 31 days per call, with about 3 hours of lag on PayPal's side.

### Amazon: not worth building
Amazon has no API for a regular buyer's order history (SP-API is for sellers). The only option is the **Amazon Business** Reporting
API, and only if the shop buys on an Amazon Business account. E-mail and AutoBook stay the source.

### UPS · FedEx · USPS tracking · switch `carriers.track.enabled`
- UPS: developer.ups.com → app with the **Tracking** product → `UPS_CLIENT_ID/SECRET` (a UPS account number is needed to create the app).
- FedEx: developer.fedex.com → project with the **Track API** → production keys → `FEDEX_CLIENT_ID/SECRET`.
- USPS: developers.usps.com → app → `USPS_CLIENT_ID/SECRET` (Tracking v3).
- These are a second opinion next to 17TRACK, not a replacement. **Labels are not built**: each label is a purchase, so it will be
  a separate step (UPS Shipping, FedEx Ship and USPS Labels APIs, which need payment accounts), behind a switch plus his OK for each label.

## One shared prerequisite
`SOCIAL_TOKEN_KEY` (32 random bytes, base64) in Vercel Production. Without it every CONNECT answers 503 and nothing is stored.
Generate it with `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | npx vercel env add SOCIAL_TOKEN_KEY production`,
so the value never appears on screen. Then redeploy.

## Status (09/11/2026)
| Integration | Code | Waiting on |
|---|---|---|
| `SOCIAL_TOKEN_KEY` | ✅ set in Vercel, live | — |
| YouTube | ✅ CONNECTED 09/11 | @gz28us (UCzfjAdu-r3QIpRXpU0W0MsQ), switch ON, refresh token stored. Proven live: yt_channel, yt_videos, yt_comments, yt_analytics all 200 on the real channel |
| Google (Business Profile · Calendar · Ads) | live, OFF | ✅ Cloud done 09/11 (Calendar, Business Account Mgmt, Business Information, Performance, Google Ads enabled; redirect URI added). Márcio: switch ON + CONNECT; GBP API access form (quota 0 until Google approves; v4 reviews API hidden until then); Ads developer token |
| Meta (FB · IG · DMs · Business Suite · Ads) | live, OFF | Márcio: create the Meta developer app + 2 env vars. No App Review for own assets |
| TikTok | live, OFF | Márcio: developer app + sandbox target user + 2 env vars; TikTok audit before public posts |
| eBay purchases | live, OFF | Márcio: production keyset + RuName + 3 env vars |
| PayPal | live, OFF | Márcio: Live REST app with Transaction search + 2 env vars |
| UPS / FedEx / USPS tracking | live, OFF | Márcio: 3 developer apps + 6 env vars (UPS needs the account number) |
| Amazon | not built | no buyer API (only Amazon Business) |
| Labels | not built | each label costs money: separate step, his OK each time |
