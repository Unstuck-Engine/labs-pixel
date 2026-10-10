import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadPixel, waitFor, settle, HOST } from './harness.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const md5 = (s) => createHash('md5').update(s).digest('hex');
const configCalls = (px) => px.calls.filter((c) => c.url === `${HOST}/v1/config`);

describe('consent deferral (data-wait-for-consent="true")', () => {
  test('holds every event until giveCookieConsent(), then flushes them in order', async () => {
    const px = loadPixel({ attrs: { 'data-wait-for-consent': 'true' } });
    try {
      await waitFor(() => configCalls(px).length === 1);
      assert.equal(configCalls(px)[0].body.consent, 'absent');
      px.window.Unstuck.identify('held@acme.com');
      await settle();
      assert.equal(px.events().length, 0, 'nothing reaches /v1/events before consent');

      px.window.Unstuck.giveCookieConsent();
      await waitFor(() => px.events().length === 2);
      assert.deepEqual(px.events().map((c) => c.body.event_type).sort(), ['identify', 'page_view']);
      assert.equal(px.window.sessionStorage.getItem('__unstuck_consent'), '1');
    } finally { px.close(); }
  });

  test('consent given on an earlier page of the session is honoured without waiting', async () => {
    const px = loadPixel({
      attrs: { 'data-wait-for-consent': 'true' },
      session: { __unstuck_consent: '1' },
    });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      assert.equal(configCalls(px)[0].body.consent, 'granted');
    } finally { px.close(); }
  });

  test('a policy with wait_for_consent=false overrides the attribute', async () => {
    const px = loadPixel({ attrs: { 'data-wait-for-consent': 'true' }, policy: { wait_for_consent: false } });
    try {
      await waitFor(() => px.events('page_view').length === 1);
    } finally { px.close(); }
  });

  test('without the attribute, the page view is sent at once', async () => {
    const px = loadPixel();
    try {
      await waitFor(() => px.events('page_view').length === 1);
      assert.equal(px.events('page_view')[0].body.pixel_key, 'pk_test_123');
    } finally { px.close(); }
  });
});

describe('Do Not Track', () => {
  for (const value of ['1', 'yes']) {
    test(`navigator.doNotTrack="${value}" stops the pixel before any request`, async () => {
      const px = loadPixel({ doNotTrack: value, url: 'https://customer.example/?u_email=dnt@acme.com' });
      try {
        await settle();
        assert.equal(px.calls.length, 0, 'no /v1/config, no /v1/events');
        assert.equal(px.window.Unstuck, undefined, 'no public API is installed');
        assert.equal(px.window.document.cookie, '', 'no visitor cookie is set');
      } finally { px.close(); }
    });
  }

  test('data-respect-dnt="false" opts the site out of the DNT stop', async () => {
    const px = loadPixel({ doNotTrack: '1', attrs: { 'data-respect-dnt': 'false' } });
    try {
      await waitFor(() => px.events('page_view').length === 1);
    } finally { px.close(); }
  });

  test('navigator.doNotTrack="0" tracks normally', async () => {
    const px = loadPixel({ doNotTrack: '0' });
    try {
      await waitFor(() => px.events('page_view').length === 1);
    } finally { px.close(); }
  });
});

describe('u_* URL parameters', () => {
  test('u_email and u_trait_* identify the visitor, then leave the URL', async () => {
    const px = loadPixel({
      url: 'https://customer.example/demo?u_email=Jane.Doe%40Acme.com&u_trait_role=cto&u_trait_plan=pro&utm_source=news#pricing',
    });
    try {
      await waitFor(() => px.events('identify').length === 1);
      const body = px.events('identify')[0].body;
      assert.equal(body.email, 'jane.doe@acme.com');
      assert.equal(body.email_md5, md5('jane.doe@acme.com'));
      assert.equal(body.email_sha256, sha256('jane.doe@acme.com'));
      assert.deepEqual({ ...body.traits }, { role: 'cto', plan: 'pro' });
      assert.equal(px.window.location.search, '?utm_source=news', 'u_* stripped, other params kept');
      assert.equal(px.window.location.hash, '#pricing', 'fragment kept');
    } finally { px.close(); }
  });

  test('u_eid carries the email base64-encoded', async () => {
    const eid = Buffer.from('sam@example.org').toString('base64');
    const px = loadPixel({ url: `https://customer.example/?u_eid=${encodeURIComponent(eid)}` });
    try {
      await waitFor(() => px.events('identify').length === 1);
      assert.equal(px.events('identify')[0].body.email, 'sam@example.org');
      assert.equal(px.window.location.search, '');
    } finally { px.close(); }
  });

  test('u_email wins over u_eid when both are present', async () => {
    const eid = Buffer.from('other@example.org').toString('base64');
    const px = loadPixel({ url: `https://customer.example/?u_email=first%40example.org&u_eid=${encodeURIComponent(eid)}` });
    try {
      await waitFor(() => px.events('identify').length === 1);
      assert.equal(px.events('identify')[0].body.email, 'first@example.org');
    } finally { px.close(); }
  });

  test('traits without an email identify nobody and leave the URL alone', async () => {
    const px = loadPixel({ url: 'https://customer.example/?u_trait_role=cto' });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      await settle();
      assert.equal(px.events('identify').length, 0);
      assert.equal(px.window.location.search, '?u_trait_role=cto');
    } finally { px.close(); }
  });

  test('a value that is not an email identifies nobody', async () => {
    const px = loadPixel({ url: 'https://customer.example/?u_email=not-an-email' });
    try {
      await waitFor(() => px.events('page_view').length === 1);
      await settle();
      assert.equal(px.events('identify').length, 0);
    } finally { px.close(); }
  });
});

describe('identify goes over /v1/events', () => {
  test('Unstuck.identify() posts an identify event to /v1/events and nothing else', async () => {
    const px = loadPixel();
    try {
      await waitFor(() => px.events('page_view').length === 1);
      px.window.Unstuck.identify('  Sam@Example.org ', { company: 'Example' });
      await waitFor(() => px.events('identify').length === 1);
      const call = px.events('identify')[0];
      assert.equal(call.method, 'POST');
      assert.equal(call.body.pixel_key, 'pk_test_123');
      assert.equal(call.body.email, 'sam@example.org');
      assert.deepEqual({ ...call.body.traits }, { company: 'Example' });
      assert.equal(px.calls.filter((c) => c.url.includes('/v1/identify')).length, 0);
      assert.deepEqual(
        [...new Set(px.calls.map((c) => c.url))].sort(),
        [`${HOST}/v1/config`, `${HOST}/v1/events`],
      );
    } finally { px.close(); }
  });

  test('the same email twice sends one identify', async () => {
    const px = loadPixel();
    try {
      px.window.Unstuck.identify('dup@example.org');
      px.window.Unstuck.identify('DUP@example.org');
      await waitFor(() => px.events('identify').length === 1);
      await settle();
      assert.equal(px.events('identify').length, 1);
    } finally { px.close(); }
  });

  test('an identify queued before the script loaded goes over /v1/events', async () => {
    const px = loadPixel({ queue: [['identify', 'early@example.org', { source: 'queue' }]] });
    try {
      await waitFor(() => px.events('identify').length === 1);
      assert.equal(px.events('identify')[0].body.email, 'early@example.org');
      assert.equal(px.calls.filter((c) => c.url.includes('/v1/identify')).length, 0);
    } finally { px.close(); }
  });
});
