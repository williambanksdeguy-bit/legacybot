'use strict';
// Sends email through Resend (default) or Brevo with plain fetch calls. No extra packages.
// If EMAIL_API_KEY / EMAIL_FROM are not set, configured() is false and the site simply sends nothing.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const configured = () => !!(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);

// "Legacy Bot <noreply@legacysbot.com>" -> { name, email }
function parseFrom(s) {
  const m = String(s || '').match(/^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, ''), email: m[2] };
  return { name: '', email: String(s || '').trim() };
}

async function send({ to, subject, html, text }) {
  if (!configured()) return { ok: false, error: 'Email is not set up (EMAIL_API_KEY and EMAIL_FROM are missing)' };
  const key = process.env.EMAIL_API_KEY;
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  const replyTo = process.env.EMAIL_REPLY_TO || '';
  try {
    let res;
    if (provider === 'brevo') {
      const from = parseFrom(process.env.EMAIL_FROM);
      res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: from.name ? { name: from.name, email: from.email } : { email: from.email },
          to: [{ email: to }], subject, htmlContent: html, textContent: text,
          ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
    } else {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `${provider} said ${res.status}: ${t.replace(/\s+/g, ' ').slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

// ---------- templates ----------
const p = (html) => `<p style="margin:0 0 12px">${html}</p>`;
const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#777">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`;
const table = (rows) => `<table style="margin:6px 0 14px;font-size:14px;border-collapse:collapse">${rows.join('')}</table>`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' }) : '');
const money = (n) => Number(n).toLocaleString('en-US');

function layout({ heading, body, button, foot }) {
  const btn = button && button.url
    ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="background:#f5c542;color:#1a1500;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px;display:inline-block">${esc(button.label)}</a></p>
       <p style="font-size:12px;color:#777;word-break:break-all">If the button does not work, copy this link into your browser:<br>${esc(button.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f1e8;font-family:Arial,Helvetica,sans-serif;color:#1d1b16">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#0b0b0d;border-radius:14px 14px 0 0;padding:18px 22px"><span style="font-size:22px;font-weight:700;letter-spacing:.04em;color:#f3f0e6">LEGACY <span style="color:#f5c542">BOT</span></span></div>
<div style="background:#fff;border-radius:0 0 14px 14px;padding:24px 22px;line-height:1.55;font-size:15px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>${body}${btn}
</div>
<p style="font-size:12px;color:#8a8677;text-align:center;margin:16px 0 0">${esc(foot || 'Trading involves risk and you can lose money.')}</p>
</div></body></html>`;
}

const templates = {
  verify: ({ link }) => ({
    subject: 'Confirm your Legacy Bot account',
    html: layout({ heading: 'Confirm your email', body: p('Welcome to Legacy Bot. Confirm your email address to finish setting up your account. The link works for 48 hours.'), button: { label: 'Confirm my email', url: link }, foot: 'If you did not create this account, you can ignore this email.' }),
    text: `Welcome to Legacy Bot. Confirm your email to finish setting up your account (link works for 48 hours):\n${link}\n\nIf you did not create this account, ignore this email.`,
  }),

  code: ({ code, minutes, purpose }) => ({
    subject: `${code} is your Legacy Bot code`,
    html: layout({
      heading: purpose === 'register' ? 'Confirm your email' : 'Your sign-in code',
      body: p(purpose === 'register' ? 'Enter this code to finish creating your account.' : 'Enter this code to finish signing in.')
        + `<p style="margin:18px 0;font-size:32px;letter-spacing:.3em;font-weight:700">${esc(code)}</p>`
        + p(`It works for ${esc(String(minutes))} minutes and only once. Never share it with anyone.`),
      foot: 'If you did not try to sign in, ignore this email and consider changing your password.',
    }),
    text: `Your Legacy Bot code is ${code}. It works for ${minutes} minutes and only once. Never share it. If this was not you, ignore this email.`,
  }),

  receipt: ({ plan, days, amount, currency, method, endsAt, link }) => ({
    subject: `Payment received - ${plan}`,
    html: layout({
      heading: 'Payment received',
      body: p('Thank you. Your payment went through and your plan is active.')
        + table([row('Plan', plan), row('Paid', `${currency} ${money(amount)}`), row('Method', method === 'card' ? 'Card' : 'Mobile money'), row('Days added', String(days)), row('Active until', fmtDate(endsAt))])
        + p('Next step: add your MT5 details on your dashboard so we can get started.'),
      button: { label: 'Open my dashboard', url: link },
    }),
    text: `Payment received.\nPlan: ${plan}\nPaid: ${currency} ${money(amount)}\nDays added: ${days}\nActive until: ${fmtDate(endsAt)}\n\nAdd your MT5 details on your dashboard: ${link}`,
  }),

  approved: ({ link }) => ({
    subject: 'Your payment is approved',
    html: layout({ heading: 'Your payment is approved', body: p('We have checked your payment and approved your account. Add your MT5 details on your dashboard to get started.'), button: { label: 'Add my MT5 details', url: link } }),
    text: `Your payment is approved. Add your MT5 details on your dashboard: ${link}`,
  }),

  rejected: ({ note, link }) => ({
    subject: 'We could not approve your payment',
    html: layout({ heading: 'We could not approve your payment', body: p('We were not able to approve your payment.') + (note ? p(`Note from us: <b>${esc(note)}</b>`) : '') + p('Please check the details and submit again, or contact us if you need help.'), button: { label: 'Open my dashboard', url: link } }),
    text: `We could not approve your payment.${note ? '\nNote from us: ' + note : ''}\nPlease check the details and submit again: ${link}`,
  }),

  expiring: ({ plan, endsAt, daysLeft, link }) => ({
    subject: `Your plan ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    html: layout({ heading: `Your plan ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, body: p(`Your <b>${esc(plan || 'plan')}</b> ends on <b>${esc(fmtDate(endsAt))}</b>. Add more time now so the bot is not switched off.`), button: { label: 'Add time', url: link } }),
    text: `Your ${plan || 'plan'} ends on ${fmtDate(endsAt)}. Add more time so the bot is not switched off: ${link}`,
  }),

  expired: ({ link }) => ({
    subject: 'Your plan has ended',
    html: layout({ heading: 'Your plan has ended', body: p('Your plan has run out, so the bot has been stopped. Choose a plan to switch it back on. Your MT5 details are still saved.'), button: { label: 'Choose a plan', url: link } }),
    text: `Your plan has ended and the bot has been stopped. Choose a plan to continue: ${link}`,
  }),

  reset: ({ link }) => ({
    subject: 'Reset your Legacy Bot password',
    html: layout({ heading: 'Reset your password', body: p('Someone asked to reset the password for this account. Use the button to choose a new one. The link works for 1 hour and only once.'), button: { label: 'Choose a new password', url: link }, foot: 'If this was not you, ignore this email and your password stays the same.' }),
    text: `Reset your Legacy Bot password (link works for 1 hour, once):\n${link}\n\nIf this was not you, ignore this email.`,
  }),

  adminSignup: ({ email }) => ({
    subject: `New sign-up: ${email}`,
    html: layout({ heading: 'New sign-up', body: p(`<b>${esc(email)}</b> just created an account.`) }),
    text: `New sign-up: ${email}`,
  }),

  adminPayment: ({ email, plan, amount, currency, method }) => ({
    subject: `Payment received: ${currency} ${money(amount)} from ${email}`,
    html: layout({ heading: 'Payment received', body: table([row('Client', email), row('Plan', plan), row('Amount', `${currency} ${money(amount)}`), row('Method', method === 'card' ? 'Card' : 'Mobile money')]) + p('The client was approved automatically.') }),
    text: `Payment received from ${email}: ${plan}, ${currency} ${money(amount)} (${method}). Approved automatically.`,
  }),

  adminCrypto: ({ email, network, amount, proof }) => ({
    subject: `Crypto payment to review: ${email}`,
    html: layout({ heading: 'Crypto payment to review', body: table([row('Client', email), row('Network', network), row('Amount', amount), row('Transaction ID', proof)]) + p('Check it and approve or reject it in the admin panel.') }),
    text: `Crypto payment to review from ${email}: ${network}, ${amount}, tx ${proof}`,
  }),

  test: () => ({
    subject: 'Legacy Bot test email',
    html: layout({ heading: 'Email is working', body: p('This is a test from your Legacy Bot admin panel. If you can read it, automatic emails are set up correctly.') }),
    text: 'This is a test from your Legacy Bot admin panel. Automatic emails are set up correctly.',
  }),
};

module.exports = { configured, send, parseFrom, templates, esc };
