// Unit tests for the email module (no network): node --test email.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const mailer = require('./email');
const T = mailer.templates;

test('sender address parsing', () => {
  assert.deepEqual(mailer.parseFrom('Legacy Bot <noreply@legacysbot.com>'), { name: 'Legacy Bot', email: 'noreply@legacysbot.com' });
  assert.deepEqual(mailer.parseFrom('"Legacy Bot" <noreply@legacysbot.com>'), { name: 'Legacy Bot', email: 'noreply@legacysbot.com' });
  assert.deepEqual(mailer.parseFrom('noreply@legacysbot.com'), { name: '', email: 'noreply@legacysbot.com' });
});

test('email stays off until both settings exist, and sending then fails politely', async () => {
  const keep = { k: process.env.EMAIL_API_KEY, f: process.env.EMAIL_FROM };
  delete process.env.EMAIL_API_KEY; delete process.env.EMAIL_FROM;
  assert.equal(mailer.configured(), false);
  const r = await mailer.send({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
  assert.equal(r.ok, false);
  process.env.EMAIL_API_KEY = 'x';
  assert.equal(mailer.configured(), false, 'key alone is not enough');
  process.env.EMAIL_FROM = 'A <a@b.com>';
  assert.equal(mailer.configured(), true);
  if (keep.k === undefined) delete process.env.EMAIL_API_KEY; else process.env.EMAIL_API_KEY = keep.k;
  if (keep.f === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = keep.f;
});

test('every template has a subject, html and text, and carries its link', () => {
  const link = 'https://legacysbot.com/x?token=abc';
  const all = [
    T.verify({ link }), T.reset({ link }), T.approved({ link }), T.rejected({ note: 'n', link }), T.expired({ link }),
    T.receipt({ plan: '1 Month', days: 30, amount: 138600, currency: 'UGX', method: 'card', endsAt: '2026-12-03T00:00:00Z', link }),
    T.expiring({ plan: '1 Month', endsAt: '2026-12-03T00:00:00Z', daysLeft: 3, link }),
  ];
  for (const t of all) {
    assert.ok(t.subject && t.html && t.text);
    assert.ok(t.html.includes(link), 'html has the link: ' + t.subject);
    assert.ok(t.text.includes(link), 'text has the link: ' + t.subject);
  }
  for (const t of [T.adminSignup({ email: 'a@b.com' }), T.adminPayment({ email: 'a@b.com', plan: 'p', amount: 1, currency: 'UGX', method: 'card' }), T.adminCrypto({ email: 'a@b.com', network: 'n', amount: '1', proof: 'p' }), T.test()]) {
    assert.ok(t.subject && t.html && t.text);
  }
  assert.match(T.receipt({ plan: 'P', days: 30, amount: 138600, currency: 'UGX', method: 'card', endsAt: '2026-12-03', link }).html, /138,600/);
});

test('text from users cannot inject HTML into emails', () => {
  const evil = '<script>alert(1)</script>"><img src=x onerror=1>';
  for (const t of [
    T.rejected({ note: evil, link: 'https://x.test/' }),
    T.adminSignup({ email: evil }),
    T.adminCrypto({ email: evil, network: evil, amount: evil, proof: evil }),
    T.receipt({ plan: evil, days: 1, amount: 1, currency: 'UGX', method: 'card', endsAt: null, link: 'https://x.test/' }),
  ]) {
    assert.ok(!t.html.includes('<script>'), t.subject);
    assert.ok(!t.html.includes('<img src=x'), t.subject);
  }
});

test('no link means no broken button', () => {
  assert.ok(!T.expired({ link: '' }).html.includes('<a href'));
});
