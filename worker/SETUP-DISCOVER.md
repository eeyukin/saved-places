# Discover setup: creator feeds (Meta Business Discovery)

Discover reads public posts from food creators you follow, finds the venues, and links back to each post.
It uses Meta's official, free Business Discovery API through a small free Cloudflare server that keeps your Meta token secret.

Time: about 30–45 minutes, once. Token renewal: every 60 days (5 minutes).

## Part A — Instagram and Facebook (once)
1. **Instagram → Professional account.** Instagram app → profile → ☰ → *Account type and tools* → *Switch to professional account* → choose **Creator** (free, reversible).
2. **Create a Facebook Page.** facebook.com/pages/create → any name (e.g. "Saved Places") → Create.
3. **Link them.** Instagram app → *Edit profile* → *Page* → connect your new Facebook Page.

## Part B — Meta developer app and token
4. Go to **developers.facebook.com** → log in → *My Apps* → **Create App**. Name it `Saved Places`. When asked for a use case, choose the option for **Instagram / managing a Page** (or *Other* → *Business*).
5. In the app dashboard, add the **Instagram** product → **API setup with Facebook login**.
6. Open **Tools → Graph API Explorer**. Top right: pick your *Saved Places* app.
   - *User or Page*: **Get User Access Token**.
   - Add permissions: `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `instagram_manage_insights`, `business_management`.
   - **Generate Access Token** → log in → select your Page and Instagram account → allow.
7. **Find your Instagram ID.** In the Explorer box type `me/accounts?fields=name,instagram_business_account` → **Submit**. Copy the number under `instagram_business_account` → `id`. This is **IG_USER_ID**.
8. **Test.** Type `IG_USER_ID?fields=business_discovery.username(danieldineskl){username,media.limit(1){caption}}` (with your number) → **Submit**. You should see a caption.
9. **Make the token last 60 days.** *Tools → Access Token Debugger* → paste the token → **Debug** → **Extend Access Token** → copy the new token. This is **META_TOKEN**. Keep it private.

## Part C — Cloudflare Worker (free)
10. Sign up at **dash.cloudflare.com** (free plan).
11. **Workers & Pages → Create → Create Worker** → name `saved-places` → **Deploy** → **Edit code**. Delete the sample, paste everything from `worker.js`, → **Deploy**.
12. Worker → **Settings → Variables and Secrets** → add:
    - `META_TOKEN` — type **Secret** — your token from step 9
    - `IG_USER_ID` — type **Text** — the number from step 7
    - `ALLOWED_ORIGIN` — type **Text** — `https://eeyukin.github.io`
    → **Deploy**.
13. Copy the Worker address (e.g. `https://saved-places.yourname.workers.dev`). Open `…workers.dev/health` in a browser: it should say `"tokenSet":true,"igUserSet":true`.

## Part D — Connect the app
14. In `config.js` add `creatorsApi: 'https://saved-places.yourname.workers.dev',` and optionally `creators: ['danieldineskl'],` (see `config.example.js`). Upload to GitHub.
    (Or paste the address in the app: **Settings → Discover server**.)
15. App → **Discover** → follow creators → **Check for new posts**.

## Good to know
- Works only for **business and creator** accounts. Personal accounts return "not found".
- Each check looks at a creator's 25 most recent posts. Posts without a venue name are skipped without using Google.
- Up to 15 Google lookups per check, to keep costs inside your free allowance.
- **Every 60 days** the token expires; the app shows "Your Meta token has expired". Repeat steps 6 and 9 and update `META_TOKEN` in Cloudflare.
- For a **public** launch, Meta requires App Review and business verification for this feature.
- The app shows the venue, credits the creator and links to the post. It does not republish captions or photos.
