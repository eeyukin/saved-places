/* Saved Places — app UI, storage and import flow. Logic for identification lives in pipeline.js (window.SP). */
(function () {
  'use strict';
  const SP = window.SP;
  const $app = document.getElementById('app');
  const APP_VERSION = '0.1.0-poc';

  // ---------------- Storage (IndexedDB) ----------------
  const DB_NAME = 'saved-places', DB_VER = 1;
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
  async function loadSettings() { settings = Object.assign({}, DEFAULT_SETTINGS, await store.kv('settings', {})); return settings; }
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
      tags: [], provider: c.providerId ? 'osm' : (c.mapsUrl ? 'gmaps' : 'manual'), providerPlaceId: c.providerId || null, mapsUrl: c.mapsUrl || null,
      photo: null, status, confidence: c.score ?? null, visited: false, visitedAt: null, notes: '',
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
    } else {
      venue = venueFromCandidate(candidate, post.clues, status);
      if (post.photo) venue.photo = post.photo;
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

  // ---------------- Router ----------------
  const routes = [];
  const route = (re, fn) => routes.push({ re, fn });
  function parseHash() { const h = location.hash.replace(/^#/, '') || '/'; const [path, qs] = h.split('?'); return { path, params: new URLSearchParams(qs || '') }; }
  async function render() {
    const { path, params } = parseHash();
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', ('#' + path).startsWith(a.getAttribute('href')) && (a.getAttribute('href') !== '#/' || path === '/')));
    for (const r of routes) { const m = path.match(r.re); if (m) { try { await r.fn(m, params); } catch (e) { console.error(e); $app.innerHTML = `<div class="banner warn">Something went wrong: ${esc(e.message)}</div>`; } window.scrollTo(0, 0); return; } }
    location.hash = '#/';
  }
  window.addEventListener('hashchange', render);

  const searchIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';

  function venueCard(v, dist) {
    const sub = [v.area || v.city, dist != null ? fmtKm(dist) : null].filter(Boolean).join(' · ');
    return `<a class="card venue" href="#/venue/${v.id}">
      <div class="thumb" style="${thumbStyle(v)}">${v.photo ? '' : esc(initials(v.name))}</div>
      <div class="grow"><div class="name">${esc(v.name)}${v.visited ? ' <small>· visited</small>' : ''}</div>
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
      <h1>Saved Places</h1>
      <form class="search" id="homeSearch">${searchIcon}<input type="search" name="q" placeholder="Cake, ramen, Bangsar, a name…" autocomplete="off" enterkeyhint="search"></form>
      <div class="chips" style="margin-top:12px">${SP.CATEGORIES.filter((c) => c !== 'Other').map((c) => `<a class="chip" href="#/places?cat=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}</div>
      <a class="card hero-add" href="#/import" style="text-decoration:none;color:inherit;margin-top:10px">
        <div class="thumb" style="background:var(--accent);color:var(--accent-ink);width:48px;height:48px">+</div>
        <div><div style="font-weight:650">Add a place</div><small>Paste an Instagram link, caption or screenshot</small></div></a>
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
        <select id="within"><option value="">Any distance</option><option value="1">Within 1 km</option><option value="3">Within 3 km</option><option value="5">Within 5 km</option><option value="10">Within 10 km</option></select>
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
      if (state.within && origin) rows = rows.filter(({ d }) => d != null && d <= +state.within);
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
      <div class="photo" style="${thumbStyle(v)}">${v.photo ? '' : esc(initials(v.name))}</div>
      <h1 style="margin-top:14px">${esc(v.name)}</h1>
      <div class="muted">${esc(v.address || 'No address')}</div>
      <div style="margin:6px 0"><span class="status ${esc(v.status)}">${esc(statusLabel)}</span>${d != null ? ` · <small>${fmtKm(d)} from ${esc(origin.label || 'you')}</small>` : ''}</div>
      <div class="row wrap" style="margin:12px 0">
        <a class="btn primary" href="${esc(directionsLink(v))}" target="_blank" rel="noopener">Directions</a>
        <a class="btn" href="${esc(mapsLink(v))}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn" href="${esc(appleMapsLink(v))}" target="_blank" rel="noopener">Apple Maps</a>
      </div>
      <div class="toggle card"><div><div style="font-weight:600">Visited</div><small>${v.visitedAt ? 'Last on ' + new Date(v.visitedAt).toLocaleDateString() : 'Not yet'}</small></div>
        <button class="btn sm ${v.visited ? 'primary' : ''}" id="visitBtn">${v.visited ? 'Visited ✓' : 'Mark visited'}</button></div>
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
      <p class="muted" style="margin-top:-6px">Give it whatever you have. The caption or a screenshot works best.</p>
      <label for="iUrl">Instagram link</label>
      <input type="url" id="iUrl" placeholder="https://www.instagram.com/reel/…" value="${esc(imp.url)}" inputmode="url">
      <small>A pasted link can't be read here. Share the post from Instagram to the <b>Saved Places</b> shortcut and it reads the caption for you.</small>
      <label for="iText">Caption, or text from the post</label>
      <textarea id="iText" placeholder="Paste the caption here, e.g. 📍 Merchant's Lane, Petaling Street…">${esc(imp.text)}</textarea>
      <label>Screenshot of the post (optional)</label>
      <div class="row"><input type="file" id="iShot" accept="image/*" class="grow"></div>
      ${imp.received ? `<div class="banner" style="font-size:13px">${esc(imp.received)}</div>` : ''}
      <div id="ocrState" class="muted" style="font-size:14px;margin-top:6px">${imp.photo ? 'Screenshot attached.' : ''}</div>
      <div class="row" style="margin-top:16px"><button class="btn" id="pasteBtn">Paste</button><button class="btn primary grow" id="goBtn">Find this place</button></div>
      ${imp.fromPending ? '<p><button class="btn ghost danger" id="dropBtn">Delete this pending post</button></p>' : ''}`;
    const sync = () => { imp.url = document.getElementById('iUrl').value.trim(); imp.text = document.getElementById('iText').value; };
    document.getElementById('goBtn').onclick = () => { sync(); if (!imp.url && !imp.text.trim()) return toast('Add a link, caption or screenshot first'); runImport(); };
    document.getElementById('pasteBtn').onclick = async () => {
      try { const t = await navigator.clipboard.readText(); if (/instagram\.com/.test(t) && !document.getElementById('iUrl').value) document.getElementById('iUrl').value = t.trim(); else document.getElementById('iText').value += (document.getElementById('iText').value ? '\n' : '') + t; }
      catch (e) { toast('Tap and hold a field, then Paste'); }
    };
    document.getElementById('iShot').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return; sync();
      const st = document.getElementById('ocrState');
      try {
        imp.photo = await resizeImage(f);
        st.textContent = 'Reading text from the screenshot… (first time takes ~20 s)';
        const T = await loadTesseract();
        const { data } = await T.recognize(f, 'eng');
        imp.text = (imp.text ? imp.text + '\n' : '') + data.text.trim();
        document.getElementById('iText').value = imp.text;
        st.textContent = 'Text read from the screenshot. Check it, then tap Find.';
      } catch (err) { st.textContent = 'Could not read the screenshot (' + err.message + '). You can still type the caption.'; }
    };
    const db = document.getElementById('dropBtn');
    if (db) db.onclick = async () => { await store.del('posts', imp.postId); imp = null; await saveActive(); toast('Deleted'); location.hash = '#/'; };
  }

  function drawImportRunning() {
    const s = imp.steps || {};
    const li = (k, label) => `<li><span class="dot ${s[k] || ''}"></span>${esc(label)}</li>`;
    $app.innerHTML = `<h1>Finding the place…</h1><ul class="steps card">${li('clues', 'Reading clues from the post')}${li('search', s.searchLabel || 'Searching OpenStreetMap')}${li('score', 'Comparing candidates')}</ul>`;
  }

  async function ensurePost(clues) {
    let post = imp.postId ? await store.get('posts', imp.postId) : null;
    if (!post && clues.shortcode) post = (await store.all('posts')).find((p) => p.shortcode === clues.shortcode) || null;
    if (!post) post = { id: uid(), collectionId: 'personal', venueId: null, addedAt: nowIso(), sharedBy: settings.myName, importStatus: 'pending' };
    Object.assign(post, { url: clues.url || imp.url || null, shortcode: clues.shortcode, kind: clues.kind, extractedText: imp.text, clues, creatorHandle: clues.creator || null, photo: imp.photo || post.photo || null });
    if (!post.venueId) await store.put('posts', post);
    imp.postId = post.id;
    return post;
  }

  async function runImport() {
    imp.stage = 'running'; imp.startedAt = Date.now(); imp.steps = { clues: 'run' }; imp.error = null; drawImportRunning();
    const clues0 = SP.extractClues(imp.text, imp.url, imp.account || null);
    // Same Instagram post already saved? Don't search again.
    if (clues0.shortcode && !imp.fromPending) {
      const existing = (await store.all('posts')).find((p) => p.shortcode === clues0.shortcode && p.venueId);
      const v = existing && await store.get('venues', existing.venueId);
      if (v && !v.deleted) { imp.stage = 'done'; imp.outcome = { kind: 'already', venue: v }; await saveActive(); return drawImportResult(); }
    }
    let post = await ensurePost(clues0);
    const providers = [SP.photonProvider(fetch.bind(window))];
    if (settings.useNominatimFallback) providers.push(SP.nominatimProvider(fetch.bind(window), sleep));
    try {
      const result = await SP.identify({
        text: imp.text, url: imp.url, account: imp.account || null, providers, region: settings.region, thresholds: settings.thresholds,
        onStep: (k, data) => {
          if (k === 'clues') { imp.steps.clues = 'ok'; imp.steps.search = 'run'; }
          if (k === 'search') imp.steps.searchLabel = `Searching ${data.provider === 'photon' ? 'OpenStreetMap (Photon)' : 'OpenStreetMap (Nominatim)'}${data.queries.length ? ': ' + data.queries.slice(0, 2).join(', ') : ''}`;
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
    drawImportResult();
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
    const levelBanner = linkOnly ? `<div class="banner warn"><b>I only have the link, not the caption.</b><br><small>A link pasted into the app can't be read: browsers block opening Instagram pages. On your iPhone, open the post in Instagram and tap Share → <b>Saved Places</b>; the shortcut reads the caption for you.</small></div>`
      : dec.level === 'medium' ? `<div class="banner">Is this the place? <small>${esc(dec.why)}</small></div>`
      : `<div class="banner warn">${cands.length ? 'Not sure which place this is.' : r.queries.length ? 'No match found in OpenStreetMap.' : 'No venue name found in the text.'} <small>${esc(imp.error ? 'Search problem: ' + imp.error : '')}</small></div>`;
    $app.innerHTML = `
      <h1>${dec.level === 'medium' ? 'Confirm the place' : 'Help me find it'}</h1>
      ${imp.received ? `<div class="muted" style="font-size:12px;margin:-4px 0 8px">${esc(imp.received)}</div>` : ''}
      ${levelBanner}
      ${cands.length ? `<div>${cands.map((c, i) => candidateHtml(c, i, i === 0 && dec.level === 'medium')).join('')}</div>` : ''}
      <h3>Search with a different name</h3>
      <div class="row"><input type="text" id="reName" placeholder="Venue name" value="${esc(cl.names[0] ? cl.names[0].name : '')}"><button class="btn" id="reBtn">Search</button></div>
      <h3>Find it in Google Maps</h3>
      <p class="muted" style="margin:4px 0 8px;font-size:14px">Open the search, tap the right place, then Share → <b>Saved Places</b>. It comes back here and finishes this import.</p>
      <a class="btn block" href="${esc(gmaps)}" target="_blank" rel="noopener">Search Google Maps</a>
      <details style="margin-top:14px"><summary>Enter it myself</summary>
        <label>Name</label><input type="text" id="mName" value="${esc(cl.names[0] ? cl.names[0].name : '')}">
        <label>Area or address</label><input type="text" id="mAddr" value="${esc(cl.areas[0] ? cl.areas[0].name : '')}">
        <label>Location (optional: Google Maps link or "lat, lng")</label><input type="text" id="mLoc" placeholder="3.1422, 101.6981">
        <button class="btn primary" id="mSave" style="margin-top:10px">Save</button></details>
      <h3>What I found in the post</h3>${cluesHtml(cl)}
      <hr><div class="row wrap"><button class="btn ghost" id="pendBtn">Decide later</button><button class="btn ghost" id="editBtn">Edit text</button><a class="btn ghost" href="#/import" id="another">Start a new one</a></div>`;
    bindAnother();

    $app.querySelectorAll('[data-pick]').forEach((b) => b.onclick = async () => {
      const c = cands[+b.dataset.pick];
      const post = await store.get('posts', imp.postId);
      const saved = await saveVenueWithPost(c, post, 'confirmed');
      await logImport(+b.dataset.pick === 0 ? 'confirmed_top' : 'picked_other', c);
      imp.stage = 'done'; imp.outcome = { kind: 'confirmed', venue: saved.venue, merged: saved.merged }; await saveActive(); drawImportResult();
    });
    document.getElementById('reBtn').onclick = () => {
      const n = document.getElementById('reName').value.trim(); if (!n) return;
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
      <dl class="kv"><dt>Version</dt><dd>${APP_VERSION}</dd><dt>Mode</dt><dd>${standalone ? 'Home-screen web app' : 'Safari'}</dd><dt>Venue data</dt><dd>© OpenStreetMap contributors, via Photon and Nominatim</dd><dt>Privacy</dt><dd>No account, no Instagram login. Searches send only the venue name and area to OpenStreetMap services.</dd></dl>`;

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
        const data = JSON.parse(await f.text()); if (data.app !== 'saved-places') throw new Error('Not a Saved Places backup');
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
    imp = { postId: null, received, url, text: fullText, account, metaStatus: qp.has('meta') ? meta.status : 'not_sent', photo: null, startedAt: Date.now(), result: null, stage: 'form' };
    const usable = fullText.trim() || account;
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
