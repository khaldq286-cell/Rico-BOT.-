
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// على Render: اضبط SESSIONS_DIR=/var/data/sessions
export const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(process.cwd(), 'sessions');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

export const sessionPath = (phone) => path.join(SESSIONS_DIR, phone);

export function listSavedSessions() {
  return fs
    .readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8,15}$/.test(d.name))
    .map((d) => d.name);
}

export function removeSession(phone) {
  fs.rmSync(sessionPath(phone), { recursive: true, force: true });
}

/**
 * handlers: { onConnecting, onOpen, onClose({code, loggedOut}), onMessages }
 * يرجّع { sock, registered }
 */
export async function createSocket(phone, handlers = {}) {
  const dir = sessionPath(phone);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr || connection === 'connecting') {
      handlers.onConnecting?.();
    }

    if (connection === 'open') {
      handlers.onOpen?.();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;

      handlers.onClose?.({
        code,
        loggedOut: code === DisconnectReason.loggedOut,
      });
    }
  });

  if (handlers.onMessages) {
    sock.ev.on('messages.upsert', handlers.onMessages);
  }

  return {
    sock,
    registered: !!state.creds.registered,
  };
}
