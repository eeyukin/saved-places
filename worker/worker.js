/**
 * Saved Places — creator feed server (Cloudflare Worker).
 *
 * Holds your Meta access token in secret and asks Instagram's official Business Discovery API
 * for a business/creator account's recent public posts. Returns only what the app needs:
 * caption, post link, time and the account's name. No images are stored or re-served.
 *
 * Settings (Cloudflare → your Worker → Settings → Variables and Secrets):
 *   META_TOKEN      (Secret)  long-lived user access token from Meta
 *   IG_USER_ID      (Text)    your own Instagram professional account's ID
 *   ALLOWED_ORIGIN  (Text)    https://eeyukin.github.io
 *   GRAPH_VERSION   (Text, optional) e.g. v23.0
 *
 * Endpoints:
 *   GET /post?url=<instagram post or reel link>  → { caption, handle, name, meta, source }   (no Meta setup needed)
 *   GET /creator?u=<handle>[&after=<cursor>]     → { account: {username, name}, posts: [...], next }  (needs Meta token)
 *   GET /health                                  → { ok: true, tokenSet, igUserSet }
 *
 * /post reads the PUBLIC post page with an honest user agent, the way a link preview does: no login,
 * no browser/crawler impersonation, cached for a day. If Instagram shows a login wall instead, it falls back
 * to the public embed page. Experimental and for personal use: Meta's terms restrict automated collection,
 * and Instagram can block this at any time.
 */
const UA = 'saved-places/0.1 (personal link preview; +https://eeyukin.github.io/saved-places/)';

function decodeEntities(s) {
  return (s || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function metaTags(html) {
  return (html.match(/<meta\b[^>]*>/gi) || []).filter((t) => /property=["']og:|name=["']description["']/i.test(t)).join('\n');
}
function readOg(html, key) {
  const t = (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i')) || [])[0] || '';
  return decodeEntities((t.match(/content=["']([^"']*)["']/i) || [])[1] || '');
}
function parseEmbed(html) {
  // <div class="Caption"><a class="CaptionUsername" ...>handle</a> ...caption... <div class="CaptionComments">
  const start = html.search(/class="Caption"/);
  if (start < 0) return null;
  let block = html.slice(start, start + 20000);
  const end = block.search(/class="CaptionComments"|<\/blockquote>|class="SocialProof"/);
  if (end > 0) block = block.slice(0, end).replace(/<[^>]*$/, ''); // drop the half-cut tag
  const handle = decodeEntities(((block.match(/class="CaptionUsername"[^>]*>([^<]+)</) || [])[1] || '').trim()) || null;
  let text = block.replace(/^[^>]*>/, '').replace(/<a[^>]*class="CaptionUsername"[^>]*>[^<]*<\/a>/, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  text = decodeEntities(text).replace(/\n{3,}/g, '\n\n').trim();
  return text ? { handle, caption: text.slice(0, 4000) } : null;
}
async function readPost(code, kind) {
  const base = `https://www.instagram.com/${kind}/${code}/`;
  const tried = [];
  // a) the public post page (preview tags)
  try {
    const res = await fetch(base, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow' });
    const html = await res.text();
    const desc = readOg(html, 'og:description');
    if (res.ok && /:\s*["“]/.test(desc)) {
      const m = desc.match(/^(?:[\d.,KkMm]+\s+likes?,\s*[\d.,KkMm]+\s+comments?\s*-\s*)?([A-Za-z0-9._]{2,30}) on [^:]{3,40}:\s*([\s\S]*)$/);
      const title = readOg(html, 'og:title');
      return { source: 'page', meta: metaTags(html), handle: m ? m[1] : null, name: (title.match(/^([\s\S]*?) on Instagram/i) || [])[1] || null,
        caption: m ? m[2].trim().replace(/^["“]/, '').replace(/["”]\.?$/, '') : '' };
    }
    tried.push(`page: ${res.status}${desc ? '' : ', no preview tags (login wall)'}`);
  } catch (e) { tried.push('page: ' + e.message); }
  // b) the public embed page (made for other websites to show the post)
  try {
    const res = await fetch(base + 'embed/captioned/', { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
    const html = await res.text();
    const e = res.ok ? parseEmbed(html) : null;
    if (e) return { source: 'embed', meta: '', handle: e.handle, name: null, caption: e.caption };
    tried.push(`embed: ${res.status}${res.ok ? ', no caption found' : ''}`);
  } catch (e) { tried.push('embed: ' + e.message); }
  return { error: 'Instagram did not share this post with the server', tried };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || 'https://eeyukin.github.io').split(',').map((s) => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors, ...extra } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'Only GET is supported' }, 405);
    // Only your app may use this server from a browser.
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403);

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, tokenSet: !!env.META_TOKEN, igUserSet: !!env.IG_USER_ID });
    if (url.pathname === '/post') {
      // Rebuild the Instagram URL ourselves, so this server can never be pointed at another website.
      const m = (url.searchParams.get('url') || '').match(/^https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})/i);
      if (!m) return json({ error: 'Not an Instagram post or reel link' }, 400);
      const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase(), code = m[2];
      const cache = caches.default;
      const key = new Request(`https://cache.saved-places/post/${code}`);
      const hit = await cache.match(key);
      if (hit) return new Response(await hit.text(), { headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...cors } });
      const r = await readPost(code, kind);
      if (r.error) return json(r, 502);
      const body = JSON.stringify({ ...r, shortcode: code, kind });
      ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' } })));
      return new Response(body, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS', ...cors } });
    }
    if (url.pathname !== '/creator') return json({ error: 'Not found' }, 404);

    const handle = (url.searchParams.get('u') || '').replace(/^@/, '').trim().toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(handle)) return json({ error: 'Invalid Instagram handle' }, 400);
    const after = (url.searchParams.get('after') || '').replace(/[^A-Za-z0-9_\-=]/g, '');
    if (!env.META_TOKEN || !env.IG_USER_ID) return json({ error: 'Server not configured: add META_TOKEN and IG_USER_ID' }, 500);

    // Cache each creator's page for 1 hour to stay well inside Meta's rate limits.
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.saved-places/creator/${handle}?after=${after}`);
    const hit = await cache.match(cacheKey);
    if (hit) { const body = await hit.text(); return new Response(body, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...cors } }); }

    const version = env.GRAPH_VERSION || 'v23.0';
    const media = `media.limit(25)${after ? `.after(${after})` : ''}{caption,permalink,timestamp,media_type}`;
    const fields = `business_discovery.username(${handle}){username,name,${media}}`;
    const api = `https://graph.facebook.com/${version}/${encodeURIComponent(env.IG_USER_ID)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(env.META_TOKEN)}`;

    let data;
    try {
      const res = await fetch(api);
      data = await res.json();
      if (!res.ok || data.error) {
        const e = data.error || {};
        let hint = '';
        if (e.code === 190) hint = 'Your Meta token has expired or is invalid. Make a new long-lived token and update META_TOKEN.';
        else if (e.code === 110 || /cannot be found|does not exist/i.test(e.message || '')) hint = 'That account was not found, or it is a personal (not business/creator) account.';
        else if (e.code === 4 || e.code === 17 || e.code === 32 || e.code === 613) hint = 'Meta rate limit reached. Try again later.';
        return json({ error: e.message || `Meta error ${res.status}`, code: e.code || null, hint }, 502);
      }
    } catch (err) {
      return json({ error: 'Could not reach Meta: ' + err.message }, 502);
    }

    const bd = data.business_discovery || {};
    const posts = ((bd.media && bd.media.data) || []).map((m) => ({
      id: m.id,
      caption: (m.caption || '').slice(0, 4000),
      permalink: m.permalink || null,
      timestamp: m.timestamp || null,
      type: m.media_type || null,
    }));
    const next = (bd.media && bd.media.paging && bd.media.paging.cursors && bd.media.paging.next) ? bd.media.paging.cursors.after : null;
    const body = JSON.stringify({ account: { username: bd.username || handle, name: bd.name || null }, posts, next });
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } })));
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS', ...cors } });
  },
};
