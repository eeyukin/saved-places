# Saved Places — proof of concept (v0.1)

Share an Instagram post and the app works out which cafe or restaurant it's about, then saves it to a searchable list on your phone.

This version tests one thing: **can it identify venues from real posts?** It's free and needs no accounts except GitHub (to host the files).

---

## Part 1 — Put the app online (about 10 minutes, on your computer)

1. Go to **github.com** and create a free account. Remember your username, e.g. `ykchigga`.
2. Click **+** (top right) → **New repository**.
   - Repository name: `saved-places`
   - Choose **Public** (GitHub Pages is free for public repos; your saved places are **not** stored here, only the app's code).
   - Click **Create repository**.
3. On the new page, click **uploading an existing file**. Drag in **all the files from this folder**: `index.html`, `app.js`, `pipeline.js`, `manifest.webmanifest`, `icon-180.png`, `icon-192.png`, `icon-512.png`, `README.md`. Click **Commit changes**.
4. Go to **Settings** → **Pages** (left menu). Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**, then **Save**.
5. Wait 1–2 minutes and refresh. GitHub shows your address:
   `https://YOUR-USERNAME.github.io/saved-places/`

## Part 2 — Open it on your iPhone

1. Open that address in **Safari**.
2. Tap **Share** → **Add to Bookmarks** (or **Add to Home Screen**).
   - If Add to Home Screen shows an **"Open as Web App"** switch, turn it **off**. The Shortcut opens Safari, and Safari and home-screen web apps keep separate storage on iPhone; with it off, everything stays in one place.
3. Quick check: tap **Add**, paste a caption such as `📍 Merchant's Lane, Petaling Street`, and tap **Find this place**.

## Part 3 — Make the "Saved Places" share shortcut (about 10 minutes, on your iPhone)

This puts **Saved Places** in Instagram's Share menu. When you share a post, your phone opens the link (like a browser would), reads the post's preview text (caption and account name), and sends it to the app. No screenshot or pasting needed.

> **Experimental.** This reads Instagram's page preview from your phone. Meta's terms don't permit automated collection, Instagram may show a login page instead of the caption, and it can stop working whenever Instagram changes something. It's for personal testing only. If it doesn't get the caption, the app says so and asks for a screenshot.

Open the **Shortcuts** app → **+** → name it **Saved Places**. Tap the **ⓘ** (details) button → turn on **Show in Share Sheet**. Set *Receive* to **URLs and Text** only. Then add these actions in order (search each name in the action search bar):

| # | Action | Set it to |
|---|---|---|
| 1 | **Get URLs from Input** | Input: *Shortcut Input* |
| 2 | **Set Variable** | Name: `Link`, Input: *URLs* |
| 3 | **If** | *Link* **contains** `goo.gl` |
| 4 | ↳ **Expand URL** | URL: *Link* |
| 5 | ↳ **URL Encode** | *Expanded URL* |
| 6 | ↳ **Get Text from Input** | *Shortcut Input* |
| 7 | ↳ **URL Encode** | *Text* (from step 6) |
| 8 | ↳ **Text** | `https://eeyukin.github.io/saved-places/?gmaps=`[*URL Encoded Text* from 5]`&gtext=`[*URL Encoded Text* from 7] |
| 9 | ↳ **Open URLs** | *Text* |
| 10 | ↳ **Stop This Shortcut** | |
| 11 | **End If** (added automatically with step 3; leave **Otherwise** empty) | |
| 12 | **Get Contents of URL** | URL: *Link* (method GET) |
| 13 | **Match Text** | Pattern: `<meta[^>]+>` — in: *Contents of URL* |
| 14 | **Combine Text** | *Matches*, with **New Lines** |
| 15 | **URL Encode** | *Combined Text* |
| 16 | **URL Encode** | *Link* |
| 17 | **Text** | `https://eeyukin.github.io/saved-places/?url=`[*URL Encoded Text* from 16]`&meta=`[*URL Encoded Text* from 15] |
| 18 | **Open URLs** | *Text* |

Tip: tap the blue variable names inside an action to pick which earlier result it uses. Getting the right variable in steps 8 and 17 is what matters most.

## Part 4 — Use it

**Save an Instagram post**
1. On the post, tap Instagram's **Share** (paper-plane) button → **Share to…** / **More** → **Saved Places**.
2. Safari opens and the app does the rest. You'll see one of four things:
   - **Saved automatically**: a strong match. Tap *Wrong place?* if it isn't.
   - **Confirm the place**: tap *Yes, this one* or pick another branch.
   - **Help me find it**: tap *Search Google Maps*, open the right place, then **Share → Saved Places**. The place comes back and finishes the import.
   - **"Instagram didn't share the caption"**: the phone got a login page. Add a screenshot on that screen and the app reads it instead.

**Save a place straight from Google Maps:** in Google Maps, open the place → **Share** → **Saved Places**.

**Find something later:** use **Places** to search (name, area, menu item, note), filter by category, and sort by *Nearest first*. Set **Home** and **Office** in Settings for "near the office" searches.

## Part 5 — The 5-post test

1. Pick 5 posts: a mix of Reels and photo posts, at least one chain with several branches, and one where the caption doesn't name the place.
2. Save each one using Part 4. For each, note whether it ended on the **right venue and branch**.
3. In **Settings → Export test log (CSV)**, save the file and send it to Claude along with your notes.

## Good to know

- **Your data stays on your phone** (Safari storage). Use **Settings → Back up** now and then. Clearing Safari's website data deletes it.
- **Venue data** comes from OpenStreetMap (© OpenStreetMap contributors) through the free Photon and Nominatim services. Coverage of small KL cafes is unknown; this test tells us how good it is.
- **No Instagram login**, ever. The app only uses what you share with it.
- Searches send only the venue name and area to OpenStreetMap's servers.

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout and styles |
| `app.js` | Screens, storage on the phone, import flow, test log |
| `pipeline.js` | Venue identification: clues → search → score → decide → duplicate check |
| `manifest.webmanifest`, `icon-*.png` | App name and icon for the home screen |
