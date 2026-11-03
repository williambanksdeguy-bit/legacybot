(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  const $toast = document.getElementById('toast');
  let me = null;
  let cfg = {};

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');
  const MASK = '••••••••';

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status });
    return data;
  }

  function toast(text) {
    $toast.textContent = text;
    $toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => ($toast.hidden = true), 2600);
  }

  async function loadMe() {
    try { me = await api('GET', '/api/me'); } catch { me = null; }
  }
  async function loadCfg() {
    try { cfg = await api('GET', '/api/config'); } catch { cfg = {}; }
  }

  function contactLinks() {
    const wa = digitsOnly(cfg.contactWhatsapp);
    const out = [];
    if (wa) out.push(`<a class="btn solid" href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">WhatsApp us</a>`);
    if (cfg.contactEmail) out.push(`<a class="btn" href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>`);
    return out.join('');
  }

  function renderNav() {
    if (!me) $nav.innerHTML = '<a class="btn small" href="#/login">Log in</a><a class="btn small solid" href="#/register">Sign up</a>';
    else $nav.innerHTML = (me.role === 'admin' ? '<a class="btn small" href="#/admin">Admin</a>' : '<a class="btn small" href="#/dashboard">Dashboard</a>') + '<button class="btn small" id="logout">Log out</button>';
    const lo = document.getElementById('logout');
    if (lo) lo.onclick = async () => { await api('POST', '/api/logout', {}); me = null; location.hash = '#/'; route(); };
  }

  // ---------- home ----------
  function viewHome() {
    const contact = contactLinks();
    $app.innerHTML = `
      <section class="hero">
        <h1>Legacy <span class="gold">Bot</span></h1>
        <p>Managed MT5 trading. Pick a plan, pay with mobile money, card or crypto, then connect your account.</p>
        <div class="row center"><a class="btn solid" href="#/plans">See plans</a><a class="btn" href="#/register">Get started</a><a class="btn" href="#/login">Log in</a></div>
      </section>
      <section class="grid how">
        <div class="card"><span class="num">1</span><h3>Pay</h3><p class="note">Choose a plan and pay with mobile money or card, or send crypto and submit the transaction ID.</p></div>
        <div class="card"><span class="num">2</span><h3>Get approved</h3><p class="note">Mobile money and card payments are approved automatically. Crypto payments are checked by us.</p></div>
        <div class="card"><span class="num">3</span><h3>Connect MT5</h3><p class="note">Once approved, add your MT5 details and we take it from there.</p></div>
      </section>
      ${contact ? `<section class="card contact"><h3>Questions? Talk to us</h3><div class="row center">${contact}</div></section>` : ''}
      <p class="note center small-print">Trading involves risk and you can lose money. Past performance does not guarantee future results.</p>`;
  }

  // ---------- auth ----------
  function authForm(kind) {
    const isReg = kind === 'register';
    $app.innerHTML = `
      <form class="form card" id="f">
        <h2>${isReg ? 'Create account' : 'Welcome back'}</h2>
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        ${isReg ? '<label>Phone number (with country code)<input type="tel" name="phone" required inputmode="tel" autocomplete="tel" placeholder="+256700000000"></label><span class="note">We use it to contact you about your account and plan. We do not share it.</span>' : ''}
        <label>Password<input type="password" name="password" required minlength="${isReg ? 10 : 1}" autocomplete="${isReg ? 'new-password' : 'current-password'}"></label>
        ${isReg ? '<span class="note">At least 10 characters.</span>' : ''}
        <div class="msg" id="msg"></div>
        <button class="btn solid" type="submit">${isReg ? 'Sign up' : 'Log in'}</button>
        <a href="#/${isReg ? 'login' : 'register'}" class="note">${isReg ? 'Already registered? Log in' : 'New here? Create an account'}</a>
        ${isReg ? '' : '<a href="#/forgot" class="note">Forgot your password?</a>'}
      </form>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { email: fd.get('email'), password: fd.get('password') };
      if (isReg) body.phone = fd.get('phone');
      try {
        const r = await api('POST', '/api/' + kind, body);
        if (r.need_code) return codeForm(r.challenge, r.email);
        await loadMe();
        location.hash = r.role === 'admin' ? '#/admin' : '#/dashboard';
      } catch (err) { document.getElementById('msg').textContent = err.message; }
    };
  }

  // Step 2 of sign-up and every login: the 6-digit code that was emailed
  function codeForm(challenge, email) {
    $app.innerHTML = `
      <form class="form card" id="cf">
        <h2>Check your email</h2>
        <p class="note">We sent a 6-digit code to <b>${esc(email)}</b>. It works for 10 minutes. Check your spam folder too.</p>
        <label>Code<input name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456"></label>
        <div class="msg" id="cmsg"></div>
        <button class="btn solid" type="submit">Verify</button>
        <button class="btn small" type="button" id="resend">Send a new code</button>
        <a href="#/login" class="note">Start again</a>
      </form>`;
    const msg = document.getElementById('cmsg');
    document.getElementById('cf').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/verify-code', { challenge, code: new FormData(e.target).get('code') });
        await loadMe();
        location.hash = r.role === 'admin' ? '#/admin' : '#/dashboard';
      } catch (err) { msg.textContent = err.message; }
    };
    document.getElementById('resend').onclick = async () => {
      try {
        const r = await api('POST', '/api/resend-code', { challenge });
        msg.textContent = r.ok ? 'A new code is on its way.' : r.error;
      } catch (err) { msg.textContent = err.message; }
    };
  }

  // ---------- forgot / reset password, email confirmation ----------
  function viewForgot() {
    $app.innerHTML = `
      <form class="form card" id="f">
        <h2>Forgot password</h2>
        <p class="note">Enter your email and we will send you a link to choose a new password.</p>
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        <div class="msg" id="msg"></div>
        <button class="btn solid" type="submit">Send reset link</button>
        <a href="#/login" class="note">Back to log in</a>
      </form>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/forgot', { email: new FormData(e.target).get('email') });
        $app.innerHTML = '<div class="form card"><h2>Check your email</h2><p class="note">If that email has an account, a reset link is on its way. It works for 1 hour. Check your spam folder too.</p><a class="btn solid" href="#/login">Back to log in</a></div>';
      } catch (err) { document.getElementById('msg').textContent = err.message; }
    };
  }

  function viewReset(token) {
    $app.innerHTML = `
      <form class="form card" id="f">
        <h2>Choose a new password</h2>
        <label>New password<input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
        <span class="note">At least 10 characters.</span>
        <div class="msg" id="msg"></div>
        <button class="btn solid" type="submit">Save password</button>
      </form>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/reset', { token, password: new FormData(e.target).get('password') });
        $app.innerHTML = '<div class="form card"><h2>Password changed</h2><p class="note">You can log in with your new password now.</p><a class="btn solid" href="#/login">Log in</a></div>';
      } catch (err) { document.getElementById('msg').textContent = err.message; }
    };
  }

  function viewVerified(ok) {
    $app.innerHTML = ok
      ? '<div class="form card"><h2>Email confirmed</h2><p class="note">Thank you. Your email address is confirmed.</p><a class="btn solid" href="#/dashboard">Go to my dashboard</a></div>'
      : '<div class="form card"><h2>Link not valid</h2><p class="note">This confirmation link has expired or was already used. Log in and press "Send again" to get a new one.</p><a class="btn solid" href="#/dashboard">Go to my dashboard</a></div>';
  }

  // ---------- animated market chart (canvas, CSP-safe) ----------
  let chartStop = () => {};
  let editAcc = false;

  // Decorative rising line that scrolls while the bot is running. It is an illustration, not real account data.
  function startChart(canvas, isRunning) {
    chartStop();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const gold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#f5c542';
    const N = 34;                       // visible points
    const L = N + 2;                    // plus one hidden point on each side
    const pts = [];
    let v = 0;
    const next = () => { v += (Math.random() - 0.36); return v; };   // random walk with an upward drift
    for (let i = 0; i < L; i++) pts.push(next());
    let W = 0, H = 0, shift = 0, reveal = reduce ? 1 : 0, lo = Math.min(...pts), hi = Math.max(...pts), last = performance.now(), raf = 0;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    function draw() {
      if (!W || !H) return;
      ctx.clearRect(0, 0, W, H);
      const padT = 16, padB = 16, dx = W / (N - 1);
      const yOf = (val) => padT + (1 - (val - lo) / Math.max(hi - lo, 0.001)) * (H - padT - padB);
      const xs = pts.map((_, i) => W + (i - (L - 2) - shift) * dx);
      const ys = pts.map(yOf);
      const running = isRunning();

      // faint grid
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
      for (let g = 1; g < 4; g++) { const y = Math.round((H / 4) * g) + .5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = running ? 1 : 0.45;
      ctx.beginPath(); ctx.rect(0, 0, W * reveal, H); ctx.clip();

      const path = () => {
        ctx.beginPath(); ctx.moveTo(xs[0], ys[0]);
        for (let i = 1; i < L - 1; i++) {
          const mx = (xs[i] + xs[i + 1]) / 2, my = (ys[i] + ys[i + 1]) / 2;
          ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
        }
        ctx.lineTo(xs[L - 1], ys[L - 1]);
      };
      // soft fill under the line
      path(); ctx.lineTo(xs[L - 1], H); ctx.lineTo(xs[0], H); ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(245,197,66,.28)'); grad.addColorStop(1, 'rgba(245,197,66,0)');
      ctx.fillStyle = grad; ctx.fill();
      // glowing line
      path();
      ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = gold; ctx.shadowColor = gold; ctx.shadowBlur = running ? 14 : 4;
      ctx.stroke();
      ctx.restore();

      // pulsing head dot where the line is currently drawn up to
      const hx = Math.min(W * reveal, W - 4);
      let hy = ys[L - 2];
      for (let i = 0; i < L - 1; i++) if (xs[i] <= hx && hx <= xs[i + 1]) { hy = ys[i] + (ys[i + 1] - ys[i]) * ((hx - xs[i]) / (xs[i + 1] - xs[i] || 1)); break; }
      const pulse = running && !reduce ? (Math.sin(performance.now() / 260) + 1) / 2 : 0;
      ctx.save();
      ctx.fillStyle = 'rgba(245,197,66,' + (0.18 + pulse * 0.25) + ')';
      ctx.beginPath(); ctx.arc(hx, hy, 7 + pulse * 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = running ? gold : 'rgba(245,197,66,.5)';
      ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function frame(now) {
      if (!canvas.isConnected) { chartStop(); return; }
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      reveal = Math.min(1, reveal + dt / 1.6);                 // line draws itself in on first load
      if (isRunning() && reveal >= 1) {
        shift += dt / 0.6;                                       // a new point every ~0.6s
        while (shift >= 1) { shift -= 1; pts.shift(); pts.push(next()); }
      }
      if (isRunning()) {                                         // only ease the scale while moving, so Stop truly freezes the chart
        lo += (Math.min(...pts) - lo) * 0.08;
        hi += (Math.max(...pts) - hi) * 0.08;
      }
      draw();
      raf = requestAnimationFrame(frame);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    if (!reduce) raf = requestAnimationFrame(frame);
    chartStop = () => { cancelAnimationFrame(raf); ro.disconnect(); chartStop = () => {}; };
  }

  function botDashboardHtml(u) {
    return `
      <div class="card status-card">
        <small class="label">Account status</small>
        <div class="status-big">READY</div>
        <p class="note">Details saved for ${esc(u.broker)}</p>
      </div>

      <div class="card grid">
        <div class="between"><h3 class="sec">MT5 account</h3><button type="button" class="btn small" id="editAcc">Edit</button></div>
        <div class="kvgrid">
          <div class="kv"><small>Broker</small><span>${esc(u.broker)}</span></div>
          <div class="kv"><small>Login</small><span>${esc(u.mt5_login)}</span></div>
          <div class="kv"><small>Server</small><span>${esc(u.mt5_server)}</span></div>
          <div class="kv"><small>Password</small><span>${u.has_investor_password ? MASK : '<span class="note">Not provided</span>'}</span></div>
        </div>
      </div>

      <div class="card grid" id="botdash">
        <div class="between"><h3 class="sec">Market view</h3><span class="tag">Animation</span></div>
        <canvas id="chart" class="chart" role="img" aria-label="Animated illustration of a rising forex chart"></canvas>
        <ul class="live">
          <li><i></i>Scanning the market</li>
          <li><i></i>Applying risk limits</li>
          <li><i></i>Watching your account</li>
        </ul>
        <p class="note" id="liveNote"></p>
        <p class="note fine">Illustrative animation only. It does not show your balance, trades or results.</p>
      </div>

      <div class="card grid">
        <h3 class="sec">Bot control</h3>
        <div class="between"><span class="note">Bot status</span><span class="pill" id="botPill"></span></div>
        <div class="row two">
          <button type="button" class="btn go" id="startBot">&#9654; Start bot</button>
          <button type="button" class="btn stop" id="stopBot">&#9632; Stop bot</button>
        </div>
        <div class="msg" id="mb"></div>
      </div>`;
  }

  function paintBot() {
    const run = !!(me && me.bot_running);
    const dash = document.getElementById('botdash');
    if (dash) dash.classList.toggle('running', run);
    const pill = document.getElementById('botPill');
    if (pill) { pill.className = 'pill ' + (run ? 'on' : 'off'); pill.innerHTML = '<i></i>' + (run ? 'Running' : 'Stopped'); }
    const start = document.getElementById('startBot'), stop = document.getElementById('stopBot');
    if (start) start.disabled = run;
    if (stop) stop.disabled = !run;
    const note = document.getElementById('liveNote');
    if (note) note.textContent = run ? 'The bot is switched on for your account.' : 'The bot is stopped. Press Start to switch it on.';
  }

  function initBotDashboard() {
    const canvas = document.getElementById('chart');
    if (!canvas) return;
    paintBot();
    startChart(canvas, () => !!(me && me.bot_running));
    const setBot = async (running) => {
      const start = document.getElementById('startBot'), stop = document.getElementById('stopBot');
      start.disabled = stop.disabled = true;
      document.getElementById('mb').textContent = '';
      try {
        await api('PUT', '/api/me/bot', { running });
        me.bot_running = running;
        toast(running ? 'Bot started' : 'Bot stopped');
      } catch (err) { document.getElementById('mb').textContent = err.message; }
      paintBot();
    };
    document.getElementById('startBot').onclick = () => setBot(true);
    document.getElementById('stopBot').onclick = () => setBot(false);
    document.getElementById('editAcc').onclick = () => { editAcc = true; viewDashboard(); };
  }

  // ---------- plans and online payment ----------
  let selectedPlan = null;
  const money = (n) => Number(n).toLocaleString('en-US');
  const planDays = (d) => (d % 365 === 0 ? `${d / 365} year${d / 365 > 1 ? 's' : ''}` : `${d} days`);

  async function plansHtml() {
    let data = { markets: [], plans: [] };
    try { data = await api('GET', '/api/plans'); } catch { /* shown as empty */ }
    const first = data.markets[0] || null;   // the price shown on the list; the customer sees their own country's price when paying
    const cur = first ? first.code : '';
    const rows = data.plans.map((p) => `
      <div class="plan ${selectedPlan === p.id ? 'sel' : ''}">
        <div><b>${esc(p.name)}</b><small class="note">${planDays(p.days)}${p.note ? ' - ' + esc(p.note) : ''}</small></div>
        <div class="price"><b>$${esc(p.total_usd)}</b><small class="note">$${esc(p.price_usd)} plan${Number(p.tax_usd) ? ` + $${esc(p.tax_usd)} tax` : ''}${first ? ` &middot; ${first.currency} ${money(p.prices[first.code])}` : ''}</small></div>
        <button type="button" class="btn small solid" data-plan="${p.id}" ${cur ? '' : 'disabled'}>${me ? 'Buy this plan' : 'Sign up to buy'}</button>
      </div>`).join('');
    const note = !data.plans.length ? '<p class="note">No plans are available right now.</p>'
      : cur ? '' : '<p class="note">Online payment is not switched on yet. Pay with crypto below, or contact us.</p>';
    return { html: `<div class="plans">${rows}</div>${note}<div id="payBox"></div>`, data, cur };
  }

  function bindPlans(root, info) {
    root.onclick = (e) => {
      const b = e.target.closest('button[data-plan]');
      if (!b) return;
      if (!me) { location.hash = '#/register'; return; }
      selectedPlan = Number(b.dataset.plan);
      root.querySelectorAll('.plan').forEach((el) => el.classList.toggle('sel', el.contains(b)));
      const p = info.data.plans.find((x) => x.id === selectedPlan);
      const box = root.querySelector('#payBox');
      const mk = info.data.markets;
      const byCode = Object.fromEntries(mk.map((m) => [m.code, m]));
      const canCard = (info.data.methods || []).includes('card');
      box.innerHTML = `
        <form class="grid payform" id="momo">
          <h3 class="sec">Pay for ${esc(p.name)}</h3>
          <p class="note" id="priceNote"></p>
          ${canCard
            ? `<div class="seg"><label class="inline"><input type="radio" name="method" value="mobile_money" checked> Mobile money</label><label class="inline"><input type="radio" name="method" value="card"> Visa / Mastercard</label></div>`
            : '<input type="hidden" name="method" value="mobile_money">'}
          <div id="phoneWrap">
            ${mk.length > 1
              ? `<label>Country<select name="country">${mk.map((m) => `<option value="${esc(m.code)}">${esc(m.name)} (${esc(m.currency)})</option>`).join('')}</select></label>`
              : `<input type="hidden" name="country" value="${esc(mk[0].code)}">`}
            <label>Mobile money number<input name="phone" inputmode="tel" autocomplete="tel" required></label>
            <p class="note">A prompt will appear on your phone. Approve it to finish.</p></div>
          <p class="note" id="cardNote" hidden>Card payments are charged in UGX. You will be taken to MarzPay's secure page to pay, then brought back here.</p>
          <div class="msg" id="mp"></div>
          <button class="btn solid" type="submit"></button>
        </form>`;
      const f = box.querySelector('#momo');
      const syncMethod = () => {
        const card = f.elements.method.value === 'card';
        const code = card ? 'UG' : f.elements.country.value;
        const m = byCode[code] || mk[0];
        const label = `${m.currency} ${money(p.prices[m.code])}`;
        f.querySelector('#priceNote').textContent = `You pay ${label}.`;
        f.querySelector('button[type=submit]').textContent = `Pay ${label}`;
        f.querySelector('#phoneWrap').hidden = card;
        f.querySelector('#cardNote').hidden = !card;
        f.elements.phone.required = !card;
        f.elements.phone.placeholder = (byCode[f.elements.country.value] || m).example;
      };
      f.addEventListener('change', syncMethod);
      syncMethod();
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = f.querySelector('button[type=submit]');
        btn.disabled = true;
        const fd = new FormData(f);
        try {
          const r = await api('POST', '/api/me/pay', { plan_id: selectedPlan, currency: info.cur, method: fd.get('method'), country: fd.get('country'), phone: fd.get('phone') });
          if (r.redirect_url && /^https:\/\//.test(r.redirect_url)) location.href = r.redirect_url;
          else location.hash = '#/pay/' + r.order_id;
        } catch (err) { f.querySelector('#mp').textContent = err.message; btn.disabled = false; }
      };
      f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  }

  async function viewPlans() {
    await Promise.all([loadMe(), loadCfg()]);
    renderNav();
    const info = await plansHtml();
    $app.innerHTML = `<div class="grid stack"><div class="card grid"><h2>Choose your plan</h2>${info.html}</div>
      ${me ? '' : '<p class="note center">Already have an account? <a href="#/login">Log in</a></p>'}</div>`;
    bindPlans($app.querySelector('.card'), info);
  }

  let payRun = 0;
  async function viewPay(id) {
    if (!me) { location.hash = '#/login'; return; }
    const run = ++payRun;
    $app.innerHTML = `<div class="grid stack"><div class="card grid center" id="paybox"><h2>Waiting for payment</h2><p class="note">Finish the payment (approve the prompt on your phone, or complete the card page). This page updates by itself.</p><div class="spin"></div></div></div>`;
    const box = document.getElementById('paybox');
    const tick = async () => {
      if (run !== payRun || !box.isConnected) return;
      let o;
      try { o = await api('GET', '/api/me/orders/' + encodeURIComponent(id)); }
      catch (err) { if (err.status === 401 || err.status === 404) { location.hash = '#/dashboard'; return; } setTimeout(tick, 5000); return; }
      if (run !== payRun || !box.isConnected) return;
      if (o.status === 'PAID') {
        await loadMe();
        box.innerHTML = `<h2>Payment received</h2><p class="note">${esc(o.plan_name)} is active. Your MT5 details are open now.</p><a class="btn solid" href="#/dashboard">Continue</a>`;
        return;
      }
      if (o.status === 'FAILED' || o.status === 'EXPIRED') {
        box.innerHTML = `<h2>${o.status === 'FAILED' ? 'Payment did not go through' : 'Payment timed out'}</h2><p class="note">${esc(o.note || 'No money was taken, or it will be returned. You can try again.')}</p><a class="btn solid" href="#/plans">Try again</a>`;
        return;
      }
      setTimeout(tick, 4000);
    };
    tick();
  }

  // ---------- client dashboard ----------
  async function viewDashboard() {
    if (!me) { location.hash = '#/login'; return; }
    await Promise.all([loadMe(), loadCfg()]);
    const u = me;
    const approved = u.status === 'approved';
    const rejected = u.status === 'rejected';
    const expired = u.status === 'expired';
    const paid = !!u.pay_proof;
    const hasDetails = !!u.mt5_login;
    const step = approved ? (hasDetails ? 4 : 3) : paid && !rejected && !expired ? 2 : 1;
    const showBot = approved && hasDetails && !editAcc;
    chartStop();
    const steps = ['Payment', 'Review', 'MT5 details'];

    let banner;
    if (approved && hasDetails) banner = ['ok', 'Payment approved and MT5 details saved. Use Bot control below to start or stop the bot.'];
    else if (approved) banner = ['ok', 'Payment approved. Add your MT5 details below to get started.'];
    else if (expired) banner = ['bad', 'Your plan has ended and the bot is stopped. Choose a plan below to continue.'];
    else if (rejected) banner = ['bad', `Your payment was not approved.${u.admin_note ? ' Note from us: ' + u.admin_note : ''} Please check the details and submit again.`];
    else if (paid && !rejected) banner = ['wait', 'Payment received. We are reviewing it now and your MT5 details will open once it is approved.'];
    else banner = ['info', 'Welcome. Choose a plan to get started.'];
    const info = approved ? null : await plansHtml();
    const endsTxt = u.plan_ends_at ? new Date(u.plan_ends_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const left = u.plan_ends_at ? Math.max(0, Math.ceil((new Date(u.plan_ends_at) - Date.now()) / 86400000)) : null;

    const addr = cfg.payAddress
      ? `<div class="pay"><small class="note">Send ${esc(cfg.payAmount)} via ${esc(cfg.payNetwork)} to</small><div class="addr"><b>${esc(cfg.payAddress)}</b><button type="button" class="btn small" id="copy">Copy</button></div></div>`
      : '';
    const contact = contactLinks();

    $app.innerHTML = `
      <div class="grid stack">
        <div class="card">
          <div class="between"><h2>${esc(u.email)}</h2><span class="badge ${esc(u.status)}">${esc(u.status)}</span></div>
          <ol class="stepper">${steps.map((s, i) => `<li class="${i + 1 < step ? 'done' : i + 1 === step ? 'active' : ''}">${i + 1}. ${s}</li>`).join('')}</ol>
          <div class="banner ${banner[0]}">${esc(banner[1])}</div>
        </div>

        ${cfg.requireVerify && !u.email_verified ? `<div class="card grid"><h3>Confirm your email</h3><p class="note">We sent a confirmation link to <b>${esc(u.email)}</b>. You need to confirm it before you can pay. Check your spam folder too.</p><div class="row"><button type="button" class="btn small solid" id="resendV">Send again</button></div><div class="msg" id="mv"></div></div>` : ''}
        ${approved && u.plan_ends_at ? `<div class="card between"><div><small class="label">Your plan</small><div><b>${esc(u.plan_name || 'Plan')}</b> <span class="note">ends ${esc(endsTxt)} (${left} day${left === 1 ? '' : 's'} left)</span></div></div><a class="btn small" href="#/plans">Add time</a></div>` : ''}
        ${showBot ? botDashboardHtml(u) : ''}

        ${showBot ? '' : approved
          ? '<div class="card done-card"><h3>Payment approved</h3><p class="note">Thank you. Your payment has been verified.</p></div>'
          : `<div class="card grid" id="plansCard"><h3>1. Choose your plan</h3>${info.html}</div>
            <details class="card" ${info.cur ? '' : 'open'}><summary>Pay with crypto instead</summary>
            <form class="grid" id="pay">
              ${addr}
              <label>Network<input name="pay_network" required value="${esc(u.pay_network || cfg.payNetwork)}"></label>
              <label>Amount sent<input name="pay_amount" required value="${esc(u.pay_amount || cfg.payAmount)}"></label>
              <label>Transaction ID (hash)<input name="pay_proof" required minlength="8" value="${esc(u.pay_proof)}"></label>
              <div class="msg" id="m2"></div>
              <button class="btn solid" type="submit">${paid && !rejected && !expired ? 'Update payment details' : 'Submit for review'}</button>
            </form></details>`}

        ${showBot ? '' : `<form class="card grid ${approved ? '' : 'locked'}" id="acc">
          <div class="between"><h3>2. Your MT5 account</h3>${approved ? '' : '<span class="lock-tag">Locked</span>'}</div>
          ${approved ? '' : '<p class="note">This opens as soon as your payment is approved.</p>'}
          <label>Broker<input name="broker" required value="${esc(u.broker)}" ${approved ? '' : 'disabled'}></label>
          <label>MT5 login (numbers)<input name="mt5_login" required inputmode="numeric" value="${esc(u.mt5_login)}" ${approved ? '' : 'disabled'}></label>
          <label>Server<input name="mt5_server" required value="${esc(u.mt5_server)}" placeholder="e.g. Exness-MT5Real35" ${approved ? '' : 'disabled'}></label>
          <label>MT5 password<input name="mt5_investor" type="password" autocomplete="off" placeholder="${u.has_investor_password ? 'Saved. Leave blank to keep it' : ''}" ${approved ? '' : 'disabled'}></label>
          <div class="msg" id="m1"></div>
          <div class="row"><button class="btn solid" type="submit" ${approved ? '' : 'disabled'}>Save MT5 details</button>${approved && hasDetails ? '<button type="button" class="btn" id="cancelEdit">Cancel</button>' : ''}</div>
        </form>`}

        <div class="card grid">
          <h3>Contact</h3>
          ${contact ? `<div class="row">${contact}</div>` : ''}
          <form class="grid" id="wa">
            <label>Your WhatsApp number (optional)<input name="whatsapp" inputmode="tel" placeholder="+256700000000" value="${u.whatsapp ? '+' + esc(u.whatsapp) : ''}"></label>
            <div class="msg" id="m3"></div>
            <button class="btn small" type="submit">Save number</button>
          </form>
        </div>
      </div>`;

    const bind = (id, msgId, method, url, okText) => {
      const f = document.getElementById(id);
      if (!f) return;
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(method, url, Object.fromEntries(new FormData(f)));
          toast(okText);
          if (id === 'acc') editAcc = false;
          await loadMe();
          viewDashboard();
        } catch (err) { document.getElementById(msgId).textContent = err.message; }
      };
    };
    bind('pay', 'm2', 'PUT', '/api/me/payment', 'Submitted for review');
    const rv = document.getElementById('resendV');
    if (rv) rv.onclick = async () => {
      rv.disabled = true;
      try { await api('POST', '/api/me/resend-verification', {}); toast('Confirmation email sent'); }
      catch (err) { document.getElementById('mv').textContent = err.message; }
      setTimeout(() => { rv.disabled = false; }, 30000);
    };
    const pc = document.getElementById('plansCard');
    if (pc && info) bindPlans(pc, info);
    bind('acc', 'm1', 'PUT', '/api/me/account', 'MT5 details saved');
    const cancelEdit = document.getElementById('cancelEdit');
    if (cancelEdit) cancelEdit.onclick = () => { editAcc = false; viewDashboard(); };
    if (showBot) initBotDashboard();
    bind('wa', 'm3', 'PUT', '/api/me/contact', 'Number saved');

    const copy = document.getElementById('copy');
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(cfg.payAddress); toast('Address copied'); } catch { toast('Could not copy. Select and copy it manually.'); }
    };
  }

  // ---------- admin ----------
  const TITLES = { approved: 'Approved (paid)', pending: 'Pending', expired: 'Expired', rejected: 'Rejected' };

  const field = (label, val) => `<div class="kv"><small>${label}</small><span>${val ? esc(val) : '<span class="note">Not provided</span>'}</span></div>`;

  function userCard(u) {
    const wa = digitsOnly(u.whatsapp);
    return `
      <div class="user" data-id="${u.id}">
        <div class="between"><div class="em">${esc(u.email)}</div><span class="badge ${esc(u.status)}">${esc(u.status)}</span></div>
        ${u.phone ? `<div class="kv"><small>Phone</small><span>+${esc(digitsOnly(u.phone))}</span></div>` : ''}
        ${wa ? `<div class="kv"><small>WhatsApp</small><a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">+${wa}</a></div>` : ''}
        ${field('Payment proof', u.pay_proof || 'No transaction submitted')}
        ${u.pay_proof ? field('Network / amount', `${u.pay_network || ''} / ${u.pay_amount || ''}`) : ''}
        ${field('Broker', u.broker)}${field('MT5 login', u.mt5_login)}${field('Server', u.mt5_server)}
        <div class="kv"><small>MT5 password</small>
          ${u.has_investor_password
            ? `<span class="pwrow"><code class="pw">${MASK}</code><button class="btn small" data-act="reveal">Show</button></span>`
            : '<span class="note">Not provided</span>'}
        </div>
        ${u.plan_ends_at ? field('Plan', `${u.plan_name || 'Plan'} until ${new Date(u.plan_ends_at).toLocaleDateString('en-GB')}`) : ''}
        ${field('Email', u.email_verified ? 'Confirmed' : 'Not confirmed yet')}
        ${field('Registered', u.created_at)}
        ${u.admin_note ? field('Note', u.admin_note) : ''}
        <div class="actions">
          ${u.email_verified ? '' : '<button class="btn small" data-act="verify">Mark email confirmed</button>'}
          ${u.status !== 'approved' ? '<button class="btn small green" data-act="approved">Approve</button>' : ''}
          ${u.status !== 'rejected' ? '<button class="btn small red" data-act="rejected">Reject</button>' : ''}
          ${u.status !== 'pending' ? '<button class="btn small" data-act="pending">Set pending</button>' : ''}
          <button class="btn small danger" data-act="delete">Delete</button>
        </div>
      </div>`;
  }

  async function viewAdmin() {
    if (!me) { location.hash = '#/login'; return; }
    if (me.role !== 'admin') { location.hash = '#/dashboard'; return; }
    let users = await api('GET', '/api/admin/users');
    let planData = await api('GET', '/api/admin/plans');
    let orders = await api('GET', '/api/admin/orders');
    let mailInfo = await api('GET', '/api/admin/emails');
    await loadCfg();
    let filter = 'all';
    let q = '';

    $app.innerHTML = `
      <h2 class="big">Admin panel</h2>
      <p class="note">MT5 account and payment management</p>
      <div class="grid stats" id="stats"></div>

      <details class="card settings">
        <summary>Contact details shown to clients</summary>
        <form class="grid" id="contact">
          <label>Email<input type="email" name="contact_email" placeholder="you@example.com" value="${esc(cfg.contactEmail)}"></label>
          <label>WhatsApp number (with country code)<input name="contact_whatsapp" inputmode="tel" placeholder="+256700000000" value="${cfg.contactWhatsapp ? '+' + esc(cfg.contactWhatsapp) : ''}"></label>
          <div class="msg" id="mc"></div>
          <button class="btn solid small" type="submit">Save contact details</button>
        </form>
      </details>

      <details class="card settings" id="plansAdmin"></details>
      <details class="card settings" id="ordersAdmin"></details>
      <details class="card settings" id="emailAdmin"></details>

      <div class="toolbar">
        <input type="search" id="q" placeholder="Search by email, MT5 login or WhatsApp" autocomplete="off">
        <div class="chips" id="chips"></div>
      </div>
      <div id="list"></div>`;

    const $stats = document.getElementById('stats');
    const $chips = document.getElementById('chips');
    const $list = document.getElementById('list');

    const matches = (u) => {
      const t = q.trim().toLowerCase();
      if (!t) return true;
      return [u.email, u.mt5_login, u.whatsapp, u.phone].some((v) => String(v || '').toLowerCase().includes(t));
    };

    function render() {
      const cnt = (s) => users.filter((u) => u.status === s).length;
      const awaiting = users.filter((u) => u.status === 'pending' && u.pay_proof).length;
      $stats.innerHTML = `
        <div class="stat"><small>Total users</small><b>${users.length}</b></div>
        <div class="stat"><small>Approved</small><b>${cnt('approved')}</b></div>
        <div class="stat"><small>Awaiting review</small><b>${awaiting}</b></div>
        <div class="stat"><small>Expired</small><b>${cnt('expired')}</b></div>
        <div class="stat"><small>Rejected</small><b>${cnt('rejected')}</b></div>`;

      const base = users.filter(matches);
      const n = (s) => base.filter((u) => u.status === s).length;
      $chips.innerHTML = [['all', 'All', base.length], ['approved', 'Approved', n('approved')], ['pending', 'Pending', n('pending')], ['expired', 'Expired', n('expired')], ['rejected', 'Rejected', n('rejected')]]
        .map(([k, label, c]) => `<button type="button" class="chip ${filter === k ? 'active' : ''}" data-filter="${k}">${label} <span>${c}</span></button>`).join('');

      const groups = filter === 'all' ? ['approved', 'pending', 'expired', 'rejected'] : [filter];
      $list.innerHTML = `<div class="grid cols ${filter === 'all' ? '' : 'single'}">${groups.map((g) => {
        const items = base.filter((u) => u.status === g);
        return `<section class="col ${g}"><h3>${TITLES[g]}<span>${items.length}</span></h3><div class="col-body">${items.map(userCard).join('') || '<p class="note">No users here.</p>'}</div></section>`;
      }).join('')}</div>`;
    }
    render();

    // ----- plans & prices -----
    const planRow = (p) => `
      <form class="planform" data-id="${p ? p.id : ''}">
        <input name="name" placeholder="Name" value="${p ? esc(p.name) : ''}" required>
        <input name="days" inputmode="numeric" placeholder="Days" value="${p ? p.days : ''}" required>
        <input name="price_usd" inputmode="decimal" placeholder="Price $" value="${p ? esc(p.price_usd) : ''}" required>
        <input name="tax_usd" inputmode="decimal" placeholder="Tax $" value="${p ? esc(p.tax_usd) : '3'}">
        <input name="note" placeholder="Note (optional)" value="${p ? esc(p.note) : ''}">
        <label class="inline"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}> Shown</label>
        <span class="row"><button class="btn small solid" type="submit">${p ? 'Save' : 'Add plan'}</button>${p ? '<button class="btn small danger" type="button" data-pdel="' + p.id + '">Delete</button>' : ''}</span>
      </form>`;
    function renderPlansAdmin() {
      const $p = document.getElementById('plansAdmin');
      const open = $p.open;
      $p.innerHTML = `
        <summary>Plans, prices, countries and exchange rates</summary>
        <p class="note">Prices are in US dollars. Customers pay the plan price plus tax, converted at the rate for their country (Uganda is rounded up to the next 100).</p>
        <form class="grid" id="rates">
          <p class="note"><b>Countries and exchange rates.</b> Type how much local money 1 US dollar costs to switch a country on. Leave it blank to switch it off. Card payments are always in UGX, so keep Uganda on for card.</p>
          ${planData.markets.map((m) => `<label>${esc(m.name)}: ${esc(m.currency)} for 1 US dollar<input name="${esc(m.code)}" inputmode="decimal" placeholder="off" value="${esc(m.rate)}"></label>`).join('')}
          <div class="msg" id="mr"></div>
          <button class="btn small solid" type="submit">Save rates</button>
        </form>
        <h3 class="sec">Plans</h3>
        ${planData.onlineReady ? '' : '<p class="note">MarzPay keys are not set on the server yet, so customers cannot pay online.</p>'}
        <div class="planlist">${planData.plans.map(planRow).join('')}</div>
        <h3 class="sec">Add a plan</h3>
        ${planRow(null)}
        <div class="msg" id="mpl"></div>`;
      $p.open = open;
      const reload = async () => { planData = await api('GET', '/api/admin/plans'); renderPlansAdmin(); };
      $p.querySelector('#rates').onsubmit = async (e) => {
        e.preventDefault();
        try { await api('PUT', '/api/admin/rates', Object.fromEntries(new FormData(e.target))); toast('Rate saved'); await reload(); }
        catch (err) { $p.querySelector('#mr').textContent = err.message; }
      };
      $p.querySelectorAll('form.planform').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          const body = Object.fromEntries(new FormData(f));
          body.active = f.querySelector('[name=active]').checked;
          try {
            await api(f.dataset.id ? 'PUT' : 'POST', '/api/admin/plans' + (f.dataset.id ? '/' + f.dataset.id : ''), body);
            toast(f.dataset.id ? 'Plan saved' : 'Plan added');
            await reload();
          } catch (err) { $p.querySelector('#mpl').textContent = err.message; toast(err.message); }
        };
      });
      $p.querySelectorAll('[data-pdel]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Delete this plan? Past payments keep their record.')) return;
          try { await api('DELETE', '/api/admin/plans/' + b.dataset.pdel, {}); toast('Plan deleted'); await reload(); }
          catch (err) { toast(err.message); }
        };
      });
    }
    renderPlansAdmin();

    // ----- online payments -----
    function renderOrders() {
      const $o = document.getElementById('ordersAdmin');
      const open = $o.open;
      const paidN = orders.filter((o) => o.status === 'PAID').length;
      $o.innerHTML = `
        <summary>Online payments <span class="note">(${orders.length} recent, ${paidN} paid)</span></summary>
        ${orders.length ? orders.map((o) => `
          <div class="order" data-oid="${o.id}">
            <div class="between"><b>${esc(o.email || 'Deleted user')}</b><span class="badge ord-${esc(o.status.toLowerCase())}">${esc(o.status)}</span></div>
            <div class="note">${esc(o.plan_name)} (${o.days} days) &middot; ${esc(o.currency)} ${money(o.charged)} ($${esc(o.total_usd)}) &middot; ${esc(o.country || '')} ${o.phone ? esc(o.phone) : 'card'}</div>
            <div class="note">${new Date(o.created_at).toLocaleString('en-GB')}${o.note ? ' &middot; ' + esc(o.note) : ''}</div>
            ${o.status === 'PAID' ? '' : `<div class="actions"><button class="btn small" data-ocheck="${o.id}">Re-check with MarzPay</button><button class="btn small green" data-oapprove="${o.id}">Approve (money received)</button></div>`}
          </div>`).join('') : '<p class="note">No online payments yet.</p>'}`;
      $o.open = open;
      const refresh = async () => { orders = await api('GET', '/api/admin/orders'); users = await api('GET', '/api/admin/users'); renderOrders(); render(); };
      $o.querySelectorAll('[data-ocheck]').forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try { const r = await api('POST', `/api/admin/orders/${b.dataset.ocheck}/recheck`, {}); toast('Status: ' + r.status); await refresh(); }
          catch (err) { toast(err.message); b.disabled = false; }
        };
      });
      $o.querySelectorAll('[data-oapprove]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Only approve if you can see this money in your MarzPay wallet. Continue?')) return;
          try { await api('POST', `/api/admin/orders/${b.dataset.oapprove}/approve`, {}); toast('Approved'); await refresh(); }
          catch (err) { toast(err.message); }
        };
      });
    }
    renderOrders();

    // ----- email -----
    function renderEmailAdmin() {
      const $e = document.getElementById('emailAdmin');
      const open = $e.open;
      const m = mailInfo;
      $e.innerHTML = `
        <summary>Emails <span class="note">(${m.enabled ? 'on' : 'not set up'})</span></summary>
        ${m.enabled
          ? `<p class="note">Sending as <b>${esc(m.from)}</b> through ${esc(m.provider)}. Admin alerts go to <b>${esc(m.notify || 'nobody (set ADMIN_NOTIFY_EMAIL)')}</b>. Clients ${m.requireVerify ? 'must confirm their email before paying' : 'do not need to confirm their email'}. Expiry checks by pinger: ${m.cron ? 'on' : 'off (set CRON_KEY)'}.</p>
             <div class="row"><button type="button" class="btn small solid" id="mailTest">Send me a test email</button></div><div class="msg" id="mm"></div>`
          : '<p class="note">Automatic emails are off. Add EMAIL_API_KEY and EMAIL_FROM in your host settings (see the README), then redeploy.</p>'}
        <h3 class="sec">Recent emails</h3>
        ${m.log.length ? m.log.map((l) => `<div class="order"><div class="between"><b>${esc(l.subject)}</b><span class="badge ord-${l.status === 'sent' ? 'paid' : 'failed'}">${esc(l.status)}</span></div><div class="note">${esc(l.to_email)} &middot; ${new Date(l.created_at).toLocaleString('en-GB')}${l.error ? ' &middot; ' + esc(l.error) : ''}</div></div>`).join('') : '<p class="note">None yet.</p>'}`;
      $e.open = open;
      const t = $e.querySelector('#mailTest');
      if (t) t.onclick = async () => {
        t.disabled = true;
        try { const r = await api('POST', '/api/admin/email-test', {}); toast('Test sent to ' + r.to); }
        catch (err) { $e.querySelector('#mm').textContent = err.message; }
        mailInfo = await api('GET', '/api/admin/emails');
        renderEmailAdmin();
      };
    }
    renderEmailAdmin();

    document.getElementById('q').addEventListener('input', (e) => { q = e.target.value; render(); });

    document.getElementById('contact').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/api/admin/settings', Object.fromEntries(new FormData(e.target)));
        document.getElementById('mc').textContent = '';
        toast('Contact details saved');
      } catch (err) { document.getElementById('mc').textContent = err.message; }
    };

    $app.onclick = async (e) => {
      const chip = e.target.closest('button[data-filter]');
      if (chip) { filter = chip.dataset.filter; render(); return; }
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const card = b.closest('.user');
      const id = Number(card.dataset.id);
      const u = users.find((x) => x.id === id);
      const act = b.dataset.act;
      try {
        if (act === 'reveal') {
          const code = card.querySelector('.pw');
          const hide = () => { code.textContent = MASK; b.textContent = 'Show'; b.dataset.shown = '0'; };
          if (b.dataset.shown === '1') { hide(); return; }
          const r = await api('POST', `/api/admin/users/${id}/reveal`, {});
          code.textContent = r.password;
          b.textContent = 'Hide';
          b.dataset.shown = '1';
          clearTimeout(b._t);
          b._t = setTimeout(() => { if (b.isConnected) hide(); }, 30000);
        } else if (act === 'verify') {
          await api('POST', `/api/admin/users/${id}/verify`, {});
          u.email_verified = true;
          render();
          toast('Marked as confirmed');
        } else if (act === 'delete') {
          if (!confirm(`Delete ${u.email}? This cannot be undone.`)) return;
          await api('DELETE', `/api/admin/users/${id}`, {});
          users = users.filter((x) => x.id !== id);
          render();
          toast('User deleted');
        } else {
          let note = '';
          if (act === 'rejected') {
            note = prompt('Reason for rejecting (optional)');
            if (note === null) return;
          }
          let days = '';
          if (act === 'approved') {
            days = prompt('Days of access from today? Leave blank for no end date.');
            if (days === null) return;
          }
          await api('POST', `/api/admin/users/${id}/status`, { status: act, note, days });
          users = await api('GET', '/api/admin/users');
          render();
          toast('Updated');
        }
      } catch (err) { toast(err.message); }
    };
  }

  // ---------- router ----------
  async function route() {
    $app.onclick = null;
    payRun++;
    chartStop();
    const r = location.hash.replace(/^#/, '') || '/';
    if (r !== '/dashboard') editAcc = false;
    try {
      renderNav();
      if (r === '/login') return authForm('login');
      if (r === '/register') return authForm('register');
      if (r === '/forgot') return viewForgot();
      if (r.startsWith('/reset/')) return viewReset(r.slice(7));
      if (r === '/verified') return viewVerified(true);
      if (r === '/verify-failed') return viewVerified(false);
      if (r === '/plans') return await viewPlans();
      if (r.startsWith('/pay/')) return await viewPay(r.slice(5));
      if (r === '/dashboard') return await viewDashboard();
      if (r === '/admin') return await viewAdmin();
      await loadCfg();
      return viewHome();
    } catch (err) {
      if (err.status === 401) { me = null; renderNav(); location.hash = '#/login'; }
      else toast(err.message);
    }
  }

  window.addEventListener('hashchange', route);
  loadMe().then(route);
})();
