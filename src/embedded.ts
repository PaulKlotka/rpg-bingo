import './style.css';
import { getPattern, patternHelp } from '../functions/src/shared/patterns';
import type { RewardOffer } from '../functions/src/shared/embedded';
import { acceptsConnection } from './embed-bridge';

interface View {
  playerId: string; card: (number | null)[] | null; pattern: string; offer: RewardOffer | null;
  phase: string; revision: number; marks: number[]; rolls: number; last: { number: number; playerId: string } | null;
  canUndo: boolean; pending: { winnerIds: string[]; confirmAt: number } | null; winners: string[];
  players: { playerId: string; name: string }[]; serverNow: number;
}
export async function mountEmbedded() {
  const root = document.querySelector<HTMLDivElement>('#app')!;
  document.documentElement.classList.add('embedded-page');
  root.innerHTML = `<main class="embed-shell"><header class="embed-heading"><h1>RPG Bingo</h1>
    <p id="embed-message" role="status" aria-live="polite">Connecting to Between Turns.</p>
    <button id="embed-retry" class="new-card" hidden>Retry</button></header>
    <section id="embed-game" class="card-panel" hidden><div class="embed-details"><section><h2 id="embed-pattern"></h2><p id="embed-help"></p></section>
    <section class="prize-panel"><p class="eyebrow">THIS GAME'S REWARD</p><h3 id="embed-reward"></h3><p id="embed-benefit"></p></section></div>
    <div class="embed-board"><div class="embed-board-inner">
    <div class="letters grid grid-cols-5" aria-hidden="true"><span>B</span><span>I</span><span>N</span><span>G</span><span>O</span></div>
    <div id="embed-card" class="grid grid-cols-5" role="group" aria-label="Bingo card"></div></div></div>
    <div class="embed-controls"><p id="embed-roll" role="status" aria-live="polite"></p><button id="embed-die" class="new-card">Roll a d20</button>
    <button id="embed-undo" class="new-card" hidden>Undo my last roll</button></div>
    <p class="embed-instructions">Tap a number to record a physical roll for everyone. Take turns submitting rolls. Bingo has a fifteen-second review before the reward is awarded.</p></section></main>`;
  const message = root.querySelector<HTMLElement>('#embed-message')!;
  const retry = root.querySelector<HTMLButtonElement>('#embed-retry')!;
  const params = new URLSearchParams(location.search);
  const origin = params.get('btParentOrigin') ?? '';
  const nonce = params.get('btNonce') ?? '';
  const allowed = (import.meta.env.VITE_BETWEEN_TURNS_ORIGINS || 'https://between-turns-paul.web.app').split(',').map((value: string) => value.trim());
  if (window.parent === window || !allowed.includes(origin) || params.get('btVersion') !== '1' || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) {
    message.textContent = 'Open Bingo from the Current Game page in Between Turns.'; return;
  }
  const post = (type: string) => window.parent.postMessage({ channel: 'between-turns', version: 1, nonce, type }, origin);
  let credential = ''; let connected = false; let busy = false; let view: View | undefined;
  let pending: Record<string, unknown> | undefined;
  const endpoint = import.meta.env.VITE_BINGO_EMBED_API_URL || '/embeddedApi';
  async function request<T>(data: object): Promise<T> {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify(data), cache: 'no-store', signal: AbortSignal.timeout(25_000) });
    const body = await response.json();
    if (!response.ok || body.error) throw Object.assign(new Error(body.error?.message || 'Bingo is unavailable. Try again.'), { code: body.error?.code });
    return body.result as T;
  }
  function failure(error: unknown) {
    message.textContent = error instanceof Error ? error.message : 'Bingo could not connect.';
    retry.hidden = false;
    if (!connected) post('error');
  }
  function render() {
    if (!view) return;
    root.querySelector<HTMLElement>('#embed-game')!.hidden = false;
    const pattern = getPattern(view.pattern);
    root.querySelector('#embed-pattern')!.textContent = pattern.name;
    root.querySelector('#embed-help')!.textContent = patternHelp(view.pattern);
    root.querySelector('#embed-reward')!.textContent = view.offer?.reward.name ?? 'Waiting for Rewards';
    root.querySelector('#embed-benefit')!.textContent = view.offer?.reward.qualifyingRoll ?? '';
    const names = view.winners.map(id => view!.players.find(p => p.playerId === id)?.name ?? 'Player').join(', ');
    message.textContent = view.phase === 'review' ? `Bingo: ${names}. Reviewing the winning roll…`
      : view.phase === 'settling' ? `Bingo: ${names}. Recording rewards…`
      : view.phase === 'complete' ? `Bingo: ${names}. Reward recorded. Between Turns will choose the next game.`
      : 'Complete the pattern to win.';
    // The backend revalidates all participants for every move. A cached roster
    // must not prevent play when the previous submitter's only peer has left.
    const disabled = busy || !!pending || view.phase !== 'playing';
    const grid = root.querySelector('#embed-card')!;
    view.card?.forEach((number, index) => {
      const cell = (grid.children[index] as HTMLButtonElement | undefined) ?? document.createElement('button'); cell.className = 'cell'; cell.type = 'button';
      const marked = number === null || view!.marks.includes(number);
      cell.textContent = number === null ? 'FREE' : String(number);
      cell.setAttribute('aria-pressed', String(marked)); cell.setAttribute('aria-label', number === null ? 'Free center' : `Record roll ${number}`);
      cell.classList.toggle('marked', marked); cell.classList.toggle('pattern-target', pattern.squares.includes(index));
      cell.disabled = disabled || number === null;
      cell.onclick = () => { void move({ action: 'roll', kind: 'physical', number }); };
      if (!cell.parentElement) grid.append(cell);
    });
    root.querySelector('#embed-roll')!.textContent = `Last roll: ${view.last?.number ?? '—'} · ${view.rolls} rolls`;
    root.querySelector<HTMLButtonElement>('#embed-die')!.disabled = disabled;
    const undo = root.querySelector<HTMLButtonElement>('#embed-undo')!;
    undo.hidden = !view.canUndo; undo.disabled = busy || !!pending;
  }
  async function refresh() {
    if (busy || !connected || pending) return;
    busy = true;
    try { view = await request<View>({ action: 'view' }); retry.hidden = true; if (view.phase === 'complete') post('refresh'); }
    catch (error) { failure(error); }
    finally { busy = false; if (retry.hidden) render(); }
  }
  async function move(data?: Record<string, unknown>) {
    if (busy || !view) return;
    pending ??= { ...data, revision: view.revision, requestId: crypto.randomUUID() };
    busy = true; render();
    try { view = await request<View>(pending); pending = undefined; retry.hidden = true; post('refresh'); }
    catch (error) {
      if ((error as { code?: string }).code === 'failed-precondition') pending = undefined;
      failure(error);
    }
    finally { busy = false; if (retry.hidden) render(); }
  }
  root.querySelector('#embed-die')!.addEventListener('click', () => { void move({ action: 'roll', kind: 'virtual' }); });
  root.querySelector('#embed-undo')!.addEventListener('click', () => { void move({ action: 'undo' }); });
  retry.onclick = () => { if (!connected) location.reload(); else if (pending) void move(); else void refresh(); };
  window.addEventListener('message', async event => {
    if (connected || busy || !acceptsConnection(event, origin, window.parent, nonce, Date.now())) return;
    busy = true;
    try {
      view = await request<View>({ action: 'connect', nonce, grant: event.data.grant });
      connected = true; retry.hidden = true; post('connected');
    } catch (error) { failure(error); }
    finally { busy = false; render(); }
  });
  try { credential = (await request<{ credential: string }>({ action: 'begin', nonce })).credential; post('ready'); }
  catch (error) { failure(error); }
  const timer = window.setInterval(() => { void refresh(); }, 3000);
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
}
