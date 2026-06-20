/**
 * Unstuck tracking script — v0 stub.
 *
 * Spec: https://github.com/Unstuck-Engine/product/blob/main/docs/specs/7.6-website-intent-signal-deanon.md
 * Companion spec (frontend): 7.6.1 (not yet authored) will replace this stub
 * with the full Snitcher-tracker-mirroring implementation: HEM hashing,
 * auto form/click/download tracking, fingerprint computation, vendor pixel
 * injection (Vector + Snitcher Radar), URL-param identify capture
 * (?u_email / ?u_eid / ?u_trait_*), consent gating, DNT respect.
 *
 * This v0 covers the minimum: __unstuck_vid cookie, session_id, page_view
 * event, Unstuck.identify(), Unstuck.track(), Unstuck.giveCookieConsent()
 * surface so customer code can install today and not break tomorrow.
 */
(function() {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var dataKey = script.getAttribute('data-key');
  if (!dataKey) {
    console.warn('[unstuck] missing data-key attribute on script tag');
    return;
  }

  var HOST = 'https://pixel.unstuckengine.com';
  var VID_COOKIE = '__unstuck_vid';
  var SID_KEY = '__unstuck_sid';
  var OPTOUT_COOKIE = '__unstuck_optout';

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + d.toUTCString() + '; path=/; SameSite=Lax';
  }
  function uuid() {
    return 'u-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }

  if (getCookie(OPTOUT_COOKIE) === '1') return;
  if (navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes') {
    // Spec 7.6 §C.3 default: respect DNT (override-able via data-respect-dnt="false")
    if (script.getAttribute('data-respect-dnt') !== 'false') return;
  }

  var vid = getCookie(VID_COOKIE);
  if (!vid) { vid = uuid(); setCookie(VID_COOKIE, vid, 365); }
  var sid = sessionStorage.getItem(SID_KEY);
  if (!sid) { sid = uuid(); sessionStorage.setItem(SID_KEY, sid); }

  function sendEvent(eventType, extra) {
    var body = {
      pixel_key: dataKey,
      visitor_id: vid,
      session_id: sid,
      event_type: eventType,
      url: location.href,
      referrer: document.referrer || undefined
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    try {
      fetch(HOST + '/v1/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(function() {});
    } catch (e) {}
  }

  // URL parameter capture (spec 7.6 §C.3) — ?u_email / ?u_eid / ?u_trait_*
  function captureUrlIdentify() {
    var params = new URLSearchParams(location.search);
    var email = params.get('u_email');
    var eid = params.get('u_eid');
    var emailValue = email;
    if (!emailValue && eid) {
      try { emailValue = atob(eid); } catch (e) {}
    }
    if (!emailValue) return;
    var traits = {};
    params.forEach(function(value, key) {
      if (key.indexOf('u_trait_') === 0) traits[key.slice(8)] = value;
    });
    sendEvent('identify', { email: emailValue, traits: traits });
    // Strip params from URL so they don't leak into analytics/referrers
    params.delete('u_email');
    params.delete('u_eid');
    Object.keys(traits).forEach(function(k) { params.delete('u_trait_' + k); });
    var search = params.toString();
    var newUrl = location.pathname + (search ? '?' + search : '') + location.hash;
    try { history.replaceState(null, '', newUrl); } catch (e) {}
  }
  captureUrlIdentify();

  // Call config-loader; if it tells us to inject vendor pixels, do it
  fetch(HOST + '/v1/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data_key: dataKey,
      vid: vid,
      sid: sid,
      url: location.href,
      referrer: document.referrer || undefined,
      ua: navigator.userAgent
    })
  }).then(function(r) { return r.json(); }).then(function(cfg) {
    // TODO (7.6.1): inject cfg.vendor_pixels — Vector needs
    //   window.vector = window.vector || {}; vector.partnerId = vp.partner_id;
    //   then load https://cdn.vector.co/pixel.js
    // and Snitcher Radar needs its own bootstrap.
    sendEvent('page_view');
  }).catch(function() { sendEvent('page_view'); });

  // Expose Unstuck.* API mirroring Snitcher's tracker (spec 7.6 §C.3)
  var queue = window.UnstuckQueue || [];
  window.Unstuck = window.Unstuck || {};
  window.Unstuck.identify = function(email, traits) {
    // TODO (7.6.1): client-side MD5 + SHA-256 of lower(email) → email_md5 + email_sha256
    sendEvent('identify', { email: email, traits: traits || {} });
  };
  window.Unstuck.track = function(eventName, properties) {
    sendEvent('custom', { event_name: eventName, properties: properties || {} });
  };
  window.Unstuck.page = function(properties) {
    sendEvent('page_view', properties ? { properties: properties } : undefined);
  };
  window.Unstuck.giveCookieConsent = function() {
    // TODO (7.6.1): flush queued events when wait-for-consent mode lands
  };
  // Flush any queued calls made before script loaded
  while (queue.length) {
    var call = queue.shift();
    var method = call[0], args = call.slice(1);
    if (window.Unstuck[method]) window.Unstuck[method].apply(null, args);
  }
})();
