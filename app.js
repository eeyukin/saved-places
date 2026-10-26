/* Valerie's Makan-makan ✨ (Saved Places) — app UI, storage and import flow. Logic for identification lives in pipeline.js (window.SP). */
(function () {
  'use strict';
  const SP = window.SP;
  const $app = document.getElementById('app');
  const APP_VERSION = '0.1.0-poc';

  // ---------------- Storage (IndexedDB) ----------------
  const DB_NAME = 'saved-places', DB_VER = 2;
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('venues')) d.createObjectStore('venues', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('posts')) d.createObjectStore('posts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('log')) d.createObjectStore('log', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('discover')) d.createObjectStore('discover', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      const r = fn(s); t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : r); t.onerror = () => reject(t.error);
    });
  }
  const store = {
    all: (s) => tx(s, 'readonly', (os) => os.getAll()),
    get: (s, id) => tx(s, 'readonly', (os) => os.get(id)),
    put: (s, obj) => tx(s, 'readwrite', (os) => os.put(obj)),
    del: (s, id) => tx(s, 'readwrite', (os) => os.delete(id)),
    clear: (s) => tx(s, 'readwrite', (os) => os.clear()),
    async kv(k, fallback) { const r = await store.get('kv', k); return r ? r.v : fallback; },
    setKv: (k, v) => store.put('kv', { k, v }),
  };

  const DEFAULT_SETTINGS = {
    myName: 'Me', region: { lat: 3.10, lng: 101.62, radiusKm: 40, label: 'Klang Valley' },
    home: null, office: null, thresholds: { ...SP.DEFAULT_THRESHOLDS }, useNominatimFallback: true, customTags: [],
  };
  let settings = null;
  const SHORTCUT_NAME = (window.SP_CONFIG && window.SP_CONFIG.shortcutName) || 'Valerie "Click Here"';
  const BUILT_IN_KEY = (window.SP_CONFIG && /^AIza/.test(window.SP_CONFIG.googleKey || '')) ? window.SP_CONFIG.googleKey : '';
  const googleKey = () => settings.googleKey || BUILT_IN_KEY; // a key pasted in Settings wins; otherwise the built-in one
  async function loadSettings() {
    settings = Object.assign({}, DEFAULT_SETTINGS, await store.kv('settings', {}));
    return settings;
  }
  const saveSettings = () => store.setKv('settings', settings);

  // ---------------- Utilities ----------------
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowIso = () => new Date().toISOString();
  const fmtKm = (d) => (d == null ? '' : d < 1 ? `${Math.round(d * 1000)} m` : `${d < 10 ? d.toFixed(1) : Math.round(d)} km`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function toast(msg, ms = 2600) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
  function initials(name) { return (name || '?').replace(/^the\s+/i, '').trim().slice(0, 1).toUpperCase(); }
  function hashHue(s) { let h = 0; for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const googlePhotoUrl = (v, px) => (v.googlePhoto && v.googlePhoto.name && googleKey()) ? `https://places.googleapis.com/v1/${v.googlePhoto.name}/media?maxWidthPx=${px}&key=${encodeURIComponent(googleKey())}` : null;
  // List thumbnails: the Google Maps photo, cropped square (background-size: cover); else the post image; else initials.
  function cardThumbStyle(v) { const g = googlePhotoUrl(v, 240); return g ? `background-image:url('${g}')` : thumbStyle(v); }
  const hasCardImage = (v) => !!(googlePhotoUrl(v, 240) || v.photo);
  function thumbStyle(v) { return v.photo ? `background-image:url('${v.photo}')` : `background-color:hsl(${hashHue(v.name)} 45% 85% / .5)`; }
  const mapsLink = (v) => v.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name + ' ' + (v.area || v.address || ''))}`;
  const directionsLink = (v) => v.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}` : mapsLink(v);
  const appleMapsLink = (v) => `https://maps.apple.com/?q=${encodeURIComponent(v.name)}${v.lat != null ? `&ll=${v.lat},${v.lng}` : ''}`;
  function parseLatLng(s) {
    const m = (s || '').match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/); if (m) return { lat: +m[1], lng: +m[2] };
    const g = SP.parseGoogleMaps(s, ''); return g.lat != null ? { lat: g.lat, lng: g.lng } : null;
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  let lastPosition = null;
  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Location not available'));
      navigator.geolocation.getCurrentPosition((p) => { lastPosition = { lat: p.coords.latitude, lng: p.coords.longitude, label: 'Current location' }; resolve(lastPosition); },
        (e) => reject(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get location')), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
  }
  async function resizeImage(file, max = 480) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.72);
    } finally { URL.revokeObjectURL(url); }
  }
  let tesseractP = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractP) tesseractP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'; s.onload = () => res(window.Tesseract); s.onerror = () => rej(new Error('Could not load text reader')); document.head.appendChild(s); });
    return tesseractP;
  }

  // ---------------- Data helpers ----------------
  async function allVenues() { return (await store.all('venues')).filter((v) => !v.deleted); }
  async function postsFor(venueId) { return (await store.all('posts')).filter((p) => p.venueId === venueId); }
  async function pendingPosts() { return (await store.all('posts')).filter((p) => !p.venueId).sort((a, b) => b.addedAt.localeCompare(a.addedAt)); }
  async function logEvent(entry) { await store.put('log', { id: uid(), at: nowIso(), ...entry }); }

  function venueFromCandidate(c, clues, status) {
    return {
      id: uid(), collectionId: 'personal', name: c.name, address: c.address || '', area: c.area || (clues && clues.areas[0] ? clues.areas[0].name : ''), city: c.city || '',
      lat: c.lat ?? null, lng: c.lng ?? null,
      categories: SP.CATEGORIES.filter((k) => (clues ? clues.categories : []).includes(k) || (c.categories || []).includes(k)),
      tags: [], provider: c.providerId ? c.providerId.split(':')[0] : (c.mapsUrl ? 'gmaps' : 'manual'), providerPlaceId: c.providerId || null, mapsUrl: c.mapsUrl || null,
      photo: null, googlePhoto: c.googlePhoto || null, status, confidence: c.score ?? null, visited: false, visitedAt: null, notes: '',
      menuItems: clues ? clues.menuItems : [], keywords: clues ? clues.hashtags.slice(0, 15) : [],
      createdBy: settings.myName, createdAt: nowIso(), lastVerifiedAt: status === 'pending' ? null : nowIso(),
    };
  }

  /** Attach a post to an existing venue (dedupe) or a new one. Returns {venue, merged}. */
  async function saveVenueWithPost(candidate, post, status) {
    const venues = await allVenues();
    const dup = SP.findDuplicate(candidate, venues);
    let venue, merged = false;
    if (dup) {
      venue = dup.venue; merged = true;
      const clues = post.clues || {};
      venue.categories = Array.from(new Set([...(venue.categories || []), ...SP.CATEGORIES.filter((k) => (clues.categories || []).includes(k))]));
      venue.menuItems = mergeMenu(venue.menuItems || [], clues.menuItems || []);
      venue.keywords = Array.from(new Set([...(venue.keywords || []), ...(clues.hashtags || [])])).slice(0, 30);
      if (!venue.photo && post.photo) venue.photo = post.photo;
      if (!venue.googlePhoto && candidate.googlePhoto) venue.googlePhoto = candidate.googlePhoto;
    } else {
      venue = venueFromCandidate(candidate, post.clues, status);
      if (post.photo) venue.photo = post.photo;
    }
    // The post's caption goes into the place's notes (added below any notes already there).
    if (post.noteCaption) {
      const cap = post.noteCaption.trim(), who = post.creatorHandle || (post.clues && post.clues.creator);
      const block = who ? `From @${who}'s post:\n${cap}` : cap;
      if (!(venue.notes || '').includes(cap.slice(0, 80))) venue.notes = venue.notes ? `${venue.notes}\n\n${block}` : block;
    }
    await store.put('venues', venue);
    post.venueId = venue.id; post.importStatus = 'saved';
    await store.put('posts', post);
    return { venue, merged, dupReason: dup && dup.reason };
  }
  function mergeMenu(a, b) { const seen = new Set(a.map((m) => SP.norm(m.name))); return a.concat(b.filter((m) => !seen.has(SP.norm(m.name)))).slice(0, 20); }

  function originFor(key) {
    if (key === 'home') return settings.home; if (key === 'office') return settings.office; if (key === 'here') return lastPosition;
    return null;
  }

  // Older places found via Google before photos were added: look up their photo once, in the background.
  let backfilling = false;
  async function backfillGooglePhotos() {
    if (backfilling || !googleKey()) return; backfilling = true;
    try {
      const todo = (await allVenues()).filter((v) => v.provider === 'google' && v.providerPlaceId && !v.googlePhoto && !v.googlePhotoTried).slice(0, 10);
      let changed = false;
      for (const v of todo) {
        try {
          const id = v.providerPlaceId.replace(/^google:/, '');
          const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, { headers: { 'X-Goog-Api-Key': googleKey(), 'X-Goog-FieldMask': 'photos' } });
          const d = res.ok ? await res.json() : {};
          const ph = (d.photos || [])[0];
          v.googlePhotoTried = true;
          if (ph) { const a = (ph.authorAttributions || [])[0] || {}; v.googlePhoto = { name: ph.name, author: a.displayName || '', authorUri: a.uri || '' }; changed = true; }
          await store.put('venues', v);
        } catch (e) { /* try again next time */ }
      }
      if (changed && /^\/(places)?$/.test(parseHash().path)) render();
    } finally { backfilling = false; }
  }

  // ---------------- Router ----------------
  const routes = [];
  const route = (re, fn) => routes.push({ re, fn });
  function parseHash() { const h = location.hash.replace(/^#/, '') || '/'; const [path, qs] = h.split('?'); return { path, params: new URLSearchParams(qs || '') }; }
  let navSeq = 0; // bumps on every screen change, so slow background work never redraws over a newer screen
  async function render() {
    navSeq++;
    const { path, params } = parseHash();
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', ('#' + path).startsWith(a.getAttribute('href')) && (a.getAttribute('href') !== '#/' || path === '/')));
    if (path === '/' || path === '/places') setTimeout(backfillGooglePhotos, 500);
    for (const r of routes) { const m = path.match(r.re); if (m) { try { await r.fn(m, params); } catch (e) { console.error(e); $app.innerHTML = `<div class="banner warn">Something went wrong: ${esc(e.message)}</div>`; } window.scrollTo(0, 0); return; } }
    location.hash = '#/';
  }
  window.addEventListener('hashchange', render);
  // Discover tab stays greyed until Discover is switched on in config.js.
  if (window.SP_CONFIG && window.SP_CONFIG.discoverEnabled) { const t = document.querySelector('#tabs a[data-tab="discover"]'); if (t) t.classList.remove('soon-tab'); }
  // Tapping "Add" always starts a fresh import, even if you're already on the Add screen.
  document.getElementById('tabs').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab="import"]'); if (!a) return;
    e.preventDefault(); location.hash = '#/import?new=' + Date.now();
  });

  const searchIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';

  function venueCard(v, dist) {
    const sub = [v.area || v.city, dist != null ? fmtKm(dist) : null].filter(Boolean).join(' · ');
    return `<a class="card venue" href="#/venue/${v.id}">
      <div class="thumb" style="${cardThumbStyle(v)}">${hasCardImage(v) ? '' : esc(initials(v.name))}</div>
      <div class="grow"><div class="name">${esc(v.name)} <span class="visited-label ${v.visited ? 'on' : ''}">Visited</span></div>
        <div class="meta">${esc(sub || v.address || '')}</div>
        <div>${(v.categories || []).slice(0, 3).map((c) => `<span class="tag">${esc(c)}</span>`).join('')}${(v.tags || []).slice(0, 2).map((c) => `<span class="tag">#${esc(c)}</span>`).join('')}</div></div></a>`;
  }

  // ---------------- Home ----------------
  route(/^\/$/, async () => {
    const venues = await allVenues();
    const pending = await pendingPosts();
    const recent = venues.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
    const origin = lastPosition || settings.home || settings.office;
    const nearby = origin ? venues.filter((v) => v.lat != null).map((v) => ({ v, d: SP.haversineKm(origin, v) })).sort((a, b) => a.d - b.d).slice(0, 5) : [];
    $app.innerHTML = `
      <h1>Valerie's Makan-makan ✨</h1>
      <form class="search" id="homeSearch">${searchIcon}<input type="search" name="q" placeholder="Cake, ramen, Bangsar, a name…" autocomplete="off" enterkeyhint="search"></form>
      <div class="chips" style="margin-top:12px">${SP.CATEGORIES.filter((c) => c !== 'Other').map((c) => `<a class="chip" href="#/places?cat=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}</div>
      <a class="card hero-add" href="#/import" style="text-decoration:none;color:inherit;margin-top:10px">
        <div class="thumb" style="background:var(--accent);color:var(--accent-ink);width:48px;height:48px">+</div>
        <div><div style="font-weight:650">Add a place</div><small>Paste an Instagram link</small></div></a>
      <a class="card hero-add ${discoverOn() ? '' : 'soon'}" href="#/discover" style="text-decoration:none;color:inherit;margin-top:10px">
        <div class="thumb" style="width:48px;height:48px;font-size:20px">★</div>
        <div><div style="font-weight:650">Discover ${discoverOn() ? '' : '<span class="tag">Coming soon</span>'}</div><small>Places recommended by creators you follow</small></div></a>
      ${pending.length ? `<h2>Needs your help (${pending.length})</h2>${pending.slice(0, 3).map((p) => `<a class="card venue" href="#/import?post=${p.id}"><div class="thumb">?</div><div class="grow"><div class="name">${esc((p.clues && p.clues.names[0] && p.clues.names[0].name) || 'Unidentified post')}</div><div class="meta">${esc(p.url || 'No link')} · tap to identify</div></div></a>`).join('')}` : ''}
      <h2>Recently saved</h2>
      ${recent.length ? recent.map((v) => venueCard(v)).join('') : `<div class="empty">Nothing saved yet. Share an Instagram post to get started.</div>`}
      <h2>Nearby</h2>
      ${nearby.length ? `<small>From ${esc(origin.label || 'your location')}</small><div style="margin-top:8px">${nearby.map((x) => venueCard(x.v, x.d)).join('')}</div>`
        : `<button class="btn" id="locBtn">Show places near me</button> <small>or set Home/Office in Settings</small>`}
    `;
    document.getElementById('homeSearch').onsubmit = (e) => { e.preventDefault(); location.hash = '#/places?q=' + encodeURIComponent(e.target.q.value); };
    const lb = document.getElementById('locBtn');
    if (lb) lb.onclick = async () => { try { await getPosition(); render(); } catch (e) { toast(e.message); } };
  });

  // ---------------- Places list ----------------
  route(/^\/places$/, async (m, params) => {
    const state = { q: params.get('q') || '', cat: params.get('cat') || '', sort: params.get('sort') || 'recent', from: params.get('from') || (settings.office ? 'office' : settings.home ? 'home' : 'here'), within: params.get('within') || '', visited: params.get('visited') || '', who: params.get('who') || '' };
    const venues = await allVenues();
    const posts = await store.all('posts');
    const whoBy = new Map(); posts.forEach((p) => { if (p.venueId) { const s = whoBy.get(p.venueId) || new Set(); s.add(p.sharedBy); whoBy.set(p.venueId, s); } });
    const people = Array.from(new Set(posts.map((p) => p.sharedBy).filter(Boolean)));
    const allCats = Array.from(new Set([...SP.CATEGORIES, ...venues.flatMap((v) => v.categories || [])]));
    const allTags = Array.from(new Set(venues.flatMap((v) => v.tags || [])));

    $app.innerHTML = `
      <h1>Places</h1>
      <div class="search">${searchIcon}<input type="search" id="q" value="${esc(state.q)}" placeholder="Search name, area, menu item, note…" autocomplete="off"></div>
      <div class="chips" style="margin-top:12px" id="cats"><span class="chip ${!state.cat ? 'on' : ''}" data-cat="">All</span>${allCats.map((c) => `<span class="chip ${state.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`).join('')}${allTags.map((t) => `<span class="chip ${state.cat === '#' + t ? 'on' : ''}" data-cat="#${esc(t)}">#${esc(t)}</span>`).join('')}</div>
      <div class="filters">
        <select id="sort"><option value="recent">Recently added</option><option value="near">Nearest first</option><option value="az">A to Z</option><option value="visited">Recently visited</option></select>
        <select id="from"><option value="here">From me</option><option value="home" ${settings.home ? '' : 'disabled'}>From home</option><option value="office" ${settings.office ? '' : 'disabled'}>From office</option></select>
        <select id="within"><option value="">Any distance</option><option value="2">&lt; 2 km</option><option value="5">&lt; 5 km</option><option value="10">&lt; 10 km</option><option value="20">&lt; 20 km</option><option value="20plus">20 km+</option></select>
        <select id="visited"><option value="">Visited or not</option><option value="no">Not visited</option><option value="yes">Visited</option></select>
        ${people.length > 1 ? `<select id="who"><option value="">Anyone</option>${people.map((p) => `<option ${state.who === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>` : ''}
      </div>
      <div id="list"></div>`;
    ['sort', 'from', 'within', 'visited'].forEach((k) => { document.getElementById(k).value = state[k]; });

    async function draw() {
      const needsOrigin = state.sort === 'near' || state.within;
      let origin = originFor(state.from);
      if (needsOrigin && !origin && state.from === 'here') { try { origin = await getPosition(); } catch (e) { toast(e.message + ' — set Home/Office in Settings'); } }
      const q = SP.norm(state.q);
      const terms = q.split(' ').filter(Boolean);
      let rows = venues.map((v) => ({ v, d: origin ? SP.haversineKm(origin, v) : null }));
      if (terms.length) rows = rows.filter(({ v }) => {
        const hay = SP.norm([v.name, v.address, v.area, v.city, v.notes, (v.categories || []).join(' '), (v.tags || []).join(' '), (v.keywords || []).join(' '), (v.menuItems || []).map((x) => x.name).join(' ')].join(' '));
        return terms.every((t) => hay.includes(t));
      });
      if (state.cat) rows = rows.filter(({ v }) => state.cat.startsWith('#') ? (v.tags || []).includes(state.cat.slice(1)) : (v.categories || []).includes(state.cat));
      if (state.visited) rows = rows.filter(({ v }) => !!v.visited === (state.visited === 'yes'));
      if (state.who) rows = rows.filter(({ v }) => (whoBy.get(v.id) || new Set([v.createdBy])).has(state.who));
      if (state.within && origin) rows = rows.filter(({ d }) => d != null && (state.within === '20plus' ? d >= 20 : d < +state.within));
      const by = { recent: (a, b) => b.v.createdAt.localeCompare(a.v.createdAt), az: (a, b) => a.v.name.localeCompare(b.v.name), near: (a, b) => (a.d ?? 1e9) - (b.d ?? 1e9), visited: (a, b) => (b.v.visitedAt || '').localeCompare(a.v.visitedAt || '') };
      rows.sort(by[state.sort] || by.recent);
      document.getElementById('list').innerHTML = rows.length
        ? `<small>${rows.length} place${rows.length === 1 ? '' : 's'}${origin && needsOrigin ? ` · from ${esc(origin.label || state.from)}` : ''}</small><div style="margin-top:8px">${rows.map((r) => venueCard(r.v, r.d)).join('')}</div>`
        : `<div class="empty">${venues.length ? 'No places match.' : 'No places saved yet.'}</div>`;
      history.replaceState(null, '', '#/places?' + new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString());
    }
    document.getElementById('q').oninput = (e) => { state.q = e.target.value; draw(); };
    document.getElementById('cats').onclick = (e) => { const c = e.target.closest('[data-cat]'); if (!c) return; state.cat = c.dataset.cat; document.querySelectorAll('#cats .chip').forEach((x) => x.classList.toggle('on', x === c)); draw(); };
    ['sort', 'from', 'within', 'visited', 'who'].forEach((k) => { const el = document.getElementById(k); if (el) el.onchange = (e) => { state[k] = e.target.value; draw(); }; });
    draw();
  });

  // ---------------- Venue details ----------------
  route(/^\/venue\/(.+)$/, async (m) => {
    const v = await store.get('venues', m[1]);
    if (!v || v.deleted) { $app.innerHTML = '<div class="empty">This place was deleted.</div>'; return; }
    const posts = await postsFor(v.id);
    const origin = lastPosition || settings.office || settings.home;
    const d = origin ? SP.haversineKm(origin, v) : null;
    const allCats = Array.from(new Set([...SP.CATEGORIES, ...(v.categories || [])]));
    const statusLabel = { verified: 'Verified automatically', confirmed: 'Confirmed by you', manual: 'Entered manually', pending: 'Pending' }[v.status] || v.status;
    $app.innerHTML = `
      <p><a href="javascript:history.back()">‹ Back</a></p>
      ${v.googlePhoto && googleKey()
        ? `<div class="photo" style="background-image:url('https://places.googleapis.com/v1/${esc(v.googlePhoto.name)}/media?maxWidthPx=800&key=${encodeURIComponent(googleKey())}')"></div>
           <small>Photo${v.googlePhoto.author ? `: ${v.googlePhoto.authorUri ? `<a href="${esc(v.googlePhoto.authorUri)}" target="_blank" rel="noopener">${esc(v.googlePhoto.author)}</a>` : esc(v.googlePhoto.author)}` : ''} · Google Maps</small>
           ${v.photo ? `<div class="row" style="margin-top:8px"><div class="thumb" style="${thumbStyle(v)};width:56px;height:56px"></div><small>From the Instagram post</small></div>` : ''}`
        : `<div class="photo" style="${thumbStyle(v)}">${v.photo ? '' : esc(initials(v.name))}</div>`}
      <h1 style="margin-top:14px">${esc(v.name)}</h1>
      <div class="muted">${esc(v.address || 'No address')}</div>
      <div style="margin:6px 0"><span class="status ${esc(v.status)}">${esc(statusLabel)}</span>${d != null ? ` · <small>${fmtKm(d)} from ${esc(origin.label || 'you')}</small>` : ''}</div>
      <div class="row wrap" style="margin:12px 0">
        <a class="btn primary" href="${esc(directionsLink(v))}" target="_blank" rel="noopener">Directions</a>
        <a class="btn" href="${esc(mapsLink(v))}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn" href="${esc(appleMapsLink(v))}" target="_blank" rel="noopener">Apple Maps</a>
      </div>
      <button class="toggle card visit-toggle" id="visitBtn" aria-pressed="${v.visited ? 'true' : 'false'}">
        <span class="visited-label big ${v.visited ? 'on' : ''}">Visited${v.visited ? ' ✓' : ''}</span>
        <small>${v.visited ? (v.visitedAt ? 'On ' + new Date(v.visitedAt).toLocaleDateString() + ' · tap to undo' : 'Tap to undo') : 'Tap when you\'ve been here'}</small></button>
      <h3>Categories</h3>
      <div class="chips" id="vcats" style="flex-wrap:wrap">${allCats.map((c) => `<span class="chip ${(v.categories || []).includes(c) ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`).join('')}</div>
      <div class="row"><input type="text" id="newTag" placeholder="Add your own tag, e.g. date night"><button class="btn sm" id="addTag">Add</button></div>
      <div style="margin-top:6px" id="tagList">${(v.tags || []).map((t) => `<span class="tag" data-tag="${esc(t)}">#${esc(t)} ✕</span>`).join('')}</div>
      <h3>Notes</h3>
      <textarea id="notes" placeholder="Cosy, good for dates, try the cheesecake…">${esc(v.notes || '')}</textarea>
      <h3>Instagram posts (${posts.length})</h3>
      <div class="stack">${posts.map((p) => `<div class="card"><div class="row"><div class="grow"><a href="${esc(p.url || '#')}" target="_blank" rel="noopener">${esc(p.url ? (p.kind === 'reel' ? 'Reel ' : 'Post ') + (p.shortcode || '') : 'No link saved')}</a><br><small>Shared by ${esc(p.sharedBy || '—')} · ${new Date(p.addedAt).toLocaleDateString()}${p.clues && p.clues.creator ? ' · by @' + esc(p.clues.creator) : ''}</small></div>
        <button class="btn sm ghost" data-unlink="${p.id}">Wrong place</button></div>
        ${p.extractedText ? `<details><summary>Text from the post</summary><div style="white-space:pre-wrap;font-size:14px">${esc(p.extractedText)}</div></details>` : ''}</div>`).join('') || '<small>No linked posts.</small>'}</div>
      <details style="margin-top:16px"><summary>Edit details</summary>
        <label>Name</label><input type="text" id="eName" value="${esc(v.name)}">
        <label>Address</label><input type="text" id="eAddr" value="${esc(v.address || '')}">
        <label>Area / neighbourhood</label><input type="text" id="eArea" value="${esc(v.area || '')}">
        <label>Location (paste a Google Maps link or "lat, lng")</label><input type="text" id="eLoc" value="${v.lat != null ? esc(v.lat + ', ' + v.lng) : ''}">
        <div class="row" style="margin-top:10px"><button class="btn primary" id="saveEdit">Save changes</button></div>
        <dl class="kv" style="margin-top:14px"><dt>Source</dt><dd>${esc(v.provider)} ${esc(v.providerPlaceId || '')}</dd><dt>Confidence</dt><dd>${v.confidence ?? '—'}</dd><dt>Added</dt><dd>${new Date(v.createdAt).toLocaleString()} by ${esc(v.createdBy)}</dd><dt>Last verified</dt><dd>${v.lastVerifiedAt ? new Date(v.lastVerifiedAt).toLocaleDateString() : '—'}</dd></dl>
      </details>
      <hr><button class="btn danger block" id="delBtn">Delete this place</button>`;

    const save = async () => { await store.put('venues', v); };
    document.getElementById('visitBtn').onclick = async () => { v.visited = !v.visited; v.visitedAt = v.visited ? nowIso() : v.visitedAt; await save(); render(); };
    document.getElementById('vcats').onclick = async (e) => { const c = e.target.closest('[data-cat]'); if (!c) return; const k = c.dataset.cat; v.categories = (v.categories || []).includes(k) ? v.categories.filter((x) => x !== k) : [...(v.categories || []), k]; c.classList.toggle('on'); await save(); };
    document.getElementById('addTag').onclick = async () => { const t = document.getElementById('newTag').value.trim().replace(/^#/, ''); if (!t) return; v.tags = Array.from(new Set([...(v.tags || []), t])); await save(); render(); };
    document.getElementById('tagList').onclick = async (e) => { const t = e.target.closest('[data-tag]'); if (!t) return; v.tags = v.tags.filter((x) => x !== t.dataset.tag); await save(); render(); };
    let nt; document.getElementById('notes').oninput = (e) => { clearTimeout(nt); nt = setTimeout(async () => { v.notes = e.target.value; await save(); toast('Note saved', 1200); }, 600); };
    document.getElementById('saveEdit').onclick = async () => {
      v.name = document.getElementById('eName').value.trim() || v.name; v.address = document.getElementById('eAddr').value.trim(); v.area = document.getElementById('eArea').value.trim();
      const ll = parseLatLng(document.getElementById('eLoc').value); if (ll) { v.lat = ll.lat; v.lng = ll.lng; }
      if (v.status === 'verified') v.status = 'confirmed'; v.lastVerifiedAt = nowIso(); await save(); toast('Saved'); render();
    };
    $app.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => {
      const p = await store.get('posts', b.dataset.unlink); p.venueId = null; p.importStatus = 'pending'; await store.put('posts', p);
      await logEvent({ type: 'correction', postId: p.id, url: p.url, outcome: 'wrong_match', venueName: v.name });
      const left = await postsFor(v.id); if (!left.length) { v.deleted = true; await save(); }
      location.hash = '#/import?post=' + p.id;
    });
    document.getElementById('delBtn').onclick = async () => {
      if (!confirm(`Delete ${v.name}? Its Instagram links will be deleted too.`)) return;
      for (const p of posts) await store.del('posts', p.id);
      await store.del('venues', v.id); toast('Deleted'); location.hash = '#/places';
    };
  });

  // ---------------- Import ----------------
  // Active import survives a round-trip to Google Maps (the Shortcut brings the place back).
  let imp = null;
  async function saveActive() { await store.setKv('activeImport', imp ? { ...imp, result: imp.result ? { ...imp.result, candidates: imp.result.candidates } : null } : null); }

  route(/^\/import$/, async (m, params) => {
    const postId = params.get('post');
    if (postId) {
      const p = await store.get('posts', postId);
      if (p) imp = { postId: p.id, url: p.url || '', text: p.extractedText || '', photo: p.photo || null, startedAt: Date.now(), result: null, stage: 'form', fromPending: true };
    } else if (params.has('new') || !imp || (imp.stage === 'done' && !params.has('r'))) {
      imp = { postId: null, url: '', text: '', photo: null, startedAt: null, result: null, stage: 'form' };
    }
    drawImport();
    if (params.get('auto') === '1' && imp.stage === 'form') runImport();
  });

  function drawImport() {
    if (imp.stage === 'form') return drawImportForm();
    if (imp.stage === 'running') return drawImportRunning();
    return drawImportResult();
  }

  function drawImportForm() {
    $app.innerHTML = `
      <h1>Add a place</h1>
      <p class="muted" style="margin-top:-6px">Paste an Instagram post or Reel link.</p>
      <input type="url" id="iUrl" placeholder="https://www.instagram.com/reel/…" value="${esc(imp.url)}" inputmode="url" autocapitalize="off" autocomplete="off">
      <div class="row" style="margin-top:10px"><button class="btn" id="pasteBtn">Paste</button><button class="btn primary grow" id="goBtn">Find this place</button></div>
      ${imp.received ? `<div class="banner" style="font-size:13px">${esc(imp.received)}</div>` : ''}
      <div id="igHelp" class="card" style="margin-top:10px;display:none">
        <div style="font-weight:650">Let Safari read the caption</div>
        <ol style="margin:8px 0 10px;padding-left:20px;font-size:14px;line-height:1.6">
          <li>Tap <b>Open in Safari</b></li>
          <li>Close Instagram's sign-up pop-up if it appears</li>
          <li>Tap Safari's <b>Share</b> button → <b>${esc(SHORTCUT_NAME)}</b></li>
        </ol>
        <a class="btn primary block" id="openIg" target="_blank" rel="noopener">Open in Safari</a>
        <small style="display:block;margin-top:6px">If the Instagram app opens instead, come back, <b>press and hold</b> the button and choose <b>Open in New Tab</b>.</small>
      </div>
      <details style="margin-top:22px" ${imp.photo ? 'open' : ''}><summary>No link? Use a screenshot of the post</summary>
        <div class="row" style="margin-top:8px"><input type="file" id="iShot" accept="image/*" class="grow"></div>
        <div id="ocrState" class="muted" style="font-size:14px;margin-top:6px">${imp.photo ? 'Screenshot attached.' : ''}</div>
      </details>
      ${imp.fromPending ? '<p><button class="btn ghost danger" id="dropBtn">Delete this pending post</button></p>' : ''}`;
    const isIgUrl = (u) => /instagram\.com\//i.test(u || '');
    const sync = () => { imp.url = document.getElementById('iUrl').value.trim(); };
    const igHelp = () => {
      if (!document.getElementById('iUrl') || !document.getElementById('igHelp')) return; // screen already changed
      const u = document.getElementById('iUrl').value.trim();
      // With the app server set up, a pasted Instagram link is read straight away.
      if (isIgUrl(u) && creatorsApi() && !imp.showIgHelp && !(imp.text || '').trim() && u !== imp.autoReadUrl) {
        imp.autoReadUrl = u; imp.url = u; clearTimeout(window.__spAuto); window.__spAuto = setTimeout(() => { if (document.getElementById('iUrl')) readThenImport(); }, 500); return;
      }
      const show = isIgUrl(u) && (imp.showIgHelp || !creatorsApi());
      document.getElementById('igHelp').style.display = show ? 'block' : 'none';
      // x-safari-https:// makes iOS open the link in Safari instead of handing it to the Instagram app.
      if (show) document.getElementById('openIg').href = /iPhone|iPad|iPod/.test(navigator.userAgent) ? u.replace(/^https?:\/\//i, 'x-safari-https://') : u;
    };
    document.getElementById('iUrl').addEventListener('input', igHelp);
    setTimeout(igHelp, 0);
    document.getElementById('goBtn').onclick = () => {
      sync();
      if (!imp.url) return toast('Paste an Instagram link first');
      if (/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(imp.url)) { const g = SP.parseGoogleMaps(imp.url, ''); if (g.name) return finishManual({ ...g, mapsUrl: imp.url }, 'google_maps_link'); }
      if (!isIgUrl(imp.url)) return toast('That doesn\'t look like an Instagram link');
      if ((imp.text || '').trim() || imp.photo) return runImport();
      if (creatorsApi() && !imp.showIgHelp) return readThenImport();
      igHelp(); document.getElementById('igHelp').scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Follow the steps to let Safari read the caption.');
    };
    document.getElementById('pasteBtn').onclick = async () => {
      try { const t = (await navigator.clipboard.readText()).trim(); if (!t) return toast('Nothing copied yet'); document.getElementById('iUrl').value = t; imp.showIgHelp = false; igHelp(); }
      catch (e) { const el = document.getElementById('iUrl'); el.focus(); toast('Tap and hold the box, then Paste'); }
    };
    document.getElementById('iShot').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return; sync();
      const st = document.getElementById('ocrState');
      try {
        imp.photo = await resizeImage(f);
        st.textContent = 'Reading text from the screenshot… (first time takes ~20 s)';
        const T = await loadTesseract();
        const { data } = await T.recognize(f, 'eng');
        imp.text = data.text.trim(); imp.caption = null; // screenshot text is too messy for notes
        if (!imp.text) { st.textContent = 'No text found in that screenshot.'; return; }
        runImport();
      } catch (err) { st.textContent = 'Could not read the screenshot (' + err.message + ').'; }
    };
    const db = document.getElementById('dropBtn');
    if (db) db.onclick = async () => { await store.del('posts', imp.postId); imp = null; await saveActive(); toast('Deleted'); location.hash = '#/'; };
  }

  function drawImportRunning() {
    const s = imp.steps || {};
    const li = (k, label) => `<li><span class="dot ${s[k] || ''}"></span>${esc(label)}</li>`;
    $app.innerHTML = `<h1>Finding the place…</h1><ul class="steps card">${li('clues', 'Reading clues from the post')}${li('search', s.searchLabel || 'Searching OpenStreetMap')}${li('score', 'Comparing candidates')}</ul>`;
  }

  // Read an Instagram post through the app server (Cloudflare Worker /post). Returns null if not set up.
  async function readPostViaServer(link) {
    const api = creatorsApi(); if (!api) return null;
    const res = await fetch(`${api}/post?url=${encodeURIComponent(link)}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `Server error ${res.status}`);
    let caption = d.caption || '', handle = d.handle || null, name = d.name || null;
    if (d.meta) { const m = SP.parseInstagramMeta(d.meta); caption = caption || m.caption; handle = handle || m.handle; name = name || m.accountName; }
    return { caption, handle, name, source: d.source };
  }
  async function readThenImport() {
    const seq = navSeq;
    $app.innerHTML = `<h1>Reading the post…</h1><ul class="steps card"><li><span class="dot run"></span>Getting the caption from Instagram</li></ul>`;
    try {
      const r = await readPostViaServer(imp.url);
      if (seq !== navSeq) return;
      if (r && r.caption) {
        imp.text = r.caption; imp.caption = r.caption; imp.account = r.handle ? { handle: r.handle, accountName: r.name } : null;
        imp.received = `Read by the app server (${r.source === 'embed' ? 'embed page' : 'post page'}) · caption ✓`;
        return runImport();
      }
      imp.received = 'The app server got the post but no caption';
    } catch (e) { if (seq !== navSeq) return; imp.received = 'App server: ' + e.message; }
    imp.showIgHelp = true; imp.stage = 'form'; drawImportForm();
    toast("Instagram didn't share this post with the server. Use Safari instead (steps below).", 5000);
  }

  async function ensurePost(clues) {
    let post = imp.postId ? await store.get('posts', imp.postId) : null;
    if (!post && clues.shortcode) post = (await store.all('posts')).find((p) => p.shortcode === clues.shortcode) || null;
    if (!post) post = { id: uid(), collectionId: 'personal', venueId: null, addedAt: nowIso(), sharedBy: settings.myName, importStatus: 'pending' };
    Object.assign(post, { noteCaption: imp.caption || post.noteCaption || null, url: clues.url || imp.url || null, shortcode: clues.shortcode, kind: clues.kind, extractedText: imp.text, clues, creatorHandle: clues.creator || null, photo: imp.photo || post.photo || null });
    if (!post.venueId) await store.put('posts', post);
    imp.postId = post.id;
    return post;
  }

  async function runImport() {
    const seq = navSeq;
    imp.stage = 'running'; imp.startedAt = Date.now(); imp.steps = { clues: 'run' }; imp.error = null; drawImportRunning();
    const clues0 = SP.extractClues(imp.text, imp.url, imp.account || null);
    // Same Instagram post already saved? Don't search again.
    if (clues0.shortcode && !imp.fromPending) {
      const existing = (await store.all('posts')).find((p) => p.shortcode === clues0.shortcode && p.venueId);
      const v = existing && await store.get('venues', existing.venueId);
      if (v && !v.deleted) { imp.stage = 'done'; imp.outcome = { kind: 'already', venue: v }; await saveActive(); return drawImportResult(); }
    }
    let post = await ensurePost(clues0);
    const providers = [];
    if (googleKey()) providers.push(SP.googlePlacesProvider(fetch.bind(window), googleKey()));
    else { providers.push(SP.photonProvider(fetch.bind(window))); if (settings.useNominatimFallback) providers.push(SP.nominatimProvider(fetch.bind(window), sleep)); }
    try {
      const result = await SP.identify({
        text: imp.text, url: imp.url, account: imp.account || null, providers, region: settings.region, thresholds: settings.thresholds,
        onStep: (k, data) => {
          if (k === 'clues') { imp.steps.clues = 'ok'; imp.steps.search = 'run'; }
          if (k === 'search') imp.steps.searchLabel = `Searching ${data.provider === 'google' ? 'Google Places' : data.provider === 'photon' ? 'OpenStreetMap (Photon)' : 'OpenStreetMap (Nominatim)'}${data.queries.length ? ': ' + data.queries.slice(0, 2).join(', ') : ''}`;
          if (k === 'done') { imp.steps.search = 'ok'; imp.steps.score = 'ok'; }
          drawImportRunning();
        },
      });
      imp.result = result;
      if (result.errors.length && !result.candidates.length) imp.error = result.errors[0];
      if (result.decision.level === 'high') {
        post = await store.get('posts', post.id);
        const saved = await saveVenueWithPost(result.decision.top, post, 'verified');
        imp.stage = 'done'; imp.outcome = { kind: 'auto', venue: saved.venue, merged: saved.merged };
        await logImport('auto_saved', result.decision.top);
      } else { imp.stage = 'choose'; }
    } catch (e) {
      console.error(e); imp.stage = 'choose'; imp.error = e.message;
      imp.result = { clues: clues0, candidates: [], decision: { level: 'low', why: 'Search failed' }, errors: [e.message], queries: SP.buildQueries(clues0) };
    }
    await saveActive();
    if (seq === navSeq) drawImportResult();
  }

  async function logImport(outcome, chosen) {
    const r = imp.result || { clues: {}, candidates: [], decision: {} };
    const top = r.candidates[0], second = r.candidates[1];
    await logEvent({
      type: 'import', postId: imp.postId, url: imp.url || (r.clues && r.clues.url) || '', shortcode: r.clues && r.clues.shortcode,
      hadText: !!(imp.text || '').trim(), hadScreenshot: !!imp.photo, metaStatus: imp.metaStatus || 'not_sent',
      nameClues: (r.clues.names || []).map((n) => `${n.name} [${n.source}]`).join('; '), areas: (r.clues.areas || []).map((a) => a.name).join('; '),
      menuItems: (r.clues.menuItems || []).length, candidates: r.candidates.length,
      topName: top ? top.name : '', topScore: top ? top.score : '', secondScore: second ? second.score : '', level: r.decision.level || '',
      outcome, chosenName: chosen ? chosen.name : '', chosenRank: chosen && r.candidates.length ? r.candidates.findIndex((c) => c.providerId === chosen.providerId) + 1 : '',
      ms: imp.startedAt ? Date.now() - imp.startedAt : '', errors: (r.errors || []).join('; '),
    });
  }

  function candidateHtml(c, i, best) {
    return `<div class="cand ${best ? 'best' : ''}">
      <div class="row"><div class="grow"><div style="font-weight:650">${esc(c.name)}</div><small>${esc(c.address || '')}</small></div><div class="score">${c.score}</div></div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${esc(c.reasons.join(' · '))}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm ${best ? 'primary' : ''}" data-pick="${i}">${best ? 'Yes, this one' : 'This one'}</button>
        <a class="btn sm ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name + ' ' + (c.lat != null ? c.lat + ',' + c.lng : ''))}">Check on map</a></div></div>`;
  }

  function cluesHtml(cl) {
    const parts = [];
    if (cl.names.length) parts.push(`<dt>Names</dt><dd>${cl.names.map((n) => `${esc(n.name)} <small>(${esc(n.source)})</small>`).join(', ')}</dd>`);
    if (cl.areas.length) parts.push(`<dt>Areas</dt><dd>${esc(cl.areas.map((a) => a.name).join(', '))}</dd>`);
    if (cl.categories.length) parts.push(`<dt>Looks like</dt><dd>${esc(cl.categories.join(', '))}</dd>`);
    if (cl.creator) parts.push(`<dt>Posted by</dt><dd>@${esc(cl.creator)}</dd>`);
    if (cl.hashtags.length) parts.push(`<dt>Hashtags</dt><dd>${esc(cl.hashtags.slice(0, 8).map((h) => '#' + h).join(' '))}</dd>`);
    return parts.length ? `<dl class="kv">${parts.join('')}</dl>` : '<small>No useful clues found. The link alone doesn\'t say which place it is.</small>';
  }

  function drawImportResult() {
    const o = imp.outcome;
    if (imp.stage === 'done' && o) {
      if (o.kind === 'already') { $app.innerHTML = `<h1>Already saved</h1><div class="banner good">This post is already linked to <b>${esc(o.venue.name)}</b>.</div>${venueCard(o.venue)}<p><a class="btn block" href="#/import" id="another">Add another</a></p>`; bindAnother(); return; }
      const label = o.kind === 'auto' ? 'Saved automatically' : o.kind === 'pending' ? 'Saved as pending' : 'Saved';
      $app.innerHTML = `<h1>${esc(label)}</h1>
        ${imp.received ? `<div class="muted" style="font-size:12px;margin:-4px 0 8px">${esc(imp.received)}</div>` : ''}
        ${o.kind === 'pending' ? `<div class="banner warn">The link is kept under <b>Needs your help</b> on Home. Open it any time to try again.</div>` : `<div class="banner good">${o.merged ? `Added this post to your existing <b>${esc(o.venue.name)}</b> record.` : `<b>${esc(o.venue.name)}</b> is in your collection${o.kind === 'auto' ? ' (high-confidence match)' : ''}.`}</div>${venueCard(o.venue)}`}
        <div class="row" style="margin-top:12px">${o.kind === 'auto' ? '<button class="btn" id="undoBtn">Wrong place?</button>' : ''}<a class="btn primary grow" href="#/import" id="another">Add another</a></div>`;
      bindAnother();
      const ub = document.getElementById('undoBtn');
      if (ub) ub.onclick = async () => {
        const post = await store.get('posts', imp.postId); const v = o.venue;
        post.venueId = null; post.importStatus = 'pending'; await store.put('posts', post);
        if (!o.merged) await store.del('venues', v.id);
        await logImport('auto_undone', null);
        imp.stage = 'choose'; imp.outcome = null; await saveActive(); drawImportResult();
      };
      return;
    }
    const r = imp.result; const cl = r.clues; const dec = r.decision;
    const cands = r.candidates.filter((c) => c.score >= 25);
    const gmaps = SP.googleMapsSearchUrl(cl, settings.region);
    const linkOnly = !(imp.text || '').trim() && !imp.account;
    const levelBanner = linkOnly ? `<div class="banner warn"><b>I only have the link, not the caption.</b><br><small>A link pasted into the app can't be read: browsers block opening Instagram pages. Open the post in <b>Safari</b> and tap Share → <b>${esc(SHORTCUT_NAME)}</b>; the shortcut reads the caption for you.</small></div>`
      : dec.level === 'medium' ? `<div class="banner">Is this the place? <small>${esc(dec.why)}</small></div>`
      : `<div class="banner warn">${cands.length ? 'Not sure which place this is.' : r.queries.length ? `No match found in ${googleKey() ? 'Google Places' : 'OpenStreetMap'}.` : 'No venue name found in the text.'} <small>${esc(imp.error ? 'Search problem: ' + imp.error : '')}</small></div>`;
    $app.innerHTML = `
      <h1>${dec.level === 'medium' ? 'Confirm the place' : 'Help me find it'}</h1>
      ${imp.received ? `<div class="muted" style="font-size:12px;margin:-4px 0 8px">${esc(imp.received)}</div>` : ''}
      ${levelBanner}
      ${cands.length ? `<div>${cands.map((c, i) => candidateHtml(c, i, i === 0 && dec.level === 'medium')).join('')}</div>` : ''}
      <h3>Search with a different name</h3>
      <div class="row"><input type="text" id="reName" placeholder="Venue name, e.g. Aifokato" value="${esc(cl.names[0] ? cl.names[0].name : '')}"><button class="btn" id="reBtn">Search</button></div>
      <h3>Find it in Google Maps</h3>
      <p class="muted" style="margin:4px 0 8px;font-size:14px">Open the search, tap the right place, then Share → <b>${esc(SHORTCUT_NAME)}</b>. It comes back here and finishes this import.</p>
      <a class="btn block" href="${esc(gmaps)}" target="_blank" rel="noopener">Search Google Maps</a>
      <details style="margin-top:14px"><summary>Enter it myself</summary>
        <label>Name</label><input type="text" id="mName" value="${esc(cl.names[0] ? cl.names[0].name : '')}">
        <label>Area or address</label><input type="text" id="mAddr" value="${esc(cl.areas[0] ? cl.areas[0].name : '')}">
        <label>Location (optional: Google Maps link or "lat, lng")</label><input type="text" id="mLoc" placeholder="3.1422, 101.6981">
        <button class="btn primary" id="mSave" style="margin-top:10px">Save</button></details>
      <h3>What I found in the post</h3>${cluesHtml(cl)}
      <hr><div class="row wrap"><button class="btn ghost" id="pendBtn">Decide later</button><button class="btn ghost" id="editBtn">Back</button><a class="btn ghost" href="#/import" id="another">Start a new one</a></div>`;
    bindAnother();

    $app.querySelectorAll('[data-pick]').forEach((b) => b.onclick = async () => {
      const seq = navSeq;
      const c = cands[+b.dataset.pick];
      const post = await store.get('posts', imp.postId);
      const saved = await saveVenueWithPost(c, post, 'confirmed');
      await logImport(+b.dataset.pick === 0 ? 'confirmed_top' : 'picked_other', c);
      imp.stage = 'done'; imp.outcome = { kind: 'confirmed', venue: saved.venue, merged: saved.merged }; await saveActive(); if (seq === navSeq) drawImportResult();
    });
    document.getElementById('reBtn').onclick = async () => {
      const n = document.getElementById('reName').value.trim(); if (!n) return;
      // A link pasted here: an Instagram post goes to the Safari steps; a Google Maps place is saved directly.
      if (/instagram\.com\//i.test(n)) { imp.url = n; imp.showIgHelp = true; imp.stage = 'form'; drawImportForm(); toast('That\'s a post link. Follow the steps to let Safari read its caption.'); return; }
      if (/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(n)) {
        const g = SP.parseGoogleMaps(n, '');
        if (g.name) return finishManual({ ...g, mapsUrl: n }, 'google_maps_link');
        return toast('Short Google Maps links can\'t be read here. Open it in Google Maps and share it instead.');
      }
      if (/^https?:\/\//i.test(n)) return toast('Type the venue\'s name here, not a link.');
      imp.text = `📍 ${n}\n` + imp.text.replace(/^📍 .*\n/, ''); imp.stage = 'form'; runImport();
    };
    document.getElementById('mSave').onclick = async () => {
      const name = document.getElementById('mName').value.trim(); if (!name) return toast('Add a name');
      const ll = parseLatLng(document.getElementById('mLoc').value);
      const g = SP.parseGoogleMaps(document.getElementById('mLoc').value, '');
      await finishManual({ name, address: document.getElementById('mAddr').value.trim(), area: '', lat: ll ? ll.lat : null, lng: ll ? ll.lng : null, mapsUrl: g.mapsUrl && /google/.test(g.mapsUrl) ? g.mapsUrl : null }, 'manual_entry');
    };
    document.getElementById('pendBtn').onclick = async () => { await logImport('left_pending', null); imp.stage = 'done'; imp.outcome = { kind: 'pending' }; await saveActive(); drawImportResult(); };
    document.getElementById('editBtn').onclick = () => { imp.stage = 'form'; drawImportForm(); };
  }
  function bindAnother() { const a = document.getElementById('another'); if (a) a.onclick = (e) => { e.preventDefault(); imp = { postId: null, url: '', text: '', photo: null, startedAt: null, result: null, stage: 'form' }; saveActive(); location.hash = '#/import?new=' + Date.now(); }; }

  async function finishManual(place, outcome) {
    const post = imp.postId ? await store.get('posts', imp.postId) : null;
    const cand = { name: place.name, address: place.address || '', area: place.area || '', lat: place.lat, lng: place.lng, mapsUrl: place.mapsUrl || null, providerId: null, score: null };
    let saved;
    if (post) saved = await saveVenueWithPost(cand, post, 'manual');
    else { const p = { id: uid(), collectionId: 'personal', venueId: null, addedAt: nowIso(), sharedBy: settings.myName, url: null, clues: null, importStatus: 'pending' }; saved = await saveVenueWithPost(cand, p, 'manual'); }
    await logImport(outcome, cand);
    imp.stage = 'done'; imp.outcome = { kind: 'confirmed', venue: saved.venue, merged: saved.merged }; await saveActive();
    location.hash = '#/import?auto=0&r=' + Date.now(); drawImportResult();
  }


  // ---------------- Discover (creator feeds via Meta Business Discovery) ----------------
  const discoverOn = () => !!(window.SP_CONFIG && window.SP_CONFIG.discoverEnabled);
  const creatorsApi = () => ((window.SP_CONFIG && window.SP_CONFIG.creatorsApi) || settings.creatorsApi || '').replace(/\/+$/, '');
  async function followedCreators() {
    const saved = await store.kv('creators', null);
    if (saved) return saved;
    return ((window.SP_CONFIG && window.SP_CONFIG.creators) || []).map((h) => h.replace(/^@/, '').toLowerCase());
  }
  const MAX_LOOKUPS_PER_CHECK = 15; // caps Google searches per "Check for new posts"

  async function checkCreators(onProgress) {
    const api = creatorsApi(); if (!api) throw new Error('Discover server not set up yet (Settings → Discover server).');
    const creators = await followedCreators(); if (!creators.length) throw new Error('Follow at least one creator first.');
    const known = new Set((await store.all('discover')).map((d) => d.id));
    const providers = googleKey() ? [SP.googlePlacesProvider(fetch.bind(window), googleKey())] : [SP.photonProvider(fetch.bind(window))];
    let lookups = 0, added = 0; const problems = [];
    for (const h of creators) {
      onProgress && onProgress(`Checking @${h}…`);
      let data;
      try {
        const res = await fetch(`${api}/creator?u=${encodeURIComponent(h)}`);
        data = await res.json();
        if (!res.ok) { problems.push(`@${h}: ${data.hint || data.error || res.status}`); continue; }
      } catch (e) { problems.push(`@${h}: ${e.message}`); continue; }
      for (const post of data.posts || []) {
        const id = 'ig:' + post.id; if (known.has(id)) continue;
        const clues = SP.extractClues(post.caption || '', post.permalink || '', { handle: data.account.username, creatorOnly: true });
        const item = { id, handle: data.account.username, creatorName: data.account.name || null, permalink: post.permalink, timestamp: post.timestamp, type: post.type,
          clues: { names: clues.names, areas: clues.areas, categories: clues.categories, shortcode: clues.shortcode, kind: clues.kind },
          status: 'no_name', candidate: null, checkedAt: nowIso() };
        if (clues.names.length) {
          if (lookups >= MAX_LOOKUPS_PER_CHECK) { item.status = 'later'; }
          else {
            lookups++;
            onProgress && onProgress(`Finding ${clues.names[0].name}…`);
            try {
              const r = await SP.identify({ text: post.caption || '', url: post.permalink || '', account: { handle: data.account.username, creatorOnly: true }, providers, region: settings.region, thresholds: settings.thresholds });
              const top = r.decision.top;
              item.status = r.decision.level === 'low' ? 'not_found' : r.decision.level; // high | medium | not_found
              if (top && r.decision.level !== 'low') item.candidate = { providerId: top.providerId, name: top.name, address: top.address, area: top.area, city: top.city, lat: top.lat, lng: top.lng, categories: top.categories, mapsUrl: top.mapsUrl || null, googlePhoto: top.googlePhoto || null, score: top.score };
            } catch (e) { item.status = 'later'; }
          }
        }
        // Store the caption privately on this phone only for matching/re-checks; it's never shown or shared.
        item.caption = (post.caption || '').slice(0, 2000);
        await store.put('discover', item); added++;
      }
    }
    await store.setKv('discoverCheckedAt', nowIso());
    return { added, lookups, problems };
  }

  function discoverCard(d, savedIds) {
    const c = d.candidate; const when = d.timestamp ? new Date(d.timestamp).toLocaleDateString() : '';
    const credit = `<small>Recommended by <b>@${esc(d.handle)}</b>${when ? ' · ' + esc(when) : ''} · <a href="${esc(d.permalink || '#')}" target="_blank" rel="noopener">View post</a></small>`;
    if (!c) return `<div class="card" style="margin-top:10px"><div class="muted" style="font-size:14px">${d.status === 'later' ? 'Not checked yet: tap Check again.' : d.status === 'not_found' ? `Couldn't find "${esc((d.clues.names[0] || {}).name || '')}" on Google.` : 'No venue named in this post.'}</div>${credit}</div>`;
    const v = { ...c, photo: null };
    const saved = d.savedVenueId && savedIds.has(d.savedVenueId);
    const dist = (lastPosition || settings.office || settings.home) ? SP.haversineKm(lastPosition || settings.office || settings.home, c) : null;
    return `<div class="card venue" style="margin-top:10px;align-items:flex-start">
      <div class="thumb" style="${cardThumbStyle(v)}">${hasCardImage(v) ? '' : esc(initials(c.name))}</div>
      <div class="grow"><div class="name">${esc(c.name)}${d.status === 'medium' ? ' <small>· likely</small>' : ''}</div>
        <div class="meta">${esc([c.area || c.city, dist != null ? fmtKm(dist) : null].filter(Boolean).join(' · ') || c.address || '')}</div>
        <div>${(c.categories || []).slice(0, 3).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>
        ${credit}
        <div class="row" style="margin-top:8px">${saved ? `<a class="btn sm" href="#/venue/${d.savedVenueId}">Saved ✓</a>` : `<button class="btn sm primary" data-dsave="${esc(d.id)}">Save</button>`}
          <a class="btn sm ghost" target="_blank" rel="noopener" href="${esc(c.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}` : (c.mapsUrl || '#'))}">Directions</a></div></div></div>`;
  }

  route(/^\/discover$/, async (m, params) => {
    if (!discoverOn()) {
      $app.innerHTML = `
        <h1>Discover <span class="tag">Coming soon</span></h1>
        <p class="muted" style="margin-top:-6px">Places recommended by food creators you follow, each linked back to their post.</p>
        <div class="card soon-card">
          <div style="font-weight:650;margin-bottom:6px">Reminder: set up the Meta API</div>
          <small>Discover uses Instagram's official Business Discovery API. To switch it on:</small>
          <ol style="margin:8px 0 0;padding-left:20px;font-size:14px;line-height:1.7">
            <li>Instagram account switched to <b>Professional</b> ✓</li>
            <li>Create a <b>Facebook Page</b> and link it to that Instagram account (blocked by a Facebook restriction for now)</li>
            <li>Create a <b>Meta developer app</b> and a 60-day token</li>
            <li>Add <b>META_TOKEN</b> and <b>IG_USER_ID</b> to the Cloudflare server</li>
            <li>Ask Claude to switch Discover on</li>
          </ol>
          <small style="display:block;margin-top:8px">Full steps: <b>worker/SETUP-SERVER.md</b>, Parts A and B.</small>
        </div>`;
      return;
    }
    const creators = await followedCreators();
    const items = (await store.all('discover')).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const savedIds = new Set((await allVenues()).map((v) => v.id));
    const filter = params.get('show') || 'places';
    const shown = items.filter((d) => filter === 'all' || d.candidate);
    const checked = await store.kv('discoverCheckedAt', null);
    $app.innerHTML = `
      <h1>Discover</h1>
      <p class="muted" style="margin-top:-6px;font-size:14px">Places recommended by food creators you follow. Each one links back to the creator's post.</p>
      ${creatorsApi() ? '' : `<div class="banner warn">The app server isn't set up yet. See the setup guide, then add its address in <a href="#/settings">Settings</a>.</div>`}
      <div class="chips" id="creatorChips" style="flex-wrap:wrap">${creators.map((h) => `<span class="chip on" data-unfollow="${esc(h)}">@${esc(h)} ✕</span>`).join('') || '<small>No creators yet.</small>'}</div>
      <div class="row" style="margin-top:6px"><input type="text" id="newCreator" placeholder="@creator handle" autocapitalize="off" autocomplete="off" spellcheck="false"><button class="btn sm" id="followBtn">Follow</button></div>
      <div class="row" style="margin-top:10px"><button class="btn primary grow" id="checkBtn">Check for new posts</button></div>
      <div id="checkState" class="muted" style="font-size:13px;margin-top:6px">${checked ? 'Last checked ' + new Date(checked).toLocaleString() : ''}</div>
      <div class="chips" style="margin-top:10px"><a class="chip ${filter === 'places' ? 'on' : ''}" href="#/discover?show=places">Places found</a><a class="chip ${filter === 'all' ? 'on' : ''}" href="#/discover?show=all">All posts</a></div>
      <div id="dlist">${shown.length ? shown.map((d) => discoverCard(d, savedIds)).join('') : `<div class="empty">${items.length ? 'No places found yet in these posts.' : 'Follow a creator and tap Check for new posts.'}</div>`}</div>`;

    document.getElementById('followBtn').onclick = async () => {
      const h = document.getElementById('newCreator').value.trim().replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9._]{1,30}$/.test(h)) return toast('Enter an Instagram handle, e.g. danieldineskl');
      await store.setKv('creators', Array.from(new Set([...creators, h]))); render();
    };
    document.getElementById('creatorChips').onclick = async (e) => {
      const c = e.target.closest('[data-unfollow]'); if (!c) return;
      if (!confirm(`Stop following @${c.dataset.unfollow}?`)) return;
      await store.setKv('creators', creators.filter((x) => x !== c.dataset.unfollow)); render();
    };
    document.getElementById('checkBtn').onclick = async (e) => {
      const btn = e.target; btn.disabled = true; const st = document.getElementById('checkState');
      try {
        const r = await checkCreators((msg) => { st.textContent = msg; });
        toast(r.added ? `Found ${r.added} new post${r.added === 1 ? '' : 's'}` : 'No new posts');
        if (r.problems.length) setTimeout(() => toast(r.problems[0], 6000), 2800);
        render();
      } catch (err) { st.textContent = err.message; btn.disabled = false; }
    };
    $app.querySelectorAll('[data-dsave]').forEach((b) => b.onclick = async () => {
      const d = await store.get('discover', b.dataset.dsave); if (!d || !d.candidate) return;
      const post = { id: uid(), collectionId: 'personal', venueId: null, addedAt: nowIso(), sharedBy: `@${d.handle} (Discover)`, url: d.permalink, shortcode: d.clues.shortcode, kind: d.clues.kind,
        extractedText: d.caption || '', noteCaption: d.caption || null, clues: { names: d.clues.names, areas: d.clues.areas, categories: d.clues.categories, menuItems: [], hashtags: [], creator: d.handle }, creatorHandle: d.handle, importStatus: 'pending' };
      const saved = await saveVenueWithPost({ ...d.candidate }, post, d.status === 'high' ? 'verified' : 'confirmed');
      d.savedVenueId = saved.venue.id; await store.put('discover', d);
      toast(saved.merged ? `Added to your existing ${saved.venue.name}` : `Saved ${saved.venue.name}`); render();
    });
  });

  // ---------------- Settings ----------------
  route(/^\/settings$/, async () => {
    const venues = await allVenues(); const posts = await store.all('posts'); const log = await store.all('log');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    let persisted = null; try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { /* ignore */ }
    const t = settings.thresholds;
    const locRow = (key, label) => `<div class="card" style="margin-top:8px"><div class="row"><div class="grow"><b>${label}</b><br><small>${settings[key] ? `${settings[key].lat.toFixed(4)}, ${settings[key].lng.toFixed(4)}` : 'Not set'}</small></div>
      <button class="btn sm" data-here="${key}">Use current</button>${settings[key] ? `<button class="btn sm ghost" data-clear="${key}">Clear</button>` : ''}</div>
      <div class="row" style="margin-top:8px"><input type="text" data-locinput="${key}" placeholder="or paste a Google Maps link / lat, lng"><button class="btn sm" data-setloc="${key}">Set</button></div></div>`;
    $app.innerHTML = `
      <h1>Settings</h1>
      <label>Your name (shown as "shared by")</label><input type="text" id="myName" value="${esc(settings.myName)}">
      <h2>Locations</h2><p class="muted" style="font-size:14px;margin:0">Used for "near home" and "near office". Location is only asked for when you use it.</p>
      ${locRow('home', 'Home')}${locRow('office', 'Office')}
      <h2>App server</h2>
      <p class="muted" style="font-size:14px;margin:0">${(window.SP_CONFIG && window.SP_CONFIG.creatorsApi) ? 'Built into the app.' : 'Your Cloudflare Worker address. It reads pasted Instagram links (no Safari needed) and powers Discover.'}</p>
      <div class="row" style="margin-top:6px"><input type="url" id="cApi" value="${esc(settings.creatorsApi || '')}" placeholder="${(window.SP_CONFIG && window.SP_CONFIG.creatorsApi) ? 'Optional — built-in address in use' : 'https://saved-places.yourname.workers.dev'}" autocapitalize="off"><button class="btn sm" id="cSave">Save</button></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="cTest">Test server</button><small id="cTestOut"></small></div>
      <h2>Venue lookup</h2>
      <p class="muted" style="font-size:14px;margin:0">${googleKey() ? `Using <b>Google Places</b>${!settings.googleKey ? ' (built into the app — nothing to set up).' : ' (your own key).'}` : 'Using free OpenStreetMap. Add a Google Places key for much better coverage.'}</p>
      <label>Google Places API key (stored only on this phone)</label>
      <div class="row"><input type="text" id="gKey" value="${esc(settings.googleKey || '')}" placeholder="${BUILT_IN_KEY ? 'Optional — built-in key in use' : 'AIza…'}" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn sm" id="gSave">Save</button></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="gTest">Test key</button><small id="gTestOut"></small></div>
      <h2>Proof-of-concept test</h2>
      <p class="muted" style="font-size:14px;margin:0">${log.filter((l) => l.type === 'import').length} imports logged. Export the log after testing and send it to Claude.</p>
      <div class="row wrap" style="margin-top:8px"><button class="btn" id="csvBtn">Export test log (CSV)</button><button class="btn ghost" id="clearLog">Clear log</button></div>
      <details style="margin-top:10px"><summary>Matching thresholds</summary>
        <div class="row"><div class="grow"><label>Auto-save at score ≥</label><input type="number" id="tAuto" value="${t.auto}"></div><div class="grow"><label>Ask at score ≥</label><input type="number" id="tConfirm" value="${t.confirm}"></div><div class="grow"><label>Lead needed</label><input type="number" id="tMargin" value="${t.margin}"></div></div>
        <div class="toggle"><span>Also search Nominatim when Photon misses</span><input type="checkbox" id="nomi" ${settings.useNominatimFallback ? 'checked' : ''}></div>
        <label>Home region (lat, lng, radius km)</label><div class="row"><input type="text" id="rLL" value="${settings.region.lat}, ${settings.region.lng}"><input type="number" id="rKm" value="${settings.region.radiusKm}" style="max-width:100px"></div>
        <button class="btn sm" id="saveT" style="margin-top:8px">Save thresholds</button></details>
      <h2>Your data</h2>
      <p class="muted" style="font-size:14px;margin:0">${venues.length} places, ${posts.length} posts, stored only on this phone${persisted ? ' (protected from automatic clearing)' : ''}. Back up now and then.</p>
      <div class="row wrap" style="margin-top:8px"><button class="btn" id="expBtn">Back up (JSON)</button><label class="btn" style="margin:0;color:var(--text)">Restore<input type="file" id="impFile" accept="application/json,.json" hidden></label></div>
      <p style="margin-top:14px"><button class="btn danger ghost" id="wipeBtn">Delete all my data</button></p>
      <h2>About</h2>
      <dl class="kv"><dt>Version</dt><dd>${APP_VERSION}</dd><dt>Mode</dt><dd>${standalone ? 'Home-screen web app' : 'Safari'}</dd><dt>Venue data</dt><dd>${googleKey() ? 'Google Places (Google Maps)' : '© OpenStreetMap contributors, via Photon and Nominatim'}</dd><dt>Privacy</dt><dd>No account, no Instagram login. Searches send only the venue name and area to OpenStreetMap services.</dd></dl>`;

    document.getElementById('cSave').onclick = async () => { settings.creatorsApi = document.getElementById('cApi').value.trim(); await saveSettings(); toast('Saved'); render(); };
    document.getElementById('cTest').onclick = async () => {
      const out = document.getElementById('cTestOut'); const api = (document.getElementById('cApi').value.trim() || creatorsApi()).replace(/\/+$/, '');
      if (!api) { out.textContent = 'Add the server address first'; return; }
      out.textContent = 'Testing…';
      try { const r = await (await fetch(api + '/health')).json(); out.textContent = 'Server works ✓ (reading links)' + (r.tokenSet && r.igUserSet ? ' · Discover ready ✓' : ' · Discover needs the Meta token'); }
      catch (e) { out.textContent = 'Failed: ' + e.message; }
    };
    document.getElementById('gSave').onclick = async () => { settings.googleKey = document.getElementById('gKey').value.trim(); await saveSettings(); toast(settings.googleKey ? 'Google key saved' : 'Key removed'); render(); };
    document.getElementById('gTest').onclick = async () => {
      const out = document.getElementById('gTestOut'); const key = document.getElementById('gKey').value.trim(); if (!key) { out.textContent = 'Paste a key first'; return; }
      out.textContent = 'Testing…';
      try { const r = await SP.googlePlacesProvider(fetch.bind(window), key).search('Merchant\'s Lane Kuala Lumpur', settings.region); out.textContent = r.length ? `Works: found "${r[0].name}"` : 'Key works but found nothing'; }
      catch (e) { out.textContent = 'Failed: ' + e.message; }
    };
    document.getElementById('myName').onchange = async (e) => { settings.myName = e.target.value.trim() || 'Me'; await saveSettings(); toast('Saved'); };
    $app.querySelectorAll('[data-here]').forEach((b) => b.onclick = async () => { try { const p = await getPosition(); settings[b.dataset.here] = { lat: p.lat, lng: p.lng, label: b.dataset.here === 'home' ? 'Home' : 'Office' }; await saveSettings(); render(); } catch (e) { toast(e.message); } });
    $app.querySelectorAll('[data-setloc]').forEach((b) => b.onclick = async () => { const k = b.dataset.setloc; const ll = parseLatLng($app.querySelector(`[data-locinput="${k}"]`).value); if (!ll) return toast('Could not read a location from that'); settings[k] = { ...ll, label: k === 'home' ? 'Home' : 'Office' }; await saveSettings(); render(); });
    $app.querySelectorAll('[data-clear]').forEach((b) => b.onclick = async () => { settings[b.dataset.clear] = null; await saveSettings(); render(); });
    document.getElementById('saveT').onclick = async () => {
      settings.thresholds = { auto: +document.getElementById('tAuto').value, confirm: +document.getElementById('tConfirm').value, margin: +document.getElementById('tMargin').value };
      settings.useNominatimFallback = document.getElementById('nomi').checked;
      const ll = parseLatLng(document.getElementById('rLL').value); if (ll) settings.region = { ...settings.region, ...ll };
      settings.region.radiusKm = +document.getElementById('rKm').value || 40; await saveSettings(); toast('Saved');
    };
    document.getElementById('csvBtn').onclick = async () => {
      const rows = (await store.all('log')).sort((a, b) => a.at.localeCompare(b.at));
      const cols = ['at', 'type', 'url', 'shortcode', 'hadText', 'hadScreenshot', 'metaStatus', 'nameClues', 'areas', 'menuItems', 'candidates', 'topName', 'topScore', 'secondScore', 'level', 'outcome', 'chosenName', 'chosenRank', 'ms', 'errors', 'venueName'];
      const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))).join('\n');
      download(`saved-places-test-log-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
    };
    document.getElementById('clearLog').onclick = async () => { if (confirm('Clear the test log?')) { await store.clear('log'); render(); } };
    document.getElementById('expBtn').onclick = async () => {
      const data = { app: 'saved-places', version: APP_VERSION, exportedAt: nowIso(), settings, venues: await store.all('venues'), posts: await store.all('posts'), log: await store.all('log') };
      download(`saved-places-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), 'application/json');
    };
    document.getElementById('impFile').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text()); if (data.app !== 'saved-places') throw new Error("Not a Valerie's Makan-makan backup");
        for (const v of data.venues || []) await store.put('venues', v);
        for (const p of data.posts || []) await store.put('posts', p);
        for (const l of data.log || []) await store.put('log', l);
        toast(`Restored ${(data.venues || []).length} places`); render();
      } catch (err) { toast('Restore failed: ' + err.message); }
    };
    document.getElementById('wipeBtn').onclick = async () => {
      if (!confirm('Delete every saved place, post and log on this phone? Back up first if unsure.')) return;
      for (const s of ['venues', 'posts', 'log']) await store.clear(s); toast('All data deleted'); render();
    };
  });

  // ---------------- Incoming shares (from the iPhone Shortcut) ----------------
  // ?url=<instagram link>&text=<caption or screenshot text>    -> runs an import
  // ?gmaps=<expanded google maps link>&gtext=<shared text>     -> completes the active import, or saves a new place
  async function handleIncoming() {
    const qp = new URLSearchParams(location.search);
    if (![...qp.keys()].some((k) => ['url', 'text', 'gmaps', 'gtext', 'meta'].includes(k))) return false;
    history.replaceState(null, '', location.pathname + location.hash);
    const url = (qp.get('url') || '').trim(), text = qp.get('text') || '', gmaps = qp.get('gmaps') || '', gtext = qp.get('gtext') || '';
    const looksMaps = (s) => /google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/.test(s);
    if (gmaps || looksMaps(url)) {
      const place = SP.parseGoogleMaps(gmaps || url, gtext || text);
      if (!place.name) { toast('Could not read the place from Google Maps'); location.hash = '#/import?new=' + Date.now(); return true; }
      const saved = await store.kv('activeImport', null);
      imp = saved && saved.stage === 'choose' && Date.now() - (saved.startedAt || 0) < 60 * 60 * 1000 ? saved : { postId: null, url: '', text: '', photo: null, startedAt: Date.now(), result: null, stage: 'choose' };
      await finishManual({ ...place, mapsUrl: gmaps || url }, imp.postId ? 'google_maps_fallback' : 'google_maps_direct');
      return true;
    }
    // Experimental: preview tags the Shortcut read from the post page on the phone.
    const meta = SP.parseInstagramMeta(qp.get('meta') || '');
    const account = meta.status === 'ok' ? { handle: meta.handle, accountName: meta.accountName } : null;
    const fullText = [meta.caption, text].filter((x) => x && x.trim()).join('\n');
    const metaRaw = qp.get('meta') || '';
    const received = `Received from the shortcut: link ${url ? '✓' : '✗ (empty)'} · page data ${metaRaw.length} characters, ${(metaRaw.match(/<meta/gi) || []).length} preview tags · caption ${meta.caption ? '✓' : '✗'}${meta.status === 'login' ? ' (Instagram sent a login page)' : ''}`;
    const thumb = (qp.get('thumb') || '').startsWith('data:image/') ? qp.get('thumb') : null;
    imp = { postId: null, caption: fullText.trim() || null, received: received + (qp.has('thumb') || qp.has('thumberr') ? ` · thumbnail ${thumb ? '✓' : '✗'}` : ''), url, text: fullText, account, metaStatus: qp.has('meta') ? meta.status : 'not_sent', photo: thumb, startedAt: Date.now(), result: null, stage: 'form' };
    const usable = fullText.trim() || account;
    if (!usable && /instagram\.com\//i.test(url) && creatorsApi()) { location.hash = '#/import?auto=0&t=' + Date.now(); setTimeout(readThenImport, 50); return true; }
    if (!usable) setTimeout(() => toast(meta.status === 'login' ? "Instagram didn't share the caption for this post. Add a screenshot instead." : 'Got the link. Add a screenshot or the caption so I can find the place.', 5000), 300);
    location.hash = '#/import?auto=' + (usable ? '1' : '0') + '&t=' + Date.now();
    return true;
  }

  // ---------------- Boot ----------------
  (async function boot() {
    try { await db(); } catch (e) { $app.innerHTML = '<div class="banner warn">This browser blocked storage (private browsing?). The app needs it to save places.</div>'; return; }
    await loadSettings();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    const savedImp = await store.kv('activeImport', null);
    if (savedImp && savedImp.stage === 'choose') imp = savedImp;
    const handled = await handleIncoming();
    if (!handled) render();
  })();

  window.__SP_APP__ = { store, settings: () => settings }; // for testing
})();
