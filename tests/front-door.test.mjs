// c67.2 front door: the visitor cookie on the registrable domain, and the
// page's consent state in every request body.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from 'jsdom';
import { loadPixel, waitFor, HOST } from './harness.mjs';

const vidCookies = (jar, url) =>
  jar.getCookiesSync(url).filter((c) => c.key === '__unstuck_vid');
const configCalls = (px) => px.calls.filter((c) => c.url === `${HOST}/v1/config`);

describe('visitor cookie on the registrable domain', () => {
  test('www.acme.com writes the cookie on acme.com, so blog.acme.com is the same visitor', async () => {
    const px = loadPixel({ url: 'https://www.acme.com/pricing' });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      const [c] = vidCookies(px.cookieJar, 'https://www.acme.com/');
      assert.equal(c.domain, 'acme.com');
      assert.equal(c.hostOnly, false);
      assert.equal(vidCookies(px.cookieJar, 'https://blog.acme.com/').length, 1);
      assert.equal(px.events('page_view')[0].body.visitor_id, c.value);
    } finally { px.close(); }
  });

  test('a public suffix is never chosen: shop.acme.co.uk lands on acme.co.uk', async () => {
    const px = loadPixel({ url: 'https://shop.acme.co.uk/' });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      assert.equal(vidCookies(px.cookieJar, 'https://shop.acme.co.uk/')[0].domain, 'acme.co.uk');
    } finally { px.close(); }
  });

  test('a vercel.app site keeps its own host (vercel.app is a public suffix)', async () => {
    const px = loadPixel({ url: 'https://my-site.vercel.app/' });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      assert.equal(vidCookies(px.cookieJar, 'https://my-site.vercel.app/')[0].domain, 'my-site.vercel.app');
      assert.equal(vidCookies(px.cookieJar, 'https://other.vercel.app/').length, 0);
    } finally { px.close(); }
  });

  test('a host-only cookie from the previous script keeps its visitor id and moves to the domain', async () => {
    const jar = new CookieJar();
    jar.setCookieSync('__unstuck_vid=u-old-visitor; Path=/', 'https://www.acme.com/');
    const px = loadPixel({ url: 'https://www.acme.com/', cookieJar: jar });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      const cookies = vidCookies(px.cookieJar, 'https://www.acme.com/');
      assert.equal(cookies.length, 1, 'the host-only copy is gone');
      assert.equal(cookies[0].value, 'u-old-visitor');
      assert.equal(cookies[0].domain, 'acme.com');
      assert.equal(px.events('page_view')[0].body.visitor_id, 'u-old-visitor');
      assert.equal(px.window.document.cookie.includes('__unstuck_probe'), false, 'the probe cookie is removed');
    } finally { px.close(); }
  });

  test('an IP host keeps a host-only cookie', async () => {
    const px = loadPixel({ url: 'http://127.0.0.1/' });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      assert.equal(vidCookies(px.cookieJar, 'http://127.0.0.1/')[0].hostOnly, true);
    } finally { px.close(); }
  });
});

describe('consent in every request body', () => {
  test('absent until given, then granted on config and every event', async () => {
    const px = loadPixel();
    try {
      await waitFor(() => px.events('page_view').length === 1);
      assert.equal(configCalls(px)[0].body.consent, 'absent');
      assert.equal(px.events('page_view')[0].body.consent, 'absent');
      px.window.Unstuck.giveCookieConsent();
      px.window.Unstuck.track('clicked');
      await waitFor(() => px.events('custom').length === 1);
      assert.equal(px.events('custom')[0].body.consent, 'granted');
    } finally { px.close(); }
  });

  test('consent given earlier in the tab is sent on the first event', async () => {
    const px = loadPixel({ session: { __unstuck_consent: '1' } });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      assert.equal(px.events('page_view')[0].body.consent, 'granted');
    } finally { px.close(); }
  });
});
