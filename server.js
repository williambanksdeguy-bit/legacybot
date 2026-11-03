const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const marz = require('./marz');
const mailer = require('./email');
const T = mailer.templates;
const { MARKETS, normalizePhone, parseMoneyCents, centsToStr, parseRate, localCharge, acceptPayment, PENDING_MINUTES } = require('./pricing');

// ---- optional .env loader (no extra dependency) ----
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (PROD ? null : 'dev-secret-change-me');
const ENC_RAW = process.env.ENC_KEY || (PROD ? null : 'dev-key-not-for-production-use-0000');
if (!JWT_SECRET || !ENC_RAW || (PROD && (JWT_SECRET.length < 32 || ENC_RAW.length < 32))) {
  console.error('Set JWT_SECRET and ENC_KEY (each at least 32 random characters) before running in production.');
  process.exit(1);
}
// Any long random text works. A 64-character hex string is used as-is; anything else is hashed into a key.
const ENC_KEY = /^[0-9a-f]{64}$/i.test(ENC_RAW)
  ? Buffer.from(ENC_RAW, 'hex')
  : crypto.createHash('sha256').update(ENC_RAW).digest();

// ---- encryption for MT5 passwords ----
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ---- database (Postgres, e.g. Neon) ----
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to your Postgres connection string (postgresql://...).');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
});
// Neon closes idle connections; log it instead of crashing
pool.on('error', (e) => console.error('Idle database connection error:', e.message));
const q = (text, params) => pool.query(text, params);

async function getSetting(key, fallback = '') {
  const { rows } = await q('SELECT value FROM settings WHERE key=$1', [key]);
  return rows[0] ? rows[0].value : fallback;
}
async function setSetting(key, value) {
  await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
}

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      broker TEXT, mt5_login TEXT, mt5_server TEXT, mt5_investor_enc TEXT,
      pay_network TEXT, pay_amount TEXT, pay_proof TEXT,
      whatsapp TEXT,
      admin_note TEXT,
      created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS audit (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER, action TEXT, target_id INTEGER, ip TEXT,
      created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    )`);
  await q('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // Bot on/off switch the client controls from their dashboard (added after first release)
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_running BOOLEAN NOT NULL DEFAULT false');
  // Paid plans: when access ends (NULL = no end date, e.g. approved by hand after a crypto payment)
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_name TEXT');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_ends_at TIMESTAMPTZ');
  // Email: confirmation, reminders, password reset
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS expiry_warned_at TIMESTAMPTZ');
  await q(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      to_email TEXT, subject TEXT, status TEXT, error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // People who signed up before email existed are treated as confirmed (one time only)
  if (!(await q("SELECT 1 FROM settings WHERE key='email_verify_migrated'")).rowCount) {
    await q('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');
    await setSetting('email_verify_migrated', '1');
  }
  // Phone number (required at sign-up) and one-time email codes for sign-up / login
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT');
  await q(`
    CREATE TABLE IF NOT EXISTS login_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, days INTEGER NOT NULL,
      price_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL DEFAULT 0,
      note TEXT, active BOOLEAN NOT NULL DEFAULT true, sort INTEGER NOT NULL DEFAULT 0
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, email TEXT,
      plan_id INTEGER, plan_name TEXT NOT NULL, days INTEGER NOT NULL,
      currency TEXT NOT NULL, total_cents INTEGER NOT NULL, rate NUMERIC NOT NULL, charged INTEGER NOT NULL,
      phone TEXT, status TEXT NOT NULL DEFAULT 'PENDING', reference TEXT UNIQUE NOT NULL,
      marz_uuid TEXT, note TEXT, last_check TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ
    )`);
  await q("ALTER TABLE orders ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'mobile_money'");
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS marz_ref TEXT');
  // Starting prices (edit them in the admin panel). Only added when there are no plans at all.
  const hasPlans = await q('SELECT 1 FROM plans LIMIT 1');
  if (!hasPlans.rowCount) {
    for (const [i, [name, days, price]] of [['1 Month', 30, 3000], ['3 Months', 90, 6000], ['6 Months', 180, 11700], ['1 Year', 365, 23000]].entries()) {
      await q('INSERT INTO plans (name, days, price_cents, tax_cents, sort) VALUES ($1,$2,$3,300,$4)', [name, days, price, i]);
    }
  }
  await q("ALTER TABLE orders ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'UG'");
  // Rates are kept per country now (rate_UG, rate_KE ...). Carry over an older rate_UGX, otherwise start Uganda at 4200.
  const oldUg = await getSetting('rate_UGX', '');
  await q("INSERT INTO settings (key, value) VALUES ('rate_UG', $1) ON CONFLICT (key) DO NOTHING", [oldUg || '4200']);
  const admin = await q("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (!admin.rowCount && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await q("INSERT INTO users (email, pass_hash, role, status, email_verified_at) VALUES ($1,$2,'admin','approved', now()) ON CONFLICT (email) DO NOTHING",
      [process.env.ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12)]);
    console.log('Admin account created for', process.env.ADMIN_EMAIL);
  }
}
const ready = init();
ready.catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });

// ---- app ----
const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
    },
  },
}));

// Health check for the host: does not touch the database, so it never wakes Neon
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// rawBody is kept so the MarzPay webhook signature can be checked
app.use(express.json({ limit: '20kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(cookieParser());

// Wait for the tables to exist before serving any /api request
app.use('/api', (_req, _res, next) => ready.then(() => next(), next));

// Require JSON content type on writes (blocks simple cross-site form posts)
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

// Express 4 does not catch rejected promises, so every async route goes through this
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function setSession(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('lb_session', token, { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 8 * 3600 * 1000 });
}
async function auth(req, res, next) {
  let p;
  try { p = jwt.verify(req.cookies.lb_session, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Not signed in' }); }
  try {
    const { rows } = await q('SELECT * FROM users WHERE id=$1', [p.id]);
    if (!rows[0]) return res.status(401).json({ error: 'Not signed in' });
    let u = rows[0];
    // A plan that has run out switches the client to "expired" (and the bot off) the moment they next use the site
    if (u.role === 'user' && u.status === 'approved' && u.plan_ends_at && new Date(u.plan_ends_at) < new Date()) {
      const r = await q("UPDATE users SET status='expired', bot_running=false WHERE id=$1 AND status='approved' AND plan_ends_at < now() RETURNING *", [u.id]);
      if (r.rows[0]) { u = r.rows[0]; fire(u.email, T.expired({ link: baseUrl(req) + '/#/plans' })); }
    }
    req.user = u;
    next();
  } catch (e) { next(e); }
}
// Role is read from the database on every request, never trusted from the browser
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}
async function audit(req, action, targetId) {
  await q('INSERT INTO audit (admin_id, action, target_id, ip) VALUES ($1,$2,$3,$4)', [req.user.id, action, targetId ?? null, req.ip]);
}
// Ids in URLs must be plain integers, otherwise Postgres would throw
const idParam = (req) => (/^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null);

const clean = (s, max = 120) => String(s ?? '').trim().slice(0, max);
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const phoneOk = (d) => d === '' || (d.length >= 7 && d.length <= 15);

function publicUser(u) {
  return {
    id: u.id, email: u.email, role: u.role, status: u.status,
    broker: u.broker, mt5_login: u.mt5_login, mt5_server: u.mt5_server,
    has_investor_password: !!u.mt5_investor_enc,
    pay_network: u.pay_network, pay_amount: u.pay_amount, pay_proof: u.pay_proof,
    whatsapp: u.whatsapp, phone: u.phone, admin_note: u.admin_note, created_at: u.created_at,
    bot_running: !!u.bot_running,
    email_verified: !!u.email_verified_at,
    plan_name: u.plan_name || null,
    plan_ends_at: u.plan_ends_at ? new Date(u.plan_ends_at).toISOString() : null,
  };
}

// Switch every approved client whose plan has run out to "expired" (and stop their bot).
async function expireDue() {
  const { rows } = await q("UPDATE users SET status='expired', bot_running=false WHERE role='user' AND status='approved' AND plan_ends_at IS NOT NULL AND plan_ends_at < now() RETURNING email");
  for (const u of rows) fire(u.email, T.expired({ link: baseUrl() ? baseUrl() + '/#/plans' : '' }));
}

// Plans ending within 3 days get one reminder email (reset when they renew)
async function remindDue() {
  const { rows } = await q(`UPDATE users SET expiry_warned_at=now()
    WHERE role='user' AND status='approved' AND plan_ends_at IS NOT NULL AND plan_ends_at > now()
      AND plan_ends_at < now() + interval '3 days' AND expiry_warned_at IS NULL
    RETURNING email, plan_name, plan_ends_at`);
  for (const u of rows) {
    const daysLeft = Math.max(1, Math.ceil((new Date(u.plan_ends_at) - Date.now()) / 86400000));
    fire(u.email, T.expiring({ plan: u.plan_name, endsAt: u.plan_ends_at, daysLeft, link: baseUrl() ? baseUrl() + '/#/plans' : '' }));
  }
}

// ---- email helpers (nothing here can break a request: failures are logged and ignored) ----
let lastBase = '';
function baseUrl(req) {
  const b = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : req ? `${req.protocol}://${req.get('host')}` : lastBase;
  if (b) lastBase = b;
  return b || lastBase;
}
const adminEmail = () => process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || '';
async function sendMail(to, tpl) {
  const r = await mailer.send({ to, ...tpl });
  await q('INSERT INTO email_log (to_email, subject, status, error) VALUES ($1,$2,$3,$4)', [to, tpl.subject, r.ok ? 'sent' : 'failed', r.error || null]).catch(() => {});
  return r;
}
function fire(to, tpl) {
  if (!to || !mailer.configured()) return;
  sendMail(to, tpl).catch((e) => console.error('email failed', e.message));
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
async function makeToken(userId, kind, hours) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO email_tokens (user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4::int))', [userId, kind, sha(raw), hours]);
  return raw;
}
// One-time use: returns the user id, or null if the token is wrong, used or expired
async function takeToken(raw, kind) {
  const r = await q('UPDATE email_tokens SET used_at=now() WHERE token_hash=$1 AND kind=$2 AND used_at IS NULL AND expires_at > now() RETURNING user_id', [sha(String(raw).slice(0, 100)), kind]);
  return r.rows[0] ? r.rows[0].user_id : null;
}
async function sendVerification(u, req) {
  const raw = await makeToken(u.id, 'verify', 48);
  fire(u.email, T.verify({ link: `${baseUrl(req)}/api/verify?token=${raw}` }));
}
// Buying needs a confirmed email, but only when email is set up (otherwise nobody could ever confirm)
const needsVerify = (u) => mailer.configured() && process.env.REQUIRE_EMAIL_VERIFY !== 'off' && !u.email_verified_at;
const VERIFY_MSG = 'Please confirm your email first. Check your inbox (and spam) for our message, or press "Send again" on your dashboard.';


// ---- email codes (2-step sign-in) ----
// Needs email to be set up; REQUIRE_2FA=off turns it off. Codes: 6 digits, 10 minutes, 5 tries, stored hashed.
const twoFactorOn = () => mailer.configured() && process.env.REQUIRE_2FA !== 'off';
const CODE_MINUTES = 10, CODE_TRIES = 5, CODE_COOLDOWN_S = 60;
const codeHash = (userId, code) => sha(`${JWT_SECRET}:${userId}:${code}`);
function challengeToken(userId, purpose) { return jwt.sign({ id: userId, purpose, c: 1 }, JWT_SECRET, { expiresIn: CODE_MINUTES * 60 }); }
function readChallenge(tok) {
  try { const p = jwt.verify(String(tok || ''), JWT_SECRET); return p.c === 1 ? p : null; } catch { return null; }
}
// Returns false if a code was sent less than a minute ago
async function issueCode(user, purpose) {
  const recent = await q("SELECT 1 FROM login_codes WHERE user_id=$1 AND created_at > now() - make_interval(secs => $2::int)", [user.id, CODE_COOLDOWN_S]);
  if (recent.rowCount) return false;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await q('UPDATE login_codes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [user.id]);
  await q('INSERT INTO login_codes (user_id, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4::int))', [user.id, purpose, codeHash(user.id, code), CODE_MINUTES]);
  const r = await sendMail(user.email, T.code({ code, minutes: CODE_MINUTES, purpose }));
  if (!r.ok) console.error('code email failed:', r.error);
  return true;
}

// ---- online payments (MarzPay) ----
const lastPoll = new Map(); // order id -> ms of the last MarzPay lookup, so a polling browser cannot hammer the API

// Marks an order paid exactly once and gives the client their days. Safe to call repeatedly.
async function settleOrder(orderId, note, lastCheck) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      "UPDATE orders SET status='PAID', paid_at=now(), note=$2, last_check=COALESCE($3, last_check) WHERE id=$1 AND status<>'PAID' RETURNING *",
      [orderId, note, lastCheck || null]);
    if (r.rowCount && r.rows[0].user_id) {
      const o = r.rows[0];
      await c.query(
        `UPDATE users SET status='approved', admin_note=NULL, plan_name=$2,
           plan_ends_at = GREATEST(now(), COALESCE(plan_ends_at, now())) + make_interval(days => $3), expiry_warned_at = NULL
         WHERE id=$1`, [o.user_id, o.plan_name, o.days]);
    }
    await c.query('COMMIT');
    if (r.rowCount) afterPaid(r.rows[0]).catch((e) => console.error('receipt failed', e.message));
    return r.rowCount > 0;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function afterPaid(o) {
  if (!mailer.configured()) return;
  const u = o.user_id ? (await q('SELECT email, plan_ends_at FROM users WHERE id=$1', [o.user_id])).rows[0] : null;
  if (u) fire(u.email, T.receipt({ plan: o.plan_name, days: o.days, amount: o.charged, currency: o.currency, method: o.method, endsAt: u.plan_ends_at, link: baseUrl() ? baseUrl() + '/#/dashboard' : '' }));
  fire(adminEmail(), T.adminPayment({ email: o.email || '', plan: o.plan_name, amount: o.charged, currency: o.currency, method: o.method }));
}

// Asks MarzPay for the real status of an order and acts on it. The webhook only tells us WHICH order to look at.
async function checkOrder(id, { force = false } = {}) {
  const get = async () => (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0] || null;
  const o = await get();
  if (!o || o.status === 'PAID' || o.status === 'FAILED') return o;

  const now = Date.now();
  if (!force && now - (lastPoll.get(id) || 0) < 4000) return o;
  lastPoll.set(id, now);

  const st = await marz.fetchTransaction(o.marz_uuid || o.reference);
  const ageMin = (now - new Date(o.created_at).getTime()) / 60000;
  if (!st) {
    await q('UPDATE orders SET last_check=$2 WHERE id=$1', [id, 'MarzPay did not return a status']);
  } else if (st.state === 'failed') {
    await q("UPDATE orders SET status='FAILED', note='Payment failed or was cancelled', last_check=$2 WHERE id=$1 AND status IN ('PENDING','EXPIRED')", [id, JSON.stringify(st)]);
  } else if (st.state === 'completed') {
    const verdict = acceptPayment(o, st, { allowSandbox: process.env.MARZPAY_ALLOW_SANDBOX === 'true' });
    if (verdict.ok) await settleOrder(id, st.providerTxnId ? `momo:${st.providerTxnId}` : null, JSON.stringify(st));
    else await q('UPDATE orders SET last_check=$2, note=$3 WHERE id=$1', [id, JSON.stringify(st), verdict.reason]);
  } else {
    await q('UPDATE orders SET last_check=$2 WHERE id=$1', [id, JSON.stringify(st)]);
  }
  // Unpaid for too long: expire it (a late confirmation can still revive it on the next check)
  if (ageMin > PENDING_MINUTES) await q("UPDATE orders SET status='EXPIRED' WHERE id=$1 AND status='PENDING'", [id]);
  return get();
}

// Rate per country, as numbers (or as the saved text when raw = true). Only countries with a rate are switched on.
async function countryRates(raw = false) {
  const out = {};
  for (const code of Object.keys(MARKETS)) {
    const v = await getSetting('rate_' + code, '');
    const n = parseRate(v);
    if (n) out[code] = raw ? v : n;
  }
  return out;
}

function parsePlan(b) {
  const name = clean(b.name, 60);
  const days = /^\d{1,4}$/.test(String(b.days ?? '').trim()) ? Number(String(b.days).trim()) : 0;
  const price = parseMoneyCents(b.price_usd);
  const tax = parseMoneyCents(b.tax_usd === '' || b.tax_usd == null ? '0' : b.tax_usd);
  if (!name) return { error: 'Give the plan a name' };
  if (days < 1 || days > 3650) return { error: 'Days must be between 1 and 3650' };
  if (price === null || price <= 0) return { error: 'Enter a price in dollars, like 30 or 29.99' };
  if (tax === null) return { error: 'Tax must be a number in dollars, like 3' };
  const sort = /^-?\d{1,5}$/.test(String(b.sort ?? '0').trim()) ? Number(String(b.sort ?? '0').trim()) : 0;
  return { v: { name, days, price_cents: price, tax_cents: tax, note: clean(b.note, 100) || null, active: !(b.active === false || b.active === 'false'), sort } };
}

// ---- public API ----
app.get('/api/config', ah(async (_req, res) => {
  res.json({
    payNetwork: process.env.PAY_NETWORK || '',
    payAddress: process.env.PAY_ADDRESS || '',
    payAmount: process.env.PAY_AMOUNT || '',
    contactEmail: await getSetting('contact_email', process.env.CONTACT_EMAIL || ''),
    contactWhatsapp: digits(await getSetting('contact_whatsapp', process.env.CONTACT_WHATSAPP || '')),
    emailEnabled: mailer.configured(),
    requireVerify: mailer.configured() && process.env.REQUIRE_EMAIL_VERIFY !== 'off',
  });
}));

// Plans with their local-currency prices (public, so the plans can be shown before sign-up)
app.get('/api/plans', ah(async (_req, res) => {
  const { rows } = await q('SELECT * FROM plans WHERE active ORDER BY sort, id');
  const rates = await countryRates();
  const markets = marz.configured()
    ? Object.entries(MARKETS).filter(([code]) => rates[code]).map(([code, m]) => ({ code, name: m.name, currency: m.currency, example: m.example }))
    : [];
  // Card collection is UGX only, so it is offered only while Uganda is switched on
  const cardOk = markets.some((m) => m.code === 'UG') && process.env.CARD_PAYMENTS !== 'off';
  res.json({
    markets,
    methods: markets.length ? (cardOk ? ['mobile_money', 'card'] : ['mobile_money']) : [],
    plans: rows.map((p) => {
      const total = p.price_cents + p.tax_cents;
      const prices = {};
      for (const m of markets) prices[m.code] = localCharge(total, rates[m.code], MARKETS[m.code].step);
      return { id: p.id, name: p.name, days: p.days, note: p.note, price_usd: centsToStr(p.price_cents), tax_usd: centsToStr(p.tax_cents), total_usd: centsToStr(total), prices };
    }),
  });
}));

// MarzPay calls this when a payment finishes. The body is never trusted: it only says WHICH order to re-check with MarzPay.
app.post('/api/webhooks/marzpay', ah(async (req, res) => {
  const secret = process.env.MARZPAY_SIGNING_SECRET;
  if (secret && !marz.verifySignature(secret, req.get('x-marzpay-timestamp') || '', req.get('x-marzpay-signature') || '', req.rawBody || '')) {
    return res.status(401).json({ error: 'bad signature' });
  }
  const parsed = marz.parseMomo(req.body);
  if (parsed && (parsed.reference || parsed.uuid)) {
    const { rows } = await q('SELECT id FROM orders WHERE reference=$1 OR marz_ref=$1 OR marz_uuid=$2', [parsed.reference || '', parsed.uuid || '']);
    if (rows[0]) await checkOrder(rows[0].id, { force: true }).catch((e) => console.error('order check failed', e.message));
  }
  res.json({ ok: true });
}));

// After a card payment MarzPay sends the customer's browser back to the same callback address. Send them on to the status page.
app.get('/api/webhooks/marzpay', ah(async (req, res) => {
  const ref = String(req.query.ref || '').slice(0, 80);
  const { rows } = await q('SELECT id FROM orders WHERE reference=$1', [ref]);
  res.redirect(302, rows[0] ? `/#/pay/${rows[0].id}` : '/#/dashboard');
}));

app.post('/api/register', authLimiter, ah(async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const phone = digits(clean(req.body.phone, 30));
  if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });
  if (phone === '' || !phoneOk(phone)) return res.status(400).json({ error: 'Enter your phone number with country code, e.g. +256700000000' });
  const r = await q('INSERT INTO users (email, pass_hash, phone) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id',
    [email, bcrypt.hashSync(password, 12), phone]);
  if (!r.rowCount) return res.status(409).json({ error: 'Email already registered' });
  const user = { id: r.rows[0].id, email, role: 'user' };
  if (mailer.configured()) fire(adminEmail(), T.adminSignup({ email }));
  if (twoFactorOn()) {
    await issueCode(user, 'register');
    return res.json({ ok: true, need_code: true, challenge: challengeToken(user.id, 'register'), email });
  }
  await q('UPDATE users SET email_verified_at=now() WHERE id=$1', [user.id]); // no email service: nothing to confirm
  setSession(res, user);
  res.json({ ok: true, role: 'user' });
}));

app.post('/api/login', authLimiter, ah(async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const { rows } = await q('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (twoFactorOn()) {
    await issueCode(u, 'login');
    return res.json({ ok: true, need_code: true, challenge: challengeToken(u.id, 'login'), email: u.email });
  }
  setSession(res, u);
  res.json({ ok: true, role: u.role });
}));

// Step 2: the 6-digit code from the email
app.post('/api/verify-code', authLimiter, ah(async (req, res) => {
  const ch = readChallenge(req.body.challenge);
  if (!ch) return res.status(401).json({ error: 'This sign-in has expired. Please start again.' });
  const code = digits(req.body.code);
  const { rows } = await q('SELECT * FROM login_codes WHERE user_id=$1 AND used_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1', [ch.id]);
  const row = rows[0];
  if (!row || row.attempts >= CODE_TRIES) return res.status(401).json({ error: 'That code has expired or was used too many times. Press "Send a new code".' });
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(codeHash(ch.id, code)), Buffer.from(row.code_hash));
  if (!ok) {
    await q('UPDATE login_codes SET attempts = attempts + 1 WHERE id=$1', [row.id]);
    return res.status(401).json({ error: 'Wrong code. Check the latest email and try again.' });
  }
  const used = await q('UPDATE login_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id', [row.id]);
  if (!used.rowCount) return res.status(401).json({ error: 'That code was already used.' });
  const u = (await q('SELECT * FROM users WHERE id=$1', [ch.id])).rows[0];
  if (!u) return res.status(401).json({ error: 'Account not found' });
  if (!u.email_verified_at) await q('UPDATE users SET email_verified_at=now() WHERE id=$1', [u.id]); // a working code proves the inbox
  setSession(res, u);
  res.json({ ok: true, role: u.role });
}));

app.post('/api/resend-code', authLimiter, ah(async (req, res) => {
  const ch = readChallenge(req.body.challenge);
  if (!ch) return res.status(401).json({ error: 'This sign-in has expired. Please start again.' });
  const u = (await q('SELECT id, email FROM users WHERE id=$1', [ch.id])).rows[0];
  if (!u) return res.status(401).json({ error: 'Account not found' });
  const sent = await issueCode(u, ch.purpose);
  res.json(sent ? { ok: true } : { ok: false, error: `Please wait ${CODE_COOLDOWN_S} seconds before asking for another code.` });
}));

app.post('/api/logout', (_req, res) => { res.clearCookie('lb_session'); res.json({ ok: true }); });

// The link in the confirmation email lands here
app.get('/api/verify', ah(async (req, res) => {
  const uid = await takeToken(req.query.token, 'verify');
  if (!uid) return res.redirect(302, '/#/verify-failed');
  await q('UPDATE users SET email_verified_at=now() WHERE id=$1', [uid]);
  res.redirect(302, '/#/verified');
}));

// Forgot password: always answers the same, so nobody can use it to find out who has an account
app.post('/api/forgot', authLimiter, ah(async (req, res) => {
  const em = clean(req.body.email, 200).toLowerCase();
  if (emailOk(em) && mailer.configured()) {
    const { rows } = await q("SELECT id, email FROM users WHERE email=$1 AND role='user'", [em]);
    if (rows[0]) {
      const raw = await makeToken(rows[0].id, 'reset', 1);
      fire(rows[0].email, T.reset({ link: `${baseUrl(req)}/#/reset/${raw}` }));
    }
  }
  res.json({ ok: true });
}));

app.post('/api/reset', authLimiter, ah(async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });
  const uid = await takeToken(req.body.token, 'reset');
  if (!uid) return res.status(400).json({ error: 'This reset link is not valid any more. Ask for a new one.' });
  await q("UPDATE users SET pass_hash=$1 WHERE id=$2 AND role='user'", [bcrypt.hashSync(password, 12), uid]);
  await q("UPDATE email_tokens SET used_at=now() WHERE user_id=$1 AND kind='reset' AND used_at IS NULL", [uid]);
  res.json({ ok: true });
}));

// ---- user API ----
app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

app.post('/api/me/resend-verification', auth, ah(async (req, res) => {
  if (req.user.email_verified_at) return res.json({ ok: true, already: true });
  if (!mailer.configured()) return res.status(503).json({ error: 'Email is not set up yet' });
  const recent = await q("SELECT 1 FROM email_tokens WHERE user_id=$1 AND kind='verify' AND created_at > now() - interval '60 seconds'", [req.user.id]);
  if (recent.rowCount) return res.status(429).json({ error: 'We just sent one. Wait a minute and try again.' });
  await sendVerification(req.user, req);
  res.json({ ok: true });
}));

// Step 1: payment proof (available any time until approved)
app.put('/api/me/payment', auth, ah(async (req, res) => {
  if (needsVerify(req.user)) return res.status(403).json({ error: VERIFY_MSG });
  const network = clean(req.body.pay_network, 40);
  const amount = clean(req.body.pay_amount, 20);
  const proof = clean(req.body.pay_proof, 200);
  if (!network || !amount || proof.length < 8) return res.status(400).json({ error: 'Network, amount and a transaction ID are required' });
  if (req.user.status === 'approved') return res.status(400).json({ error: 'Payment already approved' });
  await q("UPDATE users SET pay_network=$1, pay_amount=$2, pay_proof=$3, status='pending', admin_note=NULL WHERE id=$4",
    [network, amount, proof, req.user.id]);
  fire(adminEmail(), T.adminCrypto({ email: req.user.email, network, amount, proof }));
  res.json({ ok: true });
}));

// Step 3: MT5 details, only after the payment has been approved
app.put('/api/me/account', auth, ah(async (req, res) => {
  if (req.user.status !== 'approved') return res.status(403).json({ error: 'MT5 details open once your payment is approved' });
  const broker = clean(req.body.broker, 60);
  const login = clean(req.body.mt5_login, 20);
  const server = clean(req.body.mt5_server, 80);
  const investor = clean(req.body.mt5_investor, 80);
  if (!broker || !/^\d{5,12}$/.test(login) || !server) return res.status(400).json({ error: 'Broker, numeric MT5 login and server are required' });
  const enc = investor ? encrypt(investor) : req.user.mt5_investor_enc;
  await q('UPDATE users SET broker=$1, mt5_login=$2, mt5_server=$3, mt5_investor_enc=$4 WHERE id=$5',
    [broker, login, server, enc, req.user.id]);
  res.json({ ok: true });
}));

// Optional: client leaves a WhatsApp number so the admin can reach them
app.put('/api/me/contact', auth, ah(async (req, res) => {
  const wa = digits(clean(req.body.whatsapp, 30));
  if (!phoneOk(wa)) return res.status(400).json({ error: 'Enter a valid WhatsApp number with country code' });
  await q('UPDATE users SET whatsapp=$1 WHERE id=$2', [wa || null, req.user.id]);
  res.json({ ok: true });
}));

// Pay for a plan with mobile money. The amount is worked out here from the plan and the current rate, never taken from the browser.
app.post('/api/me/pay', auth, ah(async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ error: 'Only client accounts can buy a plan' });
  if (!marz.configured()) return res.status(503).json({ error: 'Online payments are not switched on yet. Use crypto or contact us.' });
  if (needsVerify(req.user)) return res.status(403).json({ error: VERIFY_MSG });
  const planId = /^\d{1,9}$/.test(String(req.body.plan_id ?? '')) ? Number(req.body.plan_id) : null;
  const method = req.body.method === 'card' ? 'card' : 'mobile_money';
  if (method === 'card' && process.env.CARD_PAYMENTS === 'off') return res.status(400).json({ error: 'Card payments are not available' });
  // Card is always charged in UGX; mobile money in the customer's own country
  const country = method === 'card' ? 'UG' : String(req.body.country || 'UG').toUpperCase();
  const cur = MARKETS[country];
  if (!cur) return res.status(400).json({ error: 'That country is not available' });
  const currency = cur.currency;
  const phone = method === 'card' ? null : normalizePhone(country, req.body.phone);
  if (method === 'mobile_money' && !phone) return res.status(400).json({ error: `Enter a ${cur.name} mobile number, like ${cur.example}` });
  const plan = planId === null ? null : (await q('SELECT * FROM plans WHERE id=$1 AND active', [planId])).rows[0];
  if (!plan) return res.status(404).json({ error: 'That plan is not available' });
  const rate = parseRate(await getSetting('rate_' + country, ''));
  if (!rate) return res.status(400).json({ error: `Payments from ${cur.name} are not switched on` });

  const recent = await q("SELECT COUNT(*)::int AS n FROM orders WHERE user_id=$1 AND created_at > now() - interval '1 hour'", [req.user.id]);
  if (recent.rows[0].n >= 6) return res.status(429).json({ error: 'Too many payment attempts. Try again in a while.' });

  const total = plan.price_cents + plan.tax_cents;
  const charged = localCharge(total, rate, cur.step);
  const reference = crypto.randomUUID(); // MarzPay wants a UUID here
  const ins = await q(
    `INSERT INTO orders (user_id, email, plan_id, plan_name, days, currency, total_cents, rate, charged, phone, reference, method, country)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [req.user.id, req.user.email, plan.id, plan.name, plan.days, currency, total, rate, charged, phone, reference, method, country]);
  const orderId = ins.rows[0].id;

  const base = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
  const r = await marz.createCollection({
    amount: charged, phone, country, reference, method,
    description: `Legacy Bot - ${plan.name}`.slice(0, 80), callbackUrl: `${base}/api/webhooks/marzpay?ref=${reference}`,
  });
  if (!r.ok) {
    await q("UPDATE orders SET status='FAILED', note=$2 WHERE id=$1", [orderId, r.error]);
    return res.status(502).json({ error: r.error });
  }
  await q('UPDATE orders SET marz_uuid=$2, marz_ref=$3 WHERE id=$1', [orderId, r.uuid, r.marzRef]);
  res.json({ ok: true, order_id: orderId, redirect_url: method === 'card' ? r.redirectUrl : undefined });
}));

// The browser polls this while the customer approves the prompt on their phone
app.get('/api/me/orders/:id', auth, ah(async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Not found' });
  const own = await q('SELECT 1 FROM orders WHERE id=$1 AND user_id=$2', [id, req.user.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'Not found' });
  const o = await checkOrder(id);
  res.json({ id: o.id, status: o.status, plan_name: o.plan_name, days: o.days, charged: o.charged, currency: o.currency, note: o.status === 'PAID' ? null : o.note });
}));

// Start / stop the bot. Only for approved clients who have saved their MT5 details.
app.put('/api/me/bot', auth, ah(async (req, res) => {
  if (typeof req.body.running !== 'boolean') return res.status(400).json({ error: 'running must be true or false' });
  if (req.user.status !== 'approved') return res.status(403).json({ error: 'The bot opens once your payment is approved' });
  if (!req.user.mt5_login) return res.status(400).json({ error: 'Save your MT5 details first' });
  await q('UPDATE users SET bot_running=$1 WHERE id=$2', [req.body.running, req.user.id]);
  res.json({ ok: true, bot_running: req.body.running });
}));

// ---- admin API ----
app.get('/api/admin/stats', auth, adminOnly, ah(async (_req, res) => {
  const { rows } = await q(`
    SELECT COUNT(*)::int AS total,
      (COUNT(*) FILTER (WHERE status='approved'))::int AS approved,
      (COUNT(*) FILTER (WHERE status='pending'))::int AS pending,
      (COUNT(*) FILTER (WHERE status='rejected'))::int AS rejected,
      (COUNT(*) FILTER (WHERE status='expired'))::int AS expired,
      (COUNT(*) FILTER (WHERE status='pending' AND pay_proof IS NOT NULL))::int AS "awaitingReview"
    FROM users WHERE role='user'`);
  res.json(rows[0]);
}));

// The admin page searches and filters this list in the browser
app.get('/api/admin/users', auth, adminOnly, ah(async (_req, res) => {
  await expireDue();
  const { rows } = await q("SELECT * FROM users WHERE role='user' ORDER BY id DESC LIMIT 5000");
  res.json(rows.map(publicUser));
}));

// Showing an MT5 password is deliberate and logged
app.post('/api/admin/users/:id/reveal', auth, adminOnly, ah(async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'No password stored' });
  const { rows } = await q('SELECT mt5_investor_enc FROM users WHERE id=$1', [id]);
  if (!rows[0] || !rows[0].mt5_investor_enc) return res.status(404).json({ error: 'No password stored' });
  await audit(req, 'reveal_password', id);
  res.json({ password: decrypt(rows[0].mt5_investor_enc) });
}));

app.post('/api/admin/users/:id/status', auth, adminOnly, ah(async (req, res) => {
  const status = req.body.status;
  if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'User not found' });
  // Approving by hand (e.g. a crypto payment): optional number of days of access. Blank = no end date.
  const daysRaw = String(req.body.days ?? '').trim();
  if (status === 'approved' && daysRaw && !/^[1-9]\d{0,3}$/.test(daysRaw)) return res.status(400).json({ error: 'Days must be a whole number like 30' });
  const r = await q("UPDATE users SET status=$1, admin_note=$2, bot_running=(bot_running AND $1='approved') WHERE id=$3 AND role='user' RETURNING email", [status, clean(req.body.note, 300) || null, id]);
  if (!r.rowCount) return res.status(404).json({ error: 'User not found' });
  const dash = baseUrl(req) + '/#/dashboard';
  if (status === 'approved') fire(r.rows[0].email, T.approved({ link: dash }));
  else if (status === 'rejected') fire(r.rows[0].email, T.rejected({ note: clean(req.body.note, 300), link: dash }));
  if (status === 'approved') {
    const days = daysRaw ? Number(daysRaw) : null;
    await q("UPDATE users SET expiry_warned_at = NULL, plan_ends_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() + make_interval(days => $2::int) END, plan_name = CASE WHEN $2::int IS NULL THEN NULL ELSE 'Manual' END WHERE id=$1", [id, days]);
  }
  await audit(req, 'set_' + status, id);
  res.json({ ok: true });
}));

app.delete('/api/admin/users/:id', auth, adminOnly, ah(async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'User not found' });
  const r = await q("DELETE FROM users WHERE id=$1 AND role='user'", [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'User not found' });
  await audit(req, 'delete_user', id);
  res.json({ ok: true });
}));

// Contact details shown to clients
app.put('/api/admin/settings', auth, adminOnly, ah(async (req, res) => {
  const email = clean(req.body.contact_email, 200).toLowerCase();
  const wa = digits(clean(req.body.contact_whatsapp, 30));
  if (email && !emailOk(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (!phoneOk(wa)) return res.status(400).json({ error: 'WhatsApp number needs 7 to 15 digits including country code' });
  await setSetting('contact_email', email);
  await setSetting('contact_whatsapp', wa);
  await audit(req, 'update_contact_settings');
  res.json({ ok: true });
}));

// Plans and prices
app.get('/api/admin/plans', auth, adminOnly, ah(async (_req, res) => {
  const { rows } = await q('SELECT * FROM plans ORDER BY sort, id');
  const rates = await countryRates(true);
  res.json({
    markets: Object.entries(MARKETS).map(([code, m]) => ({ code, name: m.name, currency: m.currency, rate: rates[code] || '' })),
    onlineReady: marz.configured(),
    plans: rows.map((p) => ({ id: p.id, name: p.name, days: p.days, price_usd: centsToStr(p.price_cents), tax_usd: centsToStr(p.tax_cents), note: p.note || '', active: p.active, sort: p.sort })),
  });
}));

app.post('/api/admin/plans', auth, adminOnly, ah(async (req, res) => {
  const p = parsePlan(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const v = p.v;
  const r = await q('INSERT INTO plans (name, days, price_cents, tax_cents, note, active, sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [v.name, v.days, v.price_cents, v.tax_cents, v.note, v.active, v.sort]);
  await audit(req, 'add_plan', r.rows[0].id);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/admin/plans/:id', auth, adminOnly, ah(async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Plan not found' });
  const p = parsePlan(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const v = p.v;
  const r = await q('UPDATE plans SET name=$2, days=$3, price_cents=$4, tax_cents=$5, note=$6, active=$7, sort=$8 WHERE id=$1',
    [id, v.name, v.days, v.price_cents, v.tax_cents, v.note, v.active, v.sort]);
  if (!r.rowCount) return res.status(404).json({ error: 'Plan not found' });
  await audit(req, 'edit_plan', id);
  res.json({ ok: true });
}));

app.delete('/api/admin/plans/:id', auth, adminOnly, ah(async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Plan not found' });
  const r = await q('DELETE FROM plans WHERE id=$1', [id]); // past orders keep their own copy of the plan name and days
  if (!r.rowCount) return res.status(404).json({ error: 'Plan not found' });
  await audit(req, 'delete_plan', id);
  res.json({ ok: true });
}));

// Exchange rates: how much local money one US dollar costs, per country. A rate switches that country on; blank switches it off.
app.put('/api/admin/rates', auth, adminOnly, ah(async (req, res) => {
  const todo = [];
  for (const code of Object.keys(MARKETS)) {
    if (req.body[code] === undefined) continue;
    const raw = String(req.body[code]).trim();
    if (raw === '') { todo.push([code, '']); continue; }
    const rate = parseRate(raw);
    if (rate === null) return res.status(400).json({ error: `Enter the ${MARKETS[code].name} rate as a number, like 4200` });
    todo.push([code, String(rate)]);
  }
  for (const [code, v] of todo) await setSetting('rate_' + code, v);
  await audit(req, 'update_rates');
  res.json({ ok: true });
}));

// Online payments, newest first
app.get('/api/admin/orders', auth, adminOnly, ah(async (_req, res) => {
  const { rows } = await q('SELECT id, user_id, email, plan_name, days, country, currency, total_cents, charged, phone, status, note, last_check, created_at, paid_at FROM orders ORDER BY id DESC LIMIT 200');
  res.json(rows.map((o) => ({ ...o, total_usd: centsToStr(o.total_cents), total_cents: undefined })));
}));

app.post('/api/admin/orders/:id/recheck', auth, adminOnly, ah(async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Payment not found' });
  const o = await checkOrder(id, { force: true });
  if (!o) return res.status(404).json({ error: 'Payment not found' });
  await audit(req, 'recheck_order', id);
  res.json({ status: o.status, note: o.note, last_check: o.last_check });
}));

// Only after you can see the money in your MarzPay wallet
app.post('/api/admin/orders/:id/approve', auth, adminOnly, ah(async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Payment not found' });
  const done = await settleOrder(id, 'Approved by admin', null);
  if (!done) return res.status(400).json({ error: 'Payment not found or already paid' });
  await audit(req, 'approve_order', id);
  res.json({ ok: true });
}));

// Email status, a test button and the last emails sent
app.get('/api/admin/emails', auth, adminOnly, ah(async (_req, res) => {
  const { rows } = await q('SELECT to_email, subject, status, error, created_at FROM email_log ORDER BY id DESC LIMIT 30');
  res.json({
    enabled: mailer.configured(), provider: (process.env.EMAIL_PROVIDER || 'resend').toLowerCase(), from: process.env.EMAIL_FROM || '',
    notify: adminEmail(), requireVerify: mailer.configured() && process.env.REQUIRE_EMAIL_VERIFY !== 'off',
    cron: !!process.env.CRON_KEY, log: rows,
  });
}));

app.post('/api/admin/email-test', auth, adminOnly, ah(async (req, res) => {
  if (!mailer.configured()) return res.status(400).json({ error: 'Email is not set up yet. Add EMAIL_API_KEY and EMAIL_FROM in your host settings.' });
  const r = await sendMail(req.user.email, T.test());
  if (!r.ok) return res.status(502).json({ error: r.error });
  await audit(req, 'email_test');
  res.json({ ok: true, to: req.user.email });
}));

// For when someone cannot get their confirmation email
app.post('/api/admin/users/:id/verify', auth, adminOnly, ah(async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'User not found' });
  const r = await q("UPDATE users SET email_verified_at=now() WHERE id=$1 AND role='user'", [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'User not found' });
  await audit(req, 'verify_email', id);
  res.json({ ok: true });
}));

// Lets a free uptime pinger (e.g. cron-job.org) run the expiry and reminder checks even when the host has put the site to sleep
app.get('/api/cron/sweep', ah(async (req, res) => {
  const key = process.env.CRON_KEY;
  if (!key) return res.status(404).json({ error: 'Not found' });
  const a = Buffer.from(String(req.query.key || ''));
  const b = Buffer.from(key);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Bad key' });
  baseUrl(req);
  await expireDue();
  await remindDue();
  res.json({ ok: true });
}));

// ---- static frontend ----
// no-cache = the browser always checks for a newer file, so a new deploy shows up on the next refresh
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Last resort: log the real error, show the browser a generic one
app.use((err, _req, res, _next) => {
  const code = err.status || err.statusCode;
  if (code >= 400 && code < 500) return res.status(code).json({ error: 'Bad request' });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
  ready.then(() => {
    app.listen(PORT, () => console.log('Legacy Bot running on port', PORT));
    // Keeps the database honest for anything else that reads bot_running (e.g. a trading worker)
    const sweep = () => Promise.all([expireDue(), remindDue()]).catch((e) => console.error('sweep failed', e.message));
    setInterval(sweep, 10 * 60 * 1000).unref();
    sweep();
  });
}
app.ready = ready;
module.exports = app;
