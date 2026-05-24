// ============================================================
// ElectroVote — app.js
// ============================================================

// ── Firebase refs (set after init) ──────────────────────────
let db;
const COL = {
  elections: 'elections',
  votes: 'votes',
  voters: 'voters',
  candidates: 'candidates',
  requests: 'requests',
  settings: 'settings'
};

// ── State ────────────────────────────────────────────────────
let currentVoter = null;       // logged-in voter object
let currentElection = null;    // election being viewed
let adminLoggedIn = false;
let pendingVote = null;        // {candidateId, candidateName}
let photoDataCache = '';       // temp for candidate photo upload
let countdownTimer = null;

// ── Init ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Init Firebase
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();

  // Seed H2B election if not exists
  await seedH2BElection();

  // Route
  await route();

  // Hash change routing
  window.addEventListener('hashchange', route);
});

// ── Router ───────────────────────────────────────────────────
async function route() {
  const hash = location.hash;
  if (!hash || hash === '#') { showScreen('welcome-screen'); startWelcome(); return; }
  if (hash === '#home') { showScreen('home-screen'); await loadHome(); return; }
  if (hash === '#login') { showScreen('login-screen'); return; }
  if (hash === '#admin') { showScreen('admin-login-screen'); return; }
  if (hash === '#admin-panel') { if (!adminLoggedIn) { location.hash = '#admin'; return; } showScreen('admin-panel-screen'); await loadAdminPanel(); return; }
  if (hash === '#request-election') { showScreen('request-election-screen'); return; }
  if (hash.startsWith('#election/')) {
    const id = hash.replace('#election/', '');
    await loadElectionDetail(id);
    return;
  }
  if (hash.startsWith('#mod/')) {
    const id = hash.replace('#mod/', '');
    showScreen('mod-login-screen');
    document.getElementById('mod-election-id-hidden').value = id;
    return;
  }
  if (hash.startsWith('#mod-panel/')) {
    const id = hash.replace('#mod-panel/', '');
    showScreen('mod-panel-screen');
    await loadModPanel(id);
    return;
  }
  location.hash = '#home';
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

// ── Welcome ──────────────────────────────────────────────────
function startWelcome() {
  let secs = 5;
  const fill = document.getElementById('welcome-fill');
  const txt = document.getElementById('welcome-txt');
  const iv = setInterval(() => {
    secs -= 0.05;
    fill.style.width = Math.max(0, (secs / 5) * 100) + '%';
    txt.textContent = secs > 0 ? `Entering in ${Math.ceil(secs)}…` : 'Welcome!';
    if (secs <= 0) { clearInterval(iv); location.hash = '#home'; }
  }, 50);
}

// ── Seed H2B election ─────────────────────────────────────────
async function seedH2BElection() {
  const ref = db.collection(COL.elections).doc(PLATFORM_CONFIG.featuredElectionId);
  const snap = await ref.get();
  if (snap.exists) return;

  const shifin_b64 = await fetch('shifin_b64.txt').then(r => r.text()).catch(() => '');
  const fahman_b64 = await fetch('fahman_b64.txt').then(r => r.text()).catch(() => '');

  await ref.set({
    title: 'H2B Class Election 2026',
    description: 'Vote for your class representative for the academic year 2026.',
    status: 'approved',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    createdBy: 'admin',
    moderatorKey: null,
    voteStart: null,
    voteEnd: null,
    resultsPublished: false,
    demoMode: false,
    demoStart: null,
    demoEnd: null,
    featured: true
  });

  // Seed candidates
  const cRef = ref.collection(COL.candidates);
  await cRef.doc('shifin').set({
    name: 'Shifin', classOf: 'H2B',
    description: 'Shifin is a dedicated student of Class H2B whose vision goes beyond the classroom. His core mission is to make the school a better place for everyone — fostering a stronger community, improving the overall school experience, and ensuring that every student feels valued and heard.',
    photo: shifin_b64 ? 'data:image/jpeg;base64,' + shifin_b64 : '',
    order: 1
  });
  await cRef.doc('fahman').set({
    name: 'Fahman', classOf: 'H2B',
    description: 'Fahman is an enthusiastic student of Class H2B with a strong passion for student life beyond academics. His primary goal is to elevate the school\'s sports and arts programmes — ensuring that every talented student gets the opportunities, resources, and recognition they truly deserve.',
    photo: fahman_b64 ? 'data:image/jpeg;base64,' + fahman_b64 : '',
    order: 2
  });

  // Seed voters
  const voters = [
    { id: 'SHA001', name: 'Shahana', pass: await sha256('Sha@7821') },
    { id: 'RIN002', name: 'Rinshan', pass: await sha256('Rin@4356') },
    { id: 'ANS003', name: 'Anshid',  pass: await sha256('Ans@9134') },
    { id: 'FAH004', name: 'Fahman',  pass: await sha256('Fah@6278') },
    { id: 'SHI005', name: 'Shifin',  pass: await sha256('Shi@3049') },
  ];
  const vRef = ref.collection(COL.voters);
  for (const v of voters) await vRef.doc(v.id).set(v);
}

// ── SHA-256 ───────────────────────────────────────────────────
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Election status logic ─────────────────────────────────────
function getElectionPhase(elec) {
  const now = Date.now();
  // Demo running?
  if (elec.demoMode) {
    const ds = elec.demoStart ? new Date(elec.demoStart).getTime() : 0;
    const de = elec.demoEnd ? new Date(elec.demoEnd).getTime() : Infinity;
    if (now >= ds && now <= de) return 'demo';
  }
  if (!elec.voteStart) return 'not-configured';
  const start = new Date(elec.voteStart).getTime();
  const end = new Date(elec.voteEnd).getTime();
  const resultsEnd = end + 48 * 3600 * 1000;
  if (now < start) return 'not-open';
  if (now >= start && now <= end) return 'open';
  if (now > end && now <= resultsEnd) return 'results';
  if (now > resultsEnd) return 'reset-available';
  return 'closed';
}

// ── Home ──────────────────────────────────────────────────────
async function loadHome() {
  const grid = document.getElementById('elections-grid');
  grid.innerHTML = '<div class="loader"><div class="spinner"></div> Loading elections…</div>';
  const snap = await db.collection(COL.elections).where('status', '==', 'approved').get();
  if (snap.empty) { grid.innerHTML = '<div class="empty-state"><div class="icon">🗳️</div><p>No active elections right now.</p></div>'; return; }
  grid.innerHTML = '';
  snap.forEach(doc => {
    const e = { id: doc.id, ...doc.data() };
    const phase = getElectionPhase(e);
    const badgeMap = { 'open': ['Active', 'badge-active'], 'not-open': ['Upcoming', 'badge-pending'], 'results': ['Results Available', 'badge-results'], 'reset-available': ['Ended', 'badge-closed'], 'demo': ['Demo', 'badge-demo'], 'not-configured': ['Scheduled', 'badge-pending'] };
    const [label, cls] = badgeMap[phase] || ['Unknown', 'badge-pending'];
    grid.innerHTML += `
      <div class="election-card" onclick="location.hash='#election/${e.id}'">
        <div class="election-card-header">
          <h3>${e.title}</h3>
          <p>${e.description || ''}</p>
        </div>
        <div class="election-card-body">
          <div class="election-meta">
            <span class="badge ${cls}">${label}</span>
            ${e.featured ? '<span class="badge badge-results">Featured</span>' : ''}
          </div>
          ${e.voteStart ? `<div style="font-size:0.78rem;color:var(--muted)">📅 ${new Date(e.voteStart).toLocaleDateString()} – ${new Date(e.voteEnd).toLocaleDateString()}</div>` : ''}
        </div>
        <div class="election-card-footer">
          <button class="btn btn-outline btn-sm btn-full">View Election →</button>
        </div>
      </div>`;
  });
}

// ── Election Detail ───────────────────────────────────────────
async function loadElectionDetail(id) {
  showScreen('election-detail-screen');
  currentElection = null;
  const ref = db.collection(COL.elections).doc(id);
  const snap = await ref.get();
  if (!snap.exists) { location.hash = '#home'; return; }
  const elec = { id: snap.id, ...snap.data() };
  currentElection = elec;

  document.getElementById('ed-title').textContent = elec.title;
  document.getElementById('ed-desc').textContent = elec.description || '';

  const phase = getElectionPhase(elec);
  renderElectionTimeline(elec, phase);
  renderElectionMeta(elec, phase);

  // Demo banner
  document.getElementById('demo-banner').className = phase === 'demo' ? 'show' : '';

  const container = document.getElementById('ed-content');

  if (phase === 'results' || phase === 'reset-available') {
    if (elec.resultsPublished) { await renderResults(id, container); return; }
    container.innerHTML = `<div class="empty-state"><div class="icon">📋</div><p>Results will be published by officials soon.</p></div>`;
    return;
  }
  if (phase === 'not-configured' || phase === 'not-open') {
    if (elec.voteStart) {
      container.innerHTML = `<div class="empty-state"><div class="icon">⏳</div><p>Voting opens on ${new Date(elec.voteStart).toLocaleString()}</p><div id="ed-countdown" class="countdown-wrap"></div></div>`;
      startCountdown(new Date(elec.voteStart).getTime(), 'ed-countdown');
    } else {
      container.innerHTML = `<div class="empty-state"><div class="icon">📅</div><p>Voting dates not set yet. Check back soon.</p></div>`;
    }
    return;
  }
  if (phase === 'open' || phase === 'demo') {
    if (!currentVoter || currentVoter.electionId !== id) {
      // Show login form inline
      renderVoterLogin(id, container, elec);
      return;
    }
    await renderCandidates(id, container, elec, phase);
    return;
  }
}

function renderElectionTimeline(elec, phase) {
  const steps = ['Scheduled', 'Voting Open', 'Results (48h)', 'Reset'];
  const phaseIdx = { 'not-configured': 0, 'not-open': 0, 'open': 1, 'demo': 1, 'results': 2, 'reset-available': 3 };
  const cur = phaseIdx[phase] ?? 0;
  document.getElementById('ed-timeline').innerHTML = steps.map((s, i) =>
    `<div class="timeline-step ${i < cur ? 'done' : i === cur ? 'current' : ''}">${s}</div>`
  ).join('');
}

function renderElectionMeta(elec, phase) {
  const badges = [];
  const badgeMap = { 'open': ['Active', 'badge-active'], 'not-open': ['Upcoming', 'badge-pending'], 'results': ['Results Window', 'badge-results'], 'reset-available': ['Ended', 'badge-closed'], 'demo': ['Demo Mode', 'badge-demo'], 'not-configured': ['Scheduled', 'badge-pending'] };
  const [label, cls] = badgeMap[phase] || ['Unknown', 'badge-pending'];
  badges.push(`<span class="badge ${cls}">${label}</span>`);
  if (elec.voteStart) badges.push(`<span style="font-size:0.78rem;color:var(--muted)">📅 ${new Date(elec.voteStart).toLocaleString()} → ${new Date(elec.voteEnd).toLocaleString()}</span>`);
  document.getElementById('ed-meta').innerHTML = badges.join('');
}

function renderVoterLogin(electionId, container, elec) {
  container.innerHTML = `
    <div style="display:flex;justify-content:center;padding:2rem 1rem;">
      <div class="form-box">
        <h2>Voter Login</h2>
        <p class="sub">Enter your credentials to vote in this election</p>
        <div class="field"><label>Voter ID</label><input id="vl-id" type="text" placeholder="Enter your Voter ID" autocomplete="off"></div>
        <div class="field"><label>Password</label><input id="vl-pass" type="password" placeholder="Enter your password"></div>
        <div class="field"><label>Your Class</label>
          <select id="vl-class">
            <option value="">— Select class —</option>
            <option>H1A</option><option>H1B</option><option>H1C</option>
            <option>H2A</option><option>H2B</option><option>H2C</option>
            <option>H3A</option><option>H3B</option><option>H3C</option>
          </select>
        </div>
        <div id="vl-err" class="err-msg"></div>
        <button class="btn btn-primary btn-full" onclick="doVoterLogin('${electionId}')">Proceed to Vote</button>
      </div>
    </div>`;
}

async function doVoterLogin(electionId) {
  const id = document.getElementById('vl-id').value.trim().toUpperCase();
  const pass = document.getElementById('vl-pass').value.trim();
  const cls = document.getElementById('vl-class').value;
  const err = document.getElementById('vl-err');
  err.style.display = 'none';
  if (!id || !pass || !cls) { err.textContent = 'Please fill all fields.'; err.style.display = 'block'; return; }
  const passHash = await sha256(pass);
  const snap = await db.collection(COL.elections).doc(electionId).collection(COL.voters).doc(id).get();
  if (!snap.exists || snap.data().pass !== passHash) { err.textContent = 'Invalid Voter ID or password.'; err.style.display = 'block'; return; }
  currentVoter = { ...snap.data(), id, electionId, class: cls };
  await loadElectionDetail(electionId);
}

async function renderCandidates(electionId, container, elec, phase) {
  const snaps = await db.collection(COL.elections).doc(electionId).collection(COL.candidates).orderBy('order').get();
  const candidates = snaps.docs.map(d => ({ id: d.id, ...d.data() }));

  // Check if already voted
  const voteSnap = await db.collection(COL.elections).doc(electionId).collection(COL.votes).doc(currentVoter.id).get();
  const voted = voteSnap.exists;

  let html = `<div style="padding:0 1.5rem;"><div class="voter-badge">👤 ${currentVoter.name} &nbsp;·&nbsp; ${currentVoter.class}</div></div>`;
  if (voted) html += `<div style="padding:0 1.5rem;margin-bottom:1rem;"><div class="msg ok">✓ You have already voted. Thank you!</div></div>`;
  if (phase === 'demo') html += `<div style="padding:0 1.5rem;margin-bottom:1rem;"><div class="msg info">🧪 This is a demo session — votes are for testing only.</div></div>`;

  html += `<div class="candidates-grid" style="padding:0 1.5rem 2rem;">`;
  candidates.forEach(c => {
    const photo = c.photo ? `<img class="candidate-photo" src="${c.photo}" alt="${c.name}">` : `<div class="candidate-placeholder">👤</div>`;
    html += `<div class="candidate-card">
      ${photo}
      <div class="candidate-body">
        <h3>${c.name}</h3>
        <div class="candidate-class">Class ${c.classOf}</div>
        <p>${c.description}</p>
        <button class="vote-btn" ${voted ? 'disabled' : ''} onclick="openVoteConfirm('${c.id}','${c.name}','${electionId}')">Vote for ${c.name}</button>
      </div>
    </div>`;
  });
  html += `</div>`;
  container.innerHTML = html;
}

async function renderResults(electionId, container) {
  const [candSnap, voteSnap] = await Promise.all([
    db.collection(COL.elections).doc(electionId).collection(COL.candidates).orderBy('order').get(),
    db.collection(COL.elections).doc(electionId).collection(COL.votes).get()
  ]);
  const candidates = candSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const counts = {}; candidates.forEach(c => { counts[c.id] = 0; });
  const classCounts = {};
  voteSnap.docs.forEach(d => {
    const v = d.data();
    if (counts[v.candidateId] !== undefined) counts[v.candidateId]++;
    if (!classCounts[v.class]) classCounts[v.class] = { total: 0 };
    classCounts[v.class][v.candidateId] = (classCounts[v.class][v.candidateId] || 0) + 1;
    classCounts[v.class].total++;
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const maxV = Math.max(...Object.values(counts));
  let html = `<div style="max-width:620px;margin:0 auto;padding:1rem 1.5rem;">
    <div style="text-align:center;color:var(--muted);font-size:0.88rem;margin-bottom:1.2rem;">Total votes: <strong style="color:var(--text)">${total}</strong></div>`;
  candidates.forEach(c => {
    const pct = total ? Math.round((counts[c.id] / total) * 100) : 0;
    const isWinner = counts[c.id] === maxV && maxV > 0 && candidates.filter(x => counts[x.id] === maxV).length === 1;
    html += `<div class="result-card">
      <div class="result-name">${c.name}${isWinner ? ' <span class="winner-badge">🏆 Winner</span>' : ''}</div>
      <div class="result-bar-wrap"><div class="result-bar" style="width:${pct}%"></div></div>
      <div class="result-count">${counts[c.id]} vote${counts[c.id] !== 1 ? 's' : ''} — ${pct}%</div>
    </div>`;
  });
  const classEntries = Object.entries(classCounts).sort((a, b) => b[1].total - a[1].total);
  if (classEntries.length) {
    html += `<h3 style="font-family:'Playfair Display',serif;color:var(--gold);margin:1.5rem 0 1rem;">Votes by Class</h3>
    <p style="font-size:0.82rem;color:var(--muted);margin-bottom:0.8rem;">Highest turnout: <span class="top-class">${classEntries[0][0]}</span></p>
    <table class="data-table"><thead><tr><th>Class</th>${candidates.map(c => `<th>${c.name}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;
    classEntries.forEach(([cls, d]) => {
      html += `<tr><td>${cls}</td>${candidates.map(c => `<td>${d[c.id] || 0}</td>`).join('')}<td>${d.total}</td></tr>`;
    });
    html += `</tbody></table>`;
  }
  html += `</div>`;
  container.innerHTML = html;
}

// ── Vote Confirm ──────────────────────────────────────────────
function openVoteConfirm(candidateId, candidateName, electionId) {
  pendingVote = { candidateId, candidateName, electionId };
  document.getElementById('confirm-text').textContent = `You are about to vote for ${candidateName}. This cannot be undone. Confirm?`;
  document.getElementById('confirm-modal').classList.add('open');
}
function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('open');
  pendingVote = null;
}
async function submitVote() {
  if (!pendingVote || !currentVoter) return;
  const { candidateId, candidateName, electionId } = pendingVote;
  const phase = getElectionPhase(currentElection);
  const col = phase === 'demo' ? 'demo_votes' : COL.votes;
  const ref = db.collection(COL.elections).doc(electionId).collection(col).doc(currentVoter.id);
  const existing = await ref.get();
  if (existing.exists) { closeConfirm(); toast('Already voted!', 'bad'); return; }
  await ref.set({ candidateId, candidateName, class: currentVoter.class, voterName: currentVoter.name, time: firebase.firestore.FieldValue.serverTimestamp() });
  closeConfirm();
  document.getElementById('success-msg').textContent = `Thank you, ${currentVoter.name}! Your vote for ${candidateName} has been recorded. Your voice matters — congratulations on making a difference!`;
  showScreen('success-screen');
}

// ── Countdown ─────────────────────────────────────────────────
function startCountdown(targetMs, elId) {
  function update() {
    const diff = targetMs - Date.now();
    if (diff <= 0) { clearInterval(countdownTimer); const el = document.getElementById(elId); if (el) el.innerHTML = '<div style="color:var(--green)">Voting is now open!</div>'; return; }
    const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
    const el = document.getElementById(elId);
    if (el) el.innerHTML = `
      <div class="countdown-unit"><div class="countdown-num">${String(h).padStart(2,'0')}</div><div class="countdown-label">Hours</div></div>
      <div class="countdown-unit"><div class="countdown-num">${String(m).padStart(2,'0')}</div><div class="countdown-label">Mins</div></div>
      <div class="countdown-unit"><div class="countdown-num">${String(s).padStart(2,'0')}</div><div class="countdown-label">Secs</div></div>`;
  }
  update();
  countdownTimer = setInterval(update, 1000);
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type}`;
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Admin Login ───────────────────────────────────────────────
async function doAdminLogin() {
  const pass = document.getElementById('admin-pass-input').value;
  const err = document.getElementById('admin-login-err');
  const hash = await sha256(pass);
  if (hash === ADMIN_PASS_HASH) {
    err.style.display = 'none';
    document.getElementById('admin-pass-input').value = '';
    adminLoggedIn = true;
    location.hash = '#admin-panel';
  } else {
    err.textContent = 'Incorrect password.';
    err.style.display = 'block';
  }
}
function doAdminLogout() { adminLoggedIn = false; location.hash = '#home'; }

// ── Admin Panel ───────────────────────────────────────────────
async function loadAdminPanel() {
  if (!adminLoggedIn) { location.hash = '#admin'; return; }
  await loadAdminElections();
  await loadPendingRequests();
}

async function loadAdminElections() {
  const wrap = document.getElementById('admin-elections-list');
  wrap.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const snap = await db.collection(COL.elections).get();
  if (snap.empty) { wrap.innerHTML = '<div class="empty-state"><p>No elections.</p></div>'; return; }
  wrap.innerHTML = '';
  snap.forEach(doc => {
    const e = { id: doc.id, ...doc.data() };
    const phase = getElectionPhase(e);
    const badgeMap = { 'open': ['Active', 'badge-active'], 'not-open': ['Upcoming', 'badge-pending'], 'results': ['Results Window', 'badge-results'], 'reset-available': ['Reset Available', 'badge-closed'], 'demo': ['Demo', 'badge-demo'], 'not-configured': ['Pending Setup', 'badge-pending'] };
    const [label, cls] = badgeMap[phase] || ['Unknown', 'badge-pending'];
    wrap.innerHTML += `<div class="list-item">
      <div class="list-thumb-ph">🗳️</div>
      <div class="list-info"><strong>${e.title}</strong><span><span class="badge ${cls}">${label}</span> · ${e.status}</span></div>
      <div class="list-actions">
        <button class="btn btn-outline btn-xs" onclick="openAdminElectionModal('${e.id}')">Manage</button>
        ${phase === 'reset-available' ? `<button class="btn btn-danger btn-xs" onclick="resetElection('${e.id}')">Reset</button>` : ''}
      </div>
    </div>`;
  });
}

async function loadPendingRequests() {
  const wrap = document.getElementById('admin-requests-list');
  wrap.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const snap = await db.collection(COL.requests).where('status', '==', 'pending').get();
  if (snap.empty) { wrap.innerHTML = '<div class="empty-state"><p>No pending requests.</p></div>'; return; }
  wrap.innerHTML = '';
  snap.forEach(doc => {
    const r = { id: doc.id, ...doc.data() };
    wrap.innerHTML += `<div class="request-card">
      <h4>${r.electionTitle}</h4>
      <p>${r.description || ''}<br><span style="color:var(--muted);font-size:0.78rem;">Type: ${r.requestType || 'new election'} · From: ${r.requestedBy || 'unknown'}</span></p>
      ${r.requestType === 'new' ? '' : `<p style="color:var(--muted);font-size:0.8rem;">Details: ${JSON.stringify(r.details || {})}</p>`}
      <div class="request-actions">
        <button class="btn btn-green btn-xs" onclick="approveRequest('${r.id}')">Approve</button>
        <button class="btn btn-danger btn-xs" onclick="rejectRequest('${r.id}')">Reject</button>
      </div>
    </div>`;
  });
}

// ── Admin Election Modal ──────────────────────────────────────
let adminEditElectionId = null;
async function openAdminElectionModal(electionId) {
  adminEditElectionId = electionId;
  const snap = await db.collection(COL.elections).doc(electionId).get();
  const e = { id: snap.id, ...snap.data() };
  const phase = getElectionPhase(e);
  const modal = document.getElementById('admin-election-modal');

  document.getElementById('aem-title').textContent = e.title;
  // Voting window
  document.getElementById('aem-start').value = e.voteStart ? toLocalInput(e.voteStart) : '';
  document.getElementById('aem-end').value = e.voteEnd ? toLocalInput(e.voteEnd) : '';
  // Lock after 48h from start
  const locked = e.voteStart && Date.now() - new Date(e.voteStart).getTime() > 48 * 3600000;
  document.getElementById('aem-start').disabled = !!locked;
  document.getElementById('aem-end').disabled = !!locked;
  document.getElementById('aem-lock-warn').style.display = locked ? 'block' : 'none';
  // Publish
  document.getElementById('aem-publish-btn').textContent = e.resultsPublished ? 'Unpublish Results' : 'Publish Results';
  // Demo
  document.getElementById('aem-demo-start').value = e.demoStart ? toLocalInput(e.demoStart) : '';
  document.getElementById('aem-demo-end').value = e.demoEnd ? toLocalInput(e.demoEnd) : '';
  document.getElementById('aem-demo-toggle-btn').textContent = e.demoMode ? 'Stop Demo Mode' : 'Start Demo Mode';
  // Reset
  document.getElementById('aem-reset-section').style.display = phase === 'reset-available' ? 'block' : 'none';
  // Mod key
  document.getElementById('aem-mod-key').textContent = e.moderatorKey || '(none — admin election)';
  // Tabs: load candidates & voters
  await loadAEMCandidates(electionId);
  await loadAEMVoters(electionId);

  modal.classList.add('open');
}

function toLocalInput(isoStr) {
  const d = new Date(isoStr);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

async function saveAEMDates() {
  const start = document.getElementById('aem-start').value;
  const end = document.getElementById('aem-end').value;
  const msg = document.getElementById('aem-date-msg');
  if (!start || !end) { msg.className = 'msg bad'; msg.textContent = 'Set both dates.'; return; }
  if (new Date(start) >= new Date(end)) { msg.className = 'msg bad'; msg.textContent = 'End must be after start.'; return; }
  const e = (await db.collection(COL.elections).doc(adminEditElectionId).get()).data();
  if (e.voteStart && Date.now() - new Date(e.voteStart).getTime() > 48 * 3600000) { msg.className = 'msg bad'; msg.textContent = 'Locked — 48h passed since voting started.'; return; }
  await db.collection(COL.elections).doc(adminEditElectionId).update({ voteStart: start, voteEnd: end });
  msg.className = 'msg ok'; msg.textContent = 'Voting window saved.';
  setTimeout(() => { msg.className = 'msg'; }, 3000);
}

async function saveAEMDemo() {
  const ds = document.getElementById('aem-demo-start').value;
  const de = document.getElementById('aem-demo-end').value;
  const msg = document.getElementById('aem-demo-msg');
  if (!ds || !de) { msg.className = 'msg bad'; msg.textContent = 'Set both demo dates.'; return; }
  await db.collection(COL.elections).doc(adminEditElectionId).update({ demoStart: ds, demoEnd: de });
  msg.className = 'msg ok'; msg.textContent = 'Demo window saved.';
  setTimeout(() => { msg.className = 'msg'; }, 3000);
}

async function toggleDemo() {
  const snap = await db.collection(COL.elections).doc(adminEditElectionId).get();
  const demoMode = !snap.data().demoMode;
  await db.collection(COL.elections).doc(adminEditElectionId).update({ demoMode });
  document.getElementById('aem-demo-toggle-btn').textContent = demoMode ? 'Stop Demo Mode' : 'Start Demo Mode';
  toast(demoMode ? 'Demo mode started.' : 'Demo mode stopped.', 'ok');
}

async function togglePublish() {
  const snap = await db.collection(COL.elections).doc(adminEditElectionId).get();
  const resultsPublished = !snap.data().resultsPublished;
  await db.collection(COL.elections).doc(adminEditElectionId).update({ resultsPublished });
  document.getElementById('aem-publish-btn').textContent = resultsPublished ? 'Unpublish Results' : 'Publish Results';
  toast(resultsPublished ? 'Results published!' : 'Results unpublished.', 'ok');
}

async function resetElection(id) {
  const eid = id || adminEditElectionId;
  if (!confirm('This will permanently delete all votes for this election from Firebase. Are you sure?')) return;
  // Delete all votes
  const votesSnap = await db.collection(COL.elections).doc(eid).collection(COL.votes).get();
  const batch = db.batch();
  votesSnap.docs.forEach(d => batch.delete(d.ref));
  const demoSnap = await db.collection(COL.elections).doc(eid).collection('demo_votes').get();
  demoSnap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  await db.collection(COL.elections).doc(eid).update({ resultsPublished: false, voteStart: null, voteEnd: null, demoMode: false });
  toast('Election reset. All votes deleted from Firebase.', 'ok');
  await loadAdminElections();
  if (id) return;
  document.getElementById('admin-election-modal').classList.remove('open');
}

async function resetVoterVote() {
  const vid = document.getElementById('aem-reset-voter-id').value.trim().toUpperCase();
  const msg = document.getElementById('aem-reset-msg');
  if (!vid) { msg.className = 'msg bad'; msg.textContent = 'Enter a Voter ID.'; return; }
  const ref = db.collection(COL.elections).doc(adminEditElectionId).collection(COL.votes).doc(vid);
  const snap = await ref.get();
  if (!snap.exists) { msg.className = 'msg bad'; msg.textContent = 'No vote found for this ID.'; return; }
  await ref.delete();
  document.getElementById('aem-reset-voter-id').value = '';
  msg.className = 'msg ok'; msg.textContent = `Vote for ${vid} removed. They may re-vote.`;
  setTimeout(() => { msg.className = 'msg'; }, 4000);
}

// ── AEM Candidates ────────────────────────────────────────────
async function loadAEMCandidates(id) {
  const wrap = document.getElementById('aem-candidates-list');
  wrap.innerHTML = '';
  const snap = await db.collection(COL.elections).doc(id).collection(COL.candidates).orderBy('order').get();
  if (snap.empty) { wrap.innerHTML = '<div class="empty-state" style="padding:1rem;"><p>No candidates yet.</p></div>'; return; }
  snap.forEach(doc => {
    const c = { id: doc.id, ...doc.data() };
    const thumb = c.photo ? `<img class="list-thumb" src="${c.photo}" alt="">` : `<div class="list-thumb-ph">👤</div>`;
    wrap.innerHTML += `<div class="list-item">${thumb}<div class="list-info"><strong>${c.name}</strong><span>Class ${c.classOf}</span></div><div class="list-actions"><button class="btn btn-danger btn-xs" onclick="removeAEMCandidate('${doc.id}')">Remove</button></div></div>`;
  });
}

function toggleAddCandidateForm() {
  const f = document.getElementById('aem-add-cand-form');
  f.style.display = f.style.display === 'block' ? 'none' : 'block';
}

let aemPhotoData = '';
function aemPreviewPhoto(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    aemPhotoData = e.target.result;
    const prev = document.getElementById('aem-photo-preview');
    prev.src = aemPhotoData; prev.style.display = 'block';
    document.getElementById('aem-photo-label').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

async function addAEMCandidate() {
  const name = document.getElementById('aem-cand-name').value.trim();
  const cls = document.getElementById('aem-cand-class').value.trim();
  const desc = document.getElementById('aem-cand-desc').value.trim();
  const msg = document.getElementById('aem-cand-msg');
  if (!name || !cls || !desc) { msg.className = 'msg bad'; msg.textContent = 'Fill all fields.'; return; }
  const snap = await db.collection(COL.elections).doc(adminEditElectionId).collection(COL.candidates).orderBy('order', 'desc').limit(1).get();
  const lastOrder = snap.empty ? 0 : snap.docs[0].data().order || 0;
  await db.collection(COL.elections).doc(adminEditElectionId).collection(COL.candidates).add({ name, classOf: cls, description: desc, photo: aemPhotoData || '', order: lastOrder + 1 });
  aemPhotoData = '';
  msg.className = 'msg ok'; msg.textContent = `${name} added.`;
  await loadAEMCandidates(adminEditElectionId);
  setTimeout(() => { msg.className = 'msg'; toggleAddCandidateForm(); }, 1500);
}

async function removeAEMCandidate(candId) {
  if (!confirm('Remove this candidate? Their votes will also be deleted.')) return;
  await db.collection(COL.elections).doc(adminEditElectionId).collection(COL.candidates).doc(candId).delete();
  // Remove votes for this candidate
  const vs = await db.collection(COL.elections).doc(adminEditElectionId).collection(COL.votes).where('candidateId', '==', candId).get();
  const batch = db.batch(); vs.docs.forEach(d => batch.delete(d.ref)); await batch.commit();
  await loadAEMCandidates(adminEditElectionId);
  toast('Candidate removed.', 'ok');
}

// ── AEM Voters ────────────────────────────────────────────────
async function loadAEMVoters(id) {
  const wrap = document.getElementById('aem-voters-list');
  wrap.innerHTML = '';
  const snap = await db.collection(COL.elections).doc(id).collection(COL.voters).get();
  if (snap.empty) { wrap.innerHTML = '<div class="empty-state" style="padding:1rem;"><p>No voters added yet.</p></div>'; return; }
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>ID</th><th>Name</th><th>Actions</th></tr></thead><tbody>` +
    snap.docs.map(d => `<tr><td>${d.id}</td><td>${d.data().name}</td><td><button class="btn btn-danger btn-xs" onclick="removeAEMVoter('${d.id}')">Remove</button></td></tr>`).join('') +
    '</tbody></table>';
}

async function addAEMVoterSingle() {
  const id = document.getElementById('aem-voter-id').value.trim().toUpperCase();
  const pass = document.getElementById('aem-voter-pass').value.trim();
  const name = document.getElementById('aem-voter-name').value.trim();
  const msg = document.getElementById('aem-voter-msg');
  if (!id || !pass || !name) { msg.className = 'msg bad'; msg.textContent = 'Fill ID, name and password.'; return; }
  const hash = await sha256(pass);
  await db.collection(COL.elections).doc(adminEditElectionId).collection(COL.voters).doc(id).set({ id, name, pass: hash });
  document.getElementById('aem-voter-id').value = '';
  document.getElementById('aem-voter-pass').value = '';
  document.getElementById('aem-voter-name').value = '';
  msg.className = 'msg ok'; msg.textContent = `${name} (${id}) added.`;
  await loadAEMVoters(adminEditElectionId);
  setTimeout(() => { msg.className = 'msg'; }, 3000);
}

async function addAEMVoterBulk() {
  const raw = document.getElementById('aem-bulk-text').value.trim();
  const msg = document.getElementById('aem-bulk-msg');
  if (!raw) { msg.className = 'msg bad'; msg.textContent = 'Paste voter list first.'; return; }
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0, failed = 0;
  const credsLog = [];
  for (const line of lines) {
    // Format: "Name - password"  OR  "ID - Name - password"  OR auto-generate
    const parts = line.split('-').map(p => p.trim());
    let id, name, pass;
    if (parts.length === 2) {
      // "Name - password"
      name = parts[0]; pass = parts[1];
      id = name.replace(/\s+/g, '').toUpperCase().slice(0, 6) + String(Math.floor(Math.random() * 900) + 100);
    } else if (parts.length >= 3) {
      // "ID - Name - password"
      id = parts[0].toUpperCase(); name = parts[1]; pass = parts[2];
    } else { failed++; continue; }
    try {
      const hash = await sha256(pass);
      await db.collection(COL.elections).doc(adminEditElectionId).collection(COL.voters).doc(id).set({ id, name, pass: hash });
      credsLog.push(`${id} | ${name} | ${pass}`);
      added++;
    } catch { failed++; }
  }
  msg.className = 'msg ok'; msg.textContent = `Added ${added} voter(s).${failed ? ` ${failed} failed.` : ''}`;
  document.getElementById('aem-bulk-creds').textContent = credsLog.join('\n');
  document.getElementById('aem-bulk-creds-wrap').style.display = credsLog.length ? 'block' : 'none';
  await loadAEMVoters(adminEditElectionId);
}

async function autoAddVotersBulk() {
  const raw = document.getElementById('aem-auto-names').value.trim();
  const msg = document.getElementById('aem-auto-msg');
  if (!raw) { msg.className = 'msg bad'; msg.textContent = 'Enter names first.'; return; }
  const names = raw.split('\n').map(n => n.trim()).filter(Boolean);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#';
  const genPass = () => Array.from({ length: 8 }, (_, i) => {
    if (i === 0) return chars[Math.floor(Math.random() * 26)].toUpperCase();
    if (i === 4) return '@';
    return chars[Math.floor(Math.random() * chars.length)];
  }).join('');
  const credsLog = [];
  for (const name of names) {
    const id = name.replace(/\s+/g, '').toUpperCase().slice(0, 6) + String(Math.floor(Math.random() * 900) + 100);
    const pass = genPass();
    const hash = await sha256(pass);
    await db.collection(COL.elections).doc(adminEditElectionId).collection(COL.voters).doc(id).set({ id, name, pass: hash });
    credsLog.push(`${name} | ${id} | ${pass}`);
  }
  msg.className = 'msg ok'; msg.textContent = `${names.length} voter(s) generated.`;
  document.getElementById('aem-auto-creds').textContent = credsLog.join('\n');
  document.getElementById('aem-auto-creds-wrap').style.display = 'block';
  await loadAEMVoters(adminEditElectionId);
}

async function removeAEMVoter(vid) {
  if (!confirm(`Remove voter ${vid}?`)) return;
  await db.collection(COL.elections).doc(adminEditElectionId).collection(COL.voters).doc(vid).delete();
  await loadAEMVoters(adminEditElectionId);
  toast('Voter removed.', 'ok');
}

// ── Live Vote Stats (Admin) ────────────────────────────────────
async function loadAEMStats() {
  const wrap = document.getElementById('aem-stats-wrap');
  const [candSnap, voteSnap] = await Promise.all([
    db.collection(COL.elections).doc(adminEditElectionId).collection(COL.candidates).orderBy('order').get(),
    db.collection(COL.elections).doc(adminEditElectionId).collection(COL.votes).get()
  ]);
  const candidates = candSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const counts = {}; candidates.forEach(c => { counts[c.id] = 0; });
  const classCounts = {};
  voteSnap.docs.forEach(d => {
    const v = d.data();
    if (counts[v.candidateId] !== undefined) counts[v.candidateId]++;
    if (!classCounts[v.class]) classCounts[v.class] = { total: 0 };
    classCounts[v.class][v.candidateId] = (classCounts[v.class][v.candidateId] || 0) + 1;
    classCounts[v.class].total++;
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let html = candidates.map(c => `<div class="stat-row"><span class="stat-label">${c.name}</span><span class="stat-val">${counts[c.id]} vote${counts[c.id] !== 1 ? 's' : ''}</span></div>`).join('');
  html += `<div class="stat-row"><span class="stat-label">Total</span><span class="stat-val">${total}</span></div>`;
  const classEntries = Object.entries(classCounts).sort((a, b) => b[1].total - a[1].total);
  if (classEntries.length) {
    html += `<br><table class="data-table"><thead><tr><th>Class</th>${candidates.map(c => `<th>${c.name}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;
    classEntries.forEach(([cls, d]) => {
      html += `<tr><td>${cls}</td>${candidates.map(c => `<td>${d[c.id] || 0}</td>`).join('')}<td>${d.total}</td></tr>`;
    });
    html += '</tbody></table>';
  }
  wrap.innerHTML = html;
}

// ── AEM Tabs ──────────────────────────────────────────────────
function switchAEMTab(tab) {
  document.querySelectorAll('#admin-election-modal .tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#admin-election-modal .tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(`aem-tab-${tab}`).classList.add('active');
  document.getElementById(`aem-tc-${tab}`).classList.add('active');
  if (tab === 'stats') loadAEMStats();
}

// ── Request a new election (public) ──────────────────────────
async function submitElectionRequest() {
  const title = document.getElementById('req-title').value.trim();
  const desc = document.getElementById('req-desc').value.trim();
  const by = document.getElementById('req-by').value.trim();
  const contact = document.getElementById('req-contact').value.trim();
  const msg = document.getElementById('req-msg');
  if (!title || !desc || !by) { msg.className = 'msg bad'; msg.textContent = 'Fill all required fields.'; return; }
  const key = crypto.randomUUID().split('-')[0].toUpperCase();
  await db.collection(COL.requests).add({ electionTitle: title, description: desc, requestedBy: by, contact, requestType: 'new', status: 'pending', moderatorKey: key, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  document.getElementById('req-success-key').textContent = key;
  document.getElementById('req-form-wrap').style.display = 'none';
  document.getElementById('req-success-wrap').style.display = 'block';
}

// ── Approve / Reject request ──────────────────────────────────
async function approveRequest(reqId) {
  const snap = await db.collection(COL.requests).doc(reqId).get();
  const r = snap.data();
  if (r.requestType === 'new') {
    // Create election
    const elecRef = db.collection(COL.elections).doc();
    await elecRef.set({ title: r.electionTitle, description: r.description, status: 'approved', createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: r.requestedBy, moderatorKey: r.moderatorKey, voteStart: null, voteEnd: null, resultsPublished: false, demoMode: false, featured: false });
    await db.collection(COL.requests).doc(reqId).update({ status: 'approved', electionId: elecRef.id });
    toast(`Election approved! ID: ${elecRef.id}`, 'ok');
  } else {
    // Mod action request — apply it
    await applyModRequest(r);
    await db.collection(COL.requests).doc(reqId).update({ status: 'approved' });
    toast('Request approved and applied.', 'ok');
  }
  await loadPendingRequests();
  await loadAdminElections();
}

async function applyModRequest(r) {
  const ref = db.collection(COL.elections).doc(r.electionId);
  if (r.requestType === 'set-dates') { await ref.update({ voteStart: r.details.start, voteEnd: r.details.end }); }
  if (r.requestType === 'publish') { await ref.update({ resultsPublished: true }); }
  if (r.requestType === 'add-candidate') {
    const snap = await ref.collection(COL.candidates).orderBy('order', 'desc').limit(1).get();
    const lastOrder = snap.empty ? 0 : snap.docs[0].data().order || 0;
    await ref.collection(COL.candidates).add({ ...r.details, order: lastOrder + 1 });
  }
}

async function rejectRequest(reqId) {
  await db.collection(COL.requests).doc(reqId).update({ status: 'rejected' });
  toast('Request rejected.', 'bad');
  await loadPendingRequests();
}

// ── Moderator Login ───────────────────────────────────────────
async function doModLogin() {
  const electionId = document.getElementById('mod-election-id-hidden').value;
  const key = document.getElementById('mod-key-input').value.trim().toUpperCase();
  const err = document.getElementById('mod-login-err');
  const snap = await db.collection(COL.elections).doc(electionId).get();
  if (!snap.exists || snap.data().moderatorKey !== key) { err.textContent = 'Invalid moderator key.'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  location.hash = `#mod-panel/${electionId}`;
}

async function loadModPanel(electionId) {
  const snap = await db.collection(COL.elections).doc(electionId).get();
  if (!snap.exists) { location.hash = '#home'; return; }
  const e = { id: snap.id, ...snap.data() };
  document.getElementById('mod-panel-title').textContent = e.title;
  document.getElementById('mod-panel-link').textContent = `${location.origin}/#election/${electionId}`;
  // Load stats
  const [candSnap, voteSnap] = await Promise.all([
    db.collection(COL.elections).doc(electionId).collection(COL.candidates).get(),
    db.collection(COL.elections).doc(electionId).collection(COL.votes).get()
  ]);
  const candidates = candSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const counts = {}; candidates.forEach(c => { counts[c.id] = 0; });
  voteSnap.docs.forEach(d => { const v = d.data(); if (counts[v.candidateId] !== undefined) counts[v.candidateId]++; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  document.getElementById('mod-stats').innerHTML = candidates.map(c =>
    `<div class="stat-row"><span class="stat-label">${c.name}</span><span class="stat-val">${counts[c.id]} vote${counts[c.id] !== 1 ? 's' : ''}</span></div>`
  ).join('') + `<div class="stat-row"><span class="stat-label">Total</span><span class="stat-val">${total}</span></div>`;

  document.getElementById('mod-election-id').value = electionId;
}

async function submitModRequest(type) {
  const electionId = document.getElementById('mod-election-id').value;
  const by = (await db.collection(COL.elections).doc(electionId).get()).data().createdBy;
  const baseReq = { electionId, requestedBy: by, status: 'pending', requestType: type, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
  let details = {};
  if (type === 'set-dates') {
    details.start = document.getElementById('mod-start').value;
    details.end = document.getElementById('mod-end').value;
    if (!details.start || !details.end) { toast('Set both dates.', 'bad'); return; }
  }
  if (type === 'publish') { baseReq.electionTitle = 'Publish Results'; }
  if (type === 'add-candidate') {
    details.name = document.getElementById('mod-cand-name').value.trim();
    details.classOf = document.getElementById('mod-cand-class').value.trim();
    details.description = document.getElementById('mod-cand-desc').value.trim();
    if (!details.name || !details.classOf || !details.description) { toast('Fill all candidate fields.', 'bad'); return; }
  }
  await db.collection(COL.requests).add({ ...baseReq, details });
  toast(`Request sent to admin for approval.`, 'ok');
}

// ── About modal ───────────────────────────────────────────────
function openAbout() { document.getElementById('about-modal').classList.add('open'); }

// ── Global modal close on overlay click ──────────────────────
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});
