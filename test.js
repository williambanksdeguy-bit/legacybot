// Smoke test: boots the app and exercises the main flows.
// Needs TEST_DATABASE_URL pointing at a THROWAWAY Postgres database (e.g. a second Neon branch/project).
// It DROPS the users, audit and settings tables first, so never point it at real data.
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
  await c.query('DROP TABLE IF EXISTS users, audit, settings');
  await c.end();
  const app = require('./server');
  await app.ready;
  run(app);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

function run(app) {
const server = app.listen(0, async () => {
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
    process.exit(process.exitCode || 0);
  }
});
}
