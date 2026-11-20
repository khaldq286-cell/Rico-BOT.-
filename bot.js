// ===== الملف 1: البوت + رمز الاقتران الثابت + قاعدة البيانات =====
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino'), fs = require('fs');

const PAIR_CODE = 'RICO1435';                  // رمز الاقتران الثابت (8 خانات)
const CHANNEL = '0029VbEeK337YSd7zPPAh70e';    // قناة المطور
const PREFIX = '.';
const DB = './data.json';

let db = { installs: [], commands: {}, banned: [], maintenance: false };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB)) }; } catch {}
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const socks = new Map();

async function start(num, wantPair, cb) {
  const { state, saveCreds } = await useMultiFileAuthState('./sessions/' + num);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  // رمز الاقتران نفسو هو البشغل البوت: بعد ما يدخلو في واتساب البوت يشتغل براهو
  if (!state.creds.registered && wantPair) {
    setTimeout(async () => {
      try { await sock.requestPairingCode(num, PAIR_CODE); cb && cb(null, PAIR_CODE); }
      catch (e) { cb && cb(e); }
    }, 3000);
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      socks.set(num, sock);
      if (!db.installs.find(i => i.number === num)) {
        db.installs.push({ number: num, date: new Date().toISOString() }); save();
        try { await sock.sendMessage(num + '@s.whatsapp.net', { text: '🎉 مبروك! تم تنصيب *RICO BOT* على رقمك وهو شغال الحين ⚡\nاكتب .menu عشان تشوف الاوامر' }); } catch {}
        try { const m = await sock.newsletterMetadata('invite', CHANNEL); await sock.newsletterFollow(m.id); } catch {}
      }
    }
    if (connection === 'close') {
      socks.delete(num);
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut || !state.creds.registered) {
        if (code === DisconnectReason.loggedOut || !wantPair || true) fs.rmSync('./sessions/' + num, { recursive: true, force: true });
        if (!state.creds.registered && code !== DisconnectReason.loggedOut) return;
        return;
      }
      setTimeout(() => start(num, false), 3000);   // السيرفر فصل؟ يربط براهو
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]; if (!m?.message) return;
    const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
    if (!text.startsWith(PREFIX)) return;
    const jid = m.key.remoteJid, sender = (m.key.participant || jid).split('@')[0];
    if (db.banned.includes(num) || db.banned.includes(sender)) return;
    if (db.maintenance) return sock.sendMessage(jid, { text: '🛠️ البوت تحت الصيانة حاليا، نرجع قريب.' });
    const cmd = text.slice(1).trim().split(' ')[0].toLowerCase();
    const R = {
      menu: '⚡ *RICO BOT* ⚡\n.menu  القائمة\n.ping  سرعة البوت\n.alive  حالة البوت\n.owner  المطور',
      ping: '🏓 pong!', alive: '✅ RICO BOT شغال', owner: '📢 قناة المطور:\nhttps://whatsapp.com/channel/' + CHANNEL
    };
    if (!R[cmd]) return;
    db.commands[cmd] = (db.commands[cmd] || 0) + 1; save();
    await sock.sendMessage(jid, { text: R[cmd] }, { quoted: m });
  });
  return sock;
}

function pair(num) {
  return new Promise((res, rej) => {
    fs.rmSync('./sessions/' + num, { recursive: true, force: true });
    socks.get(num)?.end?.(); socks.delete(num);
    start(num, true, (e, c) => e ? rej(e) : res(c)).catch(rej);
  });
}

async function boot() {            // يرجع كل الارقام المنصبة بعد اي اعادة تشغيل
  if (!fs.existsSync('./sessions')) return;
  for (const n of fs.readdirSync('./sessions')) {
    try { if (JSON.parse(fs.readFileSync(`./sessions/${n}/creds.json`)).registered) await start(n, false); } catch {}
  }
}

async function announce(text) {
  let ok = 0;
  for (const [n, s] of socks) { try { await s.sendMessage(n + '@s.whatsapp.net', { text: '📢 *اعلان من المطور*\n\n' + text }); ok++; } catch {} }
  return ok;
}

module.exports = { db, save, socks, pair, boot, announce, PAIR_CODE };
