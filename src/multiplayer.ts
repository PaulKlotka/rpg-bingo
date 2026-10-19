import { expired } from '../functions/src/shared/lifetime';
import { getPattern, patternHelp } from '../functions/src/shared/patterns';
import { initializeApp, getApps, type FirebaseOptions } from 'firebase/app';
import { getAuth, connectAuthEmulator, browserLocalPersistence, setPersistence, signInAnonymously } from 'firebase/auth';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { collection, connectFirestoreEmulator, doc, getDocFromServer, getFirestore, onSnapshot, query, orderBy } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import QRCode from 'qrcode';
import { PRIZES } from './prizes';
import type { MultiplayerAward, Player, Room } from '../shared/multiplayer';

const id = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]!));
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Firebase:\s*/, '').replace(/\s*\(functions\/[^)]+\)\.?$/, '') : 'Could not reach the game service. Please try again.';

export async function mountMultiplayer(root: HTMLElement, solo: HTMLElement, die: string, isOpen: () => boolean = () => true): Promise<{onNextCard(): Promise<boolean>; leave?(): void}> {
  const controlsHome = document.querySelector<HTMLElement>('#session-controls-home')!;
  const inviteControl = document.querySelector<HTMLElement>('.invite-entry')!;
  const leaveControl = document.querySelector<HTMLElement>('#leave-room-panel')!;
  const restoreControls = () => {
    const home = solo.hidden ? document.querySelector('#session-controls-fallback')! : controlsHome;
    home.prepend(inviteControl);
    home.append(leaveControl);
  };
  const emulated = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';
  let config: FirebaseOptions;
  try {
    config = emulated ? { projectId: 'demo-rpg-games', apiKey: 'demo-key', appId: 'demo-app', authDomain: 'demo-rpg-games.firebaseapp.com' } : JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG || '{}');
  } catch { config = {}; }
  if (!config.projectId || (!emulated && !import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY)) {
    root.className = 'how-panel';
    root.innerHTML = '<h2 class="section-label">INVITE A PLAYER</h2><p class="awards-intro">Multiplayer is not configured on this copy yet. Single-player is ready. For local group play, set VITE_USE_FIREBASE_EMULATORS=true in .env.local and run npm run emulators. Cloud setup is documented in README.md.</p>';
    return { onNextCard: async () => false };
  }
  root.className = '';
  root.innerHTML = '<p class="how-panel">Connecting to the game service… Your solo progress is saved.</p>';
  const existingApp = getApps().find(a => a.name === 'multiplayer');
  const app = existingApp ?? initializeApp(config, 'multiplayer');
  if (!emulated && !existingApp) initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, 'us-central1');
  if (emulated && !existingApp) {
    const host = location.hostname;
    connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, host, 8080);
    connectFunctionsEmulator(functions, host, 5001);
  }
  try {
    await setPersistence(auth, browserLocalPersistence);
    await auth.authStateReady();
    if (!auth.currentUser) await signInAnonymously(auth);
  } catch (error) {
    console.warn('Multiplayer sign-in failed', (error as {code?: string}).code ?? 'unknown');
    root.className = 'how-panel';
    root.innerHTML = '<h2 class="section-label">MULTIPLAYER CONNECTION UNAVAILABLE</h2><p class="awards-intro">Keep playing solo. Start the Firebase emulators with npm run emulators, then reload. Anonymous sign-in also needs browser storage. For cloud play, check the Firebase configuration and enabled anonymous authentication.</p>';
    return { onNextCard: async () => false };
  }
  if (!isOpen()) return { onNextCard: async () => false };
  const uid = auth.currentUser!.uid;
  const call = httpsCallable<Record<string, unknown>, unknown>(functions, 'gameCommand');
  let roomId = new URLSearchParams(location.search).get('session') ?? '';
  let room: Room | undefined;
  let player: Player | undefined;
  let awards: MultiplayerAward[] = [];
  let online = false;
  let busy = false;
  let message = '';
  let pendingRoll: Record<string, unknown> | undefined;
  let epoch = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let reviewTimer: ReturnType<typeof setTimeout> | undefined;
  let confirming = false;
  let unsubscribes: (() => void)[] = [];
  const queueKey = `rpg-games.pending-leaves.${uid}`;
  let pendingLeaves = new Set<string>();
  try { pendingLeaves = new Set(JSON.parse(localStorage.getItem(queueKey) || '[]')); } catch { /* Storage may be unavailable. */ }
  const saveLeaves = () => { try { localStorage.setItem(queueKey, JSON.stringify([...pendingLeaves])); } catch { /* Still allow the local exit. */ } };
  let draining: Promise<void> | undefined;
  const drainLeaves = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      for (const target of pendingLeaves) {
        try { await call({ action: 'leave', roomId: target }); pendingLeaves.delete(target); saveLeaves(); }
        catch { break; }
      }
    })().finally(() => { draining = undefined; });
    return draining;
  };
  window.addEventListener('online', () => { void drainLeaves(); });
  void drainLeaves();
  function leave() {
    epoch++; clearTimeout(expiryTimer); clearTimeout(reviewTimer);
    unsubscribes.forEach(unsubscribe => unsubscribe()); unsubscribes = [];
    if (roomId) { pendingLeaves.add(roomId); saveLeaves(); void drainLeaves(); }
    roomId = ''; room = undefined; player = undefined; awards = [];
    online = false; busy = false; pendingRoll = undefined; message = '';
    renderJoin();
  }


  const joinUrl = () => {
    const origin = emulated && import.meta.env.VITE_PUBLIC_ORIGIN ? import.meta.env.VITE_PUBLIC_ORIGIN : location.origin;
    const url = new URL(location.pathname, origin);
    url.searchParams.set('session', roomId);
    return url.href;
  };
  function subscribe() {
    history.replaceState(null, '', `${location.pathname}?session=${roomId}`);
    unsubscribes.push(onSnapshot(doc(db, 'rooms', roomId), { includeMetadataChanges: true }, snapshot => {
      room = snapshot.data() as Room | undefined;
      if (!room) message = 'This session has ended. Leave the room to return to solo play and create a new invite.';
      online = !snapshot.metadata.fromCache;
      render();
    }, error => { online = false; message = errorText(error); render(); }));
    unsubscribes.push(onSnapshot(doc(db, 'rooms', roomId, 'players', uid), snapshot => { player = snapshot.data() as Player | undefined; render(); }, error => { message = errorText(error); render(); }));
    unsubscribes.push(onSnapshot(query(collection(db, 'rooms', roomId, 'players', uid, 'awards'), orderBy('round')), snapshot => {
      awards = snapshot.docs.map(d => d.data() as MultiplayerAward); render();
    }, error => { message = errorText(error); render(); }));
  }
  async function submit(payload: Record<string, unknown>) {
    const started = epoch;
    busy = true; message = ''; render();
    try {
      await call(payload);
      if (started !== epoch) return;
      pendingRoll = undefined;
    } catch (error) {
      if (started !== epoch) return;
      const code = (error as {code?: string}).code;
      if (!['roll', 'undo'].includes(String(payload.action)) || !['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal'].includes(code ?? '')) pendingRoll = undefined;
      message = errorText(error);
    } finally { if (started === epoch) { busy = false; render(); } }
  }
  function renderJoin() {
    restoreControls();
    document.querySelector(!roomId && !solo.hidden ? '#solo-invite-form' : '#shared-panel-home')!.append(root);
    root.innerHTML = `<section class="how-panel"><h2 class="section-label">${roomId ? 'JOIN THIS SESSION' : 'INVITE A PLAYER'}</h2><p class="awards-intro">${roomId ? 'Join with a display name. If no numbers are marked yet, you get a card now; otherwise you join the next round.' : 'Keep your current solo card. Invited players join the next card when you choose New Card.'}</p><form id="join-session" class="session-form"><label for="player-name">Your display name</label><input id="player-name" maxlength="32" required autocomplete="nickname" placeholder="e.g. Captain Nova"><button type="submit" class="new-card" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : roomId ? 'Join session' : 'Show invite QR & link'}</button></form><p class="session-message" role="status">${escape(message)}</p></section>`;
    root.querySelector('form')!.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const name = root.querySelector<HTMLInputElement>('#player-name')!.value.trim();
      const creating = !roomId;
      const target = roomId || id();
      const started = epoch;
      busy = true; message = ''; renderJoin();
      try {
        await drainLeaves();
        if (pendingLeaves.has(target)) throw new Error('Reconnect before rejoining this room, or create a new invite from solo play.');
        if (started !== epoch || !isOpen()) return;
        await call({ action: creating ? 'create' : 'join', roomId: target, name });
        if (started !== epoch || !isOpen()) { pendingLeaves.add(target); saveLeaves(); void drainLeaves(); return; }
        roomId = target; subscribe();
      } catch (error) { if (started === epoch) message = errorText(error); }
      finally { if (started === epoch) { busy = false; if (!room) renderJoin(); } }
    });
  }
  function render() {
    if (!isOpen()) return;
    if (!room) { renderJoin(); return; }
    const sessionExpired = expired(room.expiresAt);
    clearTimeout(reviewTimer);
    const pendingBingo = room.pendingBingo;
    const reviewSeconds = pendingBingo ? Math.max(0, Math.ceil((pendingBingo.confirmAt - Date.now()) / 1000)) : 0;
    if (pendingBingo && !sessionExpired) reviewTimer = setTimeout(() => {
      if (!isOpen()) return;
      if (Date.now() >= pendingBingo.confirmAt && online && !busy && !confirming) {
        const started = epoch;
        confirming = true;
        void call({ action: 'confirm', roomId, round: pendingBingo.result.round, pendingId: pendingBingo.requestId })
          .catch(error => { if (started === epoch) message = errorText(error); })
          .finally(() => { confirming = false; if (started === epoch) render(); });
      } else render();
    }, 1000);
    clearTimeout(expiryTimer);
    if (room.expiresAt && !sessionExpired) expiryTimer = setTimeout(render, Math.max(1, room.expiresAt - Date.now()));
    const hostInviting = !sessionExpired && room.phase === 'inviting' && room.creator === uid;
    document.querySelector(hostInviting ? '#solo-invite-form' : '#shared-panel-home')!.append(root);
    solo.hidden = !hostInviting;
    inviteControl.querySelector('p')!.textContent = room.phase === 'shared'
      ? 'Invite more players. Join now if no numbers are marked; otherwise wait for the next round.'
      : 'Keep playing solo while invited players wait for your next card.';
    document.querySelector('#awards-heading')!.textContent = hostInviting ? 'WON PRIZES' : 'SOLO WON PRIZES';
    const active = !sessionExpired && room.phase === 'shared' && player?.eligibleRound === room.round && player.card !== null;
    const enoughPlayers = room.members.filter(m => m.eligibleRound <= room!.round).length >= 2;
    const allowed = active && !pendingBingo && enoughPlayers && room.lastSubmitter !== uid && online && !busy && !pendingRoll;
    const canUndo = active && (!pendingBingo || reviewSeconds > 0) && room.undo?.uid === uid && room.undo.round === room.round && room.lastSubmitter === uid && online && !busy && !pendingRoll;
    const lastName = room.members.find(m => m.uid === room!.lastSubmitter)?.name ?? 'another player';
    const status = pendingBingo && !sessionExpired ? (reviewSeconds > 0 ? 'Bingo review: cards locked for ' + reviewSeconds + ' seconds.' : 'Confirming bingo when connected…') : sessionExpired ? 'This session expired after 24 hours without activity. Leave the room to return to solo play and create a new invite.' : !online ? 'Reconnecting… Shared submissions are paused.' : busy ? 'Submitting… Please wait for the server.' : !active ? 'Waiting for the next card. You cannot submit a shared roll yet. You can leave the room to return to solo play.' : !enoughPlayers ? 'Shared play needs two active players. You can leave the room to play solo or create a new invite.' : room.lastSubmitter === uid ? 'Your roll was accepted. A different active player must submit next.' : room.lastSubmitter === null ? 'Any active player may submit the first roll.' : `You may submit. Any active player except ${lastName} may submit.`;
    const link = joinUrl();
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(link).hostname);
    const offeredPrize = PRIZES.find(p => p.name === room!.prize);
    const result = room.lastResult;
    const pattern = getPattern(room.pattern);
    const targets = new Set(pattern.squares);
    const sessionPanel = `
      <section class="how-panel session-top"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="section-label">${sessionExpired ? 'SESSION EXPIRED' : hostInviting ? 'INVITE READY · KEEP PLAYING SOLO' : room.phase === 'inviting' ? 'WAITING FOR THE HOST’S NEXT CARD' : `SHARED ROUND ${room.round}`}</h2><span class="state-pill">${online ? 'CONNECTED' : 'RECONNECTING'}</span></div>
        <p class="awards-intro">${sessionExpired ? escape(status) : hostInviting ? `${room.members.length - 1} invited player(s) waiting. Your current solo card and prize stay unchanged. ${room.members.length > 1 ? 'Choose New Card when ready to start shared play.' : 'Share the invite below.'}` : room.phase === 'inviting' ? 'The host is finishing their current single-player card. You’ll receive your first card when the host chooses New Card.' : escape(status)}</p>
        <p class="roster">${room.members.map(m => `${escape(m.name)}${room!.phase === 'inviting' && m.uid === room!.creator ? ' (playing solo)' : m.eligibleRound > room!.round ? ' (waiting)' : ''}`).join(' · ')}</p>
        <div id="room-controls" class="room-controls"></div>
        <h3 class="section-label session-invite-heading">INVITE TO THIS ROOM</h3><div class="invite-share"><img id="session-qr" alt="QR code to join this session" width="180" height="180"><div><p>Scan with your phone camera, or open this link:</p><a id="session-link" href="${escape(link)}">${escape(link)}</a><button id="copy-link" class="new-card" type="button">Copy session link</button><p class="prize-help">${loopback ? 'This localhost link only works on this computer. Open the site using its Wi-Fi address, or set VITE_PUBLIC_ORIGIN to that address before sharing.' : emulated ? 'Local test: players need the same trusted Wi-Fi and access to this computer. Keep the app and emulators running.' : 'Anyone with this invite can join. No account signup needed.'}</p></div></div>
        <p class="session-message" role="status">${escape(message)}</p>
        ${pendingRoll && !busy ? '<button id="retry-roll" class="new-card" type="button">Retry the same submission safely</button>' : ''}
      </section>`;
    root.innerHTML = `
      ${pendingBingo ? `<section class="round-result" role="status"><strong>BINGO — REVIEWING ROLL ${pendingBingo.result.number}</strong><p>${pendingBingo.result.winners.map(w => escape(w.name)).join(', ')} completed the pattern. All cards are locked. ${reviewSeconds > 0 ? `Auto-confirms in ${reviewSeconds} seconds. The last submitter can undo a mistaken roll now.` : 'Confirming bingo when connected…'} Prizes and new cards follow confirmation.</p></section>` : ''}
      ${room.phase === 'shared' ? '' : sessionPanel}
      ${result ? `<section class="round-result" role="status"><strong>Round ${result.round}: ${result.winners.map(w => escape(w.name)).join(', ')} won ${escape(result.prize)}!</strong><p>Winning roll: ${result.number}. Everyone received fresh cards for round ${result.round + 1}. ${result.winners.some(w => w.uid === uid) ? 'Your prize is in Won This Session below.' : ''}</p></section>` : ''}
      ${room.phase === 'shared' ? `<div class="game-layout grid gap-5 md:grid-cols-[1fr_260px]"><section class="card-panel"><div class="flex items-center justify-between gap-2 mb-4"><h2 class="section-label">YOUR SHARED-ROUND CARD</h2><span class="state-pill">${pendingBingo ? 'REVIEWING BINGO' : active ? 'IN PLAY' : 'WAITING'}</span></div><section class="prize-panel"><p class="eyebrow">THIS ROUND’S SHARED PRIZE</p><h3>${escape(room.prize)}</h3><p class="awards-intro">+1 to one ${escape(offeredPrize?.qualifyingRoll ?? 'qualifying roll')}. Every player with bingo on the winning roll earns it.</p></section><section class="pattern-panel" aria-label="Shared winning pattern"><p class="eyebrow">EVERYONE’S WINNING PATTERN</p><h3>${escape(pattern.name)}</h3><p>${escape(patternHelp(room.pattern))}</p><p class="pattern-legend">◇ Outline = target · Green fill = marked</p></section>${active ? `<div class="grid grid-cols-5 gap-2" role="group" aria-label="Your shared-round bingo card">${player!.card!.map((n, i) => `<button type="button" class="cell ${targets.has(i) ? 'pattern-target' : ''} ${n === null ? 'free' : ''} ${n === null || room!.marks.includes(n) ? 'marked' : ''}" ${n === null || !allowed ? 'disabled' : ''} data-number="${n ?? ''}" aria-pressed="${n === null || room!.marks.includes(n)}" aria-label="Row ${Math.floor(i / 5) + 1}, column ${i % 5 + 1}: ${n ?? 'free'}${n === null || room!.marks.includes(n) ? ', marked' : ', unmarked'}${targets.has(i) ? (pattern.id === 'single-line' || pattern.id === 'two-lines' ? ', example pattern square' : ', required pattern square') : ''}">${n === null ? '<span class="free-star">✧</span><span class="free-label">FREE</span>' : n}</button>`).join('')}</div><p class="card-status">Tap a numbered square to submit that roll for everyone. Matching squares stay marked.</p>` : '<p class="awards-intro">No active card yet. The next completed round will deal you a fresh card with everyone else. You can leave this room anytime to return to solo play and create a new invite.</p>'}</section>
      <aside class="flex flex-col gap-5"><section class="roll-panel"><p class="eyebrow">SHARED d20</p><button id="shared-die" class="die-button" aria-label="Roll a shared twenty-sided die" ${allowed ? '' : 'disabled'}>${die}<span id="shared-die-face">${room.lastAction?.number ?? 20}</span></button><p class="roll-title">Roll for everyone</p><p class="muted">${escape(status)}</p>${room.undo?.uid === uid && room.undo.round === room.round ? `<button id="undo-roll" class="new-card w-full" type="button" ${canUndo ? '' : 'disabled'}>${pendingBingo ? 'Undo winning roll' : 'Undo my last roll'} (${room.undo.number})</button><p class="prize-help">${pendingBingo ? "Undo this entry before the countdown ends to resume the same cards." : "Restores everyone’s previous marks. Available until another player submits or the round ends."}</p>` : ''}${room.lastUndo ? `<p class="prize-help" role="status">${escape(room.lastUndo.name)} undid ${room.lastUndo.number}. Previous shared marks restored.</p>` : ''}</section>${sessionPanel}<section class="how-panel"><p class="prize-help">Card taps and die rolls both count. Only the last submitter must wait for someone else. Any two active players can alternate, even in a larger group.</p><p class="awards-intro">${room.lastAction ? `Last accepted: ${escape(room.lastAction.name)} rolled ${room.lastAction.number} in round ${room.lastAction.round}.` : 'No rolls yet.'}</p><p class="prize-help">Marked numbers: ${room.marks.join(', ') || 'none yet'}</p></section></aside></div>` : ''}
      ${!hostInviting ? `<section class="awards-panel"><h2 class="section-label">WON THIS SESSION</h2><p class="awards-intro">+1 to one qualifying roll. Declare before rolling; use once. The session and unused prizes expire after 24 hours without game activity. One bingo prize per roll; attack bonuses affect accuracy, not damage. Proposed house rules, not official Starfinder rewards.</p><ul class="awards-list">${awards.map(a => `<li class="award-item ${a.used ? 'used' : ''}"><div><h3>${escape(a.prize)}</h3><p>Round ${a.round} · +1 to one ${escape(PRIZES.find(p => p.name === a.prize)?.qualifyingRoll ?? 'qualifying roll')}.</p></div><button data-award="${a.round}" data-used="${a.used}" aria-pressed="${a.used}" aria-label="${escape(a.prize)}, round ${a.round}: ${a.used ? 'used, mark unused' : 'unused, mark used'}" ${busy || !online || sessionExpired ? 'disabled' : ''}>${a.used ? 'Used · Undo' : 'Mark used'}</button></li>`).join('')}</ul>${awards.length ? '' : '<p class="prize-help">No prizes earned in this session yet.</p>'}<p class="save-status">Saved to your anonymous player in this session. Session and unused prizes expire after 24 hours without game activity. Your solo prizes remain separate below.</p></section>` : ''}`;
    root.querySelector('#room-controls')!.append(inviteControl, leaveControl);
    void QRCode.toDataURL(link, { width: 180, margin: 2, errorCorrectionLevel: 'M' }).then(src => {
      const image = root.querySelector<HTMLImageElement>('#session-qr');
      if (image) image.src = src;
    });
    root.querySelector('#copy-link')!.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); message = 'Session link copied.'; }
      catch { message = 'Copy the visible session link above; clipboard access is unavailable here.'; }
      render();
    });
    const sendRoll = (kind: 'physical' | 'virtual', number?: number) => {
      if (!allowed || !room || expired(room.expiresAt) || busy || pendingRoll) { render(); return; }
      pendingRoll = { action: 'roll', roomId, round: room.round, revision: room.revision, kind, requestId: id(), ...(kind === 'physical' ? { number } : {}) };
      void submit(pendingRoll);
    };
    root.querySelectorAll<HTMLButtonElement>('[data-number]').forEach(button => button.addEventListener('click', () => {
      const value = Number(button.dataset.number);
      if (Number.isInteger(value) && value >= 1 && value <= 20) sendRoll('physical', value);
    }));
    root.querySelector('#undo-roll')?.addEventListener('click', () => {
      if (!canUndo || !room?.undo || busy || pendingRoll || expired(room.expiresAt)) { render(); return; }
      pendingRoll = { action: 'undo', roomId, round: room.round, revision: room.revision, rollRequestId: room.undo.requestId, requestId: id() };
      void submit(pendingRoll);
    });
    root.querySelector('#shared-die')?.addEventListener('click', () => sendRoll('virtual'));
    root.querySelector('#retry-roll')?.addEventListener('click', () => { if (pendingRoll && !busy) void submit(pendingRoll); });
    root.querySelectorAll<HTMLButtonElement>('[data-award]').forEach(button => button.addEventListener('click', () => {
      void submit({ action: 'use', roomId, awardRound: Number(button.dataset.award), used: button.dataset.used !== 'true' });
    }));
  }

  if (roomId && !/^[a-f0-9]{32}$/.test(roomId)) { message = 'Invalid session link. Open the complete invite URL.'; roomId = ''; }
  if (roomId) {
    solo.hidden = true;
    try {
      const existing = await getDocFromServer(doc(db, 'rooms', roomId, 'players', uid));
      if (existing.exists() && !existing.get('left')) subscribe(); else renderJoin();
    } catch (error) { message = errorText(error); renderJoin(); }
  } else renderJoin();
  return {
    leave,
    async onNextCard() {
      if (room && expired(room.expiresAt)) return true;
      if (!room || room.phase !== 'inviting' || room.creator !== uid || room.members.length < 2) return false;
      if (busy) return true;
      await submit({ action: 'start', roomId });
      return true;
    },
  };
}
