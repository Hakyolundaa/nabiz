// Discord "Dinliyor" durumu — Discord masaüstü uygulamasıyla yerel IPC üzerinden konuşur (paket gerektirmez).
const net = require('net');
const crypto = require('crypto');

function frame(op, obj) {
  const d = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(8);
  h.writeInt32LE(op, 0);
  h.writeInt32LE(d.length, 4);
  return Buffer.concat([h, d]);
}

class DiscordPresence {
  constructor() {
    this.clientId = '';
    this.enabled = false;
    this.sock = null;
    this.ready = false;
    this.retryT = null;
    this.pending = undefined; // gönderilmeyi bekleyen son durum
    this.lastSent = 0;
    this.sendT = null;
    this.lastKey = '';
  }

  configure(enabled, clientId) {
    const changed = clientId !== this.clientId;
    this.enabled = !!enabled && !!clientId;
    this.clientId = clientId || '';
    if (!this.enabled || changed) this.disconnect();
    if (this.enabled) this.connect();
  }

  connect(i = 0) {
    if (!this.enabled || this.sock) return;
    if (i > 9) { this.scheduleRetry(); return; }
    const path = process.platform === 'win32' ? `\\\\?\\pipe\\discord-ipc-${i}` : `${process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp'}/discord-ipc-${i}`;
    const s = net.createConnection(path);
    let opened = false;
    s.once('connect', () => {
      opened = true;
      this.sock = s;
      s.write(frame(0, { v: 1, client_id: this.clientId }));
    });
    let buf = Buffer.alloc(0);
    s.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        let msg = {};
        try { msg = JSON.parse(buf.slice(8, 8 + len).toString()); } catch {}
        buf = buf.slice(8 + len);
        if (op === 1 && msg.evt === 'READY') { this.ready = true; this.flush(true); }
        if (op === 2) { this.disconnect(); this.scheduleRetry(); } // CLOSE (ör. geçersiz uygulama kimliği)
        if (op === 3) s.write(frame(4, msg)); // PING -> PONG
      }
    });
    s.on('error', () => { if (!opened) { s.destroy(); this.connect(i + 1); } });
    s.on('close', () => {
      if (this.sock === s) { this.sock = null; this.ready = false; this.scheduleRetry(); }
    });
  }

  scheduleRetry() {
    clearTimeout(this.retryT);
    if (this.enabled) this.retryT = setTimeout(() => this.connect(), 15000);
  }

  disconnect() {
    clearTimeout(this.retryT);
    if (this.sock) { try { this.sock.destroy(); } catch {} }
    this.sock = null; this.ready = false; this.lastKey = '';
  }

  // Nabız'ın çalma durumundan Discord etkinliği oluştur
  update(st) {
    if (!this.enabled) return;
    let activity = null;
    if (st && st.has && st.playing && st.title) {
      const now = Date.now();
      const start = now - Math.max(0, st.pos || 0) * 1000;
      activity = {
        type: 2, // "Dinliyor"
        details: String(st.title).slice(0, 128),
        state: String(st.artist || 'YouTube').slice(0, 128),
        assets: st.thumb ? { large_image: st.thumb, large_text: 'Nabız' } : undefined,
        timestamps: st.dur > 0 ? { start: Math.round(start), end: Math.round(start + st.dur * 1000) } : { start: Math.round(start) },
        buttons: st.url ? [{ label: "YouTube'da aç", url: st.url }] : undefined,
        instance: false,
      };
    }
    // Sadece anlamlı değişikliklerde gönder (şarkı, durdur/oynat, ileri-geri sarma)
    const key = activity ? `${activity.details}|${activity.state}|${Math.round((activity.timestamps.start) / 4000)}` : 'none';
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.pending = activity;
    this.flush();
  }

  // Discord sınırı: 20 saniyede 5 güncelleme — en fazla 4 sn'de bir gönder
  flush(force) {
    if (this.pending === undefined || !this.ready || !this.sock) return;
    const wait = force ? 0 : Math.max(0, 4000 - (Date.now() - this.lastSent));
    clearTimeout(this.sendT);
    this.sendT = setTimeout(() => {
      if (!this.sock || !this.ready || this.pending === undefined) return;
      const act = this.pending; this.pending = undefined; this.lastSent = Date.now();
      try {
        this.sock.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: act }, nonce: crypto.randomUUID() }));
      } catch {}
    }, wait);
  }
}

module.exports = { DiscordPresence };
