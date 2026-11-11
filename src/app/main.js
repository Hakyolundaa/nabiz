// Nabız — masaüstü uygulaması (Nabiz.exe)
// Sunucuyu görünmeden başlatır; ana pencere kapatılınca gizlenir, müzik ve ada çalmaya devam eder.
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, dialog, globalShortcut, powerMonitor, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// YouTube "Electron" tarayıcısını engellemesin diye standart Chrome kimliği kullan
app.userAgentFallback = app.userAgentFallback.replace(/\s?(Electron|nabiz|Nabız)\/\S+/gi, '');

// Windows bildirimleri için uygulama kimliği; Başlat menüsü kısayoluna da yazılır
const AUMID = 'Nabiz.Muzik';
if (process.platform === 'win32') app.setAppUserModelId(AUMID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  const server = require('./server.js');
  const { DiscordPresence } = require('./discord.js');
  const presence = new DiscordPresence();
  const DISCORD_DEFAULT_ID = '1569723778261590066'; // Nabız'ın Discord uygulaması
  const discordId = () => String(cfg.discordId || '').trim() || DISCORD_DEFAULT_ID;
  const ICON = path.join(__dirname, 'icon.png');
  const ISCALE = { small: 0.85, normal: 1, large: 1.2 };
  let IW = 440, IH = 262;
  const sizeIsland = () => { const k = ISCALE[cfg.islandSize] || 1; IW = Math.round(440 * k); IH = Math.round(262 * k); };
  const userDir = app.getPath('userData');
  const dataFile = path.join(userDir, 'kitaplik.json');
  const cfgFile = path.join(userDir, 'ayarlar.json');

  let cfg = { pos: 'center', island: true, hideTaskbar: false, x: null, y: null, updateUrl: '', closeToTray: true, autoUpdate: true, islandHover: true, discord: true, discordId: '', alwaysTop: true, hotkey: 'Control+Alt+N', islandSize: 'normal', islandVinyl: false, remote: false, remoteToken: '' };
  const VINFO = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')); } catch { return {}; } })();
  const VERSION = VINFO.version || '1.0.0';
  const updateBase = () => (cfg.updateUrl || VINFO.updateUrl || '').replace(/\/$/, '');
  // Dropbox paylaşım linkini doğrudan indirme linkine çevir (dl=1)
  const direct = u => { try { if (!/dropbox\.com/i.test(u)) return u; const x = new URL(u); x.searchParams.set('dl', '1'); return x.toString(); } catch { return u; } };
  // updateUrl ya bir klasör adresidir (…/version.json eklenir) ya da doğrudan sürüm dosyasının linkidir
  const manifestUrl = () => { const b = updateBase(); if (!b) return ''; return /\.json(\?|$)|dropbox\.com/i.test(b) ? direct(b) : b + '/version.json'; };
  // Güncelleme kaynakları: önce GitHub, ulaşılamazsa Dropbox (yedek). Her kaynak version.json döndürür.
  const srcManifest = b => { b = String(b || '').replace(/\/$/, ''); if (!b) return ''; return /\.json(\?|$)|dropbox\.com/i.test(b) ? direct(b) : b + '/version.json'; };
  const updateSources = () => [...new Set([cfg.updateUrl, ...(VINFO.updateUrls || []), VINFO.updateUrl].filter(Boolean))];
  async function fetchManifest(needPanel) {
    for (const b of updateSources()) {
      try {
        const r = await fetch(srcManifest(b), { cache: 'no-store', signal: AbortSignal.timeout(15000) }); if (!r.ok) continue;
        const j = await r.json(); if (!j || !j.version) continue;
        if (needPanel && !j.panel) continue;
        return { j, base: String(b).replace(/\/$/, '') };
      } catch {}
    }
    return null;
  }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')) }; } catch {}
  const saveCfg = () => { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg)); } catch {} };

  let BASE, island, mainWin, tray, quitting = false;
  let bumpIsland = () => {}, lastBump = 0, lastSongKey = '';

  // ---------- Ana pencere ----------
  const validBounds = b => { try { if (!b || !b.width) return false; const a = screen.getDisplayMatching(b).workArea;
    return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 20 && b.y < a.y + a.height - 100; } catch { return false; } };
  function createMain(show) {
    mainWin = new BrowserWindow({
      width: 1440, height: 900, ...(validBounds(cfg.winBounds) ? cfg.winBounds : {}), minWidth: 900, minHeight: 600, title: 'Nabız', icon: ICON,
      backgroundColor: '#08080a', autoHideMenuBar: true, show: false,
      skipTaskbar: cfg.hideTaskbar,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    mainWin.removeMenu();
    mainWin.loadURL(BASE);
    if (cfg.winMax) mainWin.once('ready-to-show', () => mainWin.maximize());
    let bT;
    const rememberBounds = () => { clearTimeout(bT); bT = setTimeout(() => {
      if (!mainWin || mainWin.isDestroyed() || mainWin.isAlwaysOnTop()) return; // mini oynatıcıdayken kaydetme
      cfg.winMax = mainWin.isMaximized();
      if (!cfg.winMax && !mainWin.isMinimized()) cfg.winBounds = mainWin.getBounds();
      saveCfg();
    }, 800); };
    mainWin.on('resize', rememberBounds); mainWin.on('move', rememberBounds);
    mainWin.on('maximize', rememberBounds); mainWin.on('unmaximize', rememberBounds);
    // Kapat = gizle. Müzik çalmaya devam eder, görev çubuğundan kalkar.
    mainWin.on('close', e => {
      if (quitting) return;
      if (!cfg.closeToTray) { quitting = true; app.exit(0); return; }
      e.preventDefault();
      mainWin.hide();
      mainWin.setSkipTaskbar(true);
    });
    // açılır pencereler (ör. YouTube girişi) normal pencerede açılsın
    mainWin.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON } }));
    if (show) mainWin.once('ready-to-show', () => mainWin.show());
  }
  function openMain() {
    if (!mainWin || mainWin.isDestroyed()) { createMain(true); return; }
    mainWin.setSkipTaskbar(cfg.hideTaskbar);
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }

  // ---------- Masaüstü adası ----------
  function placeIsland() {
    sizeIsland();
    if (cfg.pos === 'custom' && cfg.x != null) {
      // kayıtlı konum hâlâ bir ekranın içindeyse oraya koy
      const area = screen.getDisplayMatching({ x: cfg.x, y: cfg.y, width: IW, height: IH }).workArea;
      const cx = cfg.x + IW / 2;
      if (cx >= area.x && cx <= area.x + area.width && cfg.y >= area.y - 10 && cfg.y <= area.y + area.height - 50) {
        island.setBounds({ x: cfg.x, y: cfg.y, width: IW, height: IH });
        return;
      }
    }
    const d = screen.getPrimaryDisplay().workArea;
    const x = cfg.pos === 'left' ? d.x + 10 : cfg.pos === 'right' ? d.x + d.width - IW - 10 : d.x + Math.round((d.width - IW) / 2);
    island.setBounds({ x, y: d.y, width: IW, height: IH });
  }
  function loadIsland() { island.loadURL(`${BASE}/island.html?pos=${cfg.pos === 'custom' ? 'center' : cfg.pos}&hover=${cfg.islandHover ? 1 : 0}&size=${cfg.islandSize || 'normal'}&vinyl=${cfg.islandVinyl ? 1 : 0}`); }
  function createIsland() {
    island = new BrowserWindow({
      width: IW, height: IH, frame: false, transparent: true, resizable: false, movable: true,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, show: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    island.setAlwaysOnTop(true, 'screen-saver');
    island.setVisibleOnAllWorkspaces(true);
    island.setIgnoreMouseEvents(true, { forward: true });
    placeIsland();
    loadIsland();
    island.once('ready-to-show', () => { if (cfg.island) island.showInactive(); });
    screen.on('display-metrics-changed', () => setTimeout(() => { placeIsland(); }, 300));
    // Ada her şeyin üstünde kalsın: oyun ya da tam ekran uygulama öne geçse bile geri gelir (odağı çalmadan)
    // Not: sadece "en üstte" demek yetmiyor — oyun alta alınıp geri açılınca Windows oyunu öne alır ve ada
    // "en üstte" işaretli kalsa da arkada kalır. Bu yüzden işareti kaldırıp yeniden koyarak sıralamayı yeniletiyoruz.
    // Sakin bakım: sadece görünür ve "en üstte" kalmasını sağlar (1.8.1'deki gibi). Sık sıralama değişikliği
    // oyunlarda mouse takılmasına yol açtığı için sıralamayı yenileme (bump) sadece belirli anlarda, tek seferlik yapılır.
    const keepOnTop = () => {
      if (!cfg.island || island.isDestroyed() || islandAutoHidden) return;
      if (!island.isVisible() && !islandAutoHidden) { island.showInactive(); islandReset(); }
      if (cfg.alwaysTop && !island.isAlwaysOnTop()) island.setAlwaysOnTop(true, 'screen-saver', 1);
    };
    bumpIsland = () => {
      if (!cfg.island || !cfg.alwaysTop || island.isDestroyed() || islandAutoHidden) return;
      const now = Date.now(); if (now - lastBump < 3000) return; lastBump = now; // en fazla 3 sn'de bir
      island.setAlwaysOnTop(false);
      island.setAlwaysOnTop(true, 'screen-saver', 1);
      island.moveTop();
    };
    island.on('always-on-top-changed', (_e, on) => { if (!on && cfg.alwaysTop && cfg.island) setTimeout(keepOnTop, 50); });
    setInterval(keepOnTop, 2000);
    // oyun çözünürlük değiştirince, ekran eklenip çıkınca, uykudan uyanınca yeniden yerleştir
    const replace = () => setTimeout(() => { placeIsland(); keepOnTop(); bumpIsland(); }, 400);
    screen.on('display-added', replace); screen.on('display-removed', replace);
    powerMonitor.on('resume', replace); powerMonitor.on('unlock-screen', replace);
    // ada sayfası çökerse kendini yeniden yüklesin
    island.webContents.on('render-process-gone', () => setTimeout(loadIsland, 1000));
  }

  // ---------- Kitaplık yedeği ----------
  // 1) Her gün bir yerel yedek (son 7 gün) — herkes için
  // 2) Bilgisayarda Dropbox varsa Dropbox/Nabiz-Yedek/kitaplik.json — bilgisayar değişse de kitaplık kaybolmaz
  const dropboxDir = () => { const d = path.join(app.getPath('home'), 'Dropbox'); return fs.existsSync(d) ? d : null; };
  const dropboxBackup = () => { const d = dropboxDir(); return d ? path.join(d, 'Nabiz-Yedek', 'kitaplik.json') : null; };
  const localBackupDir = path.join(userDir, 'yedekler');
  let backupT = null, lastBackupAt = 0;
  function backupNow() {
    try {
      if (!fs.existsSync(dataFile)) return;
      const data = fs.readFileSync(dataFile);
      if (data.length < 10) return;
      fs.mkdirSync(localBackupDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(path.join(localBackupDir, `kitaplik-${day}.json`), data);
      const old = fs.readdirSync(localBackupDir).filter(f => /^kitaplik-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -7);
      old.forEach(f => { try { fs.unlinkSync(path.join(localBackupDir, f)); } catch {} });
      const db = dropboxBackup();
      if (db && cfg.dropboxBackup === true) { fs.mkdirSync(path.dirname(db), { recursive: true }); fs.writeFileSync(db, data); }
      lastBackupAt = Date.now();
    } catch {}
  }
  const scheduleBackup = () => { clearTimeout(backupT); backupT = setTimeout(backupNow, 15000); };
  function restoreFrom(file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || !Array.isArray(j.tracks)) throw new Error('Bu dosya bir Nabız kitaplığı değil.');
    backupNow(); // geri yüklemeden önce mevcut hali de yedekle
    fs.writeFileSync(dataFile, JSON.stringify(j));
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.reloadIgnoringCache();
    return { ok: true, tracks: j.tracks.length, playlists: (j.playlists || []).length };
  }

  // ---------- Telefondan kumanda adresleri ----------
  function remoteUrls() {
    const port = server.remotePort && server.remotePort();
    if (!cfg.remote || !port) return [];
    const nets = require('os').networkInterfaces(), out = [];
    for (const name in nets) for (const n of nets[name] || []) {
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal || /^169\.254\./.test(n.address)) continue;
      const pri = /^192\.168\./.test(n.address) ? 0 : /^10\./.test(n.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(n.address) ? 2 : 3;
      if (/vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Tailscale|ZeroTier|Radmin|Hamachi|VPN|TAP|TUN|WireGuard|Wintun|OpenVPN|Proton|Nord|Mullvad|Surfshark|Cloudflare|WARP|Npcap|Bluetooth/i.test(name)) continue;
      out.push({ pri, url: `http://${n.address}:${port}/k/${cfg.remoteToken}`, name });
    }
    return out.sort((a, b) => a.pri - b.pri).map(x => x.url);
  }

  // ---------- Adayı aç/kapat + kısayol tuşu ----------
  var islandAutoHidden = false;
  // adanın fare durumunu sıfırla: tıklanmaz (alttaki pencereye geçer) ama üstüne gelindiği algılanır
  function islandReset() {
    if (!island || island.isDestroyed()) return;
    try { island.setIgnoreMouseEvents(true, { forward: true }); island.webContents.send('island-reset'); } catch {}
  }
  function setIslandVisible(v) {
    cfg.island = !!v; saveCfg(); islandAutoHidden = false;
    if (cfg.island) { island.setOpacity(1); island.showInactive(); islandReset(); lastBump = 0; bumpIsland(); }
    else island.hide();
    if (tray) buildMenu();
  }
  let boundHotkey = '';
  function bindHotkey() {
    if (boundHotkey) { try { globalShortcut.unregister(boundHotkey); } catch {} boundHotkey = ''; }
    if (!cfg.hotkey || cfg.hotkey === 'off') return true;
    try {
      const ok = globalShortcut.register(cfg.hotkey, () => setIslandVisible(!cfg.island));
      if (ok) boundHotkey = cfg.hotkey;
      return ok;
    } catch { return false; }
  }
  const hotkeyLabel = () => (cfg.hotkey && cfg.hotkey !== 'off') ? cfg.hotkey.replace('Control', 'Ctrl').replace(/\+/g, ' + ') : '';

  // ---------- Tepsi menüsü ----------
  function buildMenu() {
    const pos = (label, v) => ({ label, type: 'radio', checked: cfg.pos === v, click: () => { cfg.pos = v; saveCfg(); placeIsland(); loadIsland(); } });
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Nabız\'ı aç', click: openMain },
      { type: 'separator' },
      { label: 'Masaüstü adası' + (hotkeyLabel() ? `   (${hotkeyLabel()})` : ''), type: 'checkbox', checked: cfg.island, click: m => setIslandVisible(m.checked) },
      { label: 'Oyunlarda ve tam ekranda da üstte kalsın', type: 'checkbox', checked: cfg.alwaysTop, click: m => { cfg.alwaysTop = m.checked; saveCfg(); if (!m.checked) island.setAlwaysOnTop(true, 'floating'); } },
      pos('Konum: Sol üst', 'left'),
      pos('Konum: Üst orta', 'center'),
      pos('Konum: Sağ üst', 'right'),
      { label: 'Konum: Serbest (adayı tutup sürükle)', type: 'radio', checked: cfg.pos === 'custom', enabled: cfg.x != null,
        click: () => { cfg.pos = 'custom'; saveCfg(); placeIsland(); loadIsland(); } },
      { type: 'separator' },
      { label: 'Açıkken de görev çubuğunda gösterme', type: 'checkbox', checked: cfg.hideTaskbar,
        click: m => { cfg.hideTaskbar = m.checked; saveCfg(); if (mainWin && mainWin.isVisible()) mainWin.setSkipTaskbar(m.checked); } },
      { label: 'Windows açılışında başlat', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        click: m => app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }) },
      { type: 'separator' },
      { label: 'Güncelleme dosyası yükle…', click: pickUpdate },
      ...(updateBase() ? [{ label: 'Güncellemeleri denetle', click: () => checkOnline(true) }] : []),
      { label: 'Sürüm ' + VERSION, enabled: false },
      { type: 'separator' },
      { label: 'Nabız\'dan çık', click: () => { quitting = true; app.exit(0); } },
    ]));
  }

  // ---------- Eski (Chrome'daki) kitaplığı bir kereliğine aktar ----------
  // ---------- Güncelleme ----------
  const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

  async function pickUpdate() {
    const r = await dialog.showOpenDialog(mainWin && mainWin.isVisible() ? mainWin : undefined, {
      title: 'Nabız güncelleme dosyasını seç', filters: [{ name: 'Nabız güncellemesi', extensions: ['zip'] }], properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    return applyUpdate(r.filePaths[0]);
  }

  async function applyUpdate(zipPath, silent = false) {
    const tmp = path.join(app.getPath('temp'), 'nabiz-guncelleme-' + Date.now());
    try {
      fs.mkdirSync(tmp, { recursive: true });
      await new Promise((res, rej) => {
        const p = spawn('tar', ['-xf', zipPath, '-C', tmp], { windowsHide: true });
        p.on('close', c => c === 0 ? res() : rej(new Error('Zip dosyası açılamadı')));
        p.on('error', rej);
      });
      let src = tmp;
      const ents = fs.readdirSync(tmp);
      if (!fs.existsSync(path.join(tmp, 'main.js')) && ents.length === 1 && fs.statSync(path.join(tmp, ents[0])).isDirectory()) src = path.join(tmp, ents[0]);
      for (const f of ['main.js', 'index.html', 'package.json', 'version.json'])
        if (!fs.existsSync(path.join(src, f))) throw new Error('Bu bir Nabız güncelleme dosyası değil');
      const nv = JSON.parse(fs.readFileSync(path.join(src, 'version.json'), 'utf8')).version;
      if (!newer(nv, installedVersion) && silent) return { ok: false };
      if (!newer(nv, VERSION) && !silent) {
        const r = await dialog.showMessageBox({ type: 'question', buttons: ['Yine de yükle', 'Vazgeç'], defaultId: 1, title: 'Nabız',
          message: `Bu dosya (${nv}) yüklü sürümden (${VERSION}) yeni değil.` });
        if (r.response !== 0) return { ok: false };
      }
      fs.cpSync(src, __dirname, { recursive: true, force: true });
      installedVersion = nv;
      if (silent) { pendingRestart = true; maybeRestart(); return { ok: true, version: nv }; }
      await dialog.showMessageBox({ type: 'info', buttons: ['Yeniden başlat'], title: 'Nabız', message: `Nabız ${nv} sürümüne güncellendi.`, detail: 'Uygulama şimdi yeniden başlayacak.' });
      relaunch();
      return { ok: true, version: nv };
    } catch (e) {
      if (!silent) dialog.showErrorBox('Nabız güncellemesi', e.message);
      return { ok: false, error: e.message };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  function relaunch(hidden = false) {
    const args = process.argv.slice(1).filter(a => a !== '--hidden');
    if (hidden) args.push('--hidden');
    app.relaunch({ args });
    quitting = true;
    app.exit(0);
  }

  // ---------- Sessiz otomatik güncelleme ----------
  // Yeni sürüm arka planda indirilip kurulur; hiçbir şey sorulmaz.
  // Nabız, müzik çalmıyorken kendini fark ettirmeden yeniden başlatır (ya da bir sonraki açılışta yeni sürümle gelir).
  let installedVersion = VERSION, pendingRestart = false, nowPlaying = false, lastPlayAt = 0, silentBusy = false;
  const startedAt = Date.now();
  // Güncelleme gelir gelmez uygula: çalan şarkıyı, saniyesini, sırayı ve görünümü kaydet, yeniden başla, kaldığı yerden devam et.
  const resumeFile = path.join(userDir, 'devam.json');
  let restarting = false;
  async function maybeRestart() {
    if (!pendingRestart || restarting) return;
    restarting = true;
    const visible = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
    try {
      if (mainWin && !mainWin.isDestroyed()) {
        const snap = await Promise.race([
          mainWin.webContents.executeJavaScript('window.__nabizSnapshot ? window.__nabizSnapshot() : null', true),
          new Promise(r => setTimeout(() => r(null), 3000)),
        ]);
        if (snap) fs.writeFileSync(resumeFile, snap);
      }
    } catch {}
    relaunch(!visible);
  }
  async function silentUpdate() {
    if (silentBusy || !cfg.autoUpdate || !updateBase()) return;
    silentBusy = true;
    try {
      const m = await fetchManifest(); if (!m) return; const j = m.j;
      if (!newer(j.version, installedVersion)) return;
      let zr = await fetch(j.zip ? direct(j.zip) : m.base + '/nabiz-guncelleme.zip', { cache: 'no-store' }).catch(() => null);
      if ((!zr || !zr.ok) && j.zipAlt) zr = await fetch(direct(j.zipAlt), { cache: 'no-store' }).catch(() => null);
      if (!zr) return;
      if (!zr.ok) return;
      const f = path.join(app.getPath('temp'), 'nabiz-guncelleme.zip');
      fs.writeFileSync(f, Buffer.from(await zr.arrayBuffer()));
      await applyUpdate(f, true);
    } catch {} finally { silentBusy = false; }
  }

  // İsteğe bağlı: çevrimiçi güncelleme adresi (ayarlar.json → updateUrl). version.json ve nabiz-guncelleme.zip bekler.
  async function checkOnline(manual) {
    if (!updateBase()) { if (manual) dialog.showMessageBox({ type: 'info', title: 'Nabız', message: 'Çevrimiçi güncelleme adresi ayarlı değil.' }); return { ok: false }; }
    try {
      const m = await fetchManifest(); if (!m) throw new Error('Güncelleme sunucusuna ulaşılamadı');
      const j = m.j, base = m.base;
      if (!newer(j.version, installedVersion)) { if (manual) dialog.showMessageBox({ type: 'info', title: 'Nabız', message: installedVersion !== VERSION ? `Nabız ${installedVersion} sürümü yüklendi; müzik durunca kendiliğinden devreye girecek.` : `En güncel sürümü kullanıyorsun (${VERSION}).` }); return { ok: false }; }
      const r = await dialog.showMessageBox({ type: 'question', buttons: ['Şimdi güncelle', 'Sonra'], defaultId: 0, title: 'Nabız', message: `Yeni sürüm var: ${j.version}`, detail: j.notes || '' });
      if (r.response !== 0) return { ok: false };
      let zr = await fetch(j.zip ? direct(j.zip) : base + '/nabiz-guncelleme.zip', { cache: 'no-store' }).catch(() => null);
      if ((!zr || !zr.ok) && j.zipAlt) zr = await fetch(direct(j.zipAlt), { cache: 'no-store' }).catch(() => null);
      if (!zr) throw new Error('Güncelleme dosyası indirilemedi');
      if (!zr.ok) throw new Error('Güncelleme dosyası indirilemedi (HTTP ' + zr.status + ')');
      const buf = Buffer.from(await zr.arrayBuffer());
      const f = path.join(app.getPath('temp'), 'nabiz-guncelleme.zip');
      fs.writeFileSync(f, buf);
      return applyUpdate(f);
    } catch (e) { if (manual) dialog.showErrorBox('Nabız', 'Güncelleme denetlenemedi: ' + e.message); return { ok: false }; }
  }

  app.on('second-instance', () => openMain());
  app.on('window-all-closed', () => { /* tepside çalışmaya devam et */ });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });

  app.whenReady().then(async () => {
    try {
      server.setDataFile(dataFile);
      const port = await server.start(5173);
      BASE = `http://localhost:${port}`;
    } catch (e) {
      dialog.showErrorBox('Nabız', 'Başlatılamadı: ' + e.message);
      app.exit(1);
      return;
    }
    server.onOpen(openMain);
    server.onSaved(scheduleBackup);
    setTimeout(backupNow, 20000);
    // Mini oynatıcı: ana pencereyi küçük, her zaman üstte bir oynatıcıya çevir
    let normalBounds = null;
    ipcMain.handle('mini', (_e, on) => {
      if (!mainWin || mainWin.isDestroyed()) return false;
      if (on) {
        normalBounds = mainWin.getBounds();
        const d = screen.getDisplayMatching(normalBounds).workArea;
        mainWin.setMinimumSize(380, 150);
        mainWin.setBounds({ x: d.x + d.width - 470, y: d.y + d.height - 200, width: 450, height: 170 });
        mainWin.setAlwaysOnTop(true, 'floating');
      } else {
        mainWin.setAlwaysOnTop(false);
        mainWin.setMinimumSize(900, 600);
        if (normalBounds) mainWin.setBounds(normalBounds);
      }
      return true;
    });
    ipcMain.handle('backup-info', () => ({ dropbox: !!dropboxDir(), dropboxOn: cfg.dropboxBackup === true, last: lastBackupAt, localDir: localBackupDir }));
    ipcMain.handle('backup-toggle', (_e, on) => { cfg.dropboxBackup = !!on; saveCfg(); if (on) backupNow(); return true; });
    ipcMain.handle('export-library', async () => {
      const r = await dialog.showSaveDialog(mainWin, { title: 'Kitaplığı dışa aktar', defaultPath: path.join(app.getPath('documents'), `nabiz-kitaplik-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'Nabız kitaplığı', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      fs.copyFileSync(dataFile, r.filePath);
      return { ok: true, path: r.filePath };
    });
    ipcMain.handle('restore-library', async (_e, fromDropbox) => {
      let file = fromDropbox ? dropboxBackup() : null;
      if (!file || !fs.existsSync(file)) {
        const r = await dialog.showOpenDialog(mainWin, { title: 'Geri yüklenecek kitaplığı seç', defaultPath: fs.existsSync(localBackupDir) ? localBackupDir : app.getPath('documents'), filters: [{ name: 'Nabız kitaplığı', extensions: ['json'] }], properties: ['openFile'] });
        if (r.canceled || !r.filePaths[0]) return { ok: false };
        file = r.filePaths[0];
      }
      const c = await dialog.showMessageBox(mainWin, { type: 'question', buttons: ['Geri yükle', 'Vazgeç'], defaultId: 0, cancelId: 1, title: 'Nabız', message: 'Kitaplık bu yedekle değiştirilsin mi?', detail: 'Şu anki kitaplığın önce otomatik olarak yedeklenir.' });
      if (c.response !== 0) return { ok: false };
      try { return restoreFrom(file); } catch (e) { dialog.showErrorBox('Nabız', e.message); return { ok: false }; }
    });
    server.onState(st => {
      presence.update(st && st.priv ? { ...st, has: false } : st);
      const songKey = st && st.has ? (st.title || '') + '|' + (st.artist || '') : '';
      if (songKey && songKey !== lastSongKey) { lastSongKey = songKey; bumpIsland(); }
      const p = !!(st && st.has && st.playing);
      if (p) lastPlayAt = Date.now();
      if (p !== nowPlaying) { nowPlaying = p; if (!p) maybeRestart(); }
    });
    presence.configure(cfg.discord, discordId());
    bindHotkey();
    ipcMain.on('clickable', (_e, v) => { if (dragT || islandAutoHidden) return; if (v) island.setIgnoreMouseEvents(false); else island.setIgnoreMouseEvents(true, { forward: true }); });
    // ada sürükleme: imleci takip et
    let dragT = null, off = null;
    ipcMain.on('drag-start', () => {
      const c = screen.getCursorScreenPoint(), [x, y] = island.getPosition();
      off = { x: c.x - x, y: c.y - y };
      island.setIgnoreMouseEvents(false);
      clearInterval(dragT);
      const t0 = Date.now();
      dragT = setInterval(() => {
        const p = screen.getCursorScreenPoint();
        island.setBounds({ x: Math.round(p.x - off.x), y: Math.round(p.y - off.y), width: IW, height: IH });   // setBounds: ölçekli ekranlarda boyut kaymasın
        if (Date.now() - t0 > 60000) endIslandDrag();   // güvenlik: bırakma kaçarsa
      }, 8);
    });
    function endIslandDrag() {
      if (!dragT) return;
      clearInterval(dragT); dragT = null;
      let [x, y] = island.getPosition();
      // üst kenara yakın bırakılırsa kenara yapıştır, ekran dışına taşmasın
      const a = screen.getDisplayNearestPoint({ x: x + IW / 2, y }).workArea;
      if (y < a.y + 24) y = a.y;
      x = Math.max(a.x - 20, Math.min(x, a.x + a.width - IW + 20));
      y = Math.max(a.y, Math.min(y, a.y + a.height - 60));
      island.setBounds({ x, y, width: IW, height: IH });
      cfg.pos = 'custom'; cfg.x = x; cfg.y = y; saveCfg(); buildMenu();
    }
    ipcMain.on('drag-end', endIslandDrag);

    // güncelleme
    ipcMain.handle('version', () => VERSION);
    ipcMain.handle('remote', async (_e, on, renew) => {
      cfg.remote = !!on;
      if (renew || !cfg.remoteToken) cfg.remoteToken = require('crypto').randomBytes(12).toString('hex');
      saveCfg();
      if (cfg.remote) { const p = await server.startRemote(cfg.remoteToken); if (!p) { cfg.remote = false; saveCfg(); return { ok: false, error: 'Kumanda başlatılamadı (port kullanımda).' }; } }
      else server.stopRemote();
      return { ok: true, urls: remoteUrls() };
    });
    if (cfg.remote && cfg.remoteToken) server.startRemote(cfg.remoteToken);
    // şarkı değişince Windows bildirimi (kapakla birlikte)
    try {
      if (process.platform === 'win32') {
        const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Nabız.lnk');
        // güvenlik ağı: kurulum kısayolları oluşturamadıysa ilk açılışta Nabız kendisi oluşturur (bir kez)
        if (!cfg.lnkChecked && /\\Nabiz\\/i.test(process.execPath)) {
          cfg.lnkChecked = true; saveCfg();
          const ico = path.join(__dirname, 'icon.ico');
          const opt = { target: process.execPath, cwd: path.dirname(process.execPath), description: 'Nabız Müzik', appUserModelId: AUMID, ...(fs.existsSync(ico) ? { icon: ico, iconIndex: 0 } : {}) };
          if (!fs.existsSync(lnk)) {   // Başlat menüsü kısayolu yoksa kurulum kısayol yapamamış demektir: ikisini de oluştur
            try { shell.writeShortcutLink(lnk, 'create', opt); } catch {}
            const dl = path.join(app.getPath('desktop'), 'Nabız.lnk');
            if (!fs.existsSync(dl)) try { shell.writeShortcutLink(dl, 'create', opt); } catch {}
          }
        }
        if (fs.existsSync(lnk)) { let cur = {}; try { cur = shell.readShortcutLink(lnk); } catch {} if (cur.appUserModelId !== AUMID) shell.writeShortcutLink(lnk, 'update', { appUserModelId: AUMID }); }
      }
    } catch {}
    let lastNote = null;
    ipcMain.handle('notify', async (_e, n) => {
      try {
        if (!Notification.isSupported()) return false;
        let icon;
        if (n.thumb) { try { const r = await fetch(String(n.thumb).replace('/hqdefault.', '/mqdefault.')); if (r.ok) icon = nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer())); } catch {} }
        if (lastNote) { try { lastNote.close(); } catch {} }
        lastNote = new Notification({ title: String(n.title || 'Nabız').slice(0, 120), body: String(n.body || '').slice(0, 200), icon: icon && !icon.isEmpty() ? icon : path.join(__dirname, 'icon.png'), silent: true });
        lastNote.on('click', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
        lastNote.show();
        return true;
      } catch { return false; }
    });
    // ---------- Aktiflik sinyali + Sorun bildir (isimsiz; dinlenen şarkılar gönderilmez) ----------
    if (!cfg.installId) { cfg.installId = require('crypto').randomBytes(6).toString('hex'); saveCfg(); }
    const os = require('os');
    const osName = () => { try { const r = os.release().split('.'); return (+r[2] >= 22000 ? 'Windows 11' : 'Windows 10') + ' (' + os.release() + ')'; } catch { return process.platform; } };
    async function panelUrl() {
      try { const m = await fetchManifest(true); const j = m && m.j; if (j && typeof j.panel === 'string' && /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(j.panel)) { if (cfg.panelUrl !== j.panel) { cfg.panelUrl = j.panel; saveCfg(); } } } catch {}
      return cfg.panelUrl || '';
    }
    const postHook = async (body) => { const u = await panelUrl(); if (!u) return false;
      const r = await fetch(u + (u.includes('?') ? '&' : '?') + 'wait=false', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Nabız', allowed_mentions: { parse: [] }, ...body }) });
      return r.ok; };
    async function heartbeat() {
      if (cfg.telemetry === false) return;
      const day = new Date().toISOString().slice(0, 10);
      if (cfg.lastBeat === day + '|' + VERSION) return;
      try { if (await postHook({ content: `🟢 \`nbz:hb|${cfg.installId}|${VERSION}|${osName()}\``, flags: 4096 })) { cfg.lastBeat = day + '|' + VERSION; saveCfg(); } } catch {}
    }
    ipcMain.handle('report', async (_e, r) => {
      try {
        const text = String(r && r.text || '').slice(0, 1800).trim(); if (!text) return { ok: false, error: 'Boş' };
        const fields = [{ name: 'Kullanıcı', value: '#' + cfg.installId.slice(0, 4).toUpperCase(), inline: true }, { name: 'Sürüm', value: VERSION, inline: true }, { name: 'Sistem', value: osName(), inline: true }];
        if (r.name) fields.unshift({ name: 'İsim', value: String(r.name).slice(0, 40), inline: true });
        if (r.tech && r.log) fields.push({ name: 'Son hata kayıtları', value: '```' + String(r.log).slice(-950) + '```' });
        const ok = await postHook({ content: `🛠️ **Sorun bildirimi** \`nbz:rp|${cfg.installId}|${VERSION}\``, embeds: [{ title: 'Sorun bildirimi', description: text, color: 0xff3b5c, fields, timestamp: new Date().toISOString() }] });
        return ok ? { ok: true } : { ok: false, error: 'Bildirim adresi henüz ayarlanmamış ya da ulaşılamadı.' };
      } catch (e) { return { ok: false, error: e.message }; }
    });
    // Geri bildirim: yıldız (1-5) + isteğe bağlı yorum → geliştiricinin paneli
    ipcMain.handle('feedback', async (_e, f) => {
      try {
        const stars = Math.max(1, Math.min(5, Math.round(+(f && f.stars) || 0))); if (!stars) return { ok: false, error: 'Yıldız seç' };
        const text = String(f && f.text || '').slice(0, 1500).trim();
        const fields = [{ name: 'Kullanıcı', value: '#' + cfg.installId.slice(0, 4).toUpperCase(), inline: true }, { name: 'Sürüm', value: VERSION, inline: true }];
        if (f.name) fields.unshift({ name: 'İsim', value: String(f.name).slice(0, 40), inline: true });
        const st = '★'.repeat(stars) + '☆'.repeat(5 - stars);
        const ok = await postHook({ content: `⭐ **Geri bildirim** ${st} \`nbz:fb|${cfg.installId}|${VERSION}|${stars}\``, embeds: [{ title: `Geri bildirim · ${st}`, description: text || '_(yorum yazılmadı)_', color: 0xffc94d, fields, timestamp: new Date().toISOString() }] });
        return ok ? { ok: true } : { ok: false, error: 'Gönderilemedi, internet bağlantını kontrol et.' };
      } catch (e) { return { ok: false, error: e.message }; }
    });
    ipcMain.handle('telemetry', (_e, on) => { if (typeof on === 'boolean') { cfg.telemetry = on; saveCfg(); if (on) heartbeat(); } return cfg.telemetry !== false; });

    // ---------- Yönetici paneli: sadece Nabız'ı yayınlayan bilgisayarda (Dropbox/Nabiz/version.json orada) ----------
    const isAdmin = () => { try { return !!cfg.admin || fs.existsSync(path.join(app.getPath('home'), 'Dropbox', 'Nabiz', 'version.json')); } catch { return false; } };
    ipcMain.handle('admin-info', () => isAdmin() ? { admin: true, ready: !!(cfg.adminToken && cfg.adminChannel), channel: cfg.adminChannel || '', me: cfg.installId, hook: !!cfg.panelUrl } : { admin: false });
    ipcMain.handle('admin-config', (_e, c) => { if (!isAdmin()) return false; if (c.token) cfg.adminToken = String(c.token).trim().replace(/^Bot\s+/i, ''); cfg.adminChannel = String(c.channel || '').trim(); saveCfg(); return true; });
    ipcMain.handle('admin-data', async (_e, days = 30) => {
      if (!isAdmin() || !cfg.adminToken || !cfg.adminChannel) return { error: 'Panel ayarlanmamış' };
      const H = { headers: { Authorization: 'Bot ' + cfg.adminToken, 'User-Agent': 'DiscordBot (nabiz, 1)' } };
      const since = Date.now() - days * 864e5; let before = '', all = [];
      try {
        for (let i = 0; i < 15; i++) {
          const r = await fetch(`https://discord.com/api/v10/channels/${cfg.adminChannel}/messages?limit=100${before ? '&before=' + before : ''}`, H);
          if (r.status === 401) return { error: 'Bot anahtarı geçersiz.' };
          if (r.status === 403) return { error: 'Bot bu kanalı göremiyor. Botu sunucuna ekleyip kanala erişim izni ver.' };
          if (r.status === 404) return { error: 'Kanal bulunamadı. Kanal ID\'sini kontrol et.' };
          if (!r.ok) return { error: 'Discord hatası (HTTP ' + r.status + ')' };
          const L = await r.json(); if (!L.length) break;
          all = all.concat(L); before = L[L.length - 1].id;
          if (new Date(L[L.length - 1].timestamp).getTime() < since) break;
        }
      } catch (e) { return { error: 'Discord\'a ulaşılamadı: ' + e.message }; }
      const beats = [], reports = [], feedbacks = []; let noContent = 0;
      for (const m of all) {
        const at = new Date(m.timestamp).getTime(); if (at < since) continue;
        if (!m.content && !(m.embeds && m.embeds.length)) { noContent++; continue; }
        let x = (m.content || '').match(/nbz:hb\|([0-9a-f]+)\|([\d.]+)\|([^`]*)/);
        if (x) { beats.push({ id: x[1], ver: x[2], os: x[3], at }); continue; }
        x = (m.content || '').match(/nbz:fb\|([0-9a-f]+)\|([\d.]+)\|([1-5])/);
        if (x) { const e = (m.embeds || [])[0] || {}; const nm = ((e.fields || []).find(z => z.name === 'İsim') || {}).value || '';
          feedbacks.push({ id: x[1], ver: x[2], stars: +x[3], at, text: /^_\(yorum yazılmadı\)_$/.test(e.description || '') ? '' : (e.description || ''), name: nm, mid: m.id, url: `https://discord.com/channels/${m.guild_id || '@me'}/${m.channel_id}/${m.id}` }); continue; }
        x = (m.content || '').match(/nbz:rp\|([0-9a-f]+)\|([\d.]+)/);
        if (x) { const e = (m.embeds || [])[0] || {}; const f = n => ((e.fields || []).find(z => z.name === n) || {}).value || '';
          reports.push({ id: x[1], ver: x[2], at, text: e.description || '', name: f('İsim'), os: f('Sistem'), log: f('Son hata kayıtları').replace(/```/g, ''), mid: m.id, url: `https://discord.com/channels/${m.guild_id || '@me'}/${m.channel_id}/${m.id}` }); }
      }
      return { beats, reports, feedbacks, me: cfg.installId, noContent, total: all.length };
    });
    // Bildirimi sil: webhook kendi gönderdiği mesajı silebilir (bota ek izin gerekmez)
    ipcMain.handle('admin-delete', async (_e, mid) => {
      if (!isAdmin() || !/^\d{15,22}$/.test(String(mid))) return { ok: false, error: 'Geçersiz' };
      const u = await panelUrl(); if (!u) return { ok: false, error: 'Webhook adresi yok' };
      try {
        const r = await fetch(u.split('?')[0] + '/messages/' + mid, { method: 'DELETE' });
        if (r.ok || r.status === 204 || r.status === 404) return { ok: true };
        return { ok: false, error: 'Discord HTTP ' + r.status };
      } catch (e) { return { ok: false, error: e.message }; }
    });
    ipcMain.handle('open-url', (_e, u) => { if (/^https:\/\/(discord\.com|discord\.gg)\//.test(String(u))) shell.openExternal(u); });

    // ---------- Söz kartını paylaş: telefona QR ile (geçici, sadece bu kart) ----------
    const shares = new Map(); let shareSrv = null, sharePort = 0, shareTimer = null;
    // Telefonun ulaşacağı adres: önce internete çıkan ağ kartı (Wi-Fi/Ethernet), VPN ve sanal kartlar hariç
    const BAD_NIC = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Tailscale|ZeroTier|Radmin|Hamachi|VPN|TAP|TUN|WireGuard|Wintun|OpenVPN|Proton|Nord|Mullvad|Surfshark|Windscribe|Cloudflare|WARP|Npcap|Bluetooth|Kaspersky|Fortinet|Cisco|Pulse|Hotspot Shield|Radmin/i;
    function routeIp() { return new Promise(res => { try { const s = require('dgram').createSocket('udp4'); s.on('error', () => { try { s.close(); } catch {} res(''); }); s.connect(53, '8.8.8.8', () => { let a = ''; try { a = s.address().address; } catch {} try { s.close(); } catch {} res(a); }); setTimeout(() => res(''), 1500); } catch { res(''); } }); }
    const lanIps = async () => { const nets = require('os').networkInterfaces(), out = [], rip = await routeIp();
      for (const name in nets) for (const n of nets[name] || []) {
        if (n.family !== 'IPv4' && n.family !== 4) continue; if (n.internal || /^169\.254\./.test(n.address)) continue;
        if (BAD_NIC.test(name)) continue;
        const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address);
        out.push({ pri: n.address === rip ? -1 : !priv ? 9 : /^192\.168\./.test(n.address) ? 0 : 1, ip: n.address, wifi: /wi-?fi|wlan|kablosuz/i.test(name) }); }
      return out.sort((a, b) => a.pri - b.pri || b.wifi - a.wifi).map(x => x.ip); };
    const sharePage = (id, title) => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nabız · Söz kartı</title>
<style>body{margin:0;background:#0b0a10;color:#fff;font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:18px 16px 40px}img{width:100%;max-width:420px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6);-webkit-touch-callout:default}
h1{font-size:19px;margin:6px 0 14px}.b{display:block;max-width:420px;margin:12px auto 0;padding:15px;border-radius:14px;font-weight:700;font-size:16px;text-decoration:none;border:0;color:#fff;background:linear-gradient(100deg,#ff2e63,#c2189b,#5b2cff)}.g{background:#25d366}.s{background:rgba(255,255,255,.1)}
p{color:rgba(255,255,255,.7);font-size:14px;line-height:1.5;max-width:420px;margin:14px auto 0}b{color:#fff}</style></head><body>
<h1>🎵 ${String(title || 'Söz kartı').replace(/[<>&"]/g, '')}</h1><img id="im" src="/s/${id}/kart.png" alt="Söz kartı">
<button class="b" id="sh" hidden>Paylaş (Instagram, WhatsApp…)</button>
<a class="b s" href="/s/${id}/kart.png" download="nabiz-soz-karti.png">Görseli telefona kaydet</a>
<p id="tip"><b>Instagram hikâyesi ya da WhatsApp:</b> görsele <b>basılı tut</b> → <b>Paylaş</b> → Instagram / WhatsApp'ı seç.<br>Ya da kaydet, sonra Instagram'da hikâye ekle → galeriden seç.</p>
<script>(async()=>{try{const r=await fetch('/s/${id}/kart.png');const b=await r.blob();const f=new File([b],'nabiz-soz-karti.png',{type:'image/png'});if(navigator.canShare&&navigator.canShare({files:[f]})){const s=document.getElementById('sh');s.hidden=false;s.onclick=()=>navigator.share({files:[f]}).catch(()=>{})}}catch(e){}})()</script></body></html>`;
    function ensureShareSrv() {
      if (shareSrv) return Promise.resolve(sharePort);
      return new Promise(resolve => {
        const srv = require('http').createServer((req, res) => {
          const m = String(req.url).match(/^\/s\/([a-f0-9]{24})(\/kart\.png)?\/?$/); const it = m && shares.get(m[1]);
          if (!it || it.exp < Date.now()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Bu paylaşım bağlantısının süresi doldu. Nabız\'da yeniden oluştur.'); }
          if (m[2]) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="nabiz-soz-karti.png"' }); return res.end(it.png); }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(sharePage(m[1], it.title));
        });
        let tries = 0; const at = p => { srv.once('error', e => { if (e.code === 'EADDRINUSE' && ++tries < 10) at(p + 1); else resolve(0); }); srv.listen(p, '0.0.0.0', () => { shareSrv = srv; sharePort = p; resolve(p); }); };
        at(5180);
      });
    }
    function sweepShares() { const now = Date.now(); for (const [k, v] of shares) if (v.exp < now) shares.delete(k);
      if (!shares.size && shareSrv) { try { shareSrv.close(); } catch {} shareSrv = null; sharePort = 0; clearInterval(shareTimer); shareTimer = null; } }
    ipcMain.handle('share-card', async (_e, dataUrl, title) => {
      const png = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'); if (!png.length || png.length > 8e6) return { ok: false, error: 'Görsel hazırlanamadı' };
      const port = await ensureShareSrv(); if (!port) return { ok: false, error: 'Paylaşım başlatılamadı (port kullanımda)' };
      const id = require('crypto').randomBytes(12).toString('hex'); shares.set(id, { png, title: String(title || '').slice(0, 80), exp: Date.now() + 15 * 60e3 });
      if (!shareTimer) shareTimer = setInterval(sweepShares, 60e3);
      const ips = await lanIps(); if (!ips.length) return { ok: false, error: 'Bilgisayar bir ağa bağlı görünmüyor' };
      return { ok: true, urls: ips.map(ip => `http://${ip}:${port}/s/${id}`) };
    });
    // İnternet üzerinden geçici paylaşım (Wi-Fi/güvenlik duvarından bağımsız): kart 1 saatlik linke yüklenir
    ipcMain.handle('share-card-web', async (_e, dataUrl) => {
      const png = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'); if (!png.length || png.length > 8e6) return { ok: false, error: 'Görsel hazırlanamadı' };
      const blob = () => new Blob([png], { type: 'image/png' });
      const tries = [
        async () => { const f = new FormData(); f.append('files[]', blob(), 'nabiz-soz-karti.png');
          const r = await fetch('https://uguu.se/upload', { method: 'POST', body: f, signal: AbortSignal.timeout(20000) });
          const j = await r.json(); const u = j && j.success && j.files && j.files[0] && j.files[0].url; if (u && /^https:\/\//.test(u)) return u; throw new Error('uguu ' + r.status); },
      ];
      let last = '';
      for (const t of tries) { try { return { ok: true, url: await t() }; } catch (e) { last = e.message; } }
      return { ok: false, error: 'İnternete yüklenemedi (' + last + ')' };
    });
    // Bilgisayarda: WhatsApp masaüstü / Instagram web aç
    ipcMain.handle('share-open', async (_e, target) => {
      if (target === 'whatsapp') {
        let has = false; try { has = !!app.getApplicationNameForProtocol('whatsapp://'); } catch {}
        if (has) { try { await shell.openExternal('whatsapp://'); return { ok: true, app: true }; } catch {} }
        shell.openExternal('https://web.whatsapp.com/'); return { ok: true, app: false };
      }
      if (target === 'instagram') { shell.openExternal('https://www.instagram.com/'); return { ok: true }; }
      return { ok: false };
    });
    ipcMain.handle('save-image', async (_e, dataUrl, name) => {
      const r = await dialog.showSaveDialog(mainWin, { title: 'Özet kartını kaydet', defaultPath: path.join(app.getPath('pictures'), name || 'nabiz-ozet.png'), filters: [{ name: 'PNG resmi', extensions: ['png'] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      fs.writeFileSync(r.filePath, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
      return { ok: true, path: r.filePath };
    });
    ipcMain.on('island-menu', () => {
      const sz = (label, v) => ({ label, type: 'radio', checked: (cfg.islandSize || 'normal') === v, click: () => { cfg.islandSize = v; saveCfg(); placeIsland(); loadIsland(); } });
      const ps = (label, v) => ({ label, type: 'radio', checked: cfg.pos === v, click: () => { cfg.pos = v; saveCfg(); placeIsland(); loadIsland(); buildMenu(); } });
      Menu.buildFromTemplate([
        { label: nowPlaying ? 'Duraklat' : 'Oynat', click: () => server.sendCmd('toggle') },
        { label: 'Sonraki şarkı', click: () => server.sendCmd('next') },
        { label: 'Önceki şarkı', click: () => server.sendCmd('prev') },
        { type: 'separator' },
        { label: "Nabız'ı aç", click: openMain },
        { label: 'Boyut', submenu: [sz('Küçük', 'small'), sz('Normal', 'normal'), sz('Büyük', 'large')] },
        { label: 'Konum', submenu: [ps('Sol üst', 'left'), ps('Üst orta', 'center'), ps('Sağ üst', 'right')] },
        { label: 'Plak animasyonu', type: 'checkbox', checked: !!cfg.islandVinyl, click: m => { cfg.islandVinyl = m.checked; saveCfg(); loadIsland(); } },
        { type: 'separator' },
        { label: 'Adayı gizle' + (hotkeyLabel() ? `   (${hotkeyLabel()})` : ''), click: () => setIslandVisible(false) },
      ]).popup({ window: island });
    });
    ipcMain.handle('get-resume', () => {
      try { const j = JSON.parse(fs.readFileSync(resumeFile, 'utf8')); fs.unlinkSync(resumeFile); return j; } catch { return null; }
    });
    ipcMain.handle('pick-update', () => pickUpdate());
    ipcMain.handle('install-update', (_e, p) => applyUpdate(p));
    ipcMain.handle('check-online', () => checkOnline(true));

    // uygulama içi ayarlar paneli
    ipcMain.handle('get-desk', () => ({
      island: cfg.island, islandHideFocus: cfg.islandHideFocus !== false, pos: cfg.pos, hasCustom: cfg.x != null, islandHover: cfg.islandHover,
      closeToTray: cfg.closeToTray, hideTaskbar: cfg.hideTaskbar, autoUpdate: cfg.autoUpdate,
      openAtLogin: app.getLoginItemSettings().openAtLogin, version: VERSION,
      discord: cfg.discord, discordId: cfg.discordId, remote: !!cfg.remote, remoteUrls: remoteUrls(), alwaysTop: cfg.alwaysTop, hotkey: cfg.hotkey, islandSize: cfg.islandSize || 'normal', islandVinyl: !!cfg.islandVinyl,
    }));
    ipcMain.handle('set-desk', (_e, key, val) => {
      if (key === 'openAtLogin') app.setLoginItemSettings({ openAtLogin: !!val, args: ['--hidden'] });
      else if (['island', 'islandHover', 'closeToTray', 'hideTaskbar', 'autoUpdate', 'pos', 'discord', 'discordId', 'alwaysTop', 'hotkey', 'islandSize', 'islandVinyl', 'islandHideFocus'].includes(key)) cfg[key] = val;
      saveCfg();
      if (key === 'island') setIslandVisible(val);
      if (key === 'alwaysTop' && !val) island.setAlwaysOnTop(true, 'floating');
      if (key === 'hotkey') { const ok = bindHotkey(); saveCfg(); buildMenu(); return ok; }
      if (key === 'pos') { placeIsland(); loadIsland(); }
      if (key === 'islandHover' || key === 'islandVinyl') loadIsland();
      if (key === 'islandSize') { placeIsland(); loadIsland(); }
      if (key === 'discord' || key === 'discordId') presence.configure(cfg.discord, discordId());
      if (key === 'hideTaskbar' && mainWin && mainWin.isVisible()) mainWin.setSkipTaskbar(!!val);
      buildMenu();
      return true;
    });

    const trayPng = path.join(__dirname, 'tray.png');
    tray = new Tray(nativeImage.createFromPath(fs.existsSync(trayPng) ? trayPng : ICON).resize({ width: 16, height: 16, quality: 'best' }));
    tray.setToolTip('Nabız');
    tray.on('click', openMain);
    buildMenu();

    try {
      const db = dropboxBackup();
      if (cfg.dropboxBackup === true && db && fs.existsSync(db) && !fs.existsSync(dataFile)) fs.copyFileSync(db, dataFile); // yeni bilgisayar: kitaplığı kendi Dropbox'undan getir
    } catch {}
    createIsland();
    createMain(!process.argv.includes('--hidden'));
    // Nabız penceresi öndeyken ada gizlenir (alttaki çubuk aynı bilgiyi gösteriyor); başka bir şeye geçince geri gelir
    const syncIslandFocus = () => {
      if (!island || island.isDestroyed() || !cfg.island) return;
      const fw = BrowserWindow.getFocusedWindow();
      const front = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized() && (fw === mainWin || mainWin.isFocused()) && !mainWin.isAlwaysOnTop();
      // gizle/göster yerine görünmez yap: Windows'ta hide/show sonrası ada tıklanamaz hale gelebiliyordu
      if (front && cfg.islandHideFocus !== false) { if (!islandAutoHidden) { islandAutoHidden = true; island.setOpacity(0); island.setIgnoreMouseEvents(true); } }
      else if (islandAutoHidden) { islandAutoHidden = false; islandReset(); island.setOpacity(1); lastBump = 0; bumpIsland(); }
      else if (front) { /* ayar kapalı */ }
    };
    if (mainWin) for (const ev of ['focus', 'blur', 'hide', 'minimize', 'restore', 'show', 'resize']) mainWin.on(ev, () => setTimeout(syncIslandFocus, 60));
    ipcMain.on('island-focus-sync', () => syncIslandFocus());
    setInterval(syncIslandFocus, 700);   // olay kaçarsa diye: odak durumunu düzenli kontrol et

    setTimeout(silentUpdate, 5000);
    setInterval(silentUpdate, 10 * 60 * 1000);   // 10 dakikada bir sessizce kontrol et
    setTimeout(heartbeat, 45 * 1000); setInterval(heartbeat, 3 * 60 * 60 * 1000);
    setInterval(maybeRestart, 60 * 1000);
  });
}
