// main.js — نقطة تشغيل المنصة
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './database/database.js';
import {
  connectRouter, restoreAll, stopBot, broadcast, botsView, connectedCount, cleanPhone,
} from './connect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

// ---------- حد المحاولات ----------
const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now();
  const a = (hits.get(k) || []).filter((t) => now - t < ms);
  if (a.length >= max) return res.status(429).json({ ok: false, error: 'محاولات كتيرة، انتظر شوية' });
  a.push(now); hits.set(k, a); next();
};

// ---------- واجهة المستخدم ----------
app.get('/api/public', (_req, res) => {
  const a = db.latestAnnouncement();
  res.json({
    maintenance: db.data.settings.maintenance,
    full: db.botCount() >= db.data.settings.installLimit,
    announcement: a?.text || null,
  });
});
app.use('/api/pair', limit(5, 10 * 60_000));
app.use('/api', connectRouter);

// ---------- لوحة المطور ----------
const tokens = new Map();
const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if ((tokens.get(t) || 0) < Date.now()) return res.status(401).json({ ok: false, error: 'غير مصرّح' });
  req.token = t; next();
};
const ok = (res, extra = {}) => res.json({ ok: true, ...extra });

app.post('/admin/api/login', limit(5, 10 * 60_000), (req, res) => {
  if (!db.checkAdminPassword(req.body?.password))
    return res.status(401).json({ ok: false, error: 'باسورد غلط' });
  const t = crypto.randomBytes(32).toString('hex');
  tokens.set(t, Date.now() + 12 * 3600_000);
  ok(res, { token: t });
});
app.post('/admin/api/logout', auth, (req, res) => { tokens.delete(req.token); ok(res); });

app.get('/admin/api/stats', auth, (_req, res) => {
  const list = botsView();
  ok(res, {
    dailyUsers: db.dailyCount(),
    totalBots: db.botCount(),
    connected: connectedCount(),
    disconnected: list.length - connectedCount(),
    stats: db.data.stats,
    topCommands: db.topCommands(5),
    installLimit: db.data.settings.installLimit,
    maintenance: db.data.settings.maintenance,
    banned: db.data.banned,
    bots: list,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  });
});
app.post('/admin/api/limit', auth, (req, res) => {
  const n = Number(req.body?.limit);
  if (!Number.isInteger(n) || n < 0 || n > 10000) return res.status(400).json({ ok: false, error: 'رقم غير صالح' });
  db.setLimit(n); ok(res);
});
app.post('/admin/api/ban', auth, async (req, res) => {
  const p = cleanPhone(req.body?.phone);
  if (!p) return res.status(400).json({ ok: false, error: 'رقم غير صالح' });
  db.ban(p); await stopBot(p, { logout: true }); ok(res);
});
app.post('/admin/api/unban', auth, (req, res) => { db.unban(cleanPhone(req.body?.phone)); ok(res); });
app.post('/admin/api/maintenance', auth, (req, res) => { db.setMaintenance(req.body?.on); ok(res); });
app.post('/admin/api/announce', auth, async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ ok: false, error: 'اكتب نص الإعلان' });
  db.addAnnouncement(text);
  ok(res, { sent: await broadcast(text) });
});
app.post('/admin/api/remove-bot', auth, async (req, res) => {
  await stopBot(cleanPhone(req.body?.phone), { logout: true }); ok(res);
});
app.post('/admin/api/password', auth, (req, res) => {
  const pw = String(req.body?.password || '');
  if (pw.length < 8) return res.status(400).json({ ok: false, error: 'الباسورد لازم 8 خانات على الأقل' });
  db.setAdminPassword(pw); tokens.clear(); ok(res);
});

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- تشغيل ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`RICO BOT شغّال على المنفذ ${port}`);
  if (!process.env.ADMIN_PASSWORD && !db.data.settings.adminHash)
    console.warn('⚠️ ما في ADMIN_PASSWORD — ما حتقدر تدخل لوحة المطور');
  restoreAll().catch((e) => console.error('فشلت الاستعادة:', e.message));
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { db.flush(); process.exit(0); });
