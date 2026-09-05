'use strict';

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID;
const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/chat_state`;
const HEADERS = { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" };

let isTurnActive = false;

function setTurnActive(active) {
  isTurnActive = active;
}

async function getState() {
  try {
    const res = await fetch(KV_URL, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function setState(data) {
  try {
    await fetch(KV_URL, { method: 'PUT', headers: HEADERS, body: JSON.stringify(data) });
  } catch (e) { console.error('Failed to update KV state:', e); }
}

function flushThinkingKV(text) {
  if (!isTurnActive) return;
  (async () => {
    try {
      if (!isTurnActive) return;
      const s = (await getState()) || {};
      await setState({ ...s, status: 'thinking', last_agent: text });
    } catch {}
  })();
}

function flushSwitchKV(info) {
  if (!isTurnActive) return;
  (async () => {
    try {
      if (!isTurnActive) return;
      const s = (await getState()) || {};
      await setState({ ...s, status: 'thinking', model_info: info, last_agent: info });
    } catch {}
  })();
}

module.exports = {
  getState,
  setState,
  setTurnActive,
  flushThinkingKV,
  flushSwitchKV
};
