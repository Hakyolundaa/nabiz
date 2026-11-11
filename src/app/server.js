// Nabız — dahili sunucu (Nabiz.exe içinde görünmeden çalışır)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
let openHandler = () => {};
let dataFile = null, dataHandler = () => {}, stateHandler = () => {}, savedHandler = () => {};

// ---- Masaüstü adası ile ana uygulama arasındaki canlı bağlantı ----
const clients = { app: new Set(), island: new Set(), remote: new Set() };
let lastState = null;
const sse = (res, obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };
const toIslands = obj => { clients.island.forEach(r => sse(r, obj)); clients.remote.forEach(r => sse(r, obj)); };
const toApps = obj => clients.app.forEach(r => sse(r, obj));
const onlineMsg = () => ({ type: 'online', v: clients.app.size > 0 });
setInterval(() => [...clients.app, ...clients.island, ...clients.remote].forEach(r => { try { r.write(': ping\n\n'); } catch {} }), 20000);
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/api/events') {
    const role = new URL(req.url, 'http://x').searchParams.get('role') === 'app' ? 'app' : 'island';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients[role].add(res);
    if (role === 'island') { if (lastState) sse(res, { type: 'state', state: lastState }); sse(res, onlineMsg()); }
    else toIslands(onlineMsg());
    req.on('close', () => { clients[role].delete(res); if (role === 'app') toIslands(onlineMsg()); });
    return;
  }
  if (p === '/api/state' && req.method === 'POST') { lastState = await readBody(req); toIslands({ type: 'state', state: lastState }); try { stateHandler(lastState); } catch {} res.end('ok'); return; }
  if (p === '/api/cmd' && req.method === 'POST') { const b = await readBody(req); toApps({ type: 'cmd', cmd: b.cmd, v: b.v }); res.end('ok'); return; }
  if (p === '/api/data') {
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (dataFile && b && typeof b === 'object') { try { fs.writeFileSync(dataFile + '.tmp', JSON.stringify(b)); fs.renameSync(dataFile + '.tmp', dataFile); try { savedHandler(); } catch {} } catch {} }
      res.end('ok'); return;
    }
    let d = '{}'; try { if (dataFile) d = fs.readFileSync(dataFile, 'utf8'); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d); return;
  }
  if (p === '/api/ytcaps') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    try { res.end(JSON.stringify(await ytCaptions(new URL(req.url, 'http://x').searchParams.get('id') || ''))); }
    catch (e) { res.end(JSON.stringify({ synced: '', error: e.message })); }
    return;
  }
  if (p === '/api/lyrics') {
    const q = new URL(req.url, 'http://x').searchParams;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    try { res.end(JSON.stringify(await getLyrics(q.get('artist') || '', q.get('title') || '', +q.get('duration') || 0))); }
    catch (e) { res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (p === '/api/img') {
    // Kapak resimlerini aynı adresten ver (özet kartı çizerken tarayıcı dışa aktarmayı engellemesin). Sadece bilinen resim sunucuları.
    try {
      const u = new URL(new URL(req.url, 'http://x').searchParams.get('u') || '');
      if (u.protocol !== 'https:' || !/(^|\.)(ytimg\.com|ggpht\.com|mzstatic\.com|googleusercontent\.com)$/.test(u.hostname)) { res.writeHead(400); return res.end(); }
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      if (!r.ok) { res.writeHead(r.status); return res.end(); }
      res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(502); res.end(); }
    return;
  }
  if (p === '/api/charts') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    try { res.end(JSON.stringify(await getCharts())); } catch (e) { res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (p === '/api/open') { openHandler(); res.end('ok'); return; }
  if (p === '/api/search') { const q = new URL(req.url, 'http://x').searchParams; return ytSearch(q.get('q') || '', res, q.get('type') || ''); }
  if (p === '/api/suggest') return ytSuggest(new URL(req.url, 'http://x').searchParams.get('q') || '', res);
  if (p === '/api/artist') { const q = new URL(req.url, 'http://x').searchParams; return artistInfo(q.get('q') || '', res, q.get('lite') === '1', q.get('t') || ''); }
  if (p === '/api/weather') return weather(new URL(req.url, 'http://x').searchParams.get('city') || '', res);
  if (p === '/api/releases') return releases(new URL(req.url, 'http://x').searchParams.get('a') || '', res);
  if (p === '/api/import') return importList(new URL(req.url, 'http://x').searchParams.get('url') || '', res);
  if (p === '/api/album') { const q = new URL(req.url, 'http://x').searchParams; return albumInfo(q.get('src') || 'dz', q.get('id') || '', res); }
  if (p === '/api/related') return ytRelated(new URL(req.url, 'http://x').searchParams.get('id') || '', res);
  if (p === '/api/playlist') return ytPlaylist(new URL(req.url, 'http://x').searchParams.get('list') || '', res);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// Şarkı sözleri (LRCLIB — ücretsiz, zaman damgalı sözler)
const lyricCache = new Map();
// YouTube videosunun kendi altyazısı (çoğu klipte sözler altyazı olarak var)
const capCache = new Map();
async function ytCaptions(id) {
  if (!/^[\w-]{11}$/.test(id)) return { synced: '' };
  if (capCache.has(id)) return capCache.get(id);
  let out = { synced: '' };
  try {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${id}&hl=tr&gl=TR`, { headers: YT_HEADERS })).text();
    const m = html.match(/"captionTracks":(\[.*?\])\s*,\s*"audioTracks"/) || html.match(/"captionTracks":(\[[^\]]*\])/);
    if (m) {
      const tracks = JSON.parse(m[1]);
      const rank = t => (t.kind === 'asr' ? 10 : 0) + (/^tr/.test(t.languageCode) ? 0 : /^en/.test(t.languageCode) ? 2 : 4);
      tracks.sort((a, b) => rank(a) - rank(b));
      for (const t of tracks.slice(0, 3)) {
        const u = String(t.baseUrl || '').replace(/\\u0026/g, '&'); if (!u) continue;
        const r = await fetch(u + (u.includes('fmt=') ? '' : '&fmt=json3'), { headers: YT_HEADERS });
        const txt = await r.text(); if (!txt || txt.length < 20) continue;
        let j; try { j = JSON.parse(txt); } catch { continue; }
        const lines = [];
        for (const ev of j.events || []) {
          const text = (ev.segs || []).map(x => x.utf8 || '').join('').replace(/\s+/g, ' ').replace(/[♪♫]/g, '').trim();
          if (!text || ev.tStartMs == null) continue;
          const ts = ev.tStartMs / 1000, mm = Math.floor(ts / 60), ss = (ts % 60).toFixed(2).padStart(5, '0');
          if (lines.length && lines[lines.length - 1].endsWith(text)) continue;
          lines.push(`[${String(mm).padStart(2, '0')}:${ss}]${text}`);
        }
        if (lines.length >= 4) { out = { synced: lines.join('\n'), source: 'yt', auto: t.kind === 'asr', lang: t.languageCode }; break; }
      }
    }
  } catch {}
  capCache.set(id, out);
  return out;
}

async function getLyrics(artist, title, duration) {
  const key = (artist + '|' + title).toLowerCase() + '|' + Math.round((duration || 0) / 4);
  if (lyricCache.has(key)) return lyricCache.get(key);
  const H = { headers: { 'User-Agent': 'Nabiz/1.7 (kisisel muzik paneli)' } };
  const enc = encodeURIComponent;
  const fold = x => String(x || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const get = async u => { try { const j = await (await fetch(u, H)).json(); return Array.isArray(j) ? j : []; } catch { return []; } };
  const aF = fold(artist), tF = fold(title);
  const artistOk = x => { const n = fold(x.artistName); return !aF || n.includes(aF) || aF.includes(n) || aF.split(' ').some(w => w.length > 2 && n.includes(w)); };
  const titleOk = x => { const n = fold(x.trackName); return n === tF || n.includes(tF) || tF.includes(n); };
  // Sırayla dene; ilk bulunan yeterli: 1) tam alanlar 2) serbest arama 3) Türkçe karakterleri sadeleştirilmiş 4) sadece şarkı adı (sanatçı uyuyorsa)
  let list = await get(`https://lrclib.net/api/search?track_name=${enc(title)}&artist_name=${enc(artist)}`);
  if (!list.length) list = await get(`https://lrclib.net/api/search?q=${enc(artist + ' ' + title)}`);
  if (!list.length && (aF !== artist.toLowerCase() || tF !== title.toLowerCase())) list = await get(`https://lrclib.net/api/search?q=${enc(aF + ' ' + tF)}`);
  if (!list.length && title.length > 2) list = (await get(`https://lrclib.net/api/search?track_name=${enc(title)}`)).filter(x => artistOk(x) || (duration && x.duration && Math.abs(x.duration - duration) <= 3));
  list = list.filter(x => titleOk(x) || artistOk(x));
  // süreye en yakın ve zaman damgalı olanı seç
  const score = x => (x.syncedLyrics ? 0 : 1000) + (duration && x.duration ? Math.abs(x.duration - duration) : 50);
  list.sort((a, b) => score(a) - score(b));
  const best = list.find(x => x.syncedLyrics || x.plainLyrics);
  const out = best && (!duration || !best.duration || Math.abs(best.duration - duration) < 25)
    ? { synced: best.syncedLyrics || '', plain: best.plainLyrics || '', name: best.trackName, artist: best.artistName, duration: best.duration || 0 }
    : { synced: '', plain: '' };
  lyricCache.set(key, out);
  return out;
}

// Türkiye'de en çok dinlenenler (Apple Music, günlük güncellenir). 30 dk önbellek.
let chartCache = { t: 0, d: null };
async function getCharts() {
  if (chartCache.d && Date.now() - chartCache.t < 30 * 60 * 1000) return chartCache.d;
  // Apple bazen geçici 5xx veriyor: iki adresi, kısa aralarla birkaç kez dene; olmazsa eldeki eski listeyi ver
  const URLS = ['https://rss.marketingtools.apple.com/api/v2/tr/music/most-played/50/songs.json', 'https://rss.applemarketingtools.com/api/v2/tr/music/most-played/50/songs.json'];
  let j = null, lastErr = '';
  for (let a = 0; a < 3 && !j; a++) {
    for (const u of URLS) {
      try { const r = await fetch(u, { headers: { 'User-Agent': UA } }); if (r.ok) { j = await r.json(); break; } lastErr = 'HTTP ' + r.status; } catch (e) { lastErr = e.message; }
    }
    if (!j) await new Promise(r => setTimeout(r, 1200 * (a + 1)));
  }
  if (!j) { if (chartCache.d) return { ...chartCache.d, stale: true }; throw new Error('Liste alınamadı (' + lastErr + ')'); }
  const d = {
    updated: j.feed.updated,
    items: j.feed.results.map((x, i) => ({ rank: i + 1, title: x.name, artist: x.artistName, thumb: (x.artworkUrl100 || '').replace(/\d+x\d+bb/, '400x400bb') })),
  };
  chartCache = { t: Date.now(), d };
  return d;
}

// ---------- Telefondan kumanda (yerel ağ) ----------
// Sadece kullanıcı açarsa çalışır; yalnızca gizli anahtarı (token) bilen telefon bağlanabilir.
let remoteServer = null, remotePort = 0, remoteToken = '';
function startRemote(token, port = 5174) {
  stopRemote();
  remoteToken = token;
  return new Promise(resolve => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const m = u.pathname.match(/^\/k\/([A-Za-z0-9]+)(\/.*)?$/);
      if (!m || m[1] !== remoteToken) { res.writeHead(404); return res.end('Bulunamadı'); }
      const sub = m[2] || '/';
      if (sub === '/' ) {
        fs.readFile(path.join(ROOT, 'remote.html'), (e, d) => { if (e) { res.writeHead(500); return res.end(); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d); });
        return;
      }
      if (sub === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.remote.add(res);
        if (lastState) sse(res, { type: 'state', state: lastState });
        sse(res, onlineMsg());
        req.on('close', () => clients.remote.delete(res));
        return;
      }
      if (sub === '/cmd' && req.method === 'POST') { const b = await readBody(req); const ok = ['toggle', 'next', 'prev', 'seek', 'vol', 'volset'].includes(b.cmd); if (ok) toApps({ type: 'cmd', cmd: b.cmd, v: b.v }); res.end(ok ? 'ok' : 'no'); return; }
      res.writeHead(404); res.end();
    });
    let tries = 0;
    const attempt = p => {
      srv.once('error', e => { if (e.code === 'EADDRINUSE' && ++tries < 8) attempt(p + 1); else resolve(0); });
      srv.listen(p, '0.0.0.0', () => { remoteServer = srv; remotePort = p; resolve(p); });
    };
    attempt(port);
  });
}
function stopRemote() {
  clients.remote.forEach(r => { try { r.end(); } catch {} }); clients.remote.clear();
  if (remoteServer) { try { remoteServer.close(); } catch {} }
  remoteServer = null; remotePort = 0;
}

// Verilen porttan başlayarak boş port bulur, açılan portu döndürür.
function start(port) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = p => {
      server.once('error', e => { if (e.code === 'EADDRINUSE' && ++tries < 10) attempt(p + 1); else reject(e); });
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    attempt(port);
  });
}

// Anahtarsız YouTube araması: arama sayfasını çekip içindeki veriyi okur.
// ---------- YouTube verisi (arama, ilgili şarkılar, çalma listesi) ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const YT_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8', 'Cookie': 'SOCS=CAI; CONSENT=YES+1' };
async function ytPage(url) {
  const r = await fetch(url, { headers: YT_HEADERS });
  return extractInitialData(await r.text());
}
// Sayfa okunamazsa YouTube'un kendi veri servisi (anahtarsız)
async function innertube(endpoint, body) {
  const r = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { ...YT_HEADERS, 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': '2.20251101.00.00' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20251101.00.00', hl: 'tr', gl: 'TR' } }, ...body }),
  });
  if (!r.ok) throw new Error('YouTube ' + r.status);
  return r.json();
}
const txt = t => !t ? '' : typeof t === 'string' ? t : t.simpleText || t.content || (t.runs ? t.runs.map(x => x.text).join('') : '');
function findDuration(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 12) return '';
  for (const k in o) {
    const v = o[k];
    if (typeof v === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(v)) return v;
    if (typeof v === 'object') { const d = findDuration(v, depth + 1); if (d) return d; }
  }
  return '';
}
// Her türlü YouTube video kutusunu (eski ve yeni biçim) tek listeye çevir
function collectVideos(data, max = 40, skip) {
  const out = [], seen = new Set(skip ? [skip] : []);
  (function walk(o) {
    if (!o || typeof o !== 'object' || out.length >= max) return;
    const v = o.videoRenderer || o.compactVideoRenderer || o.playlistVideoRenderer || o.videoWithContextRenderer;
    if (v && v.videoId) {
      if (!seen.has(v.videoId)) {
        seen.add(v.videoId);
        out.push({
          id: v.videoId, title: txt(v.title) || txt(v.headline),
          channel: txt(v.ownerText) || txt(v.longBylineText) || txt(v.shortBylineText),
          duration: txt(v.lengthText), live: !v.lengthText && !v.lengthSeconds,
          views: txt(v.shortViewCountText) || txt(v.viewCountText), age: txt(v.publishedTimeText),
        });
      }
      return;
    }
    const l = o.lockupViewModel;
    if (l && l.contentId && /VIDEO/.test(l.contentType || '')) {
      if (!seen.has(l.contentId)) {
        seen.add(l.contentId);
        const md = l.metadata && l.metadata.lockupMetadataViewModel || {};
        let channel = '';
        try { channel = txt(md.metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].text); } catch {}
        const duration = findDuration(l.contentImage);
        let views = '', age = '';
        try { const parts = md.metadata.contentMetadataViewModel.metadataRows[1].metadataParts.map(x => txt(x.text)).filter(Boolean); views = parts.find(x => /görüntü|izl|view|watch/i.test(x)) || parts[0] || ''; age = parts.find(x => x !== views) || ''; } catch {}
        out.push({ id: l.contentId, title: txt(md.title), channel, duration, live: !duration, views, age });
      }
      return;
    }
    for (const k in o) walk(o[k]);
  })(data);
  return out;
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

// type: '' (şarkı), 'live' (canlı yayın), 'podcast' (uzun içerik)
const YT_FILTER = { live: 'EgJAAQ%3D%3D', podcast: 'EgIYAg%3D%3D' };
async function ytSearch(q, res, type = '') {
  if (!q.trim()) return sendJson(res, 200, []);
  let out = [];
  const query = type === 'podcast' && !/podcast/i.test(q) ? q + ' podcast' : q;
  const sp = YT_FILTER[type] || '';
  try { const d = await ytPage('https://www.youtube.com/results?hl=tr&gl=TR&search_query=' + encodeURIComponent(query) + (sp ? '&sp=' + sp : '')); if (d) out = collectVideos(d, 30); } catch {}
  if (!out.length) { try { out = collectVideos(await innertube('search', { query, ...(sp ? { params: decodeURIComponent(sp) } : {}) }), 30); } catch {} }
  if (!out.length) return sendJson(res, 502, { error: 'YouTube şu an yanıt vermiyor, birazdan tekrar dene.' });
  sendJson(res, 200, out);
}

// ---------- Arama önerileri (YouTube) ----------
async function ytSuggest(q, res) {
  if (!q.trim()) return sendJson(res, 200, []);
  try {
    const r = await fetch('https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=tr&gl=tr&q=' + encodeURIComponent(q), { headers: YT_HEADERS });
    const t = await r.text();
    const j = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
    sendJson(res, 200, (j[1] || []).map(x => Array.isArray(x) ? x[0] : x).filter(x => typeof x === 'string').slice(0, 8));
  } catch { sendJson(res, 200, []); }
}

// ---------- Sanatçı ve albüm bilgisi: Deezer → Apple → YouTube (yedekli) ----------
const getJson = async (u, ms = 7000) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { const r = await fetch(u, { signal: c.signal, headers: { 'User-Agent': UA } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } };
const nrm = s => String(s || '').toLocaleLowerCase('tr').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ıüöçşğ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const artCache = new Map();
// İki sanatçı adı aynı kişi mi? (büyük/küçük harf, aksan, "VEVO", "Official" vb. önemsiz)
const artKey = s => nrm(String(s || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\b(official|resmi|music|müzik|muzik|tv|channel|kanal|records|plak)\b/gi, ''));
function sameArtist(a, b) {
  const x = artKey(a), y = artKey(b); if (!x || !y) return false; if (x === y) return true;
  const nx = x.replace(/ /g, ''), ny = y.replace(/ /g, ''); if (nx === ny) return true;
  const [sh, lo] = nx.length < ny.length ? [nx, ny] : [ny, nx];
  return sh.length >= 4 && lo.includes(sh) && sh.length / lo.length >= 0.6;
}
const titleMatch = (a, b) => { const x = nrm(a).replace(/\(.*?\)|\[.*?\]/g, '').trim(), y = nrm(b).replace(/\(.*?\)|\[.*?\]/g, '').trim(); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
// Şarkı adı biliniyorsa sanatçıyı şarkıdan bul: "Sanatçıya git" doğru kişiye gitsin
async function artistFromSong(q, t) {
  try {
    const s = await getJson('https://api.deezer.com/search?limit=15&q=' + encodeURIComponent(`${q} ${t}`));
    const list = (s.data || []).filter(x => x.artist && titleMatch(x.title_short || x.title, t));
    const hit = list.find(x => sameArtist(x.artist.name, q)) || list.find(x => artKey(q).includes(artKey(x.artist.name)) || nrm(t + ' ' + q).includes(artKey(x.artist.name)));
    if (hit) return { id: hit.artist.id, name: hit.artist.name };
  } catch {}
  return null;
}
async function artistInfo(q, res, lite, songT = '') {
  q = q.trim(); if (!q) return sendJson(res, 400, { error: 'boş' });
  const key = (lite ? 'L|' : 'F|') + nrm(q) + '|' + nrm(songT);
  if (artCache.has(key)) return sendJson(res, 200, artCache.get(key));
  let out = null;
  // 1) Deezer
  try {
    let a = null;
    if (songT && !lite) { const h = await artistFromSong(q, songT); if (h) { try { a = await getJson('https://api.deezer.com/artist/' + h.id); if (a.error) a = null; } catch {} } }
    if (!a) {
      const s = await getJson('https://api.deezer.com/search/artist?limit=10&q=' + encodeURIComponent(q));
      const list = (s.data || []);
      // sadece gerçekten aynı isimli sanatçı; benzemeyen birine asla gitme
      a = list.find(x => nrm(x.name) === nrm(q)) || (lite ? null : list.filter(x => sameArtist(x.name, q)).sort((x, y) => (y.nb_fan || 0) - (x.nb_fan || 0))[0]);
    }
    if (a) {
      out = { src: 'dz', id: a.id, name: a.name, picture: a.picture_xl || a.picture_big || '', fans: a.nb_fan || 0 };
      if (!lite) {
        const [top, albums, rel] = await Promise.all([
          getJson(`https://api.deezer.com/artist/${a.id}/top?limit=25`).catch(() => ({})),
          getJson(`https://api.deezer.com/artist/${a.id}/albums?limit=60`).catch(() => ({})),
          getJson(`https://api.deezer.com/artist/${a.id}/related?limit=12`).catch(() => ({})),
        ]);
        out.top = (top.data || []).map(t => ({ title: t.title_short || t.title, artist: (t.artist && t.artist.name) || a.name, duration: t.duration || 0, rank: t.rank || 0, cover: (t.album && (t.album.cover_xl || t.album.cover_big)) || '', album: t.album && t.album.title }));
        const seen = new Set();
        out.albums = (albums.data || []).filter(x => { const k = nrm(x.title); if (seen.has(k)) return false; seen.add(k); return true; })
          .map(x => ({ src: 'dz', id: x.id, title: x.title, cover: x.cover_xl || x.cover_big || '', year: (x.release_date || '').slice(0, 4), type: x.record_type || 'album' }))
          .sort((x, y) => (y.year || '').localeCompare(x.year || ''));
        out.related = (rel.data || []).map(r => ({ name: r.name, picture: r.picture_big || r.picture_medium || '' }));
      }
    }
  } catch {}
  // 2) Apple (iTunes) yedeği
  if (!out) {
    try {
      const s = await getJson('https://itunes.apple.com/search?entity=musicArtist&country=tr&limit=5&term=' + encodeURIComponent(q));
      const list = s.results || [];
      const a = list.find(x => nrm(x.artistName) === nrm(q)) || (lite ? null : list.find(x => sameArtist(x.artistName, q)));
      if (a) {
        out = { src: 'it', id: a.artistId, name: a.artistName, picture: '', fans: 0 };
        if (!lite) {
          const [al, so] = await Promise.all([
            getJson(`https://itunes.apple.com/lookup?id=${a.artistId}&entity=album&limit=60&country=tr`).catch(() => ({})),
            getJson(`https://itunes.apple.com/lookup?id=${a.artistId}&entity=song&limit=25&country=tr`).catch(() => ({})),
          ]);
          const big = u => (u || '').replace(/\d+x\d+bb/, '600x600bb');
          out.albums = (al.results || []).filter(x => x.wrapperType === 'collection').map(x => ({ src: 'it', id: x.collectionId, title: x.collectionName, cover: big(x.artworkUrl100), year: (x.releaseDate || '').slice(0, 4), type: x.trackCount <= 3 ? 'single' : 'album' }))
            .sort((x, y) => (y.year || '').localeCompare(x.year || ''));
          out.top = (so.results || []).filter(x => x.wrapperType === 'track').map(x => ({ title: x.trackName, artist: x.artistName, duration: Math.round((x.trackTimeMillis || 0) / 1000), cover: big(x.artworkUrl100), album: x.collectionName }));
          out.picture = (out.albums[0] && out.albums[0].cover) || '';
          out.related = [];
        }
      }
    } catch {}
  }
  // 3) YouTube yedeği: en azından şarkılar
  if (!out && !lite) {
    try {
      let d = await ytPage('https://www.youtube.com/results?hl=tr&gl=TR&search_query=' + encodeURIComponent(q + ' şarkılar'));
      let vids = d ? collectVideos(d, 25) : [];
      if (!vids.length) vids = collectVideos(await innertube('search', { query: q + ' şarkılar' }), 25);
      out = { src: 'yt', id: '', name: q, picture: '', fans: 0, albums: [], related: [],
        top: vids.filter(v => !v.live).map(v => ({ title: v.title, artist: q, duration: 0, cover: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, ytid: v.id })) };
    } catch {}
  }
  if (!out) return sendJson(res, lite ? 200 : 502, lite ? {} : { error: 'Sanatçı bilgisi şu an alınamadı.' });
  artCache.set(key, out);
  sendJson(res, 200, out);
}
async function albumInfo(src, id, res) {
  if (!id) return sendJson(res, 400, { error: 'boş' });
  try {
    if (src === 'it') {
      const j = await getJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=song&limit=100&country=tr`);
      const col = (j.results || []).find(x => x.wrapperType === 'collection') || {};
      const big = u => (u || '').replace(/\d+x\d+bb/, '600x600bb');
      return sendJson(res, 200, { title: col.collectionName || '', artist: col.artistName || '', cover: big(col.artworkUrl100), year: (col.releaseDate || '').slice(0, 4),
        tracks: (j.results || []).filter(x => x.wrapperType === 'track').sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber))
          .map((x, i) => ({ n: i + 1, title: x.trackName, artist: x.artistName, duration: Math.round((x.trackTimeMillis || 0) / 1000) })) });
    }
    const a = await getJson(`https://api.deezer.com/album/${encodeURIComponent(id)}`);
    if (a.error) throw new Error('bulunamadı');
    sendJson(res, 200, { title: a.title, artist: a.artist && a.artist.name, cover: a.cover_xl || a.cover_big || '', year: (a.release_date || '').slice(0, 4),
      tracks: ((a.tracks && a.tracks.data) || []).map((t, i) => ({ n: i + 1, title: t.title_short || t.title, artist: (t.artist && t.artist.name) || (a.artist && a.artist.name), duration: t.duration || 0 })) });
  } catch (e) { sendJson(res, 502, { error: 'Albüm bilgisi alınamadı.' }); }
}

// ---------- Hava durumu (Open-Meteo, anahtarsız) ----------
const wCache = new Map();
async function weather(city, res) {
  city = city.trim(); if (!city) return sendJson(res, 400, { error: 'Şehir yok' });
  const k = nrm(city), c = wCache.get(k);
  if (c && Date.now() - c.at < 20 * 60e3) return sendJson(res, 200, c.v);
  try {
    const g = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=tr&name=' + encodeURIComponent(city));
    const loc = g.results && g.results[0]; if (!loc) throw new Error('Şehir bulunamadı');
    const f = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weather_code,is_day&timezone=auto`);
    const cu = f.current || {};
    const v = { city: loc.name, temp: Math.round(cu.temperature_2m), code: cu.weather_code, day: cu.is_day === 1 };
    wCache.set(k, { at: Date.now(), v }); sendJson(res, 200, v);
  } catch (e) { sendJson(res, 502, { error: e.message || 'Hava durumu alınamadı' }); }
}

// ---------- Takip edilen sanatçıların yeni çıkanları (son 60 gün) ----------
const relCache = new Map();
async function releases(a, res) {
  const list = a.split(',').map(x => x.trim()).filter(Boolean).slice(0, 60);
  const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const big = u => (u || '').replace(/\d+x\d+bb/, '600x600bb');
  const one = async key => {
    const c = relCache.get(key); if (c && Date.now() - c.at < 3600e3) return c.v;
    const [src, id] = key.split(':'); let v = [];
    try {
      if (src === 'dz') {
        const j = await getJson(`https://api.deezer.com/artist/${encodeURIComponent(id)}/albums?limit=12`);
        v = (j.data || []).filter(x => (x.release_date || '') >= since).map(x => ({ src: 'dz', id: x.id, title: x.title, cover: x.cover_xl || x.cover_big || '', date: x.release_date, type: x.record_type || 'album' }));
      } else if (src === 'it') {
        const j = await getJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=album&limit=20&sort=recent&country=tr`);
        v = (j.results || []).filter(x => x.wrapperType === 'collection' && (x.releaseDate || '').slice(0, 10) >= since)
          .map(x => ({ src: 'it', id: x.collectionId, title: x.collectionName, cover: big(x.artworkUrl100), date: (x.releaseDate || '').slice(0, 10), type: x.trackCount <= 3 ? 'single' : 'album', artist: x.artistName }));
      }
      relCache.set(key, { at: Date.now(), v });
    } catch {}
    return v.map(x => ({ ...x, key }));
  };
  const out = [];
  for (let i = 0; i < list.length; i += 6) (await Promise.all(list.slice(i, i + 6).map(one))).forEach(v => out.push(...v));
  out.sort((x, y) => (y.date || '').localeCompare(x.date || ''));
  sendJson(res, 200, out.slice(0, 40));
}

// ---------- Spotify / Deezer listesini içe aktar ----------
function findTrackList(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 14) return null;
  if (Array.isArray(o.trackList) && o.trackList.length) return o;
  if (Array.isArray(o)) { if (o.length && o.every(x => x && typeof x === 'object' && typeof x.title === 'string' && typeof x.subtitle === 'string')) return { trackList: o }; for (const x of o) { const r = findTrackList(x, depth + 1); if (r) return r; } return null; }
  for (const k of Object.keys(o)) { const r = findTrackList(o[k], depth + 1); if (r) return r; }
  return null;
}
async function importList(url, res) {
  try {
    let m;
    if ((m = url.match(/deezer\.(?:com|page\.link)\/(?:[a-z]{2}\/)?(playlist|album)\/(\d+)/i))) {
      const j = await getJson(`https://api.deezer.com/${m[1]}/${m[2]}`, 10000);
      if (j.error) throw new Error('Deezer listesi bulunamadı (gizli olabilir)');
      let data = (j.tracks && j.tracks.data) || [], next = j.tracks && j.tracks.next;
      for (let i = 0; next && i < 8; i++) { const n = await getJson(next, 10000).catch(() => null); if (!n) break; data = data.concat(n.data || []); next = n.next; }
      return sendJson(res, 200, { title: j.title || 'Deezer listesi', source: 'Deezer', cover: j.picture_xl || j.cover_xl || '',
        tracks: data.map(t => ({ title: t.title_short || t.title, artist: (t.artist && t.artist.name) || '', duration: t.duration || 0, cover: (t.album && (t.album.cover_xl || t.album.cover_big)) || '' })) });
    }
    if ((m = url.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:embed\/)?(playlist|album|track)\/([A-Za-z0-9]+)/i))) {
      const r = await fetch(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9' } });
      const html = await r.text();
      const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!nd) throw new Error('Spotify sayfası okunamadı');
      const data = JSON.parse(nd[1]);
      const ent = findTrackList(data) || {};
      let tracks = (ent.trackList || []).map(t => ({ title: t.title, artist: t.subtitle || '', duration: Math.round((t.duration || 0) / 1000) }));
      if (!tracks.length) throw new Error('Spotify listesinde şarkı bulunamadı (liste gizli olabilir)');
      return sendJson(res, 200, { title: ent.name || ent.title || 'Spotify listesi', source: 'Spotify', tracks });
    }
    sendJson(res, 400, { error: 'Bu link tanınmadı. Spotify ya da Deezer çalma listesi / albüm linki yapıştır.' });
  } catch (e) { sendJson(res, 502, { error: e.message || 'İçe aktarılamadı' }); }
}

// Radyo: bir şarkıya benzer şarkılar (YouTube'un "sıradaki" önerileri)
async function ytRelated(id, res) {
  let out = [];
  try { out = collectVideos(await innertube('next', { videoId: id }), 30, id); } catch {}
  if (!out.length) { try { const d = await ytPage('https://www.youtube.com/watch?hl=tr&v=' + encodeURIComponent(id)); if (d) out = collectVideos(d, 30, id); } catch {} }
  sendJson(res, 200, out.filter(v => !v.live));
}

// Çalma listesini tek tek şarkı olarak içe aktar
async function ytPlaylist(list, res) {
  let data = null;
  try { data = await innertube('browse', { browseId: 'VL' + list }); } catch {}
  let items = data ? collectVideos(data, 200) : [];
  if (!items.length) { try { data = await ytPage('https://www.youtube.com/playlist?hl=tr&list=' + encodeURIComponent(list)); if (data) items = collectVideos(data, 200); } catch {} }
  let title = '';
  try { title = txt(data.metadata.playlistMetadataRenderer.title); } catch {}
  if (!title) { try { title = txt(data.header.pageHeaderRenderer.pageTitle) || txt(data.header.playlistHeaderRenderer.title); } catch {} }
  if (!items.length) return sendJson(res, 502, { error: 'Çalma listesi okunamadı (gizli olabilir).' });
  sendJson(res, 200, { title: title || 'YouTube listesi', items });
}

function extractInitialData(html) {
  const markers = ['var ytInitialData = ', 'window["ytInitialData"] = ', 'ytInitialData = '];
  for (const mk of markers) {
    const i = html.indexOf(mk);
    if (i < 0) continue;
    // JSON nesnesinin sonunu parantez sayarak bul (string içlerini atla)
    let start = html.indexOf('{', i), depth = 0, inStr = false, esc = false;
    for (let j = start; j < html.length; j++) {
      const c = html[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, j + 1)); } catch { break; } }
    }
  }
  return null;
}

module.exports = { start, startRemote, stopRemote, remotePort: () => remotePort, sendCmd: (cmd, v) => toApps({ type: 'cmd', cmd, v }), onSaved: f => { savedHandler = f; }, onState: f => { stateHandler = f; }, onOpen: f => { openHandler = f; }, setDataFile: f => { dataFile = f; }, onData: f => { dataHandler = f; } };
