# Legacy Bot

MT5 account registration with plans, MarzPay mobile money (auto-approved) and crypto (manual review).

## Run locally
```
npm install
cp .env.example .env     # then edit it (see below)
npm start                # http://localhost:3000
```

## Required settings (.env)
- `JWT_SECRET` and `ENC_KEY`: two different long random strings (at least 32 characters each).
  On Render, click "Generate" next to the value. Locally, any long random text works.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`: your admin login, created on first start.
- `PAY_NETWORK`, `PAY_ADDRESS`, `PAY_AMOUNT`: crypto details shown to clients on their dashboard.
- `MARZPAY_API_KEY`, `MARZPAY_API_SECRET`: from your MarzPay dashboard (never share them in chat).
- `MARZPAY_SIGNING_SECRET` (optional): if MarzPay gives you a webhook signing secret, set it.
- `APP_URL`: your live site address, e.g. `https://legacybot.live`, used for the payment callback.
- `MARZPAY_ALLOW_SANDBOX=true` only while testing. Leave it unset in real use.

Back up `ENC_KEY`. Without it, stored investor passwords cannot be decrypted.

## Deploy
Needs Node 18+ and a Postgres database (free option: Neon). Set `DATABASE_URL` to its connection string; tables are created on first start, so no disk is needed.
Use `/healthz` as the host's health check (it does not touch the database).
Serve it behind HTTPS (the session cookie is `Secure` in production). Neon keeps its own backups; also export the database now and then.

## Automatic emails
Off until you add two settings. With them on, the site sends:
- **Confirm your email** after sign-up (clients must confirm before paying; `REQUIRE_EMAIL_VERIFY=off` turns that rule off)
- **Payment receipt** after a mobile money or card payment, and **approved / not approved** after you review a crypto payment
- **Plan ending in 3 days** reminder and **plan has ended** notice
- **Forgot password** link (works for 1 hour, once)
- **Alerts to you**: new sign-up, payment received, crypto payment to review

Setup (about 15 minutes):
1. Make a free Resend account (resend.com) and add your domain (legacysbot.com). Add the DNS records it shows in Namecheap > Advanced DNS. Click Verify.
2. In Resend create an API key.
3. In your host (Render > Environment) add:
   - `EMAIL_API_KEY` = the Resend key
   - `EMAIL_FROM` = `Legacy Bot <noreply@legacysbot.com>` (must be on the verified domain)
   - `ADMIN_NOTIFY_EMAIL` = where your alerts should go (defaults to `ADMIN_EMAIL`)
   - `APP_URL` = your live site address
   - optional: `EMAIL_REPLY_TO` = your support address; `EMAIL_PROVIDER=brevo` to use Brevo instead of Resend
4. Redeploy, open Admin panel > **Emails** and press **Send me a test email**. The same section lists the last emails and any error.
5. So reminders and expiry run even when a free host puts the site to sleep: set `CRON_KEY` to a long random text, then make a free job at cron-job.org that opens `https://YOUR-SITE/api/cron/sweep?key=YOUR_CRON_KEY` every hour.

If the emails do not arrive, check spam first, then the Emails list in the admin panel (it shows the provider's error).

## Plans and online payments
- Admin panel > **Plans, prices and exchange rate**: add, edit, hide or delete plans. Prices are in US dollars plus a tax amount. Set **UGX for 1 US dollar**; customers are charged the converted amount, rounded up to the next 100. Check the rate when you first deploy (it starts at 4200).
- A client picks a plan, enters a mobile money number, and approves the prompt on their phone. The server asks MarzPay whether the payment really succeeded (it never trusts the webhook alone, or the browser), then approves the client and adds the days. Repeat payments add time on top of what is left.
- When a plan runs out the client becomes **Expired**, the bot is switched off, and they see the plans again.
- Admin panel > **Online payments** shows every attempt, with **Re-check** and **Approve** for stuck ones. Only approve after you see the money in your MarzPay wallet.
- Crypto still works: you approve by hand and can enter the number of days (blank = no end date).
- Customers can choose **mobile money** or **Visa/Mastercard**. Card sends them to MarzPay's secure card page and back; it needs card collection to be enabled on your MarzPay account (if MarzPay refuses it, the customer sees the error and can use mobile money). Set `CARD_PAYMENTS=off` to hide the card choice.
- Only UGX is switched on. MarzPay's card API takes UGX amounts only. Kenya (KES, M-Pesa) exists in MarzPay's docs and could be added; TZS is not listed by MarzPay.
- Every payment's reference is a random UUID, as MarzPay requires.
- This only flips the `bot_running` flag. Nothing here trades by itself.
- Free hosting that sleeps can delay the payment callback; the client's page also checks MarzPay every few seconds, so payments still complete.

## How it works
1. Client signs up and submits their crypto payment (network, amount, transaction ID).
2. You review it in the admin panel and Approve or Reject (with an optional reason shown to the client).
3. The client's MT5 details form stays locked until they are approved, then they enter broker, login, server and MT5 password.

Admin panel: search by email, MT5 login or WhatsApp; filter All / Approved / Pending / Rejected; Show/Hide button on each password (every reveal is logged); Delete button on each user; and a "Contact details" box where you set the email and WhatsApp number shown to clients. Clients can also leave their own WhatsApp number, which appears on their card.

## Bot dashboard
Once a client is approved and has saved their MT5 details, their dashboard becomes a bot dashboard: account status, MT5 account card, an animated market chart, and Start / Stop buttons. Start and Stop save a `bot_running` flag on the user (Postgres column added automatically on start). Withdrawing approval (Reject or Set pending) switches the flag off.

The chart is a decorative animation and is labelled as such on screen. The flag is only a switch: it does not connect to MT5 by itself. A separate worker that actually trades should read `bot_running` and act on it.

## Security notes
- Ask clients for the MT5 investor (read-only) password where possible, not the master password.
- Login passwords are hashed with bcrypt. MT5 passwords are AES-256-GCM encrypted and masked until you press Show.
- Admin role is checked on the server for every admin request. Revealing a password, changing status, deleting and editing contact details are written to the `audit` table.
- Login and signup are rate limited. Add 2FA for the admin account as a next step.

## Test
`npm run test:unit` checks prices, phone numbers and payment checks (no database needed).
`TEST_DATABASE_URL=<throwaway db> npm test` runs the full flow (drops the app's tables in that database, never use your real one)
