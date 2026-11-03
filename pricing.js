'use strict';
// Pure helpers (no database, no network) so they are easy to test.

// Currencies the site can charge in. Add more here once MarzPay confirms how to collect them.
const CURRENCIES = {
  UGX: { country: 'UG', step: 100 }, // charge is rounded UP to the next 100
};

// "30" or "30.50" -> cents. Anything else -> null.
function parseMoneyCents(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
const centsToStr = (c) => (Number(c) / 100).toFixed(2).replace(/\.00$/, '');

// Exchange rate: units of local currency per 1 USD, e.g. "3700" or "3712.5".
function parseRate(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,7}(\.\d{1,4})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

// Local amount to charge for a USD total (in cents), rounded up so we never under-collect.
function localCharge(totalCents, rate, step = 1) {
  const raw = (totalCents * rate) / 100;
  return Math.ceil(raw / step - 1e-9) * step;
}

// Ugandan mobile number -> "+2567XXXXXXXX", or null.
function normalizeUgPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) d = '256' + d.slice(1);
  else if (d.length === 9 && d.startsWith('7')) d = '256' + d;
  return /^2567\d{8}$/.test(d) ? '+' + d : null;
}

// Decides whether MarzPay's reply really is a successful payment for THIS order.
// `st` comes from marz.parseMomo (the API's own answer, never the customer's or the webhook's word).
function acceptPayment(order, st, { allowSandbox = false } = {}) {
  if (!st) return { ok: false, reason: 'MarzPay did not return a status' };
  if (st.state !== 'completed') return { ok: false, reason: 'not completed' };
  if ((st.mode || '').toLowerCase().includes('sandbox') && !allowSandbox) return { ok: false, reason: 'Sandbox payment ignored' };
  // MarzPay may report its own reference instead of the one we sent, so also accept our stored MarzPay reference or uuid
  const sameRef = st.reference === order.reference
    || (order.marz_ref && st.reference === order.marz_ref)
    || (order.marz_uuid && st.uuid === order.marz_uuid);
  if (!sameRef) return { ok: false, reason: 'reference does not match this order' };
  if (st.currency !== order.currency) return { ok: false, reason: 'currency does not match this order' };
  // We fixed the amount ourselves. MarzPay may report it gross or after its own fee, so allow a small shortfall.
  if (st.amountRaw === null || st.amountRaw < order.charged * 0.95) return { ok: false, reason: 'amount is lower than the order' };
  return { ok: true, reason: '' };
}

const PENDING_MINUTES = 20;

module.exports = { CURRENCIES, parseMoneyCents, centsToStr, parseRate, localCharge, normalizeUgPhone, acceptPayment, PENDING_MINUTES };
