import { acceptsEmbedMessage } from '../shared/embed';
import type { Grant } from '../shared/types';
import { command } from './client';
/** Mount once per game instance. Parent navigation only hides this element. */
export function mountEmbed(host: HTMLElement, options: { url: string; appId: string; sessionId: string; runId?: string; title: string; refresh: () => void; report: (message: string) => void }): () => void {
  const url = new URL(options.url); const nonce = crypto.randomUUID();
  url.searchParams.set('btVersion', '1'); url.searchParams.set('btNonce', nonce); url.searchParams.set('btParentOrigin', location.origin);
  const frame = document.createElement('iframe'); frame.title = options.title; frame.src = url.href;
  frame.referrerPolicy = 'no-referrer'; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.className = 'game-frame'; host.replaceChildren(frame);
  let disposed = false; let connecting = false; let connected = false;
  const timeout = window.setTimeout(() => { if (!connected) options.report(`${options.title} is taking longer than expected to connect. Try refreshing the page.`); }, 20_000);
  const onMessage = async (event: MessageEvent) => {
    if (!acceptsEmbedMessage(event, url.origin, frame.contentWindow, nonce) || disposed) return;
    if (event.data.type === 'ready' && !connecting) {
      // A frame reload creates a new protected child connection and requires a
      // fresh one-use grant even though this iframe element is preserved.
      connected = false;
      connecting = true;
      try {
        const grant = await command({ action: 'connect', appId: options.appId, sessionId: options.sessionId, ...(options.runId ? { runId: options.runId } : {}), nonce }) as Grant;
        if (!disposed) frame.contentWindow?.postMessage({ channel: 'between-turns', version: 1, type: 'connect', nonce, grant: grant.token, expiresAt: grant.expiresAt }, url.origin);
      } catch { options.report('The game connection could not be established. Please refresh to try again.'); }
      finally { connecting = false; }
    } else if (event.data.type === 'connected') { connected = true; window.clearTimeout(timeout); options.report(''); }
    else if (event.data.type === 'refresh') options.refresh();
    else if (event.data.type === 'error') options.report('The embedded application reported a connection problem.');
  };
  window.addEventListener('message', onMessage);
  return () => { disposed = true; window.clearTimeout(timeout); window.removeEventListener('message', onMessage); frame.remove(); };
}
