// connect.js — مدير الجلسات: رمز الاقتران، الاستعادة، إعادة الاتصال، الحالة
import express from 'express';
import * as db from './database/database.js';
import { createSocket, listSavedSessions, removeSession } from './Socket.js';
import { handleCommand } from './commands/commands.js';

const CUSTOM_CODE = process.env.PAIRING_CODE || 'RICO2010';
const PAIR_WINDOW = 120_000; // مهلة الربط

const bots = new Map();
const customFailed = new Set();

export const cleanPhone = (p) => String(p || '').replace(/\D/g, '');
const validPhone = (p) => /^\d{8,15}$/.test(p);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jid = (phone) => `${phone}@s.whatsapp.net`;

export const getStatus = (phone) => bots.get(phone)?.status || 'غير موجود';
export const botsView = () =>
  [...bots.entries()].map(([phone, b]) => ({ phone, status: b.status }));
export const connectedCount = () =>
  [...bots.values()].filter((b) => b.status === 'متصل').length;

async function onMessages(bot, { messages }) {
  for (const m of messages || []) {
    try {
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      if (!text.startsWith('.') || !bot.sock) continue;
      const name = await handleCommand(bot.sock, m, text);
      if (name) db.countCommand(name);
    } catch (e) {
      console.error('خطأ في معالجة رسالة:', e.message);
    }
  }
}

async function start(phone, { pairing = false, restored = false } = {}) {
  const old = bots.get(phone);
  if (old?.sock && !old.stopped) return old;

  const bot = old || { retries: 0, usedCustom: false };
  bot.stopped = false;
  bot.status = 'جارٍ الاتصال';
  if (pairing) bot.pairingPending = true;
  if (restored) bot.restored = true;
  bots.set(phone, bot);

  await createSocket(phone, {
    onConnecting: () => {
      if (!bot.stopped && bot.status !== 'بانتظار الربط')
        bot.status = 'جارٍ الاتصال';
    },
    onMessages: (ev) => onMessages(bot, ev),
    onOpen: async () => {
      bot.status = 'متصل';
      bot.retries = 0;
      console.log(`[${phone}] ✅ متصل`);

      if (bot.pairingPending) {
        bot.pairingPending = false;
        clearTimeout(bot.pairTimer);
        db.addBot(phone);
        db.stat('installs');

        try {
          await bot.sock.sendMessage(jid(phone), {
            text: '🎉 مبروك! تم ربط رقمك بـ *RICO BOT* بنجاح.\nاكتب .اوامر عشان تبدأ.',
          });
        } catch {}
      } else if (bot.restored && !bot.countedRestore) {
        bot.countedRestore = true;
        db.stat('restored');
      }
    },
    onClose: ({ code, loggedOut }) => {
      bot.sock = null;
      if (bot.stopped) return;

      if (loggedOut) {
        bot.status = 'تم تسجيل الخروج';
        bot.stopped = true;
        clearTimeout(bot.pairTimer);
        removeSession(phone);
        db.removeBot(phone);
        console.log(`[${phone}] خرج من واتساب — حُذفت الجلسة`);
        return;
      }

      if (bot.pairingPending && bot.usedCustom && code !== 515)
        customFailed.add(phone);

      bot.status = 'غير متصل';
      scheduleReconnect(phone, code);
    },
  }).then(({ sock }) => {
    bot.sock = sock;
  });

  return bot;
}

function scheduleReconnect(phone, code) {
  const bot = bots.get(phone);
  if (!bot || bot.stopped) return;

  clearTimeout(bot.timer);
  const delay = code === 515 ? 500 : Math.min(2000 * 2 ** bot.retries, 60_000);
  bot.retries += 1;

  console.log(`[${phone}] إعادة المحاولة بعد ${delay}ms (code=${code})`);

  bot.timer = setTimeout(() => {
    start(phone).catch((e) => {
      console.error(`[${phone}] فشل إعادة الاتصال:`, e.message);
      scheduleReconnect(phone, 0);
    });
  }, delay);
}

export async function stopBot(phone, { logout = false } = {}) {
  const bot = bots.get(phone);

  if (bot) {
    bot.stopped = true;
    clearTimeout(bot.timer);
    clearTimeout(bot.pairTimer);

    try {
      if (logout) await bot.sock?.logout();
      else bot.sock?.end?.(undefined);
    } catch {}

    bots.delete(phone);
  }

  if (logout) {
    removeSession(phone);
    db.removeBot(phone);
  }
}

export async function requestPairing(rawPhone) {
  const phone = cleanPhone(rawPhone);

  if (db.data.settings.maintenance)
    throw new Error('المنصة في وضع الصيانة حالياً');

  if (!validPhone(phone))
    throw new Error('رقم غير صالح، اكتبه مع مفتاح الدولة');

  if (db.isBanned(phone))
    throw new Error('هذا الرقم محظور');

  if (bots.get(phone)?.status === 'متصل')
    throw new Error('الرقم مربوط مسبقاً');

  if (db.hasBot(phone))
    throw new Error('الرقم مربوط، انتظر إعادة الاتصال التلقائي');

  if (db.botCount() >= db.data.settings.installLimit)
    throw new Error('اكتمل الحد الأقصى للتنصيبات حالياً');

  db.stat('attempts');
  db.markDaily(phone);

  await stopBot(phone);
  removeSession(phone);

  const bot = await start(phone, { pairing: true });
  await wait(2500);

  const useCustom =
    /^[A-Za-z0-9]{8}$/.test(CUSTOM_CODE) && !customFailed.has(phone);

  bot.usedCustom = useCustom;

  let code;

  try {
    code = await bot.sock.requestPairingCode(
      phone,
      useCustom ? CUSTOM_CODE.toUpperCase() : undefined
    );
  } catch (e) {
    console.error(`[${phone}] فشل طلب الرمز:`, e.message);
    db.stat('failed');
    await stopBot(phone);
    removeSession(phone);
    throw new Error('تعذّر طلب رمز الاقتران، حاول مرة ثانية');
  }

  bot.status = 'بانتظار الربط';

  bot.pairTimer = setTimeout(async () => {
    if (bot.pairingPending) {
      console.log(`[${phone}] انتهت مهلة الربط`);
      db.stat('failed');
      await stopBot(phone);
      removeSession(phone);
    }
  }, PAIR_WINDOW + 10_000);

  return {
    phone,
    code,
    custom: useCustom,
    expiresIn: PAIR_WINDOW / 1000,
  };
}

export async function restoreAll() {
  const phones = listSavedSessions().filter((p) => !db.isBanned(p));

  console.log(`استعادة ${phones.length} جلسة...`);

  for (const phone of phones) {
    try {
      await start(phone, { restored: true });
    } catch (e) {
      console.error(`[${phone}] فشلت الاستعادة:`, e.message);
    }

    await wait(1500);
  }
}

export async function broadcast(text) {
  let sent = 0;

  for (const [phone, b] of bots) {
    if (b.status !== 'متصل' || !b.sock) continue;

    try {
      await b.sock.sendMessage(jid(phone), {
        text: `📢 *إعلان من المطور*\n${text}`,
      });
      sent++;
    } catch {}

    await wait(800);
  }

  return sent;
}

export const connectRouter = express.Router();

connectRouter.post('/pair', express.json(), async (req, res) => {
  try {
    res.json({
      ok: true,
      ...(await requestPairing(req.body?.phone)),
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

connectRouter.get('/status/:phone', (req, res) => {
  const phone = cleanPhone(req.params.phone);
  res.json({
    phone,
    status: getStatus(phone),
  });
});
