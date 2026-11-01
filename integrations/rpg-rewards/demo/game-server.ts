/** Local-only integration example. Never deploy this emulator credential adapter. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Offer, SessionView } from '../shared/model';

const origin = 'http://127.0.0.1:5174';
const rewardsOrigin = 'http://127.0.0.1:5173';
const endpoint = 'http://127.0.0.1:5101/demo-rpg-rewards/us-central1/gameApi';
interface BrowserSession { state?: string; playerId?: string; sessionId?: string; displayName?: string; offer?: Offer; drawRequest?: string; awardRequest?: string }
const browsers = new Map<string, BrowserSession>();
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
async function game<T>(data: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Emulator-Game': 'demo-game' }, body: JSON.stringify(data) });
  const body = await response.json() as { result: T; error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message || 'Game API request failed.');
  return body.result;
}
function redirect(response: ServerResponse, url: string) { response.writeHead(303, { Location: url }); response.end(); }
function getBrowser(request: IncomingMessage, response: ServerResponse): BrowserSession {
  let cookie = request.headers.cookie?.match(/(?:^|;\s*)demo_browser=([a-f0-9]{48})(?:;|$)/)?.[1];
  if (!cookie || !browsers.has(cookie)) {
    cookie = randomBytes(24).toString('hex'); browsers.set(cookie, {});
    response.setHeader('Set-Cookie', `demo_browser=${cookie}; HttpOnly; SameSite=Lax; Path=/`);
  }
  return browsers.get(cookie)!;
}
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  const url = new URL(request.url || '/', origin);
  const browser = getBrowser(request, response);
  try {
    if (url.pathname === '/connect' && request.method === 'GET') {
      browser.state = randomBytes(24).toString('base64url');
      const target = new URL(rewardsOrigin);
      target.searchParams.set('gameId', 'demo-game'); target.searchParams.set('redirectUri', `${origin}/callback`); target.searchParams.set('state', browser.state);
      redirect(response, target.toString()); return;
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      if (!browser.state || url.searchParams.get('state') !== browser.state) throw new Error('Connection state did not match. Start again.');
      const player = await game<{ playerId: string; sessionId: string; displayName: string }>({ action: 'exchange', code: url.searchParams.get('code'), redirectUri: `${origin}/callback` });
      Object.assign(browser, player, { state: undefined, offer: undefined, drawRequest: undefined, awardRequest: undefined });
      redirect(response, origin); return;
    }
    if (request.method === 'POST') {
      if (request.headers.origin !== origin) { response.writeHead(403); response.end('Invalid request origin.'); return; }
      if (!browser.playerId || !browser.sessionId) throw new Error('Connect a player and session first.');
      if (url.pathname === '/draw') {
        browser.drawRequest ||= randomUUID();
        browser.offer = await game<Offer>({ action: 'draw', playerId: browser.playerId, sessionId: browser.sessionId, requestId: browser.drawRequest });
        browser.drawRequest = undefined; browser.awardRequest = undefined;
      } else if (url.pathname === '/win') {
        if (!browser.offer) throw new Error('Draw a reward first.');
        browser.awardRequest ||= randomUUID();
        await game({ action: 'award', playerId: browser.playerId, sessionId: browser.sessionId, offerId: browser.offer.id, requestId: browser.awardRequest });
        // Preserve offer and request ID so repeated winner submissions demonstrate safe retries.
      } else { response.writeHead(404); response.end(); return; }
      redirect(response, origin); return;
    }
    if (request.method !== 'GET' || url.pathname !== '/') { response.writeHead(404); response.end(); return; }
    let sessionName = '';
    if (browser.playerId && browser.sessionId) {
      const session = await game<SessionView>({ action: 'session', playerId: browser.playerId, sessionId: browser.sessionId });
      sessionName = session.session.name;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sample Game · RPG Rewards</title><style>body{background:#101820;color:#e8edf5;font-family:system-ui;margin:0;padding:8vh 6%;line-height:1.7}main{max-width:600px;margin:auto}a{color:#8fe8df}h1{font-size:38px;line-height:1.2}section{border:1px solid #42565c;border-radius:12px;background:#1b2a30;padding:24px;margin:24px 0}button{font:inherit;background:#8fe8df;border:0;border-radius:6px;padding:12px 20px;cursor:pointer}form{display:inline-block;margin-right:12px;margin-bottom:12px}.muted{color:#a9b8c7}strong{color:#edbb7e}code{overflow-wrap:anywhere}</style></head><body><main><p class="muted">LOCAL INTEGRATION EXAMPLE</p><h1>A different game.<br>The same rewards.</h1><p>This sample backend draws a reward before a win and awards that exact offer afterward.</p>${browser.playerId ? `<p>Connected as <strong>${escape(browser.displayName)}</strong> in <strong>${escape(sessionName)}</strong>.</p><section><p class="muted">OFFERED REWARD</p>${browser.offer ? `<h2>${escape(browser.offer.reward.name)}</h2><p>+1 to one ${escape(browser.offer.reward.qualifyingRoll)}.</p>` : '<p>No reward drawn yet.</p>'}</section><form action="/draw" method="post"><button type="submit">Draw reward</button></form>${browser.offer ? '<form action="/win" method="post"><button type="submit">Record a win</button></form>' : ''}<p><a href="/connect">Choose another player session</a></p>` : '<section><p>Start in RPG Rewards, create or join a session, then connect this game.</p><a href="/connect">Connect your player ↗</a></section>'}<p><a href="${rewardsOrigin}">Open RPG Rewards ↗</a></p><p class="muted">This is a local test game. RPG Bingo has not been connected or changed.</p></main></body></html>`);
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<html lang="en"><title>Sample game error</title><p>${escape(error instanceof Error ? error.message : 'Request failed.')}</p><a href="/connect">Reconnect to a session</a></html>`);
  }
});
server.listen(5174, '127.0.0.1', () => console.log(`Sample game: ${origin}`));
