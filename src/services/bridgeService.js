import dotenv from 'dotenv';
dotenv.config();

const REMOTE_URL = (process.env.REMOTE_BOT_URL || '').replace(/\/$/, '');
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'bot_bendahara_bridge_2026';

export function isBridgeMode() {
  return Boolean(REMOTE_URL && process.env.ENABLE_WHATSAPP === 'false');
}

/**
 * Memanggil endpoint API di server cPanel dari laptop lokal
 */
export async function callRemoteBot(endpoint, method = 'GET', body = null) {
  if (!REMOTE_URL) {
    throw new Error('REMOTE_BOT_URL belum disetel di .env lokal.');
  }

  const url = `${REMOTE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-bridge-token': BRIDGE_SECRET
    }
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Server cPanel error (${res.status}): ${errText}`);
  }

  return await res.json();
}

export default {
  isBridgeMode,
  callRemoteBot,
  BRIDGE_SECRET
};
