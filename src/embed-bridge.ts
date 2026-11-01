export function acceptsConnection(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, origin: string, parent: MessageEventSource | null, nonce: string, now: number): boolean {
  const data = event.data;
  return !!parent && event.source === parent && event.origin === origin && !!data && typeof data === 'object'
    && data.channel === 'between-turns' && data.version === 1 && data.type === 'connect' && data.nonce === nonce
    && typeof data.grant === 'string' && data.grant.length > 0 && data.grant.length <= 1024
    && Number.isFinite(data.expiresAt) && data.expiresAt > now;
}
