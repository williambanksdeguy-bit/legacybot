'use strict';
// Pure helpers (no database, no network) so they are easy to test.

// Countries where MarzPay collects mobile money (from MarzPay's documentation). The admin panel switches each one on by giving it
// an exchange rate. `nsn` checks the phone number without the country code; countries MarzPay does not spell out use a loose check
// (MarzPay itself rejects a wrong number). TZS is not offered by MarzPay.
const loose = /^\d{8,10}$/;
const MARKETS = {
  UG: { name: 'Uganda', currency: 'UGX', dial: '256', step: 100, nsn: /^7\d{8}$/, example: '0772 123 456' },
  KE: { name: 'Kenya', currency: 'KES', dial: '254', step: 1, nsn: /^[17]\d{8}$/, example: '0712 345 678' },
  RW: { name: 'Rwanda', currency: 'RWF', dial: '250', step: 1, nsn: /^7\d{8}$/, example: '0788 123 456' },
  CD: { name: 'DR Congo', currency: 'CDF', dial: '243', step: 1, nsn: loose },
  ZM: { name: 'Zambia', currency: 'ZMW', dial: '260', step: 1, nsn: loose },
  CM: { name: 'Cameroon', currency: 'XAF', dial: '237', step: 1, nsn: loose },
  SN: { name: 'Senegal', currency: 'XOF', dial: '221', step: 1, nsn: loose },
  CI: { name: "C\u00f4te d'Ivoire", currency: 'XOF', dial: '225', step: 1, nsn: loose },
  BJ: { name: 'Benin', currency: 'XOF', dial: '229', step: 1, nsn: loose },
  GA: { name: 'Gabon', currency: 'XAF', dial: '241', step: 1, nsn: loose },
  CG: { name: 'Congo-Brazzaville', currency: 'XAF', dial: '242', step: 1, nsn: loose },
  SL: { name: 'Sierra Leone', currency: 'SLE', dial: '232', step: 1, nsn: loose },
};
for (const m of Object.values(MARKETS)) m.example = m.example || `+${m.dial} ...`;

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

// Mobile number for a country -> "+<country code><number>", or null. Accepts local (0772...) and international (+256772...) forms.
function normalizePhone(code, v) {
  const m = MARKETS[code];
  if (!m) return null;
  const d = String(v ?? '').replace(/\D/g, '');
  let national;
  if (d.startsWith(m.dial)) national = d.slice(m.dial.length);
  else if (d.startsWith('0')) national = d.slice(1);
  else national = d;
  return m.nsn.test(national) ? `+${m.dial}${national}` : null;
}
const normalizeUgPhone = (v) => normalizePhone('UG', v);

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

module.exports = { MARKETS, normalizePhone, parseMoneyCents, centsToStr, parseRate, localCharge, normalizeUgPhone, acceptPayment, PENDING_MINUTES };
