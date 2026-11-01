import './style.css';
import QRCode from 'qrcode';
import type { SessionView, PlayerCommand } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const die = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M32 5 56 19v27L32 60 8 46V19L32 5Zm0 0v55M8 19l48 27M56 19 8 46M8 19h48L32 60 8 19Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
const arrow = `<span aria-hidden="true">↗</span>`;
let view: SessionView | null = null;
let page = 'game'; let mode = new URLSearchParams(location.search).has('join') ? 'join' : 'create';
let busy = false; let online = navigator.onLine; let clockOffset = 0;
let client: typeof import('./client'); let embed: typeof import('./embed');
let gameKey = ''; let disposeGame: (() => void) | undefined;
let rewardsKey = ''; let disposeRewards: (() => void) | undefined;
let epoch = 0; let pending: PlayerCommand | null = null;
let pollRunning = false; let lastPresence = 0; let initialized = false;
let inviteCode = ''; let qrRevision = 0;
const connectionId = crypto.randomUUID();
const requestId = () => crypto.randomUUID();
function saved(key: string) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function save(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Firebase also reports persistence failures. */ } }

$('#app').innerHTML = `
  <header class="header"><a class="brand" href="/" aria-label="Between Turns home"><span class="brand-die">${die}</span><span>BETWEEN<span class="brand-second">TURNS</span></span></a><div class="header-right"><span id="environment"></span><span class="guest"><span class="status-dot"></span> Guest player</span></div></header>
  <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
  <div id="connection" class="connection" role="status">Connecting your guest identity…</div>
  <main>
    <section id="welcome" class="welcome" hidden>
      <div class="intro"><p class="eyebrow"><span class="tiny-line"></span> A LITTLE MORE ADVENTURE</p><h1>The adventure<br>between<br><em>adventures.</em></h1><p class="lede">Keep the table together. Jump into a game,<br class="desktop-break"> collect a little luck, and make every turn count.</p><div class="intro-foot"><span class="mini-die">${die}</span><p>ONE PARTY. EVERY GAME.<br><span>No signup. Just your name and your people.</span></p></div></div>
      <div class="entry-wrap"><div class="entry-top"><span class="eyebrow">YOUR NEXT SESSION</span><span class="entry-number">01 / JOIN THE TABLE</span></div><div class="entry-card"><div class="entry-tabs" role="tablist" aria-label="Session action"><button id="create-tab" role="tab" data-mode="create">Create a session</button><button id="join-tab" role="tab" data-mode="join">Join a session</button></div><div class="entry-copy"><h2 id="entry-title"></h2><p id="entry-description"></p></div><form id="entry-form"><label for="player-name">What should we call you?</label><input id="player-name" name="name" maxlength="40" required autocomplete="nickname" placeholder="Your player name"><div id="code-field"><label for="session-code">Session code</label><input id="session-code" name="code" maxlength="32" placeholder="Your party’s 15-character code" autocomplete="off" spellcheck="false"></div><p class="field-note">Your name is unique at this table.</p><button class="button primary full" id="entry-submit" type="submit" disabled></button></form><div class="entry-bottom"><span class="status-dot"></span><span>Guest access · Sessions last 24 hours after activity</span></div></div><div class="next-up"><span class="next-icon">✧</span><div><span class="eyebrow">FIRST IN THE LINEUP</span><p>RPG Bingo <span>— Play together, collect rewards</span></p></div></div></div>
    </section>
    <section id="hub" hidden>
      <div class="session-heading"><div><p class="eyebrow">YOUR PARTY, IN ONE PLACE</p><h1>Good company.<br><em>Great side quests.</em></h1></div><div class="session-chip"><span class="status-dot"></span><div><span class="eyebrow">SESSION CODE</span><strong id="header-code"></strong></div><button id="copy-code" class="icon-button" aria-label="Copy session code">⧉</button></div></div>
      <div class="hub-bar"><nav class="navigation" aria-label="Main navigation"><button data-page="game" aria-current="page">Current Game</button><button data-page="rewards">My Rewards</button><button data-page="session">Session <span id="member-count" class="count"></span></button></nav><span id="player-label" class="player-label"></span></div>
      <section id="page-game" class="page" aria-label="Current Game"><div id="game-content"></div><div id="game-embed" hidden></div></section>
      <section id="page-rewards" class="page" aria-label="My Rewards" hidden><div class="placeholder rewards-placeholder"><div class="placeholder-art reward-art">✧</div><p class="eyebrow">A LITTLE LUCK, WELL EARNED</p><h2>Your wins belong here.</h2><p>Rewards will travel with you from game to game.<br>They’re yours to use throughout this session.</p><span class="badge">Rewards integration coming soon</span><p class="fine-print">Your reward collection will appear when RPG Rewards is connected.</p></div></section>
      <section id="page-session" class="page" aria-label="Session" hidden><div class="session-grid"><article class="panel invite-panel"><p class="eyebrow">MAKE ROOM AT THE TABLE</p><h2>Invite your party.</h2><p>Scan the QR code, share the link, or pass along your session code.</p><div class="invite-details"><img id="invite-qr" alt="QR code to join this session" width="168" height="168"><div><span class="eyebrow">SESSION CODE</span><strong id="invite-code"></strong><button id="copy-link" class="button secondary">Copy invite link ${arrow}</button></div></div><p class="fine-print" id="invite-note"></p></article><article class="panel roster-panel"><div class="panel-heading"><div><p class="eyebrow">THE PEOPLE MAKE THE PARTY</p><h2>At the table <span id="roster-count"></span></h2></div><span class="badge">All players equal</span></div><ul id="roster" class="roster"></ul><div class="session-bottom"><p id="expiry-note"></p><button id="leave-session" class="button quiet">Leave session ${arrow}</button></div><div id="leave-confirm" hidden><p>Leave this session? Joining again requires its invitation code.</p><button id="confirm-leave" class="button secondary">Leave session</button><button id="cancel-leave" class="button quiet">Stay here</button></div></article></div><article class="panel history-panel"><p class="eyebrow">THE STORY SO FAR</p><h2>Session results</h2><div id="history"></div></article></section>
    </section>
  </main><footer><span>BETWEEN TURNS</span><p>Made for the moments around the table.</p><span class="footer-mark">✧</span></footer>`;

$('#player-name').setAttribute('value', saved('bt-name'));
const query = new URLSearchParams(location.search);
let invitationPending = !!query.get('join');
const returnButton = document.createElement('button'); returnButton.className = 'button quiet'; returnButton.id = 'return-current'; returnButton.textContent = 'Stay in my current session'; returnButton.hidden = true;
$('#entry-form').after(returnButton);
returnButton.onclick = () => { invitationPending = false; history.replaceState(null, '', location.pathname); apply(view); };
$('#session-code').setAttribute('value', query.get('join') || '');

function notice(message: string, error = false) { const el = $('#notice'); el.textContent = message; el.hidden = !message; el.classList.toggle('error', error); }
function paint(target: string, html: string) { const el = $(target); if (el.innerHTML !== html) el.innerHTML = html; }
function setMode(next: string) {
  mode = next;
  $('#create-tab').setAttribute('aria-selected', String(mode === 'create'));
  $('#join-tab').setAttribute('aria-selected', String(mode === 'join'));
  $('#create-tab').tabIndex = mode === 'create' ? 0 : -1; $('#join-tab').tabIndex = mode === 'join' ? 0 : -1;
  $('#entry-title').textContent = mode === 'create' ? 'Start something good.' : 'Your party is waiting.';
  $('#entry-description').textContent = mode === 'create' ? 'Create a shared space, then invite your people.' : 'Enter your name and the code your party shared.';
  $('#code-field').hidden = mode !== 'join'; $('#session-code').toggleAttribute('required', mode === 'join');
  $('#entry-submit').innerHTML = `${mode === 'create' ? 'Create a session' : 'Join the session'} ${arrow}`;
}
setMode(mode);
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
  button.onclick = () => setMode(button.dataset.mode!);
  button.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setMode(mode === 'create' ? 'join' : 'create'); $<HTMLButtonElement>(mode === 'create' ? '#create-tab' : '#join-tab').focus(); } };
});
function navigate(next: string) {
  page = next;
  for (const value of ['game', 'rewards', 'session']) $(`#page-${value}`).hidden = value !== page;
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => { if (button.dataset.page === page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
}
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => { button.onclick = () => navigate(button.dataset.page!); });
function invitation() { const url = new URL(location.origin + location.pathname); url.searchParams.set('join', view!.session.code); return url.href; }
async function copy(value: string, message: string) { try { await navigator.clipboard.writeText(value); notice(message); } catch { notice(`Copy this: ${value}`); } }
$('#copy-code').onclick = () => { if (view) void copy(view.session.code, 'Session code copied.'); };
$('#copy-link').onclick = () => { if (view) void copy(invitation(), 'Invitation link copied.'); };
$('#leave-session').onclick = () => { $('#leave-confirm').hidden = false; $('#leave-session').hidden = true; };
$('#cancel-leave').onclick = () => { $('#leave-confirm').hidden = true; $('#leave-session').hidden = false; };
$('#confirm-leave').onclick = () => { if (view) void run({ action: 'leave', sessionId: view.session.id, requestId: requestId() }); };

$('#entry-form').onsubmit = event => {
  event.preventDefault();
  const name = $<HTMLInputElement>('#player-name').value.trim(); save('bt-name', name);
  void run(mode === 'create' ? { action: 'create', name, requestId: requestId() } : { action: 'join', name, code: $<HTMLInputElement>('#session-code').value, requestId: requestId() });
};
async function run(value: PlayerCommand) {
  if (busy || !initialized) return;
  if (!online) { notice('You’re offline. Reconnect to update your session.', true); return; }
  const sameIntent = (a: PlayerCommand, b: PlayerCommand) => JSON.stringify({ ...a, requestId: null }) === JSON.stringify({ ...b, requestId: null });
  if (pending && sameIntent(pending, value)) value = pending;
  pending = value; epoch++; busy = true; disable(); notice('');
  try {
    const response = await client.command(value);
    pending = null;
    apply(response as SessionView | null);
    if (value.action === 'join' || value.action === 'create') {
      history.replaceState(null, '', location.pathname); lastPresence = 0; await poll();
    }
  } catch (error) {
    const code = (error as { code?: string }).code || '';
    if (!['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal', ''].includes(code)) pending = null;
    notice(error instanceof Error ? error.message.replace(/^Firebase: /, '') : 'That didn’t go through. Please try again.', true);
  }
  finally { busy = false; disable(); }
}
function disable() {
  document.querySelectorAll<HTMLButtonElement>('#entry-submit, #game-content button, #confirm-leave').forEach(button => { button.disabled = busy || !online || !initialized || button.dataset.unavailable === 'true'; });
}
function apply(next: SessionView | null) {
  const oldId = view?.session.id; view = next;
  if (view) clockOffset = view.serverNow - Date.now();
  if (oldId !== view?.session.id) { inviteCode = ''; $('#leave-confirm').hidden = true; $('#leave-session').hidden = false; navigate('game'); }
  const joiningAnother = !!view && invitationPending && view.session.code !== query.get('join')?.replace(/[\s-]/g, '').toUpperCase();
  $('#welcome').hidden = !!view && !joiningAnother; $('#hub').hidden = !view || joiningAnother;
  returnButton.hidden = !joiningAnother;
  if (joiningAnother) $('#entry-description').textContent = 'Joining this party will leave your current session. Your name must be unique in the new party.';
  if (!view) { if (oldId) { disposeGame?.(); gameKey = ''; disposeRewards?.(); rewardsKey = ''; } return; }
  const s = view.session;
  $('#header-code').textContent = s.code; $('#invite-code').textContent = s.code;
  $('#member-count').textContent = String(s.members.length); $('#roster-count').textContent = String(s.members.length);
  const me = s.members.find(m => m.id === view!.playerId);
  $('#player-label').textContent = me ? `Playing as ${me.name}` : '';
  const invite = invitation();
  if (inviteCode !== s.code) {
    inviteCode = s.code; const revision = ++qrRevision;
    void QRCode.toDataURL(invite, { width: 336, margin: 2, color: { dark: '#182316', light: '#ffffff' } }).then(url => { if (revision === qrRevision) $<HTMLImageElement>('#invite-qr').src = url; }).catch(() => notice('The QR code could not be generated. You can still share the invitation link.'));
  }
  $('#invite-note').textContent = client.local ? 'Local preview: invite links work on this computer. Phone scanning needs the deployed HTTPS site.' : 'Anyone with this invitation can join. Share it with your party.';
  paint('#roster', s.members.map(m => `<li><span class="avatar">${escape(m.name.slice(0, 1).toUpperCase())}</span><div><strong>${escape(m.name)}</strong>${m.id === view!.playerId ? '<span class="you">You</span>' : ''}</div><span class="presence ${m.connected ? 'present' : ''}"><span class="status-dot"></span>${m.connected ? 'Connected' : 'Away'}</span></li>`).join(''));
  $('#expiry-note').textContent = view.expired ? 'This session and its rewards have expired.' : `Expires ${new Date(s.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} unless someone plays, joins, votes, or uses a reward.`;
  paint('#history', s.history.length ? `<ol class="result-list">${[...s.history].reverse().map(r => `<li><strong>${escape(view!.games.find(g => g.id === r.gameId)?.name || r.gameId)}</strong><span>${r.winnerIds.map(uid => escape(s.members.find(m => m.id === uid)?.name || 'Former player')).join(', ') || 'Game completed'}</span><time>${new Date(r.completedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></li>`).join('')}</ol>` : '<p class="muted">Your shared game results will appear here. The story is just beginning.</p>');
  renderGame(); renderRewards(); disable(); updateClock();
}
function renderRewards() {
  if (!view) return;
  const app = view.rewardsApp;
  const key = !view.expired && app ? `${view.session.id}:${app.embedUrl}` : '';
  if (key === rewardsKey) return;
  disposeRewards?.(); disposeRewards = undefined; rewardsKey = key;
  const host = document.getElementById('rewards-embed') || Object.assign(document.createElement('div'), { id: 'rewards-embed' });
  $('#page-rewards').append(host);
  const placeholder = $('#page-rewards .placeholder'); placeholder.hidden = !!key;
  if (key && app) disposeRewards = embed.mountEmbed(host, { url: app.embedUrl, appId: app.id, sessionId: view.session.id, title: 'My Rewards', refresh: () => { void poll(); }, report: message => notice(message, true) });
  host.hidden = !key;
}
function renderGame() {
  if (!view) return;
  const s = view.session;
  let html = ''; let key = ''; let game = view.games.find(g => g.id === s.run?.gameId);
  if (view.expired) html = `<div class="placeholder"><div class="placeholder-art">${die}</div><p class="eyebrow">UNTIL THE NEXT ADVENTURE</p><h2>This session has ended.</h2><p>There has been no activity for 24 hours.<br>Leave this session to create or join a fresh one.</p><button class="button primary" id="expired-leave">Leave expired session ${arrow}</button></div>`;
  else if (s.phase === 'lobby') {
    const ready = view.games.some(g => g.ready);
    html = `<div class="lobby-layout"><div class="lobby-main"><span class="badge"><span class="status-dot"></span> Your session is ready</span><h2>Gather the party.<br><em>Let the good rolls begin.</em></h2><p>Invite your people, then start playing together.<br>Everyone gets a say in what comes next.</p><div class="lobby-actions"><button class="button primary" id="start-game" ${ready ? '' : 'data-unavailable="true" disabled'}>Start playing ${arrow}</button><button class="button secondary" id="invite-players">Invite players ${arrow}</button></div>${!ready ? '<p class="availability-note">Your table is open. Games will be playable once their integrations are ready.</p>' : '<p class="availability-note">Any player can start. One available game starts automatically.</p>'}</div><div class="game-lineup"><p class="eyebrow">ON THE TABLE</p>${view.games.map(g => `<article class="game-card"><div class="game-card-art">${die}<span>01</span></div><div class="game-card-copy"><span class="badge">${g.ready ? 'Ready to play' : 'Integration coming soon'}</span><h3>${escape(g.name)}</h3><p>${escape(g.description)}</p></div></article>`).join('')}</div></div>`;
  } else if (s.phase === 'voting' && s.ballot) {
    const b = s.ballot; const voted = b.votes[view.playerId]; const eligible = b.eligible.includes(view.playerId);
    html = `<div class="vote-heading"><div><p class="eyebrow">THE PARTY DECIDES</p><h2>What’s our next adventure?</h2><p>${voted ? 'Your vote is in. Waiting for the party.' : eligible ? 'Pick one game. The most votes wins.' : 'Voting was already underway when you joined. You’ll enter the selected game.'}</p></div><div class="vote-timer"><strong id="vote-seconds"></strong><span>SECONDS LEFT</span></div></div><div class="vote-options">${b.options.map(gameId => { const item = view!.games.find(g => g.id === gameId)!; const count = b.eligible.filter(uid => b.votes[uid] === gameId).length; return `<button class="vote-option ${voted === gameId ? 'selected' : ''}" data-vote="${escape(gameId)}" ${voted || !eligible ? 'data-unavailable="true" disabled' : ''}><span class="vote-icon">${die}</span><h3>${escape(item?.name || gameId)}</h3><p>${escape(item?.description || '')}</p><span class="vote-count">${voted === gameId ? '✓ Your vote · ' : ''}${count} ${count === 1 ? 'vote' : 'votes'}</span></button>`; }).join('')}</div><p class="vote-foot">${b.eligible.filter(uid => b.votes[uid]).length} of ${b.eligible.length} players voted · Ties are settled at random</p>`;
  } else if (s.phase === 'playing' && game?.ready && game.embedUrl) {
    html = `<div class="playing-heading"><div><p class="eyebrow">EVERYONE’S IN</p><h2>${escape(game.name)}</h2></div><span class="badge"><span class="status-dot"></span> Playing together</span></div>`;
    key = `${s.id}:${s.run!.id}`;
  } else html = `<div class="placeholder"><div class="placeholder-art">${die}</div><h2>This game is waiting to connect.</h2><p>Your shared session is ready. The game integration is not available yet.</p><span class="badge">Integration coming soon</span></div>`;
  paint('#game-content', html);
  if (key !== gameKey) {
    disposeGame?.(); disposeGame = undefined; gameKey = key;
    if (key && game?.embedUrl) disposeGame = embed.mountEmbed($('#game-embed'), { url: game.embedUrl, appId: game.id, sessionId: s.id, runId: s.run!.id, title: game.name, refresh: () => { void poll(); }, report: message => notice(message, true) });
  }
  $('#game-embed').hidden = !key;
  const start = document.getElementById('start-game'); if (start) start.onclick = () => void run({ action: 'start', sessionId: s.id, requestId: requestId() });
  const invite = document.getElementById('invite-players'); if (invite) invite.onclick = () => navigate('session');
  const leave = document.getElementById('expired-leave'); if (leave) leave.onclick = () => void run({ action: 'leave', sessionId: s.id, requestId: requestId() });
  document.querySelectorAll<HTMLButtonElement>('[data-vote]').forEach(button => { button.onclick = () => void run({ action: 'vote', sessionId: s.id, ballotId: s.ballot!.id, gameId: button.dataset.vote!, requestId: requestId() }); });
}
function updateClock() {
  if (!view) return;
  const now = Date.now() + clockOffset;
  const timer = document.getElementById('vote-seconds');
  if (timer && view.session.ballot) timer.textContent = String(Math.max(0, Math.ceil((view.session.ballot.closesAt - now) / 1000)));
  if (!view.expired && view.session.expiresAt <= now) { view.expired = true; renderGame(); renderRewards(); }
}
async function poll() {
  if (pollRunning || !initialized || !online) return;
  pollRunning = true;
  const generation = epoch;
  try {
    const next = await client.command({ action: 'current' }) as SessionView | null;
    if (generation !== epoch) return;
    apply(next);
    if (next && !next.expired && Date.now() - lastPresence > 20_000) {
      lastPresence = Date.now();
      const presence = await client.command({ action: 'presence', sessionId: next.session.id, connectionId, connected: true });
      if (generation !== epoch) return;
      apply(presence as SessionView);
    }
    $('#connection').hidden = true;
  } catch { $('#connection').textContent = 'Connection interrupted. Reconnecting…'; $('#connection').hidden = false; }
  finally { pollRunning = false; }
}
window.addEventListener('offline', () => { online = false; $('#connection').textContent = 'You’re offline. Your session will reconnect when you’re back.'; $('#connection').hidden = false; disable(); });
window.addEventListener('online', () => { online = true; lastPresence = 0; disable(); if (!initialized) void boot(); else void poll(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastPresence = 0; void poll(); } });
window.addEventListener('pagehide', () => { if (view && initialized) void client.command({ action: 'presence', sessionId: view.session.id, connectionId, connected: false }).catch(() => {}); });
async function boot() {
  if (import.meta.env.VITE_SERVICE_PENDING === 'true') {
    $('#connection').textContent = 'Preview — shared sessions are waiting for Firebase billing activation.';
    $('#connection').hidden = false; $('#welcome').hidden = false;
    $('#environment').textContent = 'PREVIEW'; disable(); return;
  }
  try {
    client = await import('./client'); embed = await import('./embed');
    await client.initialize(); initialized = true;
    $('#environment').textContent = client.local ? 'LOCAL PREVIEW' : '';
    await poll();
  } catch (error) {
    $('#connection').textContent = error instanceof Error ? error.message : 'Guest access is unavailable.';
    $('#connection').hidden = false; $('#welcome').hidden = false;
    if (!document.getElementById('retry-connection')) {
      const button = document.createElement('button'); button.id = 'retry-connection'; button.className = 'button quiet'; button.textContent = 'Retry connection'; button.onclick = () => { button.remove(); void boot(); }; $('#connection').append(button);
    }
  }
  disable();
}
setInterval(() => { if (!busy) void poll(); }, 3000);
setInterval(updateClock, 250);
void boot();
