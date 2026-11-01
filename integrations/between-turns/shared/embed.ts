export interface EmbedMessage { channel: 'between-turns'; version: 1; type: 'ready' | 'connected' | 'refresh' | 'error'; nonce: string; message?: string; }
export function acceptsEmbedMessage(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, expectedOrigin: string, expectedSource: MessageEventSource | null, nonce: string): event is MessageEvent<EmbedMessage> {
  const data = event.data;
  return !!expectedSource && event.source === expectedSource && event.origin === expectedOrigin && !!data && typeof data === 'object' && data.channel === 'between-turns' && data.version === 1 && data.nonce === nonce && ['ready', 'connected', 'refresh', 'error'].includes(data.type);
}
