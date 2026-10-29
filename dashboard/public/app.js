// Fraud Watch front end: plain JavaScript, no framework. All numbers come from MongoDB through the API in server.js.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  const time = (iso) => new Date(iso).toLocaleTimeString();
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const reasonText = (r) => String(r).replace(/_/g, ' ');
  const pills = (reasons) => (reasons || []).map((x) => `<span class="pill">${esc(reasonText(x))}</span>`).join('');

  async function api(url, body, method) {
    const opt = body === undefined && !method ? {} : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
    const r = await fetch(url, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { /* no body */ }
    if (!r.ok) throw Object.assign(new Error((data && data.error) || r.statusText), { status: r.status });
    return data;
  }
  let toastTimer;
  function toast(msg, isErr) {
    const t = $('toast'); t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3500);
  }

  const S = { cfg: null, tab: 'live', paused: false, flaggedOnly: false, sound: false, lastAlert: null, first: true, feed: [], user: null };
  const AXIS = { ticks: { color: '#8b98a8' }, grid: { color: '#263040' } };

  // ------------------------------------------------------------------ tabs
  function showTab(name) {
    S.tab = name;
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
    history.replaceState(null, '', '#' + name);
    if (name === 'radar') sizeRadar();
    if (name === 'attack') tickReadiness();
    if (name === 'rings') loadRings();
    if (name === 'rules') loadRules();
    if (name === 'investigate') loadUserLists();
    if (name === 'try') { loadUserLists(); }
    if (name === 'tune') { loadWhatIf(); }
  }
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    const tabs = ['live', 'radar', 'attack', 'rings', 'rules', 'investigate', 'try', 'tune', 'help'];
    if (/^[1-9]$/.test(e.key)) showTab(tabs[Number(e.key) - 1]);
    if (e.key === 'p') togglePause();
  });

  // ------------------------------------------------------------------ live monitor
  const rateChart = new Chart($('c-rate'), {
    data: { labels: [], datasets: [
      { type: 'bar', label: 'events', data: [], backgroundColor: 'rgba(77,163,255,.55)', order: 2 },
      { type: 'line', label: 'flagged', data: [], borderColor: '#ff5c5c', backgroundColor: '#ff5c5c', tension: .2, pointRadius: 3, order: 1, yAxisID: 'y2' }] },
    options: { animation: false, maintainAspectRatio: false,
      scales: { x: { ...AXIS, ticks: { color: '#8b98a8', maxTicksLimit: 8 } },
                y: { ...AXIS, beginAtZero: true, title: { display: true, text: 'events/s', color: '#8b98a8' } },
                y2: { beginAtZero: true, position: 'right', ticks: { color: '#ff9a9a', precision: 0 }, grid: { drawOnChartArea: false }, title: { display: true, text: 'flagged/s', color: '#ff9a9a' } } },
      plugins: { legend: { labels: { color: '#e6edf3' } } } },
  });
  const riskChart = new Chart($('c-risk'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'risk', data: [], borderColor: '#4da3ff', pointRadius: 4, pointHoverRadius: 7, pointBackgroundColor: [], tension: .15 },
      { label: 'alert threshold', data: [], borderColor: '#f0b429', borderDash: [6, 4], pointRadius: 0 }] },
    options: { animation: false, maintainAspectRatio: false,
      onClick: (e, els) => { if (els.length && els[0].datasetIndex === 0) openDrawer(S.feedShown[S.feedShown.length - 1 - els[0].index].txId); },
      scales: { x: { display: false }, y: { ...AXIS, min: 0, max: 100 } }, plugins: { legend: { labels: { color: '#e6edf3' } } } },
  });

  function renderTicker(rows) {
    S.feedShown = S.flaggedOnly ? rows.filter((r) => r.flagged) : rows;
    $('ticker').innerHTML = S.feedShown.map((r) => `
      <tr class="click ${r.flagged ? 'flagged' : ''}" data-tx="${esc(r.txId)}">
        <td>${time(r.ts)}</td><td><a href="#" data-user="${esc(r.userId)}" style="color:inherit">${esc(r.userId)}</a></td>
        <td class="num">${money(r.amount)}</td><td class="num">${Number(r.risk).toFixed(0)}</td><td>${pills(r.reasons)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Nothing to show yet.</td></tr>';
    const ordered = [...S.feedShown].reverse();
    riskChart.data.labels = ordered.map((r) => time(r.ts));
    riskChart.data.datasets[0].data = ordered.map((r) => r.risk);
    riskChart.data.datasets[0].pointBackgroundColor = ordered.map((r) => (r.flagged ? '#ff5c5c' : '#4da3ff'));
    riskChart.data.datasets[1].data = ordered.map(() => (S.cfg ? S.cfg.scoreAlert : 60));
    riskChart.update();
  }
  $('ticker').addEventListener('click', (e) => {
    const u = e.target.closest('a[data-user]');
    if (u) { e.preventDefault(); investigate(u.dataset.user); return; }
    const tr = e.target.closest('tr[data-tx]'); if (tr) openDrawer(tr.dataset.tx);
  });

  function beep() {
    try { const c = new (window.AudioContext || window.webkitAudioContext)(); const o = c.createOscillator(); const g = c.createGain();
      o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = .08; o.start(); o.stop(c.currentTime + .15); } catch (e) { /* no audio */ }
  }
  function renderAlerts(rows) {
    $('alerts').innerHTML = rows.map((a) => `<li data-tx="${esc(a.txId)}"><span class="pill">${esc((a.reasons || []).map(reasonText).join(' + '))}</span>
      <b>${esc(a.userId)}</b> ${money(a.amount)} &middot; risk ${Number(a.risk).toFixed(0)}<span class="when">${time(a.ts)}</span></li>`).join('') || '<li class="muted">No alerts yet.</li>';
    const top = rows[0]; if (!top) return;
    if (top.txId !== S.lastAlert) {
      $('banner').dataset.tx = top.txId;
      $('banner').textContent = `ANOMALY: ${top.userId} spent ${money(top.amount)} (risk ${Number(top.risk).toFixed(0)}, ${(top.reasons || []).map(reasonText).join(' + ')}). Click for details.`;
      if (!S.first) { const b = $('banner'); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); if (S.sound) beep(); }
      S.lastAlert = top.txId;
    }
  }
  $('alerts').addEventListener('click', (e) => { const li = e.target.closest('li[data-tx]'); if (li) openDrawer(li.dataset.tx); });
  $('banner').addEventListener('click', () => { if ($('banner').dataset.tx) openDrawer($('banner').dataset.tx); });

  function renderStats(s) {
    $('k-eps').textContent = s.last60s.eventsPerSecond; $('k-flag').textContent = s.last60s.flagged; $('k-lat').textContent = s.last60s.avgLatencyMs ?? '-';
    rateChart.data.labels = s.perSecond.map((p) => new Date(p.t).toLocaleTimeString());
    rateChart.data.datasets[0].data = s.perSecond.map((p) => p.total);
    rateChart.data.datasets[1].data = s.perSecond.map((p) => p.flagged);
    rateChart.update();
  }
  async function tickLive() {
    if (S.paused) return;
    try {
      const [feed, alerts, stats] = await Promise.all(['/api/feed', '/api/alerts', '/api/stats'].map((u) => api(u)));
      S.feed = feed; S.eps = stats.last60s.events; S.connected = true; renderTicker(feed); renderAlerts(alerts); renderStats(stats); S.first = S.tourOn ? S.first : false; updateOnboard();
      $('dot').className = 'dot live'; $('status').textContent = 'live, refreshing every second';
    } catch (e) { S.connected = false; updateOnboard(); $('dot').className = 'dot'; $('status').textContent = 'offline: ' + e.message; }
  }
  function togglePause() {
    S.paused = !S.paused; $('pause').innerHTML = (S.paused ? 'Resume' : 'Pause') + ' <kbd>p</kbd>';
    $('dot').className = S.paused ? 'dot paused' : 'dot live'; $('status').textContent = S.paused ? 'paused (data keeps flowing into MongoDB)' : 'live';
    if (!S.paused) tickLive();
  }
  $('pause').addEventListener('click', togglePause);
  $('only-flagged').addEventListener('change', (e) => { S.flaggedOnly = e.target.checked; renderTicker(S.feed); });
  $('sound').addEventListener('change', (e) => { S.sound = e.target.checked; if (S.sound) beep(); });

  // pipeline control
  function showProc(name, st) {
    const el = $(name === 'detector' ? 'det-state' : 'gen-state');
    el.textContent = st.running ? 'running' : 'stopped'; el.className = 'pill ' + (st.running ? 'ok' : '');
  }
  async function tickPipeline() {
    try {
      const p = await api('/api/pipeline'); showProc('detector', p.detector); showProc('generator', p.generator);
      S.pipe = { detector: p.detector.running, generator: p.generator.running }; updateOnboard(); if (S.tab === 'attack') tickReadiness();
      const lines = [...p.detector.log.map((l) => '[detector] ' + l), ...p.generator.log.map((l) => '[traffic] ' + l)].slice(-40);
      if (lines.length) $('proc-log').textContent = lines.join('\n');
    } catch (e) { /* the live tick shows offline */ }
  }
  async function pipe(name, action, body) {
    try { await api(`/api/pipeline/${name}/${action}`, body || {}); toast(`${name} ${action === 'start' ? 'starting' : 'stopping'}...`); setTimeout(tickPipeline, 800); }
    catch (e) { toast(e.message, true); }
  }
  $('det-start').onclick = () => pipe('detector', 'start');
  $('det-stop').onclick = () => pipe('detector', 'stop');
  $('gen-start').onclick = () => pipe('generator', 'start', { users: $('gen-users').value, warmS: $('gen-warm').value });
  $('gen-stop').onclick = () => pipe('generator', 'stop');

  // ------------------------------------------------------------------ explanation drawer
  function closeDrawer() { $('drawer').classList.remove('open'); }
  async function openDrawer(txId) {
    const d = $('drawer'); d.classList.add('open'); d.innerHTML = '<p class="muted">Loading...</p>';
    try {
      const [e, cfg] = await Promise.all([api('/api/event/' + encodeURIComponent(txId)), loadConfig()]);
      const warm = e.warm, typical = warm || e.baselineMeanLog == null ? null : Math.exp(e.baselineMeanLog);
      const A = warm ? 0 : clamp01((e.z - cfg.zLow) / (cfg.zHigh - cfg.zLow));
      const V = clamp01((e.burst - cfg.burstSoft) / (cfg.burstHard - cfg.burstSoft));
      const why = [];
      if (warm) why.push(`<b>Still warming up.</b> This user has only ${e.baselineN} of ${cfg.minHistory} baseline transactions, so the amount is not judged yet.`);
      else why.push(`<b>Amount.</b> ${money(e.amount)} is <b>${(e.amount / typical).toFixed(1)}x</b> this user's typical ${money(typical)} (z = ${e.z}; normal behaviour stays below about 2.5).`);
      why.push(`<b>Velocity.</b> This was transaction number <b>${e.burst}</b> from this user within ${cfg.burstWindowS} seconds (it starts to count at ${cfg.burstSoft} and is fully suspicious at ${cfg.burstHard}).`);
      const ctx = [];
      if (e.country) ctx.push(`<b>Location.</b> Paid from <b>${esc(e.country)}</b>; this user's home country is ${esc(e.homeCountry || 'unknown')}. ${e.geoMismatch ? '<b>Different from home.</b>' : 'Same as home.'}`);
      if (e.deviceId) ctx.push(`<b>Device.</b> ${esc(e.deviceId)} ${e.newDevice ? '<b>has not been used by this user before.</b>' : 'is a known device for this user.'}` +
        ((e.deviceUsers || []).length > 1 ? ` It was used by <b>${e.deviceUsers.length} accounts</b> in the last 30 minutes (${e.deviceUsers.slice(0, 6).map(esc).join(', ')}).` : ''));
      d.innerHTML = `
        <div class="row"><h3>${e.flagged ? 'Flagged' : 'Not flagged'}</h3><span class="grow" style="flex:1"></span><button class="btn" id="dr-close">Close (Esc)</button></div>
        <div class="muted small">${esc(e.userId)} &middot; ${money(e.amount)} &middot; ${new Date(e.ts).toLocaleString()}</div>
        <div class="row" style="margin:14px 0"><div class="big" style="color:${e.flagged ? 'var(--bad)' : 'var(--ok)'}">${Number(e.risk).toFixed(0)}</div>
          <div style="flex:1"><div class="bar risk"><i style="width:${e.risk}%"></i></div><div class="muted small">risk (alert at ${cfg.scoreAlert})</div></div></div>
        <div>${pills(e.reasons) || '<span class="pill ok">no suspicious signal</span>'} ${warm ? '<span class="pill warm">warm-up</span>' : ''}</div>
        <h3 style="margin-top:18px;font-size:13px" class="muted">WHY</h3>
        <ul style="padding-left:18px;margin:6px 0">${why.map((w) => `<li style="margin:6px 0">${w}</li>`).join('')}</ul>
        <div class="barline"><span>Amount component</span><div class="bar"><i style="width:${A * 100}%"></i></div><span>${(A * 100).toFixed(0)}%</span></div>
        <div class="barline"><span>Velocity component</span><div class="bar"><i style="width:${V * 100}%"></i></div><span>${(V * 100).toFixed(0)}%</span></div>
        <div class="muted small">risk = 100 &times; (1 &minus; (1 &minus; amount) &times; (1 &minus; velocity)). Either component alone can reach the alert level.</div>
        ${ctx.length ? `<h3 style="margin-top:18px;font-size:13px" class="muted">CONTEXT (shown, not part of the score)</h3>
        <ul style="padding-left:18px;margin:6px 0">${ctx.map((w) => `<li style="margin:6px 0">${w}</li>`).join('')}</ul>
        ${(e.deviceUsers || []).length > 1 ? '<button class="btn" id="dr-rings">Show fraud rings</button>' : ''}` : ''}
        <h3 style="margin-top:18px;font-size:13px" class="muted">STORED BY MONGODB</h3>
        <table><tbody>
          <tr><td>Baseline events used</td><td class="num">${e.baselineN}</td></tr>
          <tr><td>Mean of ln(amount)</td><td class="num">${e.baselineMeanLog ?? '-'}</td></tr>
          <tr><td>Std deviation / variance</td><td class="num">${e.baselineSdLog ?? '-'} / ${e.baselineVarLog ?? '-'}</td></tr>
          <tr><td>z-score</td><td class="num">${e.z}</td></tr>
          <tr><td>Scoring latency</td><td class="num">${e.latencyMs} ms</td></tr>
          <tr><td>Ground-truth label</td><td class="num">${esc(e.label || 'none')}</td></tr></tbody></table>
        <div class="row" style="margin-top:14px"><button class="btn primary" id="dr-user">Investigate ${esc(e.userId)}</button></div>`;
      if ($('dr-rings')) $('dr-rings').onclick = () => { closeDrawer(); showTab('rings'); };
      $('dr-close').onclick = closeDrawer; $('dr-user').onclick = () => { closeDrawer(); investigate(e.userId); };
    } catch (err) { d.innerHTML = `<div class="row"><h3>Not available</h3><span style="flex:1"></span><button class="btn" id="dr-close">Close</button></div><p class="muted">${esc(err.message)}</p>`; $('dr-close').onclick = closeDrawer; }
  }

  // ------------------------------------------------------------------ investigate
  async function loadConfig() { if (!S.cfg) S.cfg = await api('/api/config'); return S.cfg; }
  async function loadUserLists() {
    try {
      const t = await api('/api/users/top?minutes=30');
      const chip = (u, extra) => `<button class="chip" data-user="${esc(u)}">${esc(u)}${extra}</button>`;
      $('chips-flagged').innerHTML = t.flagged.map((x) => chip(x.userId, ` &middot; ${x.alerts} alerts`)).join('') || '<span class="muted">none yet</span>';
      $('chips-busy').innerHTML = t.busy.map((x) => chip(x.userId, ` &middot; ${x.events}`)).join('') || '<span class="muted">none yet</span>';
      $('user-list').innerHTML = [...t.busy, ...t.flagged].map((x) => `<option value="${esc(x.userId)}">`).join('');
      S.busyUsers = t.busy.map((x) => x.userId);
    } catch (e) { /* offline */ }
  }
  ['chips-flagged', 'chips-busy'].forEach((id) => $(id).addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) investigate(c.dataset.user); }));
  $('inv-go').onclick = () => { if ($('inv-user').value.trim()) investigate($('inv-user').value.trim()); };
  $('inv-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('inv-go').click(); });
  $('inv-refresh').onclick = () => { loadUserLists(); if (S.user) investigate(S.user); };

  const userChart = new Chart($('c-user'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'amount', data: [], showLine: false, pointRadius: 4, pointHoverRadius: 8, pointBackgroundColor: [], borderColor: '#4da3ff' },
      { label: 'rolling average', data: [], borderColor: '#4da3ff', pointRadius: 0, tension: .2, borderWidth: 2 },
      { label: 'average + 3 SD', data: [], borderColor: '#f0b429', borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 }] },
    options: { animation: false, maintainAspectRatio: false, interaction: { mode: 'nearest', intersect: true },
      onClick: (e, els) => { if (els.length && els[0].datasetIndex === 0 && S.userRolling[els[0].index]) openDrawer(S.userRolling[els[0].index].txId); },
      scales: { x: { display: false }, y: { ...AXIS, beginAtZero: true } }, plugins: { legend: { labels: { color: '#e6edf3' } } } },
  });
  async function investigate(userId) {
    S.user = userId; showTab('investigate'); $('inv-user').value = userId;
    try {
      const [u, rolling] = await Promise.all([api('/api/user/' + encodeURIComponent(userId)), api('/api/rolling/' + encodeURIComponent(userId))]);
      $('inv-empty').style.display = 'none'; $('inv-body').style.display = 'block';
      const p = u.profile;
      $('inv-cards').innerHTML = p
        ? [['Transactions', p.events], ['Alerts', p.flagged], ['Typical amount', p.typical == null ? '-' : money(p.typical)],
           ['Spread (SD of ln)', p.sdLog ?? '-'], ['Last seen', time(p.last)]].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('')
        : '<div class="stat"><b>New user</b><span>no history in MongoDB yet</span></div>';
      S.userRolling = rolling;
      userChart.data.labels = rolling.map((r) => time(r.ts));
      userChart.data.datasets[0].data = rolling.map((r) => r.amount);
      userChart.data.datasets[0].pointBackgroundColor = rolling.map((r) => (r.flagged ? '#ff5c5c' : '#4da3ff'));
      userChart.data.datasets[1].data = rolling.map((r) => r.rollingAvg);
      userChart.data.datasets[2].data = rolling.map((r) => (r.rollingStd == null ? null : r.rollingAvg + 3 * r.rollingStd));
      userChart.update();
      $('inv-table').innerHTML = u.recent.map((r) => `<tr class="click ${r.flagged ? 'flagged' : ''}" data-tx="${esc(r.txId)}"><td>${time(r.ts)}</td>
        <td class="num">${money(r.amount)}</td><td class="num">${Number(r.risk).toFixed(0)}</td><td>${pills(r.reasons)}</td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">No transactions for this user yet.</td></tr>';
    } catch (e) { toast(e.message, true); }
  }
  $('inv-table').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-tx]'); if (tr) openDrawer(tr.dataset.tx); });

  // ------------------------------------------------------------------ try it yourself
  let hintTimer;
  async function showHint() {
    const id = $('try-user').value.trim(); if (!id) return;
    try {
      const u = await api('/api/user/' + encodeURIComponent(id)); S.tryProfile = u.profile;
      $('try-hint').innerHTML = u.profile && u.profile.typical
        ? `${esc(id)} has ${u.profile.events} transactions. Typical amount <b>${money(u.profile.typical)}</b>. Try an amount near that (normal) or much higher (suspicious).`
        : `${esc(id)} has no history yet. Their first transactions are in warm-up, so only the burst button will trigger an alert.`;
      if (u.profile && u.profile.typical && !S.amountTouched) $('try-amount').value = u.profile.typical;
    } catch (e) { $('try-hint').textContent = e.message; }
  }
  $('try-user').addEventListener('input', () => { clearTimeout(hintTimer); hintTimer = setTimeout(showHint, 350); });
  $('try-amount').addEventListener('input', () => (S.amountTouched = true));
  $('try-random').onclick = async () => {
    if (!S.busyUsers || !S.busyUsers.length) await loadUserLists();
    if (!S.busyUsers || !S.busyUsers.length) return toast('No users yet. Start the demo traffic first.', true);
    $('try-user').value = S.busyUsers[Math.floor(Math.random() * S.busyUsers.length)]; S.amountTouched = false; showHint();
  };
  async function send(kind) {
    const userId = $('try-user').value.trim(); if (!userId) return toast('Enter a user id first', true);
    await showHint();
    const typical = S.tryProfile && S.tryProfile.typical;
    let amount = Number($('try-amount').value);
    if (kind === 'normal') { if (!typical) return toast('This user has no typical amount yet. Use "Send this amount".', true); amount = typical; }
    if (kind === 'spike') { if (!typical) return toast('This user has no typical amount yet. Use "Send this amount".', true); amount = Math.round(typical * 10 * 100) / 100; $('try-amount').value = amount; }
    if (kind === 'burst' && !(amount > 0)) return toast('Enter an amount', true);
    if (kind === 'burst' && typical && !S.amountTouched) amount = typical;
    try {
      const r = await api('/api/transactions', { userId, amount, kind: kind === 'normal' ? 'normal' : kind === 'send' ? 'custom' : kind, count: 12, gapMs: 250 });
      if (!$('try-results').querySelector('.verdict')) $('try-results').innerHTML = '';
      r.txIds.forEach((id, i) => waitVerdict(id, userId, amount, kind === 'burst' ? `burst ${i + 1} of ${r.txIds.length}` : kind));
    } catch (e) { toast(e.message, true); }
  }
  async function waitVerdict(txId, userId, amount, label, box) {
    const row = document.createElement('div'); row.className = 'verdict pending';
    row.innerHTML = `<div class="big">...</div><div><b>${esc(userId || '')}</b> ${amount == null ? '' : money(amount)} <span class="muted small">${esc(label)}</span><br><span class="muted small">waiting for the detector...</span></div>`;
    (box || $('try-results')).prepend(row);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const e = await api('/api/event/' + encodeURIComponent(txId));
        row.className = 'verdict';
        row.innerHTML = `<div class="big" style="color:${e.flagged ? 'var(--bad)' : 'var(--ok)'}">${Number(e.risk).toFixed(0)}</div>
          <div style="flex:1"><b>${esc(e.userId)}</b> ${money(e.amount)} ${e.country ? `<span class="muted small">${esc(e.country)}${e.geoMismatch ? ' (not home)' : ''}</span>` : ''} <span class="muted small">${esc(label)}</span><br>
          ${e.flagged ? '<span class="pill">FLAGGED</span>' : '<span class="pill ok">OK</span>'}${pills(e.reasons)}${e.warm ? '<span class="pill warm">warm-up</span>' : ''}
          <span class="muted small">scored in ${e.latencyMs} ms</span></div><button class="btn" data-tx="${esc(txId)}">Why?</button>`;
        row.querySelector('button').onclick = () => openDrawer(txId); return;
      } catch (err) { if (err.status !== 404) break; }
    }
    row.querySelector('.muted.small:last-child').textContent = 'no verdict after 12 s. Is the detector running? (Live monitor tab)';
  }
  $('try-send').onclick = () => send('send'); $('try-normal').onclick = () => send('normal');
  $('try-spike').onclick = () => send('spike'); $('try-burst').onclick = () => send('burst');
  $('try-clear').onclick = () => ($('try-results').innerHTML = '<div class="muted">Nothing sent yet.</div>');

  // ------------------------------------------------------------------ tune and what-if
  const KEYS = ['scoreAlert', 'zLow', 'zHigh', 'burstSoft', 'burstHard'];
  S.buckets = [];
  const wiChart = new Chart($('c-whatif'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'precision', data: [], borderColor: '#3fb68b', pointRadius: 0, tension: .2 },
      { label: 'recall', data: [], borderColor: '#4da3ff', pointRadius: 0, tension: .2 },
      { label: 'selected threshold', data: [], borderColor: '#ff5c5c', backgroundColor: '#ff5c5c', pointRadius: 7, showLine: false }] },
    options: { animation: false, maintainAspectRatio: false, scales: { x: { ...AXIS, title: { display: true, text: 'alert threshold', color: '#8b98a8' } }, y: { ...AXIS, min: 0, max: 1 } },
      plugins: { legend: { labels: { color: '#e6edf3' } } } },
  });
  function curve() {
    const totalPos = S.buckets.reduce((s, b) => s + b.pos, 0);
    const pts = []; for (let t = 5; t <= 100; t += 5) {
      const up = S.buckets.filter((b) => b.lower >= t);
      const pos = up.reduce((s, b) => s + b.pos, 0), all = up.reduce((s, b) => s + b.pos + b.neg, 0);
      pts.push({ t, flagged: all, tp: pos, fp: all - pos, precision: all ? pos / all : null, recall: totalPos ? pos / totalPos : null });
    }
    return { pts, totalPos };
  }
  function drawWhatIf() {
    const { pts, totalPos } = curve(); const t = Number($('s-scoreAlert').value); $('v-scoreAlert').textContent = t;
    wiChart.data.labels = pts.map((p) => p.t);
    wiChart.data.datasets[0].data = pts.map((p) => p.precision);
    wiChart.data.datasets[1].data = pts.map((p) => p.recall);
    wiChart.data.datasets[2].data = pts.map((p) => (p.t === t ? (p.recall ?? 0) : null));
    wiChart.update();
    const cur = pts.find((p) => p.t === t) || {};
    const f = (v) => (v == null ? 'n/a' : (v * 100).toFixed(1) + '%');
    const f1 = cur.precision && cur.recall ? (2 * cur.precision * cur.recall) / (cur.precision + cur.recall) : null;
    $('wi-cards').innerHTML = [['Would flag', cur.flagged ?? 0], ['Real fraud caught', cur.tp ?? 0], ['False alarms', cur.fp ?? 0],
      ['Precision', f(cur.precision)], ['Recall', f(cur.recall)], ['F1', f(f1)]].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
    $('wi-note').textContent = totalPos
      ? `Based on ${totalPos} labelled fraud events in this window. Flagging changes the baseline of later events, so a real re-run could differ a little.`
      : 'No labelled fraud in this window yet. Start the demo traffic and wait for the warm-up to pass, then refresh.';
  }
  async function loadWhatIf() {
    try { const cfg = await loadConfig(); KEYS.forEach((k) => { $('s-' + k).value = cfg[k]; $('v-' + k).textContent = cfg[k]; });
      S.buckets = await api('/api/risk-buckets?minutes=' + $('wi-minutes').value); drawWhatIf(); }
    catch (e) { toast(e.message, true); }
  }
  KEYS.forEach((k) => $('s-' + k).addEventListener('input', () => { $('v-' + k).textContent = $('s-' + k).value; if (k === 'scoreAlert') drawWhatIf(); }));
  $('wi-refresh').onclick = loadWhatIf; $('wi-minutes').onchange = loadWhatIf;
  $('cfg-save').onclick = async () => {
    try { const body = {}; KEYS.forEach((k) => (body[k] = Number($('s-' + k).value))); S.cfg = await api('/api/config', body);
      toast('Saved. The detector applies it within 5 seconds.'); }
    catch (e) { toast(e.message, true); }
  };
  $('cfg-reset').onclick = async () => {
    try { S.cfg = await api('/api/config/reset', {}); KEYS.forEach((k) => { $('s-' + k).value = S.cfg[k]; $('v-' + k).textContent = S.cfg[k]; }); drawWhatIf(); toast('Defaults restored.'); }
    catch (e) { toast(e.message, true); }
  };


  // ------------------------------------------------------------------ live radar (Server-Sent Events from a change stream)
  const R = { blips: [], n: 0, f: 0, size: 0, hits: [], sweep: 0, last: performance.now() };
  const LIFE = 25000;
  const cv = $('c-radar'), cx = cv.getContext('2d');
  function hashAngle(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) / 4294967296) * Math.PI * 2; }
  function sizeRadar() {
    const w = cv.clientWidth; if (!w || w === R.size) return;
    const dpr = window.devicePixelRatio || 1; cv.width = w * dpr; cv.height = w * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); R.size = w;
  }
  function addBlips(list) {
    const now = performance.now();
    for (const e of list) {
      R.blips.push({ e, born: now, a: hashAngle(e.userId), r: 0.06 + 0.92 * clamp01(e.risk / 100) }); R.n++;
      if (e.flagged) {
        R.f++;
        const li = document.createElement('li'); li.dataset.tx = e.txId;
        li.innerHTML = `<span class="pill">${esc((e.reasons || []).map(reasonText).join(' + '))}</span><b>${esc(e.userId)}</b> ${money(e.amount)}${e.country ? ' &middot; ' + esc(e.country) : ''}<span class="when">${time(e.ts)}</span>`;
        const ul = $('rd-feed'); if (!ul.querySelector('[data-tx]')) ul.innerHTML = ''; ul.prepend(li); while (ul.children.length > 10) ul.lastChild.remove();
        if (S.sound && !S.first) beep();
      }
    }
    if (R.blips.length > 800) R.blips.splice(0, R.blips.length - 800);
    $('rd-n').textContent = R.n; $('rd-f').textContent = R.f;
  }
  function drawRadar(t) {
    requestAnimationFrame(drawRadar);
    const dt = t - R.last; R.last = t;
    R.sweep = (R.sweep + dt / 4000 * Math.PI * 2) % (Math.PI * 2);
    if (S.tab !== 'radar' || document.hidden) return;
    sizeRadar(); const w = R.size; if (!w) return;
    const c = w / 2, rad = c - 6, thr = S.cfg ? S.cfg.scoreAlert : 60;
    cx.clearRect(0, 0, w, w);
    cx.strokeStyle = 'rgba(63,182,139,.25)'; cx.lineWidth = 1;
    for (const f of [.25, .5, .75, 1]) { cx.beginPath(); cx.arc(c, c, rad * f, 0, 7); cx.stroke(); }
    cx.beginPath(); cx.moveTo(c - rad, c); cx.lineTo(c + rad, c); cx.moveTo(c, c - rad); cx.lineTo(c, c + rad); cx.stroke();
    cx.setLineDash([6, 5]); cx.strokeStyle = 'rgba(240,180,41,.8)'; cx.beginPath(); cx.arc(c, c, rad * (0.06 + 0.92 * thr / 100), 0, 7); cx.stroke(); cx.setLineDash([]);
    for (let i = 0; i < 40; i++) {                            // sweep trail
      const a = R.sweep - i * 0.025; cx.fillStyle = `rgba(63,182,139,${0.22 * (1 - i / 40)})`;
      cx.beginPath(); cx.moveTo(c, c); cx.arc(c, c, rad, a - 0.025, a); cx.closePath(); cx.fill();
    }
    const now = performance.now(); R.hits = [];
    R.blips = R.blips.filter((b) => now - b.born < LIFE);
    for (const b of R.blips) {
      const age = now - b.born, fade = 1 - age / LIFE, x = c + Math.cos(b.a) * b.r * rad, y = c + Math.sin(b.a) * b.r * rad;
      let d = (R.sweep - b.a) % (Math.PI * 2); if (d < 0) d += Math.PI * 2; const lit = d < 0.6 ? 1 - d / 0.6 : 0;
      if (b.e.flagged) {
        cx.fillStyle = `rgba(255,92,92,${0.35 + 0.65 * fade})`; cx.beginPath(); cx.arc(x, y, 5 + lit * 2, 0, 7); cx.fill();
        if (age < 2500) { cx.strokeStyle = `rgba(255,92,92,${1 - age / 2500})`; cx.beginPath(); cx.arc(x, y, 5 + age / 2500 * 22, 0, 7); cx.stroke(); }
      } else { cx.fillStyle = `rgba(120,230,190,${(0.15 + 0.6 * fade) * (0.5 + 0.5 * lit)})`; cx.beginPath(); cx.arc(x, y, 2.5, 0, 7); cx.fill(); }
      R.hits.push({ x, y, tx: b.e.txId, f: b.e.flagged, e: b.e });
    }
    $('rd-s').textContent = R.blips.length;
  }
  cv.addEventListener('click', (ev) => {
    const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = null, bd = 144; for (const h of R.hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2 - (h.f ? 40 : 0); if (d < bd) { bd = d; best = h; } }
    if (best) openDrawer(best.tx);
  });
  const nearest = (ev) => { const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top; let best = null, bd = 196; for (const h of R.hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2 - (h.f ? 40 : 0); if (d < bd) { bd = d; best = h; } } return best; };
  cv.addEventListener('mousemove', (ev) => {
    const h = nearest(ev), tip = $('rd-tip');
    if (!h) { tip.style.display = 'none'; return; }
    const e = h.e; tip.innerHTML = `<b>${esc(e.userId)}</b> &middot; ${money(e.amount)} &middot; risk ${Number(e.risk).toFixed(0)}${e.flagged ? ' <span class="pill">FLAGGED</span>' : ''}${e.country ? '<br><span class="muted">' + esc(e.country) + (e.deviceId ? ' &middot; ' + esc(e.deviceId) : '') + '</span>' : ''}`;
    tip.style.display = 'block'; tip.style.left = ev.clientX + 14 + 'px'; tip.style.top = ev.clientY + 14 + 'px';
  });
  cv.addEventListener('mouseleave', () => ($('rd-tip').style.display = 'none'));
  $('rd-feed').addEventListener('click', (e) => { const li = e.target.closest('li[data-tx]'); if (li) openDrawer(li.dataset.tx); });
  if (window.EventSource) {
    const es = new EventSource('/api/stream');
    es.onopen = () => ($('radar-status').textContent = 'stream connected');
    es.onmessage = (m) => { try { addBlips(JSON.parse(m.data)); } catch (e) { /* ignore a bad packet */ } };
    es.onerror = () => ($('radar-status').textContent = 'stream reconnecting...');
  } else $('radar-status').textContent = 'this browser has no live stream support';
  requestAnimationFrame(drawRadar);

  // ------------------------------------------------------------------ attack lab
  async function launchAttack(scenario, size) {
    const body = { scenario }; if (scenario === 'botnet') body.size = size || Number($('atk-size').value);
    const r = await api('/api/attack', body);
    $('atk-what').innerHTML = `<b>Launched.</b> ${esc(r.what)}`; $('atk-results').innerHTML = '';
    r.txIds.forEach((id, i) => waitVerdict(id, null, null, r.scenario + ' ' + (i + 1) + '/' + r.txIds.length, $('atk-results')));
    return r;
  }
  document.querySelectorAll('[data-atk]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; setTimeout(() => (b.disabled = false), 1500);
    try { await launchAttack(b.dataset.atk); toast('Attack sent to MongoDB. Watch the verdicts below, or the Radar tab.'); }
    catch (e) { toast(e.message, true); }
  }));
  async function tickReadiness() {
    try {
      const r = await api('/api/readiness'), need = 6, ok = r.ready >= need;
      $('atk-ready-t').innerHTML = ok ? `&#10003; Ready. ${r.ready} customers have a baseline, so you can launch attacks.` : `Learning what is normal... ${r.ready} of ${need} customers ready (this takes about 2 minutes after the demo traffic starts).`;
      $('atk-ready-b').style.width = Math.min(100, r.ready / need * 100) + '%'; $('atk-ready-b').style.background = ok ? 'var(--ok)' : 'var(--warn)';
      return r;
    } catch (e) { return { ready: 0 }; }
  }
  $('atk-clear').onclick = () => { $('atk-results').innerHTML = ''; $('atk-what').textContent = 'Nothing launched yet.'; };

  // ------------------------------------------------------------------ fraud rings ($graphLookup)
  let cy = null;
  async function loadRings() {
    if (!window.cytoscape) { $('ring-list').innerHTML = '<div class="muted">The graph library did not load (it comes from a CDN). Check the internet connection and reload.</div>'; return; }
    try {
      const rings = await api('/api/rings?minutes=' + $('ring-min').value);
      const els = [];
      for (const g of rings) {
        const count = new Map(); g.members.forEach((m) => m.devices.forEach((d) => count.set(d, (count.get(d) || 0) + 1)));
        g.members.forEach((m) => {
          els.push({ data: { id: 'u:' + m.userId, label: m.userId, kind: 'user', alerts: m.alerts } });
          m.devices.filter((d) => count.get(d) > 1).forEach((d) => { els.push({ data: { id: 'd:' + d, label: d, kind: 'device' } }); els.push({ data: { id: m.userId + '>' + d, source: 'u:' + m.userId, target: 'd:' + d } }); });
        });
      }
      const seen = new Set(), uniq = els.filter((e) => { if (seen.has(e.data.id)) return false; seen.add(e.data.id); return true; });
      if (!cy) cy = cytoscape({ container: $('cy'), elements: [], style: [
        { selector: 'node', style: { label: 'data(label)', color: '#e6edf3', 'font-size': 10, 'text-valign': 'bottom', 'text-margin-y': 4 } },
        { selector: 'node[kind="user"]', style: { 'background-color': '#ff5c5c', width: 'mapData(alerts, 1, 5, 22, 40)', height: 'mapData(alerts, 1, 5, 22, 40)' } },
        { selector: 'node[kind="device"]', style: { 'background-color': '#4da3ff', shape: 'round-rectangle', width: 28, height: 20 } },
        { selector: 'edge', style: { width: 1.5, 'line-color': '#5b6b80' } }] });
      cy.elements().remove(); cy.add(uniq); cy.resize(); cy.layout({ name: 'cose', animate: false, padding: 30 }).run(); cy.fit(undefined, 30);
      cy.off('tap'); cy.on('tap', 'node[kind="user"]', (ev) => investigate(ev.target.data('label')));
      $('ring-list').innerHTML = rings.length ? rings.map((g) => `<div class="card" style="margin-bottom:10px"><b>${g.size} accounts</b> <span class="muted small">&middot; ${g.totalAlerts} alerts</span>
        <div class="row small" style="margin-top:6px">${g.members.map((m) => `<button class="chip" data-user="${esc(m.userId)}">${esc(m.userId)}</button>`).join('')}</div></div>`).join('')
        : '<div class="muted">No rings in this window. In the Attack lab, launch a botnet, then press Find rings.</div>';
    } catch (e) { toast(e.message, true); }
  }
  $('ring-go').onclick = loadRings;
  $('ring-list').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) investigate(c.dataset.user); });

  // ------------------------------------------------------------------ rule builder
  const RULE_FIELDS = { amount: 'Amount', risk: 'Risk score', z: 'z-score', burst: 'Transactions in 5 s' };
  const PRESETS = { travel: { conditions: [{ field: 'amount', op: 'gte', value: 100 }], geoMismatch: true, newDevice: false },
                    newdev: { conditions: [{ field: 'amount', op: 'gte', value: 150 }], geoMismatch: false, newDevice: true },
                    fast: { conditions: [{ field: 'burst', op: 'gte', value: 5 }], geoMismatch: false, newDevice: false },
                    zhigh: { conditions: [{ field: 'z', op: 'gte', value: 3 }], geoMismatch: false, newDevice: false } };
  S.rule = JSON.parse(JSON.stringify(PRESETS.travel));
  function renderRule() {
    $('rule-conds').innerHTML = S.rule.conditions.map((c, i) => `<div class="cond" data-i="${i}">
      <select data-k="field">${Object.entries(RULE_FIELDS).map(([k, v]) => `<option value="${k}" ${c.field === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select data-k="op"><option value="gte" ${c.op === 'gte' ? 'selected' : ''}>is at least</option><option value="lte" ${c.op === 'lte' ? 'selected' : ''}>is at most</option></select>
      <input type="number" data-k="value" step="any" value="${esc(c.value)}" style="width:100px"><button class="btn" data-del="${i}" title="remove">&times;</button></div>`).join('')
      || '<div class="muted small">No numeric conditions. You can still use the two checkboxes below.</div>';
    $('rule-geo').checked = !!S.rule.geoMismatch; $('rule-dev').checked = !!S.rule.newDevice;
  }
  $('rule-conds').addEventListener('input', (e) => { const row = e.target.closest('.cond'); if (row && e.target.dataset.k) S.rule.conditions[row.dataset.i][e.target.dataset.k] = e.target.dataset.k === 'value' ? Number(e.target.value) : e.target.value; });
  $('rule-conds').addEventListener('click', (e) => { const b = e.target.closest('[data-del]'); if (b) { S.rule.conditions.splice(Number(b.dataset.del), 1); renderRule(); } });
  $('rule-add').onclick = () => { S.rule.conditions.push({ field: 'amount', op: 'gte', value: 100 }); renderRule(); };
  $('rule-geo').onchange = (e) => (S.rule.geoMismatch = e.target.checked); $('rule-dev').onchange = (e) => (S.rule.newDevice = e.target.checked);
  document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => { S.rule = JSON.parse(JSON.stringify(PRESETS[b.dataset.preset])); renderRule(); }));
  const pct = (v) => (v == null ? 'n/a' : (v * 100).toFixed(1) + '%');
  function metrics(c) { const fl = c.tp + c.fp; return { fl, tp: c.tp, fp: c.fp, fn: c.fn, p: fl ? c.tp / fl : null, r: c.tp + c.fn ? c.tp / (c.tp + c.fn) : null }; }
  $('rule-test').onclick = async () => {
    try {
      const r = await api('/api/rules/test', { rule: S.rule, minutes: Number($('rule-min').value) });
      const a = metrics(r.rule), m = metrics(r.model);
      const row = (k, x, y) => `<tr><td>${k}</td><td class="num">${x}</td><td class="num">${y}</td></tr>`;
      $('rule-out').className = '';
      $('rule-out').innerHTML = `<table class="cmp"><thead><tr><th></th><th class="num">Your rule</th><th class="num">Built-in model</th></tr></thead><tbody>
        ${row('Would flag', a.fl, m.fl)}${row('Real fraud caught', a.tp, m.tp)}${row('False alarms', a.fp, m.fp)}${row('Fraud missed', a.fn, m.fn)}${row('Precision', pct(a.p), pct(m.p))}${row('Recall', pct(a.r), pct(m.r))}</tbody></table>
        <div class="muted small" style="margin:8px 0">Fraud means events labelled spike or burst by the generator, the Attack lab or the Try-it tab.</div>
        <h2 style="margin-top:14px">Latest matches</h2>
        <table><thead><tr><th>Time</th><th>User</th><th class="num">Amount</th><th class="num">Risk</th><th>Country</th><th>Truth</th></tr></thead><tbody>
        ${r.samples.map((x) => `<tr class="click" data-tx="${esc(x.txId)}"><td>${time(x.ts)}</td><td>${esc(x.userId)}</td><td class="num">${money(x.amount)}</td><td class="num">${Number(x.risk).toFixed(0)}</td>
          <td>${esc(x.country || '-')}${x.country && x.homeCountry && x.country !== x.homeCountry ? ' (home ' + esc(x.homeCountry) + ')' : ''}</td><td>${esc(x.label || 'normal')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No transactions matched.</td></tr>'}</tbody></table>`;
    } catch (e) { toast(e.message, true); }
  };
  $('rule-out').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-tx]'); if (tr) openDrawer(tr.dataset.tx); });
  async function loadRules() {
    renderRule();
    try {
      const list = await api('/api/rules'); S.saved = list;
      $('rule-saved').innerHTML = list.map((x, i) => `<li data-load="${i}"><b>${esc(x.name)}</b><span class="when">${x.rule.conditions.length} condition(s)</span><button class="btn" data-rm="${esc(x._id)}">Delete</button></li>`).join('') || '<li class="muted">none</li>';
    } catch (e) { /* offline */ }
  }
  $('rule-saved').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { e.stopPropagation(); try { await api('/api/rules/' + encodeURIComponent(rm.dataset.rm), undefined, 'DELETE'); loadRules(); } catch (err) { toast(err.message, true); } return; }
    const li = e.target.closest('li[data-load]'); if (li) { const x = S.saved[Number(li.dataset.load)]; S.rule = JSON.parse(JSON.stringify(x.rule)); $('rule-name').value = x.name; renderRule(); }
  });
  $('rule-save').onclick = async () => { try { await api('/api/rules', { name: $('rule-name').value, rule: S.rule }); toast('Rule saved.'); loadRules(); } catch (e) { toast(e.message, true); } };


  // ------------------------------------------------------------------ onboarding checklist, header chips, start-everything
  S.pipe = { detector: false, generator: false }; S.eps = 0; S.connected = false; S.allGreenSeen = false;
  function setStep(id, state) { const li = $(id); li.className = state; li.querySelector('i').textContent = state === 'done' ? '✓' : ''; }
  function updateOnboard() {
    const flow = S.eps > 0, d = S.pipe.detector || flow, g = S.pipe.generator || flow;   // data flowing also counts if you started them in a terminal
    setStep('st-server', S.connected ? 'done' : 'wait'); setStep('st-det', d ? 'done' : ''); setStep('st-gen', g ? 'done' : '');
    setStep('st-flow', flow ? 'done' : (S.pipe.detector && S.pipe.generator ? 'wait' : ''));
    $('h-det').classList.toggle('on', S.pipe.detector); $('h-gen').classList.toggle('on', S.pipe.generator);
    $('onboard').style.display = S.connected && flow ? 'none' : '';
    $('ob-note').innerHTML = !S.connected ? 'Waiting for the dashboard server...'
      : !S.pipe.detector || !S.pipe.generator ? 'Press <b>Start everything</b>. Rows appear within seconds. Fraud is injected after a short warm-up, and then the banner below starts flashing.'
      : 'Both are running. Waiting for the first transactions...';
  }
  async function startAll() {
    try {
      const p = await api('/api/pipeline');
      if (!p.detector.running) await api('/api/pipeline/detector/start', {});
      if (!p.generator.running) await api('/api/pipeline/generator/start', { users: $('gen-users').value || 200, warmS: $('gen-warm').value || 30 });
      toast('Starting the detector and the demo traffic...'); setTimeout(tickPipeline, 800);
    } catch (e) { toast(e.message, true); }
  }
  $('ob-all').onclick = startAll; $('h-all').onclick = startAll;

  // ------------------------------------------------------------------ guided demo
  const TOTAL = 7; S.tourOn = false;
  function cap(n, title, text) { $('tour-step').textContent = 'Step ' + n + ' of ' + TOTAL; $('tour-title').textContent = title; $('tour-text').innerHTML = text; $('tour-bar').style.width = (n / TOTAL * 100) + '%'; $('tour').classList.add('on'); }
  const wait = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (!S.tourOn) throw new Error('stopped'); await new Promise((r) => setTimeout(r, 200)); } };
  function endTour() { S.tourOn = false; document.body.classList.remove('touring'); $('tour').classList.remove('on'); closeDrawer(); }
  $('tour-stop').onclick = endTour;
  async function runTour() {
    if (S.tourOn) return endTour();
    S.tourOn = true; S.first = true; document.body.classList.add('touring');
    try {
      showTab('live'); cap(1, 'Starting the system', 'Starting the <b>detector</b> (it listens to MongoDB with a change stream) and the <b>demo traffic</b> (fake customers paying). Each payment is scored by an aggregation pipeline inside MongoDB.');
      await startAll(); await wait(6000);
      showTab('radar'); cap(2, 'The live radar', 'Every dot is a payment arriving right now. <b>Near the centre is safe, near the edge is risky.</b> Hover over a dot to see who paid what.');
      await wait(7000);
      let r; for (;;) {
        r = await api('/api/readiness');
        cap(3, 'Learning what is normal', `MongoDB is building a baseline for each customer from their own recent payments: typical amount and how much it varies. <b>${r.ready} of 6</b> customers are ready. This takes about 2 minutes.`);
        if (r.ready >= 6) break; await wait(3000);
      }
      showTab('attack'); cap(4, 'Launching a botnet attack', 'Six customers will each pay about <b>10 times their normal amount</b>, all from <b>the same device</b>. That is how a stolen-credentials botnet behaves.');
      await wait(2500); const a = await launchAttack('botnet', 6); await wait(5000);
      showTab('radar'); cap(5, 'Watch the red dots', 'The attack payments land near the edge of the radar and are <b>flagged</b>. MongoDB compared each amount with that customer\'s own history and saw it was far out of line.');
      await wait(6000);
      showTab('rings'); cap(6, 'Finding the fraud ring', 'The six accounts look unrelated, but they share one device. MongoDB follows those links with <code>$graphLookup</code> and the graph shows the whole ring at once.');
      await wait(9000);
      openDrawer(a.txIds[0]); cap(7, 'Why was it flagged?', 'Every alert comes with a plain explanation: how far the amount is from normal, how fast the payments came, and where and from which device. <b>Next: try the Attack lab and Rule builder yourself.</b>');
      await wait(12000);
    } catch (e) { if (e.message !== 'stopped') toast(e.message, true); }
    endTour();
  }
  $('ob-tour').onclick = runTour; $('h-tour').onclick = runTour;

  // ------------------------------------------------------------------ start
  loadConfig().catch(() => {});
  if (location.hash && $('tab-' + location.hash.slice(1))) showTab(location.hash.slice(1));
  tickLive(); tickPipeline();
  setInterval(tickLive, 1000); setInterval(tickPipeline, 2500);
})();
