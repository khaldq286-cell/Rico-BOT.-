
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const router = express.Router();

const DB_FILE = path.join(
  process.cwd(),
  "system",
  "rico-admin.json"
);

const sessions = new Map();

const defaults = {
  passwordHash: null,
  maxBots: 15,
  maintenance: false,
  announcement: null,
  assistants: [],
  commandUsage: {},
  logs: []
};

async function loadDB() {
  try {
    return {
      ...defaults,
      ...JSON.parse(await fs.readFile(DB_FILE, "utf8"))
    };
  } catch {
    return { ...defaults };
  }
}

async function saveDB(db) {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  const temp = DB_FILE + ".tmp";
  await fs.writeFile(temp, JSON.stringify(db, null, 2));
  await fs.rename(temp, DB_FILE);
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;

  const [salt, oldHash] = stored.split(":");
  const hash = scryptSync(password, salt, 64);
  const old = Buffer.from(oldHash, "hex");

  return old.length === hash.length &&
    timingSafeEqual(hash, old);
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";
  const item = cookies.split(";").find(
    x => x.trim().startsWith(name + "=")
  );

  return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : null;
}

function requireDeveloper(req, res, next) {
  const token = getCookie(req, "rico_admin");
  const session = token && sessions.get(token);

  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "يجب تسجيل الدخول" });
  }

  req.developer = session;
  next();
}

function logAction(db, action, actor = "owner") {
  db.logs.unshift({
    action,
    actor,
    date: new Date().toISOString()
  });

  db.logs = db.logs.slice(0, 200);
}

// حالة إعداد كلمة السر
router.get("/setup-status", async (req, res) => {
  const db = await loadDB();

  res.json({
    setupRequired: !db.passwordHash
  });
});

// الإعداد الأولي
router.post("/setup", async (req, res) => {
  const db = await loadDB();

  if (db.passwordHash) {
    return res.status(403).json({
      error: "تم إعداد كلمة السر مسبقاً"
    });
  }

  const initial = process.env.RICO_INITIAL_PASSWORD;

  if (!initial || req.body.initialPassword !== initial) {
    return res.status(401).json({
      error: "كلمة السر الأولية غير صحيحة"
    });
  }

  const password = req.body.newPassword;

  if (typeof password !== "string" || password.length < 10) {
    return res.status(400).json({
      error: "كلمة السر الجديدة يجب أن تكون 10 أحرف على الأقل"
    });
  }

  db.passwordHash = hashPassword(password);
  logAction(db, "تم إعداد كلمة سر المطور");
  await saveDB(db);

  res.json({ success: true });
});

// تسجيل الدخول
router.post("/login", async (req, res) => {
  const db = await loadDB();

  if (!db.passwordHash) {
    return res.status(403).json({
      error: "يجب إعداد كلمة السر أولاً"
    });
  }

  if (!verifyPassword(req.body.password || "", db.passwordHash)) {
    return res.status(401).json({
      error: "كلمة السر غير صحيحة"
    });
  }

  const token = randomBytes(32).toString("hex");

  sessions.set(token, {
    role: "owner",
    expires: Date.now() + 12 * 60 * 60 * 1000
  });

  res.setHeader("Set-Cookie",
    `rico_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`
  );

  logAction(db, "تسجيل دخول المطور");
  await saveDB(db);

  res.json({ success: true });
});

// تسجيل الخروج
router.post("/logout", (req, res) => {
  const token = getCookie(req, "rico_admin");

  if (token) sessions.delete(token);

  res.setHeader("Set-Cookie",
    "rico_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
  );

  res.json({ success: true });
});

// معلومات لوحة المطور
router.get("/overview", requireDeveloper, async (req, res) => {
  const db = await loadDB();

  res.json({
    maxBots: db.maxBots,
    maintenance: db.maintenance,
    assistants: db.assistants,
    commandUsage: db.commandUsage,
    logs: db.logs
  });
});

// زيادة أو تنقيص الحد
router.patch("/limit", requireDeveloper, async (req, res) => {
  const db = await loadDB();
  const value = Number(req.body.maxBots);

  if (!Number.isInteger(value) || value < 1 || value > 10000) {
    return res.status(400).json({
      error: "الحد يجب أن يكون رقماً بين 1 و10000"
    });
  }

  db.maxBots = value;
  logAction(db, `تغيير الحد إلى ${value}`);
  await saveDB(db);

  res.json({ success: true, maxBots: value });
});

// تشغيل وإيقاف الصيانة
router.post("/maintenance", requireDeveloper, async (req, res) => {
  const db = await loadDB();

  db.maintenance = Boolean(req.body.enabled);

  logAction(
    db,
    db.maintenance ? "تفعيل وضع الصيانة" : "إلغاء وضع الصيانة"
  );

  await saveDB(db);

  res.json({
    success: true,
    maintenance: db.maintenance
  });
});

// حفظ إعلان
router.post("/announcement", requireDeveloper, async (req, res) => {
  const db = await loadDB();
  const message = String(req.body.message || "").trim();

  if (!message || message.length > 3000) {
    return res.status(400).json({
      error: "الإعلان مطلوب وبحد أقصى 3000 حرف"
    });
  }

  db.announcement = {
    message,
    createdAt: new Date().toISOString()
  };

  logAction(db, "حفظ إعلان جديد");
  await saveDB(db);

  res.json({
    success: true,
    message: "تم حفظ الإعلان"
  });
});

// إضافة مطور مساعد
router.post("/assistants", requireDeveloper, async (req, res) => {
  const db = await loadDB();

  const id = String(req.body.id || "").trim();
  const permissions = Array.isArray(req.body.permissions)
    ? req.body.permissions.filter(p =>
        ["view", "maintenance", "announcement", "limit", "stats"]
          .includes(p)
      )
    : [];

  if (!id || id.length > 100) {
    return res.status(400).json({
      error: "معرّف المطور غير صحيح"
    });
  }

  if (db.assistants.some(a => a.id === id)) {
    return res.status(409).json({
      error: "المطور موجود مسبقاً"
    });
  }

  db.assistants.push({ id, permissions });
  logAction(db, `إضافة مطور مساعد: ${id}`);
  await saveDB(db);

  res.json({ success: true });
});

// حذف مطور مساعد
router.delete("/assistants/:id", requireDeveloper, async (req, res) => {
  const db = await loadDB();

  db.assistants = db.assistants.filter(
    a => a.id !== req.params.id
  );

  logAction(db, `حذف مطور مساعد: ${req.params.id}`);
  await saveDB(db);

  res.json({ success: true });
});

export default router;
