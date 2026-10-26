/* Saved Places — identification pipeline.
 * Pure logic, no UI. Works in the browser (window.SP) and in Node (module.exports) for testing.
 * Stages: extractClues -> buildQueries -> provider.search -> scoreCandidates -> decide -> findDuplicate
 */
(function (root) {
  'use strict';

  // ---------- Reference data ----------
  // [canonical, level, ...aliases]   level: 'area' (specific) or 'city' (broad)
  const AREAS = [
    ['Kuala Lumpur', 'city', 'KL'], ['Petaling Jaya', 'city', 'PJ'],
    ['Bangsar', 'area', 'Bangsar South', 'Bangsar Baru'], ['Bukit Bintang', 'area', 'BB'], ['KLCC', 'area'],
    ['Chow Kit', 'area'], ['Kampung Baru', 'area', 'Kampung Bharu'], ['Brickfields', 'area'], ['Mid Valley', 'area'],
    ['Damansara Uptown', 'area', 'Uptown'], ['Damansara Utama', 'area'], ['Damansara Heights', 'area', 'Bukit Damansara'],
    ['Damansara Jaya', 'area'], ['Damansara Perdana', 'area'], ['Kota Damansara', 'area'], ['Mutiara Damansara', 'area'],
    ['Ara Damansara', 'area'], ['Sri Damansara', 'area'], ['Bandar Utama', 'area'], ['Tropicana', 'area'],
    ['Taman Tun Dr Ismail', 'area', 'TTDI'], ['Mont Kiara', 'area', 'Mont Kiara', 'Kiara'], ['Sri Hartamas', 'area', 'Hartamas'],
    ['Desa ParkCity', 'area', 'Desa Park City'], ['Kepong', 'area'], ['Cheras', 'area'], ['Ampang', 'area'],
    ['Setapak', 'area'], ['Wangsa Maju', 'area'], ['Titiwangsa', 'area'], ['Sentul', 'area'], ['Old Klang Road', 'area', 'OKR'],
    ['Taman Desa', 'area'], ['Seputeh', 'area'], ['Sri Petaling', 'area'], ['Bukit Jalil', 'area'], ['Kuchai Lama', 'area'],
    ['Puchong', 'area'], ['Subang Jaya', 'area', 'Subang', 'SS15', 'USJ'], ['Bandar Sunway', 'area', 'Sunway'],
    ['Shah Alam', 'area'], ['Setia Alam', 'area'], ['Kota Kemuning', 'area'], ['Klang', 'area'], ['Cyberjaya', 'area'],
    ['Putrajaya', 'area'], ['Kajang', 'area'], ['Semenyih', 'area'], ['Seri Kembangan', 'area', 'Serdang'], ['Bangi', 'area'],
    ['Rawang', 'area'], ['Section 17', 'area', 'Seksyen 17'], ['SS2', 'area'], ['Taman Paramount', 'area', 'Paramount'],
    ['Jalan Alor', 'area'], ['Chinatown', 'area', 'Petaling Street', 'Jalan Petaling'], ['Pudu', 'area'], ['Imbi', 'area'],
    ['Taman Connaught', 'area', 'Connaught'], ['Kelana Jaya', 'area'], ['Glenmarie', 'area'], ['Jalan Ipoh', 'area'],
    ['Bukit Ceylon', 'area'], ['Bukit Tunku', 'area', 'Kenny Hills'], ['Tun Razak Exchange', 'area', 'TRX'], ['Bandar Baru Bangi', 'area'], ['Sri Rampai', 'area'],
  ];

  const CATEGORIES = [
    'Coffee / Cafe', 'Cake / Bakery', 'Ice cream', 'Dessert', 'Brunch', 'Breakfast', 'Restaurant',
    'Japanese food', 'Korean food', 'Chinese food', 'Western food', 'Bar food', 'Other',
  ];

  const CATEGORY_WORDS = {
    'Coffee / Cafe': ['coffee', 'latte', 'espresso', 'flat white', 'cafe', 'café', 'cappuccino', 'brew', 'roaster', 'roastery', 'matcha', 'mocha', 'cold brew', 'americano'],
    'Cake / Bakery': ['cake', 'cheesecake', 'bakery', 'pastry', 'pastries', 'croissant', 'bread', 'sourdough', 'tart', 'baker', 'bakes', 'scone', 'cinnamon roll', 'danish', 'brownie', 'cookie', 'muffin'],
    'Ice cream': ['ice cream', 'gelato', 'soft serve', 'sorbet', 'scoop', 'scoops', 'popsicle'],
    'Dessert': ['dessert', 'waffle', 'bingsu', 'pudding', 'parfait', 'kakigori', 'churros', 'cendol', 'ais kacang', 'tiramisu', 'sweet tooth', 'crepe', 'mochi'],
    'Brunch': ['brunch', 'eggs benedict', 'eggs ben', 'avocado toast', 'avo toast', 'pancake', 'french toast', 'big breakfast', 'all day breakfast', 'all-day breakfast'],
    'Breakfast': ['breakfast', 'nasi lemak', 'roti canai', 'kaya toast', 'half boiled', 'half-boiled', 'dim sum breakfast'],
    'Restaurant': ['restaurant', 'dinner', 'lunch', 'fine dining', 'set menu', 'tasting menu', 'omakase'],
    'Japanese food': ['sushi', 'ramen', 'omakase', 'japanese', 'izakaya', 'udon', 'donburi', 'yakitori', 'katsu', 'sashimi', 'tempura', 'wagyu don', 'unagi'],
    'Korean food': ['korean', 'kbbq', 'k-bbq', 'bibimbap', 'tteokbokki', 'soju', 'samgyeopsal', 'kimchi', 'jjigae'],
    'Chinese food': ['dim sum', 'chinese', 'char siu', 'siew yuk', 'wonton', 'bak kut teh', 'hokkien mee', 'xiao long bao', 'peking duck', 'zi char', 'claypot'],
    'Western food': ['western', 'steak', 'burger', 'pasta', 'pizza', 'fish and chips', 'grill', 'sandwich', 'cubano', 'muffin'],
    'Bar food': ['bar food', 'cocktail', 'cocktails', 'beer', 'wings', 'pub', 'gastropub', 'bar snacks', 'happy hour', 'craft beer'],
  };

  // OpenStreetMap types we consider food venues, mapped to a default category.
  const FOOD_TYPES = {
    'amenity:cafe': 'Coffee / Cafe', 'amenity:restaurant': 'Restaurant', 'amenity:fast_food': 'Restaurant',
    'amenity:bar': 'Bar food', 'amenity:pub': 'Bar food', 'amenity:ice_cream': 'Ice cream', 'amenity:food_court': 'Restaurant',
    'amenity:biergarten': 'Bar food', 'shop:bakery': 'Cake / Bakery', 'shop:pastry': 'Cake / Bakery',
    'shop:confectionery': 'Dessert', 'shop:coffee': 'Coffee / Cafe', 'shop:ice_cream': 'Ice cream', 'shop:deli': 'Restaurant',
    'shop:tea': 'Coffee / Cafe', 'shop:chocolate': 'Dessert',
  };

  // Words that appear in Instagram's UI / phone status bar and are never venue names.
  const UI_NOISE = /^(follow|following|suggested|suggested for you|sponsored|paid partnership.*|liked by.*|view all.*|add a comment.*|more|reels?|original audio.*|home|search|send|share|save|see translation|translate|reply|replies|message|audio|remix|\d+\s*(likes?|comments?|views?|plays?)|.*\bago|lte|5g|4g|wi-?fi|\d{1,2}:\d{2}.*|\d+%|edited|pinned|top|recent|posts|tagged|for you|explore|notifications?)$/i;

  const GENERIC_WORDS = new Set(['the', 'cafe', 'café', 'coffee', 'restaurant', 'restoran', 'bakery', 'kl', 'by', 'and', 'co', 'sdn', 'bhd', 'my', 'malaysia', 'official', 'bar', 'kitchen', 'house', 'eatery', 'store', 'shop']);

  // ---------- Helpers ----------
  const norm = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = (s) => norm(s).split(' ').filter(Boolean);
  const coreTokens = (s) => { const t = tokens(s); const c = t.filter((w) => !GENERIC_WORDS.has(w)); return c.length ? c : t; };
  const uniq = (arr) => Array.from(new Set(arr));
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function bigrams(s) { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; }
  function dice(a, b) {
    if (!a || !b) return 0; if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b); if (!A.length || !B.length) return 0;
    const m = new Map(); A.forEach((x) => m.set(x, (m.get(x) || 0) + 1));
    let hit = 0; B.forEach((x) => { const n = m.get(x); if (n) { hit++; m.set(x, n - 1); } });
    return (2 * hit) / (A.length + B.length);
  }

  /** Similarity of two venue names, 0..1. Ignores generic words like "cafe" and "the". */
  function nameSimilarity(a, b) {
    const ta = coreTokens(a), tb = coreTokens(b);
    if (!ta.length || !tb.length) return 0;
    const ja = ta.join(''), jb = tb.join('');
    if (ja === jb) return 1;
    const setA = new Set(ta), setB = new Set(tb);
    const inter = ta.filter((x) => setB.has(x)).length;
    const jacc = inter / new Set([...ta, ...tb]).size;
    const d = dice(ja, jb);
    const shorter = ja.length < jb.length ? ja : jb, longer = ja.length < jb.length ? jb : ja;
    const contain = shorter.length >= 4 && longer.includes(shorter) ? 0.6 + 0.3 * (shorter.length / longer.length) : 0;
    return Math.max(jacc, d, contain, setA.size && inter === setA.size ? 0.85 * (setA.size / setB.size) ** 0.25 : 0);
  }

  function haversineKm(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    const R = 6371, toR = (x) => (x * Math.PI) / 180;
    const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function findAreas(text) {
    const found = [];
    for (const [canon, level, ...aliases] of AREAS) {
      for (const name of [canon, ...aliases]) {
        const re = new RegExp('(^|[^A-Za-z0-9])' + escapeRe(name) + '($|[^A-Za-z0-9])', name.length <= 4 ? '' : 'i');
        if (re.test(text)) { found.push({ name: canon, level }); break; }
      }
    }
    // Prefer specific areas first.
    return found.sort((x, y) => (x.level === y.level ? 0 : x.level === 'area' ? -1 : 1));
  }
  function isAreaOnly(s) { const a = findAreas(s); return a.length > 0 && a.some((x) => norm(x.name) === norm(s) || AREAS.find((r) => r[0] === x.name).slice(2).some((al) => norm(al) === norm(s))); }

  function detectCategories(text) {
    const t = ' ' + text.toLowerCase() + ' ';
    const out = [];
    for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
      if (words.some((w) => new RegExp('(^|[^a-z])' + escapeRe(w) + '($|[^a-z])').test(t))) out.push(cat);
    }
    return out;
  }

  function parseInstagramUrl(url) {
    const m = (url || '').match(/instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    if (!m) return null;
    return { kind: m[1].toLowerCase().startsWith('reel') ? 'reel' : m[1].toLowerCase() === 'tv' ? 'video' : 'post', shortcode: m[2], url: `https://www.instagram.com/${m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase()}/${m[2]}/` };
  }

  /** Parse a Google Maps place link (ideally already expanded) and optional shared text. */
  function parseGoogleMaps(url, text) {
    const out = { name: null, address: null, lat: null, lng: null, mapsUrl: url || null };
    const u = url || '';
    const place = u.match(/\/maps\/place\/([^/@?]+)/);
    if (place) out.name = decodeURIComponent(place[1].replace(/\+/g, ' ')).trim();
    const precise = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    const at = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    const q = u.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
    const ll = precise || q || at;
    if (ll) { out.lat = parseFloat(ll[1]); out.lng = parseFloat(ll[2]); }
    if (text) {
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^https?:\/\//i.test(s));
      if (lines[0] && !out.name) out.name = lines[0];
      if (lines[0] && out.name && norm(lines[0]) !== norm(out.name) && !place) out.name = lines[0];
      if (lines[1]) out.address = lines.slice(1).join(', ');
    }
    if (out.name && /,/.test(out.name) && !out.address) { const [n, ...rest] = out.name.split(','); out.name = n.trim(); out.address = rest.join(',').trim(); }
    return out;
  }

  function decodeEntities(s) {
    return (s || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
      .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  /**
   * Parse the preview tags (og:title / og:description) of an Instagram post page, as fetched by the
   * user's own phone. Returns {status: 'ok'|'login'|'none', caption, handle, accountName}.
   */
  function parseInstagramMeta(raw) {
    const out = { status: 'none', caption: '', handle: null, accountName: null };
    if (!raw || !raw.trim()) return out;
    const tags = {};
    (raw.match(/<meta\b[^>]*>/gi) || []).forEach((t) => {
      const key = (t.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const val = (t.match(/content\s*=\s*"([^"]*)"/i) || t.match(/content\s*=\s*'([^']*)'/i) || [])[1];
      if (key && val != null && !tags[key.toLowerCase()]) tags[key.toLowerCase()] = decodeEntities(val);
    });
    const desc = tags['og:description'] || tags.description || '';
    const title = tags['og:title'] || '';
    if (!desc && !title) return out;
    // e.g. 1,234 likes, 56 comments - merchantslane on October 1, 2026: "Our pandan pancakes are back..."
    const d = desc.match(/^(?:[\d.,KkMm]+\s+likes?,\s*[\d.,KkMm]+\s+comments?\s*-\s*)?([A-Za-z0-9._]{2,30}) on [^:]{3,40}:\s*([\s\S]*)$/);
    // e.g. Merchant's Lane on Instagram: "Our pandan pancakes..."
    const t = title.match(/^([\s\S]*?) on Instagram:\s*([\s\S]*)$/i) || title.match(/^([\s\S]*?)\s*\(@([A-Za-z0-9._]+)\)/);
    const unquote = (x) => (x || '').trim().replace(/^["“]/, '').replace(/["”]\.?$/, '').trim();
    if (d) { out.handle = d[1]; out.caption = unquote(d[2]); }
    if (t) { out.accountName = t[1].trim() || null; if (!out.caption && t[2] && !/^[A-Za-z0-9._]+$/.test(t[2])) out.caption = unquote(t[2]); }
    if (!out.caption && /log ?in|sign up|create an account/i.test(desc + ' ' + title)) { out.status = 'login'; return out; }
    out.status = out.caption || out.accountName ? 'ok' : 'none';
    return out;
  }

  // ---------- Stage 1: clues ----------
  /**
   * @param {string} text  caption, pasted text, and/or screenshot text (OCR)
   * @param {string} url   Instagram link, if any
   * @returns {Clues}
   */
  function extractClues(text, url, account) {
    account = account || {};
    text = (text || '').replace(/ /g, ' ');
    const ig = parseInstagramUrl(url);
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const names = []; // {name, source: 'pin'|'tag'|'mention'|'line', raw}
    const addName = (name, source, raw) => {
      name = (name || '').replace(/^[\s:–\-|•·]+|[\s:–\-|•·.!]+$/g, '').replace(/\s{2,}/g, ' ').trim();
      if (name.length < 2 || name.length > 60) return;
      if (UI_NOISE.test(name) || isAreaOnly(name)) return;
      if (/RM\s?\d/i.test(name)) return;
      names.push({ name, source, raw: raw || name });
    };

    // a) Pin / label lines: "📍 Name, Area" or "Location: ..."
    const pinRe = /(?:📍|📌|🏠|\b(?:location|address|where|venue|find (?:them|it|us) at)\s*[:\-–])\s*(.+)/i;
    for (const line of lines) {
      const m = line.match(pinRe);
      if (!m) continue;
      const parts = m[1].split(/\s*(?:\||,| - | – | @ |\/)\s*/).filter(Boolean);
      if (!parts.length || isAreaOnly(parts[0])) continue;
      const nm = parts[0].startsWith('@') ? parts[0].slice(1).replace(/[._]+/g, ' ').replace(/\b(kl|my|mys|malaysia|official|hq)\b/gi, '').trim() : parts[0];
      addName(nm, 'pin', line);
    }

    // b) Instagram header in screenshots: "handle • Follow" then location tag on the next line.
    const handleLine = /^@?([a-z0-9._]{3,30})(?:\s*[✓✔☑️]+)?(?:\s*[•·]\s*(?:follow(?:ing)?)?|\s+follow(?:ing)?)?$/i;
    let creator = account.handle || null;
    for (let i = 0; i < Math.min(lines.length, 14); i++) {
      const hm = lines[i].match(handleLine);
      if (!hm || UI_NOISE.test(lines[i]) || /^\d+$/.test(hm[1])) continue;
      if (!/[._]|\d|follow/i.test(lines[i]) && !/^[a-z0-9._]+$/.test(hm[1])) continue; // looks like a handle
      creator = creator || hm[1];
      const next = lines[i + 1];
      if (next && next.length <= 60 && !UI_NOISE.test(next) && !handleLine.test(next) && !/RM\s?\d|#/.test(next)) {
        const parts = next.split(/\s*(?:,| - | – |\|)\s*/);
        if (!isAreaOnly(parts[0])) addName(parts[0], 'tag', next);
      }
      break;
    }

    // c) @mentions (often the venue in food-blogger posts)
    const mentions = uniq((text.match(/@([A-Za-z0-9._]{3,30})/g) || []).map((m) => m.slice(1).replace(/\.$/, '')));
    for (const h of mentions) {
      const words = h.replace(/[._]+/g, ' ').replace(/\b(kl|my|mys|malaysia|official|hq)\b/gi, '').trim();
      if (words && h.toLowerCase() !== (creator || '').toLowerCase()) addName(words, 'mention', '@' + h);
    }

    // c2) The posting account itself (often the venue when a business posts its own content)
    if (account.accountName) addName(account.accountName, 'account', 'account name');
    if (account.handle) addName(account.handle.replace(/[._]+/g, ' ').replace(/\b(kl|my|mys|malaysia|official|hq)\b/gi, '').trim(), 'account', '@' + account.handle);

    // d) Short Title Case lines (weak)
    let weak = 0;
    for (const line of lines) {
      if (weak >= 3) break;
      if (line.length > 40 || /[#@]|RM\s?\d|https?:|[.!?]$/.test(line)) continue;
      const w = line.split(/\s+/);
      if (w.length < 1 || w.length > 5) continue;
      const caps = w.filter((x) => /^[A-Z0-9][\w'’&.-]*$/.test(x)).length;
      if (caps / w.length >= 0.75 && !UI_NOISE.test(line) && !isAreaOnly(line)) { addName(line, 'line'); weak++; }
    }

    // Menu items with prices: "Cubano (RM55)", "Iced latte RM14"
    const menuItems = [];
    const priceRe = /([A-Za-z][A-Za-z0-9'’&.\- ]{1,40}?)\s*[(\-–:]?\s*RM\s?(\d{1,4}(?:\.\d{1,2})?)\s*\)?/g;
    let pm;
    while ((pm = priceRe.exec(text))) {
      const item = pm[1].replace(/^(?:\d+[.)]\s*|and\s+|the\s+|a\s+|for\s+|at\s+)/i, '').trim();
      if (item.length >= 2 && !/^(only|just|about|around|from|for|is|was|at|price)$/i.test(item)) menuItems.push({ name: item, price: parseFloat(pm[2]) });
    }

    const hashtags = uniq((text.match(/#([\p{L}\p{N}_]+)/gu) || []).map((h) => h.slice(1)));
    const areas = findAreas(text + ' ' + hashtags.join(' '));
    const categories = detectCategories(text + ' ' + hashtags.join(' ').replace(/_/g, ' '));

    // Rank and dedupe names: pin > tag > mention > line
    const rank = { pin: 0, tag: 1, mention: 2, account: 3, line: 4 };
    const seen = new Set();
    const nameClues = names.sort((a, b) => rank[a.source] - rank[b.source]).filter((n) => {
      const k = coreTokens(n.name).join(' '); if (!k || seen.has(k)) return false; seen.add(k); return true;
    }).slice(0, 4);

    return {
      url: ig ? ig.url : (url || null), shortcode: ig ? ig.shortcode : null, kind: ig ? ig.kind : null,
      creator, names: nameClues, areas, categories, menuItems: menuItems.slice(0, 12), hashtags: hashtags.slice(0, 30), mentions,
      hasText: text.trim().length > 0,
    };
  }

  // ---------- Stage 2: queries ----------
  function buildQueries(clues) {
    const qs = [];
    const area = clues.areas.find((a) => a.level === 'area') || clues.areas[0];
    for (const n of clues.names) {
      if (area) qs.push({ q: `${n.name} ${area.name}`, clue: n });
      qs.push({ q: n.name, clue: n });
    }
    return qs.slice(0, 6);
  }

  /** A Google Maps search link built from the best clues — the free manual fallback. */
  function googleMapsSearchUrl(clues, region) {
    const parts = [];
    if (clues.names[0]) parts.push(clues.names[0].name);
    else parts.push(...clues.menuItems.slice(0, 3).map((m) => m.name));
    if (!parts.length) parts.push(...clues.categories.slice(0, 1));
    const area = clues.areas[0] ? clues.areas[0].name : (region && region.label) || 'Kuala Lumpur';
    parts.push(area);
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(parts.join(' '));
  }

  // ---------- Stage 3: providers ----------
  // A provider returns Candidate[]: {providerId, name, address, area, city, lat, lng, osmType, raw}
  function photonProvider(fetchFn) {
    return {
      id: 'photon',
      async search(q, region) {
        const p = new URLSearchParams({ q, limit: '8', lang: 'en' });
        if (region) { p.set('lat', region.lat); p.set('lon', region.lng); }
        const res = await fetchFn('https://photon.komoot.io/api/?' + p.toString());
        if (!res.ok) throw new Error('Photon ' + res.status);
        const data = await res.json();
        return (data.features || []).filter((f) => f.properties && f.properties.name).map((f) => {
          const pr = f.properties;
          const addr = [[pr.housenumber, pr.street].filter(Boolean).join(' '), pr.district, pr.locality, pr.city, pr.state, pr.postcode].filter(Boolean);
          return {
            providerId: `osm:${(pr.osm_type || 'X')[0]}${pr.osm_id}`, name: pr.name, address: uniq(addr).join(', '),
            area: pr.district || pr.locality || null, city: pr.city || pr.state || null,
            lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], osmType: `${pr.osm_key}:${pr.osm_value}`, source: 'photon',
          };
        });
      },
    };
  }

  function nominatimProvider(fetchFn, sleep) {
    let last = 0;
    return {
      id: 'nominatim',
      async search(q, region) {
        const wait = 1100 - (Date.now() - last); if (wait > 0) await sleep(wait); last = Date.now();
        const p = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '8', countrycodes: 'my' });
        if (region) { const d = region.radiusKm / 111; p.set('viewbox', [region.lng - d, region.lat + d, region.lng + d, region.lat - d].join(',')); }
        const res = await fetchFn('https://nominatim.openstreetmap.org/search?' + p.toString());
        if (!res.ok) throw new Error('Nominatim ' + res.status);
        const data = await res.json();
        return data.filter((r) => r.name).map((r) => {
          const a = r.address || {};
          return {
            providerId: `osm:${(r.osm_type || 'X')[0].toUpperCase()}${r.osm_id}`, name: r.name, address: r.display_name,
            area: a.suburb || a.neighbourhood || a.quarter || a.city_district || null, city: a.city || a.town || a.state || null,
            lat: parseFloat(r.lat), lng: parseFloat(r.lon), osmType: `${r.category}:${r.type}`, source: 'nominatim',
          };
        });
      },
    };
  }

  // Google Places (New) Text Search, called from the browser with a key restricted to this website.
  // Field mask stays in the Pro tier (no rating/hours/reviews) to keep within Google's free monthly usage.
  const GOOGLE_TYPE_MAP = [
    [/^(cafe|coffee_shop|tea_house|cat_cafe|dog_cafe)$/, 'amenity:cafe'], [/^(bakery|cake_shop|pastry_shop)$/, 'shop:bakery'],
    [/^(ice_cream_shop|gelato_shop|frozen_yogurt_shop)$/, 'amenity:ice_cream'], [/^(dessert_shop|dessert_restaurant|confectionery|candy_store|chocolate_shop|donut_shop)$/, 'shop:confectionery'],
    [/^(bar|pub|wine_bar|cocktail_bar|sports_bar|gastropub|bar_and_grill|brewpub|beer_garden)$/, 'amenity:bar'],
    [/^(fast_food_restaurant|meal_takeaway|sandwich_shop|hamburger_restaurant|pizza_restaurant)$/, 'amenity:fast_food'], [/^food_court$/, 'amenity:food_court'],
    [/restaurant$|^(diner|bistro|brunch_restaurant|breakfast_restaurant|meal_delivery|food)$/, 'amenity:restaurant'],
  ];
  const GOOGLE_CUISINE = { japanese_restaurant: 'Japanese food', sushi_restaurant: 'Japanese food', ramen_restaurant: 'Japanese food', korean_restaurant: 'Korean food', korean_barbecue_restaurant: 'Korean food', chinese_restaurant: 'Chinese food', dim_sum_restaurant: 'Chinese food', american_restaurant: 'Western food', steak_house: 'Western food', italian_restaurant: 'Western food', brunch_restaurant: 'Brunch', breakfast_restaurant: 'Breakfast', dessert_restaurant: 'Dessert', dessert_shop: 'Dessert' };
  function googleTypeToOsm(types) {
    for (const t of types) for (const [re, osm] of GOOGLE_TYPE_MAP) if (re.test(t)) return osm;
    return 'google:' + (types[0] || 'place');
  }
  function googlePlacesProvider(fetchFn, apiKey) {
    return {
      id: 'google',
      async search(q, region) {
        const body = { textQuery: q, maxResultCount: 8, languageCode: 'en', regionCode: 'MY' };
        if (region) body.locationBias = { circle: { center: { latitude: region.lat, longitude: region.lng }, radius: Math.min(50000, (region.radiusKm || 40) * 1000) } };
        const res = await fetchFn('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.types,places.primaryType,places.googleMapsUri,places.addressComponents' },
          body: JSON.stringify(body),
        });
        if (!res.ok) { let msg = 'Google ' + res.status; try { const e = await res.json(); if (e.error && e.error.message) msg += ': ' + e.error.message; } catch (x) { /* ignore */ } throw new Error(msg); }
        const data = await res.json();
        return (data.places || []).map((p) => {
          const types = [p.primaryType, ...(p.types || [])].filter(Boolean);
          const comp = (k) => ((p.addressComponents || []).find((c) => (c.types || []).includes(k)) || {}).longText || null;
          return {
            providerId: 'google:' + p.id, name: (p.displayName && p.displayName.text) || '', address: p.formattedAddress || p.shortFormattedAddress || '',
            area: comp('sublocality_level_1') || comp('sublocality') || comp('neighborhood') || null, city: comp('locality') || comp('administrative_area_level_1') || null,
            lat: p.location ? p.location.latitude : null, lng: p.location ? p.location.longitude : null,
            osmType: googleTypeToOsm(types), extraCategories: types.map((t) => GOOGLE_CUISINE[t]).filter(Boolean),
            mapsUrl: p.googleMapsUri || null, source: 'google',
          };
        }).filter((c) => c.name);
      },
    };
  }

  // ---------- Stage 4: scoring ----------
  const SOURCE_BONUS = { pin: 15, tag: 15, mention: 8, account: 5, line: 0 };

  function scoreCandidate(clues, c, region) {
    const reasons = [];
    let best = { sim: 0, clue: null };
    for (const n of clues.names) { const s = nameSimilarity(n.name, c.name); if (s > best.sim) best = { sim: s, clue: n }; }
    let score = Math.round(50 * best.sim);
    reasons.push(`name ${Math.round(best.sim * 100)}% like "${best.clue ? best.clue.name : '—'}"`);
    if (best.clue && best.sim >= 0.5 && SOURCE_BONUS[best.clue.source]) { score += SOURCE_BONUS[best.clue.source]; reasons.push(`name from ${best.clue.source === 'pin' ? '📍 line' : best.clue.source === 'tag' ? 'location tag' : best.clue.source === 'account' ? 'posting account' : '@mention'}`); }

    const hay = norm([c.address, c.area, c.city].join(' '));
    const areaHit = clues.areas.find((a) => {
      const row = AREAS.find((r) => r[0] === a.name) || [a.name];
      return [row[0], ...row.slice(2)].some((nm) => nm.length > 3 && hay.includes(norm(nm)));
    });
    if (areaHit) { const pts = areaHit.level === 'city' ? 8 : 20; score += pts; reasons.push(`in ${areaHit.name}`); }

    const typeCat = FOOD_TYPES[c.osmType];
    let typeFit = false;
    if (!typeCat) { score -= 25; reasons.push(`not a food place (${c.osmType})`); }
    else if (!clues.categories.length) { score += 6; reasons.push('food venue'); typeFit = true; }
    else if (clues.categories.includes(typeCat) || (typeCat === 'Restaurant' && clues.categories.some((x) => /food|Brunch|Breakfast/.test(x)))) { score += 10; reasons.push(`type fits (${typeCat})`); typeFit = true; }
    else { score += 4; reasons.push(`food venue, type ${typeCat}`); }

    if (region && c.lat != null) {
      const d = haversineKm(region, c);
      if (d <= region.radiusKm) { score += 5; } else { score -= 15; reasons.push(`${Math.round(d)} km outside your region`); }
    }
    return { ...c, score: Math.max(0, Math.min(100, score)), sim: best.sim, areaHit: !!areaHit, typeFit, reasons, categories: Array.from(new Set([...(typeCat ? [typeCat] : []), ...(c.extraCategories || [])])) };
  }

  function scoreCandidates(clues, candidates, region) {
    const byId = new Map();
    for (const c of candidates) if (!byId.has(c.providerId)) byId.set(c.providerId, c);
    return Array.from(byId.values()).map((c) => scoreCandidate(clues, c, region)).sort((a, b) => b.score - a.score);
  }

  // ---------- Stage 5: decision ----------
  const DEFAULT_THRESHOLDS = { auto: 80, confirm: 50, margin: 15 };

  function decide(scored, t) {
    t = Object.assign({}, DEFAULT_THRESHOLDS, t || {});
    const top = scored[0];
    if (!top) return { level: 'low', top: null, margin: 0, why: 'No matching places found' };
    const second = scored.find((c) => c.providerId !== top.providerId);
    const margin = second ? top.score - second.score : 100;
    const independent = top.areaHit || top.typeFit; // a second signal besides the name
    if (top.score >= t.auto && margin >= t.margin && top.sim >= 0.75 && independent) return { level: 'high', top, margin, why: 'Strong match with a clear lead' };
    if (top.score >= t.confirm) return { level: 'medium', top, margin, why: margin < t.margin ? 'Close runner-up — could be another branch' : 'Likely, but needs your OK' };
    return { level: 'low', top, margin, why: 'Not confident enough' };
  }

  // ---------- Stage 6: duplicates ----------
  function findDuplicate(candidate, venues) {
    for (const v of venues) {
      if (candidate.providerId && v.providerPlaceId === candidate.providerId) return { venue: v, reason: 'same place id' };
    }
    for (const v of venues) {
      const sim = nameSimilarity(v.name, candidate.name);
      const d = haversineKm(v, candidate);
      if (sim >= 0.85 && d != null && d <= 0.15) return { venue: v, reason: 'same name within 150 m' };
      if (sim >= 0.95 && d == null && norm(v.address || '') && norm(v.address) === norm(candidate.address || '')) return { venue: v, reason: 'same name and address' };
    }
    return null;
  }

  /** Full pipeline: clues -> search -> score -> decide. Providers are tried in order until one gives a usable match. */
  async function identify({ text, url, account, providers, region, thresholds, onStep }) {
    const step = onStep || (() => {});
    const t0 = Date.now();
    const clues = extractClues(text, url, account);
    step('clues', clues);
    const queries = buildQueries(clues);
    let all = [], errors = [];
    for (const p of providers) {
      step('search', { provider: p.id, queries: queries.map((q) => q.q) });
      let done = false;
      for (const q of queries) {
        try { all = all.concat(await p.search(q.q, region)); } catch (e) { errors.push(`${p.id}: ${e.message}`); if (/40[13]/.test(e.message)) break; }
        // Stop as soon as one query gives a confident, clear winner (saves paid lookups).
        const d = decide(scoreCandidates(clues, all, region), thresholds);
        if (d.level === 'high') { done = true; break; }
      }
      if (done) break;
    }
    const scored = scoreCandidates(clues, all, region).slice(0, 6);
    const decision = decide(scored, thresholds);
    step('done', decision);
    return { clues, queries, candidates: scored, decision, errors, ms: Date.now() - t0 };
  }

  const SP = {
    AREAS, CATEGORIES, CATEGORY_WORDS, FOOD_TYPES, DEFAULT_THRESHOLDS,
    norm, nameSimilarity, haversineKm, findAreas, detectCategories, parseInstagramUrl, parseGoogleMaps,
    extractClues, parseInstagramMeta, decodeEntities, buildQueries, googleMapsSearchUrl, photonProvider, nominatimProvider, googlePlacesProvider,
    scoreCandidate, scoreCandidates, decide, findDuplicate, identify,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = SP; else root.SP = SP;
})(typeof window !== 'undefined' ? window : globalThis);
