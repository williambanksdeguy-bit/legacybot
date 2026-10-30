# Legacy Bot

MT5 account registration, crypto payment proof and admin review.

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
- `PAY_NETWORK`, `PAY_ADDRESS`, `PAY_AMOUNT`: shown to clients on their dashboard.

Back up `ENC_KEY`. Without it, stored investor passwords cannot be decrypted.

## Deploy
Needs Node 18+ and a Postgres database (free option: Neon). Set `DATABASE_URL` to its connection string; tables are created on first start, so no disk is needed.
Use `/healthz` as the host's health check (it does not touch the database).
Serve it behind HTTPS (the session cookie is `Secure` in production). Neon keeps its own backups; also export the database now and then.

## How it works
1. Client signs up and submits their crypto payment (network, amount, transaction ID).
2. You review it in the admin panel and Approve or Reject (with an optional reason shown to the client).
3. The client's MT5 details form stays locked until they are approved, then they enter broker, login, server and MT5 password.

Admin panel: search by email, MT5 login or WhatsApp; filter All / Approved / Pending / Rejected; Show/Hide button on each password (every reveal is logged); Delete button on each user; and a "Contact details" box where you set the email and WhatsApp number shown to clients. Clients can also leave their own WhatsApp number, which appears on their card.

## Security notes
- Ask clients for the MT5 investor (read-only) password where possible, not the master password.
- Login passwords are hashed with bcrypt. MT5 passwords are AES-256-GCM encrypted and masked until you press Show.
- Admin role is checked on the server for every admin request. Revealing a password, changing status, deleting and editing contact details are written to the `audit` table.
- Login and signup are rate limited. Add 2FA for the admin account as a next step.

## Test
`TEST_DATABASE_URL=<throwaway db> npm test` (drops the app's tables in that database, never use your real one)
