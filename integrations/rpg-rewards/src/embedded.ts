import './style.css';
import type { Award } from '../shared/model';

interface View { playerId: string; displayName: string; sessionId: string; expiresAt: number; inventory: Award[]; history: Award[] }
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export async function mountEmbedded() {
  const root = document.querySelector<HTMLElement>('#app')!;
  root.innerHTML = `<main class="embed-workspace"><h1>Session rewards</h1><p id="embed-message" role="status" aria-live="polite">Connecting to Between Turns…</p><button id="embed-retry" class="secondary" hidden>Retry</button><div class="tabs" role="tablist" aria-label="Rewards view"><button id="inventory-tab" role="tab" aria-selected="true">My rewards</button><button id="history-tab" role="tab" aria-selected="false">Session reward history</button></div><section id="embed-content"></section></main>`;
  const message = root.querySelector<HTMLElement>('#embed-message')!;
  const retry = root.querySelector<HTMLButtonElement>('#embed-retry')!;
  const params = new URLSearchParams(location.search); const origin = params.get('btParentOrigin') ?? ''; const nonce = params.get('btNonce') ?? '';
  const allowed = (import.meta.env.VITE_BETWEEN_TURNS_ORIGINS || 'https://between-turns-paul.web.app').split(',').map((s: string) => s.trim());
  if (window.parent === window || !allowed.includes(origin) || params.get('btVersion') !== '1' || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) { message.textContent = 'Open Rewards from Between Turns.'; return; }
  const post = (type: string) => window.parent.postMessage({ channel: 'between-turns', version: 1, nonce, type }, origin);
  let credential = ''; let busy = false; let connected = false; let view: View | undefined; let tab = 'inventory'; let pending: object | undefined;
  async function request<T>(data: object): Promise<T> {
    const response = await fetch('/embeddedApi', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(data), cache: 'no-store', signal: AbortSignal.timeout(25000) });
    const body = await response.json();
    if (!response.ok || body.error) throw Object.assign(new Error(body.error?.message || 'Rewards are unavailable.'), { code: body.error?.code });
    return body.result;
  }
  function failure(error: unknown) { message.textContent = error instanceof Error ? error.message : 'Rewards are unavailable.'; retry.hidden = false; if (!connected) post('error'); }
  function render() {
    if (!view) return;
    if (retry.hidden) message.textContent = `${view.displayName}'s rewards for this session.`;
    root.querySelector('#inventory-tab')!.setAttribute('aria-selected', String(tab === 'inventory'));
    root.querySelector('#history-tab')!.setAttribute('aria-selected', String(tab === 'history'));
    const awards = tab === 'inventory' ? view.inventory : view.history;
    const content = root.querySelector<HTMLElement>('#embed-content')!;
    const html = awards.length ? `<div class="reward-list">${awards.map(award => `<article class="reward-card ${award.consumedAt === null ? '' : 'consumed'}"><div class="reward-info"><div class="reward-top"><h3>${escape(award.reward.name)}</h3><span class="bonus">+1</span></div><p>+1 to one ${escape(award.reward.qualifyingRoll)}.</p><div class="reward-meta"><strong>${escape(award.playerName)}</strong><span>${escape(award.gameId)}</span><time>${escape(new Date(award.awardedAt).toLocaleString())}</time></div></div>${tab === 'inventory' ? `<button class="${award.consumedAt === null ? 'use-button' : 'undo-button'}" data-award="${escape(award.id)}" data-consumed="${award.consumedAt === null}" ${busy || pending ? 'disabled' : ''}>${award.consumedAt === null ? 'Use reward' : 'Undo use'}</button>` : `<span class="state-pill">${award.consumedAt === null ? 'Available' : 'Consumed'}</span>`}</article>`).join('')}</div>` : `<div class="empty inventory-empty"><h3>${tab === 'inventory' ? 'Your next win starts the collection.' : 'No rewards awarded yet.'}</h3><p>Rewards from every game in this session appear here.</p></div>`;
    if (content.innerHTML !== html) content.innerHTML = html;
    content.querySelectorAll<HTMLButtonElement>('[data-award]').forEach(button => { button.onclick = () => { void consume({ action: 'consume', awardId: button.dataset.award, consumed: button.dataset.consumed === 'true', requestId: crypto.randomUUID() }); }; });
  }
  async function refresh() {
    if (!connected || busy || pending) return; busy = true;
    try { view = await request<View>({ action: 'view' }); retry.hidden = true; }
    catch (error) { failure(error); }
    finally { busy = false; if (retry.hidden) render(); }
  }
  async function consume(data?: object) {
    if (busy) return; pending ??= data; if (!pending) return; busy = true; render();
    try { view = await request<View>(pending); pending = undefined; retry.hidden = true; post('refresh'); }
    catch (error) { if (['permission-denied', 'invalid-argument', 'already-exists'].includes((error as { code: string }).code)) pending = undefined; failure(error); }
    finally { busy = false; if (retry.hidden) render(); }
  }
  root.querySelector('#inventory-tab')!.addEventListener('click', () => { tab = 'inventory'; render(); });
  root.querySelector('#history-tab')!.addEventListener('click', () => { tab = 'history'; render(); });
  retry.onclick = () => { if (!connected) location.reload(); else if (pending) void consume(); else void refresh(); };
  window.addEventListener('message', async event => {
    const data = event.data;
    if (busy || connected || event.source !== window.parent || event.origin !== origin || !data || data.channel !== 'between-turns' || data.version !== 1 || data.nonce !== nonce || data.type !== 'connect' || typeof data.grant !== 'string' || data.grant.length > 1024 || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) return;
    busy = true;
    try { view = await request<View>({ action: 'connect', nonce, grant: data.grant }); connected = true; retry.hidden = true; post('connected'); }
    catch (error) { failure(error); }
    finally { busy = false; if (retry.hidden) render(); }
  });
  try { credential = (await request<{ credential: string }>({ action: 'begin', nonce })).credential; post('ready'); }
  catch (error) { failure(error); }
  const timer = setInterval(() => { void refresh(); }, 3000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
