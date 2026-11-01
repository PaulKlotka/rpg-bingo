import './style.css';
import { toDataURL } from 'qrcode';
import { command, configured, identity, listSessions, local, viewSession } from './client';
import type { Session, SessionView } from '../shared/model';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const requestId = () => crypto.randomUUID();
const saved = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Firebase reports unavailable identity persistence separately. */ } };
const formatDate = (n: number) => new Date(n).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let sessions: Session[] = [];
let selected = saved('rewards-session');
let view: SessionView | undefined;
let tab: 'inventory' | 'history' = 'inventory';
let busy = false;
let refreshVersion = 0;
let playerId = '';
let invite: { url: string; image: string } | undefined;
const params = new URLSearchParams(location.search);
const joinCode = params.get('join')?.trim().toUpperCase() || '';
const connect = params.get('gameId') ? { gameId: params.get('gameId')!, redirectUri: params.get('redirectUri') || '', state: params.get('state') || '' } : undefined;

$('#app').innerHTML = `
  <header class="masthead"><a class="brand" href="/" aria-label="RPG Rewards home"><span class="brand-mark" aria-hidden="true">✦</span><span>RPG<span class="brand-light">REWARDS</span></span></a><span class="guest-badge"><span class="dot"></span> Guest player</span></header>
  <main class="layout"><aside class="sidebar"><p class="eyebrow">YOUR ADVENTURE</p><h1>Good rolls.<br>Great rewards.</h1><p class="intro">Your winnings, together.<br>Across every game you play.</p>
    <div class="session-control"><label for="session-select">CURRENT SESSION</label><select id="session-select" aria-label="Current session"><option value="">Choose a session</option></select><p id="session-note" class="muted">Create a session or join your party.</p></div>
    <details id="session-forms" open><summary>Create or join a session <span aria-hidden="true">+</span></summary><div class="forms">
      <label for="player-name">Your player name</label><input id="player-name" maxlength="40" required placeholder="What should we call you?" autocomplete="nickname" value="${escape(saved('rewards-name'))}">
      <form id="create-form"><label for="session-name">Session name</label><input id="session-name" name="name" maxlength="70" required placeholder="Saturday at the Drift"><fieldset><legend>Play style</legend><label class="radio"><input type="radio" name="kind" value="solo" checked> Solo</label><label class="radio"><input type="radio" name="kind" value="shared"> Shared</label></fieldset><button class="primary" type="submit">Create session <span aria-hidden="true">↗</span></button></form>
      <div class="divider">OR JOIN YOUR PARTY</div><form id="join-form"><label for="join-code">Join code</label><input id="join-code" name="code" required maxlength="12" pattern="[a-fA-F0-9]{12}" placeholder="12-character code" autocapitalize="characters" autocomplete="off"><button class="secondary" type="submit">Join session</button></form>
    </div></details>
    <div class="sidebar-foot"><span class="tiny-star" aria-hidden="true">✧</span><div>STARFINDER SECOND EDITION<small>One shared pool. A little extra luck.</small></div></div>
  </aside><section class="workspace" aria-label="Session rewards"><div id="connection"></div><div id="notice" role="status" aria-live="polite">Connecting your guest identity…</div><div id="session-content"></div></section></main>
  <footer><span>Built for the moments worth celebrating.</span><span>No sign-up. Just play.</span></footer>`;

function notice(message: string, error = false) { const node = $('#notice'); node.textContent = message; node.className = message ? (error ? 'notice error' : 'notice') : ''; }
function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

const rendered = new Map<string, string>();
function setHTML(selector: string, content: string) {
  if (rendered.get(selector) === content) return;
  const root = $(selector);
  const focused = document.activeElement as HTMLElement | null;
  const restore = focused && root.contains(focused) ? { id: focused.id, award: focused.dataset.award } : undefined;
  root.innerHTML = content;
  rendered.set(selector, content);
  if (restore?.id) document.getElementById(restore.id)?.focus({ preventScroll: true });
  else if (restore?.award) root.querySelector<HTMLButtonElement>('[data-award="' + CSS.escape(restore.award) + '"]')?.focus({ preventScroll: true });
}

function updateSelector() {
  setHTML('#session-select', '<option value="">Choose a session</option>' + sessions.map(s => `<option value="${escape(s.id)}" ${s.id === selected ? 'selected' : ''}>${escape(s.name)}${s.expiresAt <= Date.now() ? ' · expired' : ''}</option>`).join(''));
}
function joinUrl(code: string): string {
  const url = new URL('/', location.origin);
  url.searchParams.set('join', code);
  return url.toString();
}
function draw() {
  const session = sessions.find(s => s.id === selected);
  const expired = session && session.expiresAt <= Date.now();
  $('#session-note').textContent = session ? (expired ? 'This session and its rewards have expired.' : `Expires ${formatDate(view?.session.expiresAt || session.expiresAt)} after inactivity.`) : 'Create a session or join your party.';
  setHTML('#connection', connect ? `<div class="connect-banner"><div><strong>Connect to ${escape(connect.gameId)}</strong><p>Choose a session, then share your player identity with this game.</p></div><button id="connect-game" class="primary" ${!view || expired ? 'disabled' : ''}>Continue to game ↗</button></div>` : '');
  if (!session || expired || !view) {
    setHTML('#session-content', `<div class="empty welcome"><div class="orbit" aria-hidden="true">✦</div><p class="eyebrow">${expired ? 'ADVENTURE COMPLETE' : 'READY WHEN YOU ARE'}</p><h2>${expired ? 'A fresh adventure awaits.' : 'Every win belongs here.'}</h2><p>${expired ? 'This session and its rewards have expired. Create a new session to keep playing.' : session ? 'Loading your session…' : 'Create a solo session or join your party.<br>Your rewards from every game will meet here.'}</p><div class="welcome-rule"></div><p class="fine-print">Sessions and their rewards expire after<br>24 hours without activity.</p></div>`);
    return;
  }
  const available = view.inventory.filter(a => a.consumedAt === null);
  const consumed = view.inventory.length - available.length;
  const mine = view.members.find(m => m.playerId === playerId);
  const awards = tab === 'inventory' ? view.inventory : view.history;
  setHTML('#session-content', `<div class="session-heading"><div><p class="eyebrow">${escape(session.kind.toUpperCase())} SESSION <span class="accent">/</span> ${view.members.length} PLAYER${view.members.length === 1 ? '' : 'S'}</p><h2>${escape(session.name)}</h2><p class="muted">${escape(mine?.displayName || 'Your')}’s corner of the adventure.</p></div>${session.kind === 'shared' ? `<button class="code-chip" id="copy-code" title="Copy join code"><small>PARTY JOIN CODE</small><strong>${escape(session.joinCode)}</strong><span>Copy code ↗</span></button>` : '<span class="session-symbol" aria-hidden="true">✧</span>'}</div>
    ${session.kind === 'shared' && invite?.url === joinUrl(session.joinCode) ? `<section class="party-invite" aria-label="Invite players"><img src="${invite.image}" alt="QR code to join ${escape(session.name)}" width="160" height="160"><div><p class="eyebrow">BRING YOUR PARTY</p><h3>Scan to join this session</h3><p>Scan the QR code, enter your player name, and choose Join session.</p><a id="join-link" href="${escape(invite.url)}">Open join link</a><button id="copy-join-link" class="secondary" type="button">Copy join link</button>${['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? '<p class="local-invite-note">This preview link opens on this computer. Phone scanning requires the deployed site.</p>' : ''}</div></section>` : ''}
    <div class="stats"><div><strong>${available.length.toString().padStart(2, '0')}</strong><span>Ready to use</span><i class="stat-dot cyan"></i></div><div><strong>${consumed.toString().padStart(2, '0')}</strong><span>Consumed</span><i class="stat-dot amber"></i></div><div><strong>${view.inventory.length.toString().padStart(2, '0')}</strong><span>Won by you</span><i class="stat-dot gray"></i></div></div>
    <div class="tabs" role="tablist" aria-label="Rewards view"><button role="tab" id="inventory-tab" aria-selected="${tab === 'inventory'}" aria-controls="reward-panel" tabindex="${tab === 'inventory' ? '0' : '-1'}" data-tab="inventory">My rewards <span>${view.inventory.length}</span></button><button role="tab" id="history-tab" aria-selected="${tab === 'history'}" aria-controls="reward-panel" tabindex="${tab === 'history' ? '0' : '-1'}" data-tab="history">Session winners <span>${view.history.length}</span></button></div>
    <div id="reward-panel" role="tabpanel" aria-labelledby="${tab}-tab">${awards.length ? `<div class="reward-list">${awards.map(award => `<article class="reward-card ${award.consumedAt === null ? '' : 'consumed'}"><div class="reward-icon" aria-hidden="true">${award.consumedAt === null ? '✦' : '✓'}</div><div class="reward-info"><div class="reward-top"><h3>${escape(award.reward.name)}</h3><span class="bonus">+1</span></div><p>+1 to one ${escape(award.reward.qualifyingRoll)}.</p><div class="reward-meta">${tab === 'history' ? `<strong>${escape(award.playerName)}</strong><span>·</span>` : ''}<span>${escape(award.gameId)}</span><span>·</span><time datetime="${new Date(award.awardedAt).toISOString()}">${escape(formatDate(award.awardedAt))}</time></div></div>${tab === 'inventory' ? `<button class="${award.consumedAt === null ? 'use-button' : 'undo-button'}" data-award="${escape(award.id)}" data-consumed="${award.consumedAt === null}" ${busy ? 'disabled' : ''}>${award.consumedAt === null ? 'Use reward' : 'Undo use'}</button>` : `<span class="state-pill">${award.consumedAt === null ? 'Available' : 'Consumed'}</span>`}</article>`).join('')}</div>` : `<div class="empty inventory-empty"><span aria-hidden="true">✧</span><h3>${tab === 'inventory' ? 'Your next win starts the collection.' : 'The first winner could be you.'}</h3><p>${tab === 'inventory' ? 'Rewards earned in connected games appear here.' : 'Every winner in this session will appear here.'}</p>${local ? '<a class="demo-link" href="http://127.0.0.1:5174">Open the sample game ↗</a>' : ''}</div>`}</div>
    <div class="rules-note"><span aria-hidden="true">ⓘ</span><p>Declare your bonus before rolling. Each reward is single-use; only one applies per roll. Attack bonuses affect accuracy, not damage. These are Starfinder 2e house rules.</p></div>`);
}

async function refresh() {
  const version = ++refreshVersion;
  const nextSessions = await listSessions();
  if (version !== refreshVersion) return;
  sessions = nextSessions;
  if (!sessions.some(s => s.id === selected)) selected = sessions.find(s => s.expiresAt > Date.now())?.id || '';
  save('rewards-session', selected);
  updateSelector();
  const session = sessions.find(s => s.id === selected);
  if (session && session.expiresAt > Date.now()) {
    const nextView = await viewSession(selected);
    if (version !== refreshVersion) return;
    view = nextView;
    if (session.kind === 'shared') {
      const url = joinUrl(session.joinCode);
      if (invite?.url !== url) {
        const image = await toDataURL(url, { width: 320, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#10141cff', light: '#ffffffff' } });
        if (version !== refreshVersion) return;
        invite = { url, image };
      }
    } else invite = undefined;
  } else view = undefined;
  draw();
}
async function run(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
  try { await work(); notice(''); }
  catch (error) { notice(message(error), true); }
  finally { busy = false; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); draw(); }
}
$('#session-select').addEventListener('change', () => { selected = $<HTMLSelectElement>('#session-select').value; view = undefined; draw(); void run(refresh); });
$('#create-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const data = new FormData(event.target as HTMLFormElement);
    const displayName = $<HTMLInputElement>('#player-name').value.trim();
    if (!displayName) throw new Error('Enter your player name first.');
    const result = await command<{ sessionId: string }>({ action: 'create', requestId: requestId(), name: data.get('name'), kind: data.get('kind'), displayName });
    save('rewards-name', displayName); selected = result.sessionId; await refresh(); $<HTMLDetailsElement>('#session-forms').open = false;
  });
});
$('#join-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const displayName = $<HTMLInputElement>('#player-name').value.trim();
    if (!displayName) throw new Error('Enter your player name first.');
    const result = await command<{ sessionId: string }>({ action: 'join', joinCode: $<HTMLInputElement>('#join-code').value.trim(), displayName });
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('join');
    history.replaceState(null, '', cleanUrl);
    save('rewards-name', displayName); selected = result.sessionId; await refresh(); $<HTMLDetailsElement>('#session-forms').open = false;
  });
});
$('#session-content').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button) return;
  if (button.dataset.tab) { tab = button.dataset.tab as typeof tab; draw(); $(`#${tab}-tab`).focus(); }
  if (button.id === 'copy-code') void navigator.clipboard.writeText(view!.session.joinCode).then(() => notice('Join code copied.')).catch(() => notice('Copy the displayed join code to share it.'));
  if (button.id === 'copy-join-link' && invite) void navigator.clipboard.writeText(invite.url).then(() => notice('Join link copied.')).catch(() => notice('Use Open join link to access the invitation.'));
  if (button.dataset.award) void run(async () => { await command({ action: 'consume', sessionId: selected, awardId: button.dataset.award, consumed: button.dataset.consumed === 'true', requestId: requestId() }); await refresh(); });
});
$('#session-content').addEventListener('keydown', event => {
  if ((event.target as HTMLElement).getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); tab = event.key === 'Home' ? 'inventory' : event.key === 'End' ? 'history' : tab === 'inventory' ? 'history' : 'inventory'; draw(); $(`#${tab}-tab`).focus();
  }
});
$('#connection').addEventListener('click', event => {
  if (!(event.target as HTMLElement).closest('#connect-game') || !connect) return;
  void run(async () => {
    const result = await command<{ callbackUrl: string }>({ action: 'connect', ...connect, sessionId: selected });
    location.assign(result.callbackUrl);
  });
});
async function start() {
  try {
    playerId = await identity(); await refresh();
    if (joinCode) {
      $<HTMLInputElement>('#join-code').value = joinCode;
      $<HTMLDetailsElement>('#session-forms').open = true;
      notice('Party invitation ready. Enter your player name, then choose Join session.');
      const field = saved('rewards-name') ? '#join-code' : '#player-name';
      $(field).focus();
    } else {
      if (selected) $<HTMLDetailsElement>('#session-forms').open = false;
      notice('');
    }
    setInterval(() => { if (!busy && !document.hidden) void refresh().catch(error => notice(message(error), true)); }, 5000);
  } catch (error) { notice(message(error), true); draw(); }
}
if (configured) void start();
else { notice('Firebase is not configured. Follow README.md to run locally or prepare a deployment.', true); draw(); }
