import { GoogleAuth } from 'google-auth-library';
import { createHash } from 'node:crypto';
import type { CentralContext, RewardOffer } from './shared/embedded';

export interface IntegrationGateway {
  exchange(token: string, nonce: string): Promise<CentralContext>;
  context(context: CentralContext): Promise<CentralContext>;
  activity(context: CentralContext, eventId: string): Promise<unknown>;
  draw(context: CentralContext): Promise<RewardOffer>;
  settle(context: CentralContext, offerId: string, winnerIds: string[]): Promise<{ receipt: string }>;
  complete(context: CentralContext, eventId: string, winnerIds: string[], receipt: string): Promise<unknown>;
}
const auth = new GoogleAuth();
const eventId = (prefix: string, runId: string) => createHash('sha256').update(`${prefix}/${runId}`).digest('hex');
export class RemoteGateway implements IntegrationGateway {
  private async request<T>(target: 'hub' | 'rewards', data: object): Promise<T> {
    const url = process.env[target === 'hub' ? 'BETWEEN_TURNS_API_URL' : 'REWARDS_GAME_API_URL'];
    if (!url) throw new Error(`${target} integration has not been configured.`);
    const parsed = new URL(url);
    const emulator = process.env.FUNCTIONS_EMULATOR === 'true';
    if (parsed.protocol !== 'https:' && !(emulator && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('Integration endpoints must use HTTPS.');
    let body: { result: T; error?: { message: string } };
    if (emulator) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', [target === 'hub' ? 'X-Emulator-App' : 'X-Emulator-Game']: 'rpg-bingo' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15_000) });
      body = await response.json() as typeof body;
      if (!response.ok || body.error) throw Object.assign(new Error('Integration request was rejected.'), { response: { data: body } });
    } else {
      const client = await auth.getIdTokenClient(url);
      body = (await client.request<typeof body>({ url, method: 'POST', data, timeout: 15_000 })).data;
    }
    if (body.error || !body.result) throw new Error('Integration request failed.');
    return body.result;
  }
  exchange(token: string, nonce: string) { return this.request<CentralContext>('hub', { action: 'exchange', token, nonce }); }
  context(c: CentralContext) { return this.request<CentralContext>('hub', { action: 'context', sessionId: c.sessionId, playerId: c.playerId, runId: c.runId }); }
  activity(c: CentralContext, eventId: string) { return this.request('hub', { action: 'activity', sessionId: c.sessionId, playerId: c.playerId, runId: c.runId, eventId }); }
  draw(c: CentralContext) {
    return this.request<RewardOffer>('rewards', { action: 'draw', sessionId: c.sessionId, playerId: c.playerId, runId: c.runId, requestId: eventId(`offer/${c.playerId}`, c.runId) });
  }
  settle(c: CentralContext, offerId: string, winnerIds: string[]) {
    return this.request<{ receipt: string }>('rewards', { action: 'settle', sessionId: c.sessionId, runId: c.runId, offerId, winnerIds, requestId: eventId('settle', c.runId) });
  }
  complete(c: CentralContext, eventId: string, winnerIds: string[], receipt: string) {
    return this.request('hub', { action: 'complete', sessionId: c.sessionId, runId: c.runId, eventId, winnerIds, rewardsReceipt: receipt });
  }
}
