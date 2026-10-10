// Loads public/v1/p.js into a jsdom page the way a customer's site does: an
// inline <script data-key=...> so document.currentScript is set, with fetch
// stubbed so every request the pixel makes is recorded instead of sent.
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';

const PIXEL_SRC = readFileSync(new URL('../public/v1/p.js', import.meta.url), 'utf8');

export const HOST = 'https://pixel.unstuckengine.com';

// opts.url          page URL (query string included)
// opts.attrs        extra attributes on the script tag
// opts.policy       JSON body /v1/config answers with
// opts.doNotTrack   navigator.doNotTrack value
// opts.queue        window.UnstuckQueue calls made before the script loads
// opts.session      sessionStorage entries already present (an earlier page in the tab)
export function loadPixel(opts = {}) {
  const calls = [];
  const attrs = { 'data-key': 'pk_test_123', ...(opts.attrs || {}) };
  const attrText = Object.entries(attrs)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ');
  // Close the inline script safely if p.js ever contains the closing tag text.
  const src = PIXEL_SRC.replace(/<\/script/gi, '<\\/script');
  const virtualConsole = new VirtualConsole(); // swallow jsdom "not implemented" noise (canvas)
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><script ${attrText}>${src}</script></body></html>`,
    {
      url: opts.url || 'https://customer.example/pricing',
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window) {
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
        window.TextEncoder = TextEncoder;
        if (opts.doNotTrack !== undefined) {
          Object.defineProperty(window.navigator, 'doNotTrack', { value: opts.doNotTrack, configurable: true });
        }
        for (const [k, v] of Object.entries(opts.session || {})) window.sessionStorage.setItem(k, v);
        if (opts.queue) window.UnstuckQueue = opts.queue.map((c) => c.slice());
        window.fetch = (url, init = {}) => {
          let body = null;
          try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
          calls.push({ url: String(url), method: init.method || 'GET', body });
          const payload = String(url).endsWith('/v1/config') ? (opts.policy ?? {}) : { ok: true };
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
        };
      },
    },
  );
  const { window } = dom;
  return {
    window,
    calls,
    events: (type) => calls.filter((c) => c.url === `${HOST}/v1/events` && (!type || c.body?.event_type === type)),
    close: () => window.close(),
  };
}

// Resolves once predicate() is truthy; fails after timeoutMs. The pixel's
// sends sit behind a SHA-256 promise and the /v1/config round trip, so a fixed
// tick count would be fragile.
export async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Lets every pending promise and short timer settle, for asserting that
// something did NOT happen.
export function settle(ms = 150) {
  return new Promise((r) => setTimeout(r, ms));
}
