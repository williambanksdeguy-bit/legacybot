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
  const admin = await q("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (!admin.rowCount && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await q("INSERT INTO users (email, pass_hash, role, status) VALUES ($1,$2,'admin','approved') ON CONFLICT (email) DO NOTHING",
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

app.use(express.json({ limit: '20kb' }));
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
    req.user = rows[0];
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
    whatsapp: u.whatsapp, admin_note: u.admin_note, created_at: u.created_at,
    bot_running: !!u.bot_running,
  };
}

// ---- public API ----
app.get('/api/config', ah(async (_req, res) => {
  res.json({
    payNetwork: process.env.PAY_NETWORK || '',
    payAddress: process.env.PAY_ADDRESS || '',
    payAmount: process.env.PAY_AMOUNT || '',
    contactEmail: await getSetting('contact_email', process.env.CONTACT_EMAIL || ''),
    contactWhatsapp: digits(await getSetting('contact_whatsapp', process.env.CONTACT_WHATSAPP || '')),
  });
}));

app.post('/api/register', authLimiter, ah(async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });
  const r = await q('INSERT INTO users (email, pass_hash) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING RETURNING id',
    [email, bcrypt.hashSync(password, 12)]);
  if (!r.rowCount) return res.status(409).json({ error: 'Email already registered' });
  setSession(res, { id: r.rows[0].id, role: 'user' });
  res.json({ ok: true, role: 'user' });
}));

app.post('/api/login', authLimiter, ah(async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const { rows } = await q('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  setSession(res, u);
  res.json({ ok: true, role: u.role });
}));

app.post('/api/logout', (_req, res) => { res.clearCookie('lb_session'); res.json({ ok: true }); });

// ---- user API ----
app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

// Step 1: payment proof (available any time until approved)
app.put('/api/me/payment', auth, ah(async (req, res) => {
  const network = clean(req.body.pay_network, 40);
  const amount = clean(req.body.pay_amount, 20);
  const proof = clean(req.body.pay_proof, 200);
  if (!network || !amount || proof.length < 8) return res.status(400).json({ error: 'Network, amount and a transaction ID are required' });
  if (req.user.status === 'approved') return res.status(400).json({ error: 'Payment already approved' });
  await q("UPDATE users SET pay_network=$1, pay_amount=$2, pay_proof=$3, status='pending', admin_note=NULL WHERE id=$4",
    [network, amount, proof, req.user.id]);
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
      (COUNT(*) FILTER (WHERE status='pending' AND pay_proof IS NOT NULL))::int AS "awaitingReview"
    FROM users WHERE role='user'`);
  res.json(rows[0]);
}));

// The admin page searches and filters this list in the browser
app.get('/api/admin/users', auth, adminOnly, ah(async (_req, res) => {
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
  const r = await q("UPDATE users SET status=$1, admin_note=$2, bot_running=(bot_running AND $1='approved') WHERE id=$3 AND role='user'", [status, clean(req.body.note, 300) || null, id]);
  if (!r.rowCount) return res.status(404).json({ error: 'User not found' });
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

// ---- static frontend ----
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Last resort: log the real error, show the browser a generic one
app.use((err, _req, res, _next) => {
  const code = err.status || err.statusCode;
  if (code >= 400 && code < 500) return res.status(code).json({ error: 'Bad request' });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

if (require.main === module) ready.then(() => app.listen(PORT, () => console.log('Legacy Bot running on port', PORT)));
app.ready = ready;
module.exports = app;
