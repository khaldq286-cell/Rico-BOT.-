const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, Browsers
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESS = path.join(DATA, 'sessions');
const DB_FILE = path.join(DATA, 'db.json');
const PAIR_CODE = 'RICO2176';
fs.mkdirSync(SESS, { recursive: true });

const sha = s => crypto.createHash('sha256').update('rico:' + s).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const clean = n => String(n || '').replace(/\D/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- قاعدة البيانات (ملف JSON يبقى بعد إعادة التشغيل) ----------
let db = {
  pass: sha(process.env.ADMIN_PASS || 'rico@admin'),
  limit: 50,
  banned: [],
  linked: {},
  daily: { date: today(), n: [] },
  tokens: []
};
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
function save() {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}
function daily() {
  if (db.daily.date !== today()) db.daily = { date: today(), n: [] };
  return db.daily;
}
function trackDaily(n) {
  const d = daily();
  if (!d.n.includes(n)) { d.n.push(n); save(); }
}
save();

// ---------- جلسات البوت ----------
const sessions = new Map();
const logger = pino({ level: 'silent' });

function wipe(number) {
  fs.rmSync(path.join(SESS, number), { recursive: true, force: true });
  delete db.linked[number];
  save();
}

function stop(number, removeFiles) {
  const s = sessions.get(number);
  if (s) {
    s.stopped = true;
    try { s.sock.end(undefined); } catch {}
    sessions.delete(number);
  }
  if (removeFiles) wipe(number);
}

async function start(number, pair = false) {
  const dir = path.join(SESS, number);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch {}

  const sock = makeWASocket({
    version, auth: state, logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false
  });
  const s = { sock, number, status: 'connecting', code: null, pair };
  sessions.set(number, s);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      s.status = 'open';
      s.code = null;
      const first = !db.linked[number];
      if (first) { db.linked[number] = Date.now(); save(); }
      if (first || s.pair) {
        s.pair = false;
        try {
          await sock.sendMessage(number + '@s.whatsapp.net', {
            text: '🎉 تهانينا! تم ربط رقمك بـ RICO BOT بنجاح.\nاكتب .ping للتجربة.'
          });
        } catch {}
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      s.status = 'closed';
      if (sessions.get(number) === s) sessions.delete(number);
      if (s.stopped) return;
      if (code === DisconnectReason.loggedOut) return wipe(number);
      if (db.banned.includes(number)) return;
      if (state.creds.registered) {
        setTimeout(() => {
          if (!sessions.has(number)) start(number).catch(() => {});
        }, 3000);
      }
    }
  });

  // ---- هنا تضيف أوامر البوت ----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const t = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      if (t.trim() === '.ping') {
        try { await sock.sendMessage(m.key.remoteJid, { text: 'pong 🏓 RICO BOT' }, { quoted: m }); } catch {}
      }
    }
  });

  // طلب الاقتران بالكود الثابت RICO2176
  if (pair && !state.creds.registered) {
    await sleep(3000);
    s.code = await sock.requestPairingCode(number, PAIR_CODE);
    setTimeout(() => {
      if (!state.creds.registered && sessions.get(number) === s) stop(number, true);
    }, 180000);
  }
  return s;
}

// ---------- السيرفر ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const hits = new Map();
function limited(key, max) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter(t => now - t < 600000);
  a.push(now);
  hits.set(key, a);
  return a.length > max;
}

app.post('/api/pair', async (req, res) => {
  const n = clean(req.body.number);
  if (n.length < 8 || n.length > 15)
    return res.status(400).json({ error: 'الرقم غير صحيح، اكتبه بالصيغة الدولية بدون +' });
  if (limited('pair' + req.ip, 8))
    return res.status(429).json({ error: 'محاولات كتيرة، جرب بعد شوية' });
  if (db.banned.includes(n))
    return res.status(403).json({ error: 'هذا الرقم محظور' });
  trackDaily(n);

  if (db.linked[n]) return res.json({ status: 'open' });
  if (Object.keys(db.linked).length >= db.limit)
    return res.status(403).json({ error: 'اكتمل عدد التنصيبات حاليا' });

  try {
    stop(n, false);
    fs.rmSync(path.join(SESS, n), { recursive: true, force: true });
    const s = await start(n, true);
    res.json({ status: 'pending', code: s.code });
  } catch (e) {
    stop(n, true);
    res.status(500).json({ error: 'تعذر توليد الكود، حاول مرة ثانية' });
  }
});

app.get('/api/status/:n', (req, res) => {
  const n = clean(req.params.n);
  const s = sessions.get(n);
  if (db.linked[n] && s && s.status === 'open') return res.json({ status: 'open' });
  if (s) return res.json({ status: 'pending' });
  res.json({ status: db.linked[n] ? 'open' : 'none' });
});

// ---------- لوحة المطور ----------
const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (t && db.tokens.includes(t)) return next();
  res.status(401).json({ error: 'غير مصرح' });
};

app.post('/api/admin/login', (req, res) => {
  if (limited('login' + req.ip, 10))
    return res.status(429).json({ error: 'محاولات كتيرة، جرب بعد شوية' });
  if (sha(String(req.body.pass || '')) !== db.pass)
    return res.status(401).json({ error: 'الكود غلط' });
  const t = crypto.randomBytes(24).toString('hex');
  db.tokens = [...db.tokens.slice(-9), t];
  save();
  res.json({ token: t });
});

app.post('/api/admin/logout', auth, (req, res) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  db.tokens = db.tokens.filter(x => x !== t);
  save();
  res.json({ ok: true });
});

function stats() {
  const open = [...sessions.values()].filter(s => s.status === 'open').map(s => s.number);
  return {
    daily: daily().n.length,
    connected: open.length,
    linked: Object.keys(db.linked).length,
    limit: db.limit,
    banned: db.banned,
    numbers: open
  };
}

app.get('/api/admin/stats', auth, (req, res) => res.json(stats()));

app.post('/api/admin/limit', auth, (req, res) => {
  const { delta, value } = req.body;
  let v = value !== undefined ? parseInt(value, 10) : db.limit + (parseInt(delta, 10) || 0);
  if (isNaN(v)) return res.status(400).json({ error: 'قيمة غير صحيحة' });
  db.limit = Math.max(0, Math.min(100000, v));
  save();
  res.json(stats());
});

app.post('/api/admin/ban', auth, (req, res) => {
  const n = clean(req.body.number);
  if (n.length < 8) return res.status(400).json({ error: 'رقم غير صحيح' });
  if (!db.banned.includes(n)) db.banned.push(n);
  save();
  stop(n, false);
  res.json(stats());
});

app.post('/api/admin/unban', auth, (req, res) => {
  const n = clean(req.body.number);
  db.banned = db.banned.filter(x => x !== n);
  save();
  if (fs.existsSync(path.join(SESS, n, 'creds.json')) && !sessions.has(n)) start(n).catch(() => {});
  res.json(stats());
});

app.post('/api/admin/announce', auth, (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'اكتب نص الإعلان' });
  const targets = [...sessions.values()].filter(s => s.status === 'open');
  res.json({ total: targets.length });
  (async () => {
    for (const s of targets) {
      try { await s.sock.sendMessage(s.number + '@s.whatsapp.net', { text: '📢 ' + text }); } catch {}
      await sleep(1500);
    }
  })();
});

app.post('/api/admin/password', auth, (req, res) => {
  const p = String(req.body.pass || '');
  if (p.length < 6) return res.status(400).json({ error: 'الكود لازم 6 حروف على الأقل' });
  db.pass = sha(p);
  save();
  res.json({ ok: true });
});

// ---------- تشغيل + ربط تلقائي بعد كل إعادة تشغيل ----------
app.listen(PORT, async () => {
  console.log('RICO BOT على المنفذ ' + PORT);
  for (const n of fs.readdirSync(SESS)) {
    if (db.banned.includes(n)) continue;
    const dir = path.join(SESS, n);
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
      if (!c.registered) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    start(n).catch(() => {});
    await sleep(1500);
  }
});
