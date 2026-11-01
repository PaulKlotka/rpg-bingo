import { GoogleAuth } from 'google-auth-library';
export interface HubContext { version: 1; sessionId: string; playerId: string; displayName: string; runId: string | null; expiresAt: number }
export interface HubGateway {
  exchange(token: string, nonce: string): Promise<HubContext>;
  context(sessionId: string, playerId: string, runId?: string, gameId?: string): Promise<HubContext>;
  activity(sessionId: string, playerId: string, eventId: string): Promise<unknown>;
}
const auth = new GoogleAuth();
export class RemoteHub implements HubGateway {
  private async request<T>(data: object): Promise<T> {
    const url = process.env.BETWEEN_TURNS_API_URL;
    if (!url) throw new Error('Hub API is not configured.');
    const parsed = new URL(url);
    const emulator = process.env.FUNCTIONS_EMULATOR === 'true';
    if (parsed.protocol !== 'https:' && !(emulator && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('Invalid hub API URL.');
    let body: { result: T; error?: { code: string; message: string } };
    if (emulator) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Emulator-App': 'rpg-rewards' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) });
      body = await response.json() as typeof body;
      if (!response.ok || body.error) throw new Error('Hub rejected the operation.');
    } else {
      const client = await auth.getIdTokenClient(url);
      body = (await client.request<typeof body>({ url, method: 'POST', data, timeout: 15000 })).data;
    }
    if (body.error) throw new Error('Hub rejected the operation.');
    return body.result;
  }
  exchange(token: string, nonce: string) { return this.request<HubContext>({ action: 'exchange', token, nonce }); }
  context(sessionId: string, playerId: string, runId?: string, gameId?: string) { return this.request<HubContext>({ action: 'context', sessionId, playerId, ...(runId ? { runId, gameId } : {}) }); }
  activity(sessionId: string, playerId: string, eventId: string) { return this.request({ action: 'activity', sessionId, playerId, eventId }); }
}
