// Smoke test: boots the app and exercises the main flows.
// Needs TEST_DATABASE_URL pointing at a THROWAWAY Postgres database (e.g. a second Neon branch/project).
// It DROPS the users, audit, settings, plans and orders tables first, so never point it at real data.
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) { console.error('Set TEST_DATABASE_URL to a throwaway database first.'); process.exit(1); }
process.env.DATABASE_URL = TEST_URL;
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.ADMIN_PASSWORD = 'AdminPassword123!';
const assert = require('assert');
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS email_log, email_tokens, orders, plans, users, audit, settings');
  await c.end();
  const app = require('./server');
  await app.ready;
  run(app);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

function run(app) {
const c2 = new Client({ connectionString: TEST_URL });
const server = app.listen(0, async () => {
  await c2.connect();
  const base = 'http://127.0.0.1:' + server.address().port;
  const jar = {};
  const call = async (who, method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: jar[who] || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) jar[who] = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  try {
    assert.equal((await call('u', 'GET', '/api/me')).status, 401, 'me requires login');
    assert.equal((await call('u', 'POST', '/api/register', { email: 'a@b.com', password: 'short' })).status, 400);
    assert.equal((await call('u', 'POST', '/api/register', { email: 'a@b.com', password: 'longenough123' })).status, 200);

    // MT5 details are locked until the payment is approved
    const acct = { broker: 'exness', mt5_login: '484054192', mt5_server: 'Exness-MT5Real35', mt5_investor: 'invpass1' };
    assert.equal((await call('u', 'PUT', '/api/me/account', acct)).status, 403, 'account locked before approval');
    assert.equal((await call('u', 'PUT', '/api/me/bot', { running: true })).status, 403, 'bot locked before approval');
    assert.equal((await call('u', 'PUT', '/api/me/payment', { pay_network: 'USDT', pay_amount: '100', pay_proof: 'abc123abc123' })).status, 200);
    assert.equal((await call('u', 'PUT', '/api/me/account', acct)).status, 403, 'still locked while pending');
    assert.equal((await call('u', 'PUT', '/api/me/contact', { whatsapp: '12' })).status, 400);
    assert.equal((await call('u', 'PUT', '/api/me/contact', { whatsapp: '+256 700 000 111' })).status, 200);

    assert.equal((await call('u', 'GET', '/api/admin/users')).status, 403, 'user cannot hit admin');
    assert.equal((await call('u', 'PUT', '/api/admin/settings', { contact_email: 'x@y.com' })).status, 403);
    assert.equal((await call('a', 'POST', '/api/login', { email: 'admin@test.com', password: 'wrong' })).status, 401);
    assert.equal((await call('a', 'POST', '/api/login', { email: 'admin@test.com', password: 'AdminPassword123!' })).status, 200);

    let users = (await call('a', 'GET', '/api/admin/users')).data;
    assert.equal(users.length, 1);
    assert.equal(users[0].whatsapp, '256700000111');
    assert.equal((await call('a', 'POST', `/api/admin/users/${users[0].id}/status`, { status: 'approved' })).status, 200);

    // now the client can enter MT5 details
    assert.equal((await call('u', 'PUT', '/api/me/account', acct)).status, 200, 'account opens after approval');
    const me = (await call('u', 'GET', '/api/me')).data;
    assert.equal(me.status, 'approved');
    assert.equal(me.has_investor_password, true);
    assert.ok(!('mt5_investor_enc' in me) && !('pass_hash' in me), 'no secrets leak to client');

    // bot start / stop
    assert.equal((await call('u', 'PUT', '/api/me/bot', { running: 'yes' })).status, 400, 'running must be a boolean');
    assert.equal((await call('u', 'PUT', '/api/me/bot', { running: true })).status, 200);
    assert.equal((await call('u', 'GET', '/api/me')).data.bot_running, true, 'bot is running');
    assert.equal((await call('u', 'PUT', '/api/me/bot', { running: false })).status, 200);
    assert.equal((await call('u', 'GET', '/api/me')).data.bot_running, false, 'bot is stopped');
    // un-approving a client switches their bot off
    await call('u', 'PUT', '/api/me/bot', { running: true });
    assert.equal((await call('a', 'POST', `/api/admin/users/${me.id}/status`, { status: 'pending' })).status, 200);
    assert.equal((await call('u', 'GET', '/api/me')).data.bot_running, false, 'bot switched off when approval is withdrawn');
    assert.equal((await call('u', 'PUT', '/api/me/bot', { running: true })).status, 403, 'cannot start while not approved');
    await call('a', 'POST', `/api/admin/users/${me.id}/status`, { status: 'approved' });

    users = (await call('a', 'GET', '/api/admin/users')).data;
    assert.ok(!JSON.stringify(users).includes('invpass1'), 'password not in list');
    const rev = await call('a', 'POST', `/api/admin/users/${users[0].id}/reveal`, {});
    assert.equal(rev.data.password, 'invpass1', 'reveal decrypts correctly');

    // contact settings
    assert.equal((await call('a', 'PUT', '/api/admin/settings', { contact_email: 'not-an-email', contact_whatsapp: '' })).status, 400);
    assert.equal((await call('a', 'PUT', '/api/admin/settings', { contact_email: 'Help@Legacybot.live', contact_whatsapp: '+256 701 234 567' })).status, 200);
    const cfg = (await call('u', 'GET', '/api/config')).data;
    assert.equal(cfg.contactEmail, 'help@legacybot.live');
    assert.equal(cfg.contactWhatsapp, '256701234567');

    // plans and prices (admin-only, validated)
    assert.equal((await call('u', 'GET', '/api/admin/plans')).status, 403, 'user cannot read admin plans');
    assert.equal((await call('u', 'POST', '/api/admin/plans', { name: 'x', days: 30, price_usd: '5' })).status, 403);
    let pl = (await call('a', 'GET', '/api/admin/plans')).data;
    assert.equal(pl.plans.length, 4, 'starting plans are seeded');
    assert.equal((await call('a', 'POST', '/api/admin/plans', { name: '', days: 30, price_usd: '5' })).status, 400);
    assert.equal((await call('a', 'POST', '/api/admin/plans', { name: 'Test', days: 30, price_usd: 'abc' })).status, 400);
    const added = await call('a', 'POST', '/api/admin/plans', { name: 'Test', days: 7, price_usd: '10', tax_usd: '1', active: true });
    assert.equal(added.status, 200);
    assert.equal((await call('a', 'PUT', `/api/admin/plans/${added.data.id}`, { name: 'Test', days: 7, price_usd: '12', tax_usd: '1', active: false })).status, 200);
    assert.equal((await call('u', 'GET', '/api/plans')).data.plans.some((p) => p.name === 'Test'), false, 'hidden plans are not shown to clients');
    assert.equal((await call('a', 'PUT', '/api/admin/rates', { UGX: 'abc' })).status, 400);
    assert.equal((await call('a', 'PUT', '/api/admin/rates', { UGX: '3800' })).status, 200);
    assert.equal((await call('a', 'DELETE', `/api/admin/plans/${added.data.id}`, {})).status, 200);
    // no MarzPay keys in the test environment: paying online is refused cleanly
    assert.equal((await call('u', 'POST', '/api/me/pay', { plan_id: pl.plans[0].id, phone: '0772123456' })).status, 503);
    // webhook with nothing useful in it is harmless
    assert.equal((await call('u', 'POST', '/api/webhooks/marzpay', { hello: 'world' })).status, 200);

    // approving by hand with days, then the plan running out
    assert.equal((await call('a', 'POST', `/api/admin/users/${me.id}/status`, { status: 'approved', days: 'abc' })).status, 400);
    assert.equal((await call('a', 'POST', `/api/admin/users/${me.id}/status`, { status: 'approved', days: '30' })).status, 200);
    assert.ok((await call('u', 'GET', '/api/me')).data.plan_ends_at, 'end date set');
    await c2.query("UPDATE users SET plan_ends_at = now() - interval '1 day' WHERE id=$1", [me.id]);
    const exp = (await call('u', 'GET', '/api/me')).data;
    assert.equal(exp.status, 'expired', 'plan that ran out is expired');
    assert.equal(exp.bot_running, false);
    assert.equal((await call('u', 'PUT', '/api/me/bot', { running: true })).status, 403, 'cannot start the bot after expiry');
    await call('a', 'POST', `/api/admin/users/${me.id}/status`, { status: 'approved' });
    assert.equal((await call('u', 'GET', '/api/me')).data.plan_ends_at, null, 'approved with no days = no end date');

    // email (not configured in tests): sign-ups are confirmed straight away, and the new endpoints behave
    assert.equal((await call('u', 'GET', '/api/me')).data.email_verified, true, 'no email service = nothing to confirm');
    assert.equal((await call('u', 'POST', '/api/forgot', { email: 'nobody@nowhere.com' })).status, 200, 'forgot never reveals who has an account');
    assert.equal((await call('u', 'POST', '/api/reset', { token: 'not-a-real-token', password: 'longenough123' })).status, 400);
    assert.equal((await call('u', 'POST', '/api/reset', { token: 'x', password: 'short' })).status, 400);
    assert.equal((await call('u', 'GET', '/api/verify?token=nope')).status, 200, 'bad confirm link ends on the failed page');
    assert.equal((await call('u', 'GET', '/api/cron/sweep')).status, 404, 'cron is off without CRON_KEY');
    assert.equal((await call('u', 'GET', '/api/admin/emails')).status, 403);
    assert.equal((await call('a', 'GET', '/api/admin/emails')).data.enabled, false);
    assert.equal((await call('a', 'POST', '/api/admin/email-test', {})).status, 400);
    assert.equal((await call('u', 'POST', '/api/admin/users/1/verify', {})).status, 403);

    // delete
    assert.equal((await call('a', 'DELETE', `/api/admin/users/${users[0].id}`, {})).status, 200);
    assert.equal((await call('a', 'GET', '/api/admin/users')).data.length, 0);
    assert.equal((await call('u', 'GET', '/api/me')).status, 401, 'deleted user is signed out');
    console.log('All checks passed');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
    await c2.end().catch(() => {});
    process.exit(process.exitCode || 0);
  }
});
}
