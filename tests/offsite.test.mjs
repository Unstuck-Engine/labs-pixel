// c67.6 off-site mode: the snippet with data-demo-platform, running as the
// top-level page on a demo/tool platform, sends page views too, so the backend
// can open an Off-site visit. Everything else it never sent stays home.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPixel, waitFor, settle } from './harness.mjs';

describe('off-site mode (data-demo-platform)', () => {
  test('a hosted demo page sends its page_view, marked standalone with the platform and path', async () => {
    const px = loadPixel({
      url: 'https://app.storylane.io/share/abc123?ref=x',
      attrs: { 'data-demo-platform': 'storylane' },
    });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      const pv = px.events('page_view')[0].body;
      assert.equal(pv.standalone, true);
      assert.equal(pv.demo_platform, 'storylane');
      assert.equal(pv.demo_page_path, '/share/abc123?ref=x');
      assert.equal(pv.demo_id, 'abc123');
      assert.equal(pv.url, 'https://app.storylane.io/share/abc123?ref=x');
    } finally { px.close(); }
  });

  test('heartbeat, exit, custom and download events still never leave an off-site page', async () => {
    const px = loadPixel({
      url: 'https://app.storylane.io/share/abc123',
      attrs: { 'data-demo-platform': 'storylane' },
    });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      px.window.Unstuck.track('clicked', { a: 1 });
      px.window.dispatchEvent(new px.window.Event('pagehide'));
      px.window.document.dispatchEvent(new px.window.Event('visibilitychange'));
      await settle();
      const types = new Set(px.events().map((c) => c.body.event_type));
      for (const t of ['heartbeat', 'exit', 'custom', 'download', 'outbound_click']) {
        assert.equal(types.has(t), false, `${t} left the off-site page`);
      }
      assert.equal(types.has('page_view'), true);
    } finally { px.close(); }
  });

  test('identify still leaves an off-site page', async () => {
    const px = loadPixel({
      url: 'https://app.storylane.io/share/abc123',
      attrs: { 'data-demo-platform': 'storylane' },
    });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      px.window.Unstuck.identify('jane@acme.com');
      await waitFor(() => px.events('identify').length === 1);
      assert.equal(px.events('identify')[0].body.standalone, true);
    } finally { px.close(); }
  });

  test('without data-demo-platform the page view is not marked off-site', async () => {
    const px = loadPixel({ url: 'https://acme.com/demo' });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      const pv = px.events('page_view')[0].body;
      assert.equal(pv.standalone, undefined);
      assert.equal(pv.demo_platform, undefined);
    } finally { px.close(); }
  });
});
