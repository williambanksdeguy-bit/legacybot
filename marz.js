'use strict';
const { createHmac, timingSafeEqual } = require('crypto');

const BASE = () => (process.env.MARZPAY_BASE_URL || 'https://wallet.wearemarz.com/api/v1').replace(/\/$/, '');

function configured() {
  return !!(process.env.MARZPAY_API_KEY && process.env.MARZPAY_API_SECRET);
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${process.env.MARZPAY_API_KEY}:${process.env.MARZPAY_API_SECRET}`).toString('base64');
}

async function call(path, init = {}) {
  const res = await fetch(BASE() + path, {
    ...init,
    headers: { Authorization: authHeader(), Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

// Starts a mobile money collection. The customer gets a prompt on their phone.
// method 'card' collects by card instead: no phone number, and the customer is sent to MarzPay's secure card page (redirectUrl).
// `reference` must be a UUID. MarzPay's own reference for the transaction can differ from the one we send, so we keep both.
async function createCollection({ amount, phone, country, reference, description, callbackUrl, method = 'mobile_money' }) {
  try {
    const body = method === 'card'
      ? { amount, method: 'card', country, reference, description, callback_url: callbackUrl }
      : { amount, phone_number: phone, country, reference, description, callback_url: callbackUrl };
    const r = await call('/collect-money', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok || (r.json && r.json.status === 'error')) {
      return { ok: false, error: String((r.json && r.json.message) || `MarzPay error ${r.status}`).slice(0, 200) };
    }
    const data = (r.json && r.json.data) || {};
    const tx = data.transaction || {};
    if (method === 'card' && !data.redirect_url) return { ok: false, error: 'MarzPay did not return a card payment page' };
    return { ok: true, uuid: tx.uuid || null, marzRef: tx.reference || null, redirectUrl: data.redirect_url || null };
  } catch (e) {
    return { ok: false, error: `Could not reach MarzPay: ${e.message}`.slice(0, 200) };
  }
}

// Works for both the status endpoint and webhook payloads (same shape, optionally wrapped in `data`).
function parseMomo(json) {
  const root = json && json.transaction ? json : json && json.data && json.data.transaction ? json.data : null;
  if (!root) return null;
  const status = String((root.transaction && root.transaction.status) || '').toLowerCase();
  const amount = (root.collection && root.collection.amount) || (root.transaction && root.transaction.amount);
  return {
    state: status === 'completed' ? 'completed' : status === 'failed' || status === 'cancelled' ? 'failed' : 'pending',
    reference: (root.transaction && root.transaction.reference) || null,
    uuid: (root.transaction && root.transaction.uuid) || null,
    amountRaw: amount && amount.raw !== undefined ? Number(amount.raw) : null,
    currency: (amount && amount.currency) || null,
    mode: (root.collection && root.collection.mode) || null,
    providerTxnId: (root.collection && root.collection.provider_transaction_id) || null,
  };
}

// Different MarzPay accounts expose the lookup on slightly different paths, so try the known ones.
const statusPaths = (id) => {
  const e = encodeURIComponent(id);
  return [`/transactions/${e}`, `/collect-money/${e}`, `/collections/${e}`];
};

async function fetchTransaction(id) {
  if (!id) return null;
  for (const p of statusPaths(id)) {
    try {
      const r = await call(p);
      if (!r.ok) continue;
      const st = parseMomo(r.json);
      if (st) return st;
    } catch { /* try the next path */ }
  }
  return null;
}

// Verifies the optional X-MarzPay-Signature header (HMAC-SHA256 of "{timestamp}.{raw body}").
function verifySignature(secret, timestamp, header, rawBody, nowSec = Math.floor(Date.now() / 1000)) {
  if (!timestamp || !header) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 600) return false;
  const m = String(header).match(/v1=([a-f0-9]+)/);
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(m[1]);
  return a.length === b.length && timingSafeEqual(a, b);
}

module.exports = { configured, createCollection, parseMomo, fetchTransaction, verifySignature };
