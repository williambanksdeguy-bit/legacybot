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
        <p>Managed MT5 trading. Make your payment, get approved, then connect your account. We keep you updated at every step.</p>
        <div class="row center"><a class="btn solid" href="#/register">Get started</a><a class="btn" href="#/login">Log in</a></div>
      </section>
      <section class="grid how">
        <div class="card"><span class="num">1</span><h3>Pay</h3><p class="note">Send your payment in crypto and submit the transaction ID.</p></div>
        <div class="card"><span class="num">2</span><h3>Get approved</h3><p class="note">We verify your payment and approve your account.</p></div>
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
        <label>Password<input type="password" name="password" required minlength="${isReg ? 10 : 1}" autocomplete="${isReg ? 'new-password' : 'current-password'}"></label>
        ${isReg ? '<span class="note">At least 10 characters.</span>' : ''}
        <div class="msg" id="msg"></div>
        <button class="btn solid" type="submit">${isReg ? 'Sign up' : 'Log in'}</button>
        <a href="#/${isReg ? 'login' : 'register'}" class="note">${isReg ? 'Already registered? Log in' : 'New here? Create an account'}</a>
      </form>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api('POST', '/api/' + kind, { email: fd.get('email'), password: fd.get('password') });
        await loadMe();
        location.hash = r.role === 'admin' ? '#/admin' : '#/dashboard';
      } catch (err) { document.getElementById('msg').textContent = err.message; }
    };
  }

  // ---------- client dashboard ----------
  async function viewDashboard() {
    if (!me) { location.hash = '#/login'; return; }
    await Promise.all([loadMe(), loadCfg()]);
    const u = me;
    const approved = u.status === 'approved';
    const rejected = u.status === 'rejected';
    const paid = !!u.pay_proof;
    const hasDetails = !!u.mt5_login;
    const step = approved ? (hasDetails ? 4 : 3) : paid && !rejected ? 2 : 1;
    const steps = ['Payment', 'Review', 'MT5 details'];

    let banner;
    if (approved && hasDetails) banner = ['ok', 'You are all set. Your MT5 details are saved and we will take it from here.'];
    else if (approved) banner = ['ok', 'Payment approved. Add your MT5 details below to get started.'];
    else if (rejected) banner = ['bad', `Your payment was not approved.${u.admin_note ? ' Note from us: ' + u.admin_note : ''} Please check the details and submit again.`];
    else if (paid) banner = ['wait', 'Payment received. We are reviewing it now and your MT5 details will open once it is approved.'];
    else banner = ['info', 'Welcome. Send your payment and submit the transaction ID to get started.'];

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

        ${approved
          ? '<div class="card done-card"><h3>Payment approved</h3><p class="note">Thank you. Your payment has been verified.</p></div>'
          : `<form class="card grid" id="pay">
              <h3>1. Payment</h3>
              ${addr}
              <label>Network<input name="pay_network" required value="${esc(u.pay_network || cfg.payNetwork)}"></label>
              <label>Amount sent<input name="pay_amount" required value="${esc(u.pay_amount || cfg.payAmount)}"></label>
              <label>Transaction ID (hash)<input name="pay_proof" required minlength="8" value="${esc(u.pay_proof)}"></label>
              <div class="msg" id="m2"></div>
              <button class="btn solid" type="submit">${paid && !rejected ? 'Update payment details' : 'Submit for review'}</button>
            </form>`}

        <form class="card grid ${approved ? '' : 'locked'}" id="acc">
          <div class="between"><h3>2. Your MT5 account</h3>${approved ? '' : '<span class="lock-tag">Locked</span>'}</div>
          ${approved ? '' : '<p class="note">This opens as soon as your payment is approved.</p>'}
          <label>Broker<input name="broker" required value="${esc(u.broker)}" ${approved ? '' : 'disabled'}></label>
          <label>MT5 login (numbers)<input name="mt5_login" required inputmode="numeric" value="${esc(u.mt5_login)}" ${approved ? '' : 'disabled'}></label>
          <label>Server<input name="mt5_server" required value="${esc(u.mt5_server)}" placeholder="e.g. Exness-MT5Real35" ${approved ? '' : 'disabled'}></label>
          <label>MT5 password<input name="mt5_investor" type="password" autocomplete="off" placeholder="${u.has_investor_password ? 'Saved. Leave blank to keep it' : ''}" ${approved ? '' : 'disabled'}></label>
          <div class="msg" id="m1"></div>
          <button class="btn solid" type="submit" ${approved ? '' : 'disabled'}>Save MT5 details</button>
        </form>

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
          await loadMe();
          viewDashboard();
        } catch (err) { document.getElementById(msgId).textContent = err.message; }
      };
    };
    bind('pay', 'm2', 'PUT', '/api/me/payment', 'Submitted for review');
    bind('acc', 'm1', 'PUT', '/api/me/account', 'MT5 details saved');
    bind('wa', 'm3', 'PUT', '/api/me/contact', 'Number saved');

    const copy = document.getElementById('copy');
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(cfg.payAddress); toast('Address copied'); } catch { toast('Could not copy. Select and copy it manually.'); }
    };
  }

  // ---------- admin ----------
  const TITLES = { approved: 'Approved (paid)', pending: 'Pending', rejected: 'Rejected' };

  const field = (label, val) => `<div class="kv"><small>${label}</small><span>${val ? esc(val) : '<span class="note">Not provided</span>'}</span></div>`;

  function userCard(u) {
    const wa = digitsOnly(u.whatsapp);
    return `
      <div class="user" data-id="${u.id}">
        <div class="between"><div class="em">${esc(u.email)}</div><span class="badge ${esc(u.status)}">${esc(u.status)}</span></div>
        ${wa ? `<div class="kv"><small>WhatsApp</small><a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">+${wa}</a></div>` : ''}
        ${field('Payment proof', u.pay_proof || 'No transaction submitted')}
        ${u.pay_proof ? field('Network / amount', `${u.pay_network || ''} / ${u.pay_amount || ''}`) : ''}
        ${field('Broker', u.broker)}${field('MT5 login', u.mt5_login)}${field('Server', u.mt5_server)}
        <div class="kv"><small>MT5 password</small>
          ${u.has_investor_password
            ? `<span class="pwrow"><code class="pw">${MASK}</code><button class="btn small" data-act="reveal">Show</button></span>`
            : '<span class="note">Not provided</span>'}
        </div>
        ${field('Registered', u.created_at)}
        ${u.admin_note ? field('Note', u.admin_note) : ''}
        <div class="actions">
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
      return [u.email, u.mt5_login, u.whatsapp].some((v) => String(v || '').toLowerCase().includes(t));
    };

    function render() {
      const cnt = (s) => users.filter((u) => u.status === s).length;
      const awaiting = users.filter((u) => u.status === 'pending' && u.pay_proof).length;
      $stats.innerHTML = `
        <div class="stat"><small>Total users</small><b>${users.length}</b></div>
        <div class="stat"><small>Approved</small><b>${cnt('approved')}</b></div>
        <div class="stat"><small>Awaiting review</small><b>${awaiting}</b></div>
        <div class="stat"><small>Rejected</small><b>${cnt('rejected')}</b></div>`;

      const base = users.filter(matches);
      const n = (s) => base.filter((u) => u.status === s).length;
      $chips.innerHTML = [['all', 'All', base.length], ['approved', 'Approved', n('approved')], ['pending', 'Pending', n('pending')], ['rejected', 'Rejected', n('rejected')]]
        .map(([k, label, c]) => `<button type="button" class="chip ${filter === k ? 'active' : ''}" data-filter="${k}">${label} <span>${c}</span></button>`).join('');

      const groups = filter === 'all' ? ['approved', 'pending', 'rejected'] : [filter];
      $list.innerHTML = `<div class="grid cols ${filter === 'all' ? '' : 'single'}">${groups.map((g) => {
        const items = base.filter((u) => u.status === g);
        return `<section class="col ${g}"><h3>${TITLES[g]}<span>${items.length}</span></h3><div class="col-body">${items.map(userCard).join('') || '<p class="note">No users here.</p>'}</div></section>`;
      }).join('')}</div>`;
    }
    render();

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
          await api('POST', `/api/admin/users/${id}/status`, { status: act, note });
          u.status = act;
          u.admin_note = note || null;
          render();
          toast('Updated');
        }
      } catch (err) { toast(err.message); }
    };
  }

  // ---------- router ----------
  async function route() {
    $app.onclick = null;
    const r = location.hash.replace(/^#/, '') || '/';
    try {
      renderNav();
      if (r === '/login') return authForm('login');
      if (r === '/register') return authForm('register');
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
