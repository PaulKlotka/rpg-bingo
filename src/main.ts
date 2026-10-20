import { mountNavigation, showPage } from './navigation';
import { expired } from '../functions/src/shared/lifetime';
import './style.css';
import { isMarked } from './game';
import { getPattern, patternHelp } from '../functions/src/shared/patterns';
import { loadSession, newSession, nextCard, playNumber, rollSession, saveSession, toggleAward } from './session';

let storage: Storage | undefined;
try { storage = window.localStorage; } catch { /* Play remains available when storage is blocked. */ }
let session = loadSession(storage);
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let expiryNotice = '';
try { if (expired(JSON.parse(storage?.getItem('rpg-games.progress.v1') || '{}').expiresAt)) expiryNotice = 'Your previous session expired after 24 hours without activity. A fresh solo session has started.'; } catch { /* Ignore invalid storage. */ }
const die = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M32 5 57 20 53 46 32 60 11 46 7 20Z M7 20 32 16 57 20 43 40 53 46 M11 46 21 40 7 20 M32 5V16L21 40H43L32 16 M21 40 32 60 43 40" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="shell mx-auto w-full max-w-5xl px-4 sm:px-8">
    <header class="flex items-center justify-between py-5 sm:py-7">
      <a class="brand flex items-center gap-2.5" href="/" aria-label="RPG Games home"><span class="brand-die">${die}</span>RPG<span class="font-normal text-slate-400">Games</span></a>
      <span class="edition">AT THE TABLE</span>
    </header>
    <nav class="page-navigation" aria-label="Main menu"><span id="current-page">Game</span><details id="page-menu"><summary aria-label="Menu"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></summary><div class="page-menu-links"><a href="#game" data-page-link="game">Game</a><a href="#room" data-page-link="room">Shared Room</a><a href="#instructions" data-page-link="instructions">Instructions</a><a href="#rewards" data-page-link="rewards">Rewards</a><a href="#history" data-page-link="history">Round History</a></div></details></nav>
    <main>
      <div class="intro flex flex-wrap items-end justify-between gap-4">
        <div><p class="eyebrow">YOUR SIDE QUEST STARTS HERE</p><h1>Roll. Mark. <span>Bingo.</span></h1><p class="subtitle">A little extra adventure at your table.</p></div>
        <span class="system-tag"><span></span>STARFINDER · SECOND EDITION</span>
      </div>
      <h2 class="page-heading" data-page="room">Shared Room</h2><h2 class="page-heading" data-page="instructions">Instructions</h2><h2 class="page-heading" data-page="rewards">Rewards</h2><h2 class="page-heading" data-page="history">Round History</h2>
      <div id="session-controls-fallback" data-page="room"></div>
      <div id="shared-panel-home"><section id="multiplayer" hidden aria-label="Group session"></section></div>
      <section id="solo-game"><p id="expiry-notice" class="session-message" role="status"></p>
      <div class="game-layout grid gap-5 md:grid-cols-[1fr_260px]">
        <section class="card-panel" aria-label="Bingo card">
          <div class="flex items-center justify-between gap-3 mb-4"><h2 class="section-label">YOUR BINGO CARD</h2><span id="card-state" class="state-pill">IN PLAY</span></div>
          <section id="prize" class="prize-panel" aria-labelledby="prize-name" role="status" aria-live="polite" aria-atomic="true">
            <p id="prize-state" class="eyebrow">THIS CARD’S PRIZE</p><h3 id="prize-name"></h3><p id="prize-benefit"></p><p id="prize-help" class="prize-help"></p>
          </section>
          <section class="pattern-panel" aria-label="Winning pattern"><p class="eyebrow">THIS CARD’S WINNING PATTERN</p><h3><span id="pattern-name" class="pattern-desktop-title"></span><button id="solo-pattern-toggle" class="pattern-toggle" type="button" aria-expanded="false" aria-controls="solo-pattern-details"></button></h3><div id="solo-pattern-details" class="pattern-details"><p id="pattern-help"></p><p class="pattern-legend">◇ Outline = target · Green fill = marked</p></div></section>
          <div class="letters grid grid-cols-5" aria-hidden="true"><span>B</span><span>I</span><span>N</span><span>G</span><span>O</span></div>
          <div id="card" class="grid grid-cols-5 gap-2" role="group" aria-label="5 by 5 bingo card"></div>
          <div id="status" class="card-status" role="status" aria-live="polite"></div>
          <button id="new-card" class="new-card w-full" type="button"><span aria-hidden="true">↻</span> New Card</button>
        </section>
        <aside class="flex flex-col gap-5">
          <section class="roll-panel" aria-labelledby="roll-heading"><p class="eyebrow" id="roll-heading">LET FATE DECIDE</p><button id="roll" class="die-button" aria-label="Roll a twenty-sided die" type="button">${die}<span id="die-face">20</span></button><p class="roll-title">Roll a d20</p><p id="roll-help" class="muted">Matching numbers mark together.</p><div class="roll-result" role="status" aria-live="polite" aria-atomic="true"><span class="section-label">LAST ROLL</span><strong id="last-roll">—</strong><span id="roll-count">Ready when you are</span></div></section>
      <div id="session-controls-home" data-page="room">
      <div class="invite-entry"><button id="invite-player" class="new-card" type="button">▦ Invite a player · Show QR / session link</button><p>Keep playing solo while invited players wait for your next card.</p></div>
      <div id="solo-invite-form"></div>
      <div id="leave-room-panel" class="leave-room-panel" hidden><button id="leave-room" class="new-card" type="button">Leave room · Return to solo</button><p class="prize-help">Return to your saved solo card. Create another session with Invite a player.</p></div>
      </div>
          <section class="how-panel"><h2 class="section-label">SOLO PLAY</h2><ol><li><span>01</span><p>Roll here, or tap a number to mark or unmark every match.</p></li><li><span>02</span><p>Complete this card’s winning pattern. The center is always free.</p></li><li><span>03</span><p>Bingo locks your card. Keep rolling, or start a new card.</p></li></ol></section>
          <section class="how-panel prize-rules" aria-labelledby="prize-rules-heading"><h2 id="prize-rules-heading" class="section-label">BINGO HOUSE RULES</h2><p>Each prize grants +1 to one qualifying roll. Declare it before rolling; use it once. The session and unused prizes expire after 24 hours without game activity. Only one bingo prize per roll.</p><p>Attack bonuses affect accuracy, not damage.</p><p class="house-rule-note">Proposed bingo house rules, not official Starfinder rewards.</p></section>
        </aside>
      </div>
      </section>
      <section class="awards-panel" data-page="rewards" aria-labelledby="awards-heading">
        <div class="flex flex-wrap items-center justify-between gap-2"><h2 id="awards-heading" class="section-label">SOLO PRIZES</h2><p id="awards-count" class="prize-help" role="status" aria-live="polite"></p></div>
        <p class="awards-intro">Declare a prize before its qualifying roll. Mark it used afterward; you can undo a mistake.</p>
        <p id="awards-empty" class="prize-help">No prizes won yet. Complete the winning pattern to earn your card’s prize.</p><ul id="awards" class="awards-list"></ul><p id="save-status" class="save-status" role="status"></p>
      </section>
      <div id="history-results" data-page="history"></div>
      <section id="history-empty" class="how-panel" data-page="history"><h3 class="section-label">NO SHARED ROOM OPEN</h3><p class="awards-intro">Join or create a Shared Room from the menu to see its confirmed rounds, winners, and rewards.</p></section>
      <section id="room-page" data-page="room"></section>
      <section id="instructions-page" data-page="instructions"></section>
    </main>
    <footer class="flex flex-wrap justify-between gap-2"><span>ONE PLAYER. TWENTY SIDES. ENDLESS POSSIBILITIES.</span><span>Made for your next session.</span></footer>
  </div>`;

document.querySelector('#room-page')!.append(document.querySelector('#session-controls-home')!, document.querySelector('#session-controls-fallback')!);
document.querySelectorAll('#solo-game .card-panel, #solo-game .roll-panel').forEach(element => { (element as HTMLElement).dataset.page = 'game'; });
document.querySelectorAll('#solo-game .how-panel').forEach(element => document.querySelector('#instructions-page')!.append(element));
mountNavigation();

const card = document.querySelector<HTMLDivElement>('#card')!;
const cells: HTMLButtonElement[] = [];
for (let index = 0; index < 25; index++) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'cell';
  button.addEventListener('click', () => {
    const number = session.game.card[index];
    if (number !== null) session = playNumber(session, number);
    render();
  });
  card.append(button); cells.push(button);
}

let displayedPatternCard = session.game.card;
document.querySelector('#solo-pattern-toggle')!.addEventListener('click', event => {
  const details = document.querySelector('#solo-pattern-details')!;
  const expanded = details.classList.toggle('expanded');
  (event.currentTarget as HTMLButtonElement).setAttribute('aria-expanded', String(expanded));
});

function render() {
  if (expired(session.expiresAt)) { session = newSession(); expiryNotice = 'Your previous session expired after 24 hours without activity. A fresh solo session has started.'; }
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(render, Math.max(1, session.expiresAt - Date.now()));
  document.querySelector('#expiry-notice')!.textContent = expiryNotice;
  const game = session.game;
  if (displayedPatternCard !== game.card) {
    displayedPatternCard = game.card;
    document.querySelector('#solo-pattern-details')!.classList.remove('expanded');
    document.querySelector('#solo-pattern-toggle')!.setAttribute('aria-expanded', 'false');
  }
  const pattern = getPattern(game.pattern);
  const targets = new Set(pattern.squares);
  document.querySelector('#pattern-name')!.textContent = pattern.name;
  document.querySelector('#solo-pattern-toggle')!.textContent = pattern.name;
  document.querySelector('#pattern-help')!.textContent = patternHelp(game.pattern);
  document.querySelector('#prize-name')!.textContent = game.prize.name;
  document.querySelector('#prize-benefit')!.textContent = `+1 to one ${game.prize.qualifyingRoll}.`;
  document.querySelector('#prize-state')!.textContent = game.won ? '✦ PRIZE EARNED' : 'THIS CARD’S PRIZE';
  document.querySelector('#prize-help')!.textContent = game.won ? 'Earned! Declare this bonus before one qualifying roll.' : 'Complete the winning pattern to earn this one-use bonus.';
  document.querySelector('#prize')!.classList.toggle('earned', game.won);
  const winningCells = new Set(game.winningLines.flat());
  cells.forEach((button, index) => {
    const number = game.card[index]; const free = number === null;
    button.innerHTML = free ? '<span class="free-star" aria-hidden="true">✧</span><span class="free-label">FREE</span>' : String(number);
    button.classList.toggle('pattern-target', targets.has(index));
    button.classList.toggle('marked', isMarked(game, index));
    button.classList.toggle('free', free);
    button.classList.toggle('winning', winningCells.has(index));
    button.disabled = game.won || free;
    button.setAttribute('aria-pressed', String(isMarked(game, index)));
    const targetLabel = targets.has(index) ? (pattern.id === 'single-line' || pattern.id === 'two-lines' ? ' Example pattern square.' : ' Required pattern square.') : '';
    button.setAttribute('aria-label', free ? `Free center, always marked.${targetLabel}` : `Row ${Math.floor(index / 5) + 1}, column ${index % 5 + 1}: ${number}. ${isMarked(game, index) ? 'Marked' : 'Unmarked'}.${targetLabel} Toggle all ${number}s`);
  });
  document.querySelector('#card-state')!.textContent = game.won ? 'CARD LOCKED' : 'IN PLAY';
  document.querySelector('#card-state')!.classList.toggle('locked', game.won);
  document.querySelector('#status')!.textContent = game.won ? '✦ BINGO! Winning pattern complete. Card locked.' : 'Tap a number. Every matching square follows.';
  document.querySelector('#status')!.classList.toggle('won', game.won);
  document.querySelector('#last-roll')!.textContent = game.lastRoll === null ? '—' : String(game.lastRoll);
  document.querySelector('#die-face')!.textContent = String(game.lastRoll ?? 20);
  document.querySelector('#roll-count')!.textContent = game.rolls ? `${game.rolls} ${game.rolls === 1 ? 'roll' : 'rolls'} this card` : 'Ready when you are';
  document.querySelector('#roll-help')!.textContent = game.won ? 'Keep rolling. Your winning card stays locked.' : 'Matching numbers mark together.';
  const unused = session.awards.filter(award => !award.used).length;
  document.querySelector('#awards-count')!.textContent = `${session.awards.length} won · ${unused} unused`;
  document.querySelector<HTMLElement>('#awards-empty')!.hidden = session.awards.length > 0;
  const awards = document.querySelector('#awards')!;
  // Keep controls mounted so focus stays on the used/unused button.
  for (const [index, award] of session.awards.entries()) {
    let item = document.getElementById(`award-${award.id}`);
    if (!item) {
      item = document.createElement('li'); item.id = `award-${award.id}`; item.className = 'award-item';
      const copy = document.createElement('div'); const heading = document.createElement('h3');
      heading.textContent = `${index + 1}. ${award.prize.name}`;
      const benefit = document.createElement('p'); benefit.textContent = `+1 to one ${award.prize.qualifyingRoll}.`;
      copy.append(heading, benefit);
      const button = document.createElement('button'); button.type = 'button';
      button.addEventListener('click', () => { session = toggleAward(session, award.id); render(); });
      item.append(copy, button); awards.append(item);
    }
    item.classList.toggle('used', award.used);
    const button = item.querySelector('button')!;
    button.textContent = award.used ? 'Used · Undo' : 'Mark used';
    button.setAttribute('aria-pressed', String(award.used));
    button.setAttribute('aria-label', `${award.prize.name}, prize ${index + 1}: ${award.used ? 'used, mark unused' : 'unused, mark used'}`);
  }
  document.querySelector('#save-status')!.textContent = saveSession(session, storage) ? 'Progress saved in this browser. Sessions expire after 24 hours without game activity.' : 'Progress could not be saved. Keep this page open to retain your card and prizes.';
}

document.querySelector('#roll')!.addEventListener('click', () => { session = rollSession(session); render(); });
let multiplayer: { onNextCard(): Promise<boolean>; leave?(): void } | undefined;
let inviteEpoch = 0;
async function invite(openRoom = true) {
  if (openRoom) showPage('room');
  else if (!location.hash) showPage('game');
  const root = document.querySelector<HTMLElement>('#multiplayer')!; root.hidden = false;
  if (multiplayer) return;
  root.dataset.page = 'room';
  if (!new URLSearchParams(location.search).has('session') && !document.querySelector<HTMLElement>('#solo-game')!.hidden) {
    document.querySelector('#solo-invite-form')!.append(root);
  }
  document.querySelector<HTMLElement>('#leave-room-panel')!.hidden = false;
  if (document.querySelector<HTMLElement>('#solo-game')!.hidden) {
    document.querySelector('#session-controls-fallback')!.append(document.querySelector('.invite-entry')!, document.querySelector('#leave-room-panel')!);
  }
  const epoch = ++inviteEpoch;
  root.textContent = 'Opening session invite…';
  try {
    const { mountMultiplayer } = await import('./multiplayer');
    const controller = await mountMultiplayer(root, document.querySelector<HTMLElement>('#solo-game')!, die, () => epoch === inviteEpoch);
    if (epoch === inviteEpoch) multiplayer = controller; else controller.leave?.();
  } catch { root.textContent = 'The multiplayer service is not ready. Keep playing solo. Local setup: configure .env.local and run npm run emulators; see README.md.'; }
}
document.querySelector('#invite-player')!.addEventListener('click', () => { void invite(); });
document.querySelector('#leave-room')!.addEventListener('click', () => {
  if (!multiplayer) inviteEpoch++;
  multiplayer?.leave?.();
  document.querySelector('#session-controls-home')!.append(document.querySelector('.invite-entry')!, document.querySelector('#leave-room-panel')!);
  document.querySelector<HTMLElement>('#multiplayer')!.hidden = true;
  document.querySelector<HTMLElement>('#leave-room-panel')!.hidden = true;
  document.querySelector<HTMLElement>('#solo-game')!.hidden = false;
  document.querySelector<HTMLElement>('#history-empty')!.hidden = false;
  document.querySelector('.invite-entry p')!.textContent = 'Keep playing solo while invited players wait for your next card.';
  document.querySelector('#awards-heading')!.textContent = 'SOLO PRIZES';
  showPage('game');
  const url = new URL(location.href); url.searchParams.delete('session');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
});
document.querySelector('#new-card')!.addEventListener('click', async () => {
  const button = document.querySelector<HTMLButtonElement>('#new-card')!; button.disabled = true;
  try {
    if (await multiplayer?.onNextCard()) { showPage('game'); return; }
    session = nextCard(session); render();
  } finally { button.disabled = false; }
});
render();
if (new URLSearchParams(location.search).has('session')) { document.querySelector<HTMLElement>('#solo-game')!.hidden = true; void invite(false); }
