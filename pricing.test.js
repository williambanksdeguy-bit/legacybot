// Unit tests for pricing and payment checks. No database or network needed: node --test pricing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('crypto');
const { parseMoneyCents, centsToStr, parseRate, localCharge, normalizeUgPhone, acceptPayment } = require('./pricing');
const { parseMomo, verifySignature } = require('./marz');

test('money parsing', () => {
  assert.equal(parseMoneyCents('30'), 3000);
  assert.equal(parseMoneyCents('29.99'), 2999);
  assert.equal(parseMoneyCents(' 3 '), 300);
  for (const bad of ['', 'abc', '-5', '1.234', '1e3', '12,5', null, undefined, '1234567']) assert.equal(parseMoneyCents(bad), null, String(bad));
  assert.equal(centsToStr(3300), '33');
  assert.equal(centsToStr(11700), '117');
  assert.equal(centsToStr(2999), '29.99');
});

test('exchange rate parsing', () => {
  assert.equal(parseRate('3700'), 3700);
  assert.equal(parseRate('3712.5'), 3712.5);
  for (const bad of ['', '0', '-1', 'abc', '3,700', '1e5']) assert.equal(parseRate(bad), null, bad);
});

test('local charge rounds UP so we never under-collect', () => {
  assert.equal(localCharge(3300, 3700, 100), 122100);   // $33 x 3700, exact
  assert.equal(localCharge(3300, 3712, 100), 122500);   // 122496 -> next 100
  assert.equal(localCharge(6300, 3700, 100), 233100);
  assert.equal(localCharge(100, 3701, 100), 3800);      // 3701 -> 3800
  assert.ok(localCharge(1, 1, 1) >= 1 / 100);
});

test('Uganda phone numbers', () => {
  assert.equal(normalizeUgPhone('0772 123 456'), '+256772123456');
  assert.equal(normalizeUgPhone('772123456'), '+256772123456');
  assert.equal(normalizeUgPhone('+256 772-123-456'), '+256772123456');
  assert.equal(normalizeUgPhone('256772123456'), '+256772123456');
  for (const bad of ['', '12345', '0172123456', '+254712345678', '07721234567', 'abc']) assert.equal(normalizeUgPhone(bad), null, bad);
});

const order = { reference: 'LBABC123', currency: 'UGX', charged: 122100 };
const good = { state: 'completed', reference: 'LBABC123', amountRaw: 122100, currency: 'UGX', mode: 'live' };

test('a matching completed payment is accepted', () => {
  assert.equal(acceptPayment(order, good).ok, true);
  assert.equal(acceptPayment(order, { ...good, amountRaw: 118440 }).ok, true, 'MarzPay may report the amount after its 3% fee');
});

test('card payments: MarzPay may report its own reference or only the uuid', () => {
  const card = { ...order, marz_ref: 'MARZ-REF-9', marz_uuid: 'uuid-1' };
  assert.equal(acceptPayment(card, { ...good, reference: 'MARZ-REF-9' }).ok, true);
  assert.equal(acceptPayment(card, { ...good, reference: 'something else', uuid: 'uuid-1' }).ok, true);
  assert.equal(acceptPayment(card, { ...good, reference: 'something else', uuid: 'uuid-2' }).ok, false);
  assert.equal(acceptPayment(order, { ...good, reference: 'MARZ-REF-9' }).ok, false, 'no stored MarzPay reference to match');
});

test('anything that does not match is refused', () => {
  assert.equal(acceptPayment(order, null).ok, false);
  assert.equal(acceptPayment(order, { ...good, state: 'pending' }).ok, false);
  assert.equal(acceptPayment(order, { ...good, state: 'failed' }).ok, false);
  assert.equal(acceptPayment(order, { ...good, reference: 'OTHER' }).ok, false, 'someone else\'s payment cannot approve this order');
  assert.equal(acceptPayment(order, { ...good, currency: 'KES' }).ok, false);
  assert.equal(acceptPayment(order, { ...good, amountRaw: 1000 }).ok, false, 'underpayment');
  assert.equal(acceptPayment(order, { ...good, amountRaw: null }).ok, false);
});

test('sandbox payments are ignored unless allowed', () => {
  assert.equal(acceptPayment(order, { ...good, mode: 'sandbox' }).ok, false);
  assert.equal(acceptPayment(order, { ...good, mode: 'Sandbox' }).ok, false);
  assert.equal(acceptPayment(order, { ...good, mode: 'sandbox' }, { allowSandbox: true }).ok, true);
});

test('MarzPay reply parsing (plain and wrapped in data)', () => {
  const raw = { transaction: { status: 'completed', reference: 'LBABC123' }, collection: { amount: { raw: 122100, currency: 'UGX' }, mode: 'live', provider_transaction_id: 'P1' } };
  const a = parseMomo(raw);
  assert.deepEqual([a.state, a.reference, a.amountRaw, a.currency, a.mode, a.providerTxnId], ['completed', 'LBABC123', 122100, 'UGX', 'live', 'P1']);
  assert.equal(parseMomo({ transaction: { status: 'completed', uuid: 'u-1' } }).uuid, 'u-1');
  assert.equal(parseMomo({ data: raw }).state, 'completed');
  assert.equal(parseMomo({ transaction: { status: 'cancelled' } }).state, 'failed');
  assert.equal(parseMomo({ transaction: { status: 'processing' } }).state, 'pending');
  assert.equal(parseMomo({}), null);
  assert.equal(parseMomo(null), null);
});

test('webhook signature check', () => {
  const secret = 's3cret', ts = '1700000000', body = '{"a":1}', now = 1700000100;
  const sig = 'v1=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  assert.equal(verifySignature(secret, ts, sig, body, now), true);
  assert.equal(verifySignature(secret, ts, sig, body + ' ', now), false, 'body changed');
  assert.equal(verifySignature('other', ts, sig, body, now), false, 'wrong secret');
  assert.equal(verifySignature(secret, ts, sig, body, now + 5000), false, 'too old (replay)');
  assert.equal(verifySignature(secret, '', sig, body, now), false);
});
