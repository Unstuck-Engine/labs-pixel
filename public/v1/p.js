/**
 * Unstuck Website Intent tracking script — v1.
 *
 * Spec: product/docs/specs/7.6-website-intent-signal-deanon.md §C.3 +
 *       product/docs/specs/7.6.1-website-intent-frontend.md
 *
 * Loaded by the customer's pages via:
 *   <script async src="https://pixel.unstuckengine.com/v1/p.js"
 *           data-key="<pixel_key>"
 *           data-respect-dnt="true|false"
 *           data-wait-for-consent="true|false"></script>
 *
 * Responsibilities (single self-contained IIFE):
 *   1. Honour __unstuck_optout cookie + Do-Not-Track (default on) +
 *      wait-for-consent mode (queue events until giveCookieConsent()).
 *   2. Mint __unstuck_vid (365-day cookie) + __unstuck_sid (sessionStorage)
 *      + increment __unstuck_visit_count once per session.
 *   3. Compute a stable browser fingerprint (canvas + screen + tz + UA +
 *      languages → SHA-256 hex).
 *   4. Capture identify-by-URL: ?u_email= plain, ?u_eid= base64, ?u_trait_*=
 *      traits. Fires identify internally + strips the params.
 *   5. POST /v1/config with the request context; receives the policy
 *      payload (excluded_urls, page_scores, visit_count_scores,
 *      vendor_pixels, skip_vendors, wait_for_consent, ...).
 *   6. Inject vendor pixels per the policy: Snitcher Radar (always when
 *      available — free at load) + Vector (only when enrichment-decider
 *      gates it on). Vector's window.vector.partnerId is set BEFORE
 *      vector.load(pixel_id).
 *   7. Enforce excluded_urls — if the current URL matches, suppress
 *      page_view + vendor injection on this page.
 *   8. Compute client-side engagement score from page_scores +
 *      visit_count_scores; cache running total in sessionStorage; ship
 *      with every event in event_payload.engagement_score.
 *   9. Public Unstuck.* API mirroring Snitcher's tracker contract:
 *      identify(email, traits), track(eventName, properties),
 *      page(properties), giveCookieConsent().
 *  10. Auto-track: form submits (extract email field), downloads
 *      (.pdf/.doc/.xls/.zip), outbound clicks, popstate (SPA page-views).
 *
 * Embeds blueimp-md5 inline (~1.6 kB minified — public domain) so HEM
 * computation doesn't depend on a second network request. SHA-256 uses
 * the Web Crypto API.
 *
 * Auth: the receiving EFs (pixel-config-loader, pixel-events-ingest)
 * authenticate by pixel_key + Origin header, not bearer token.
 */
(function () {
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
  var VISIT_COUNT_COOKIE = '__unstuck_visit_count';
  var ENGAGEMENT_KEY = '__unstuck_engagement';
  var SESSION_FLAG_KEY = '__unstuck_session_counted';
  var CONSENT_FLAG_KEY = '__unstuck_consent';

  /* -------------------------------------------------------------- */
  /*  Cookie + storage helpers                                       */
  /* -------------------------------------------------------------- */

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie =
      name +
      '=' +
      encodeURIComponent(value) +
      '; expires=' +
      d.toUTCString() +
      '; path=/; SameSite=Lax';
  }
  function uuid() {
    return 'u-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }

  /* -------------------------------------------------------------- */
  /*  Privacy gates                                                  */
  /* -------------------------------------------------------------- */

  if (getCookie(OPTOUT_COOKIE) === '1') return;
  if (navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes') {
    if (script.getAttribute('data-respect-dnt') !== 'false') return;
  }

  var waitForConsentAttr = script.getAttribute('data-wait-for-consent') === 'true';
  var consentGranted = sessionStorage.getItem(CONSENT_FLAG_KEY) === '1';

  /* -------------------------------------------------------------- */
  /*  Visitor + session identifiers                                  */
  /* -------------------------------------------------------------- */

  var vid = getCookie(VID_COOKIE);
  if (!vid) {
    vid = uuid();
    setCookie(VID_COOKIE, vid, 365);
  }
  var sid = sessionStorage.getItem(SID_KEY);
  var freshSession = false;
  if (!sid) {
    sid = uuid();
    sessionStorage.setItem(SID_KEY, sid);
    freshSession = true;
  }
  if (freshSession && !sessionStorage.getItem(SESSION_FLAG_KEY)) {
    var prevVisitCount = parseInt(getCookie(VISIT_COUNT_COOKIE) || '0', 10) || 0;
    setCookie(VISIT_COUNT_COOKIE, String(prevVisitCount + 1), 365);
    sessionStorage.setItem(SESSION_FLAG_KEY, '1');
  }
  var visitCount = parseInt(getCookie(VISIT_COUNT_COOKIE) || '1', 10) || 1;

  /* -------------------------------------------------------------- */
  /*  blueimp-md5 — embedded (public domain).                        */
  /*  https://github.com/blueimp/JavaScript-MD5                       */
  /* -------------------------------------------------------------- */

  /* eslint-disable */
  var md5 = (function () {
    function safe_add(x, y) {
      var lsw = (x & 0xffff) + (y & 0xffff);
      var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
      return (msw << 16) | (lsw & 0xffff);
    }
    function bit_rol(num, cnt) {
      return (num << cnt) | (num >>> (32 - cnt));
    }
    function md5_cmn(q, a, b, x, s, t) {
      return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s), b);
    }
    function md5_ff(a, b, c, d, x, s, t) {
      return md5_cmn((b & c) | (~b & d), a, b, x, s, t);
    }
    function md5_gg(a, b, c, d, x, s, t) {
      return md5_cmn((b & d) | (c & ~d), a, b, x, s, t);
    }
    function md5_hh(a, b, c, d, x, s, t) {
      return md5_cmn(b ^ c ^ d, a, b, x, s, t);
    }
    function md5_ii(a, b, c, d, x, s, t) {
      return md5_cmn(c ^ (b | ~d), a, b, x, s, t);
    }
    function binl_md5(x, len) {
      x[len >> 5] |= 0x80 << len % 32;
      x[(((len + 64) >>> 9) << 4) + 14] = len;
      var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
      for (var i = 0; i < x.length; i += 16) {
        var olda = a, oldb = b, oldc = c, oldd = d;
        a = md5_ff(a, b, c, d, x[i], 7, -680876936);
        d = md5_ff(d, a, b, c, x[i + 1], 12, -389564586);
        c = md5_ff(c, d, a, b, x[i + 2], 17, 606105819);
        b = md5_ff(b, c, d, a, x[i + 3], 22, -1044525330);
        a = md5_ff(a, b, c, d, x[i + 4], 7, -176418897);
        d = md5_ff(d, a, b, c, x[i + 5], 12, 1200080426);
        c = md5_ff(c, d, a, b, x[i + 6], 17, -1473231341);
        b = md5_ff(b, c, d, a, x[i + 7], 22, -45705983);
        a = md5_ff(a, b, c, d, x[i + 8], 7, 1770035416);
        d = md5_ff(d, a, b, c, x[i + 9], 12, -1958414417);
        c = md5_ff(c, d, a, b, x[i + 10], 17, -42063);
        b = md5_ff(b, c, d, a, x[i + 11], 22, -1990404162);
        a = md5_ff(a, b, c, d, x[i + 12], 7, 1804603682);
        d = md5_ff(d, a, b, c, x[i + 13], 12, -40341101);
        c = md5_ff(c, d, a, b, x[i + 14], 17, -1502002290);
        b = md5_ff(b, c, d, a, x[i + 15], 22, 1236535329);
        a = md5_gg(a, b, c, d, x[i + 1], 5, -165796510);
        d = md5_gg(d, a, b, c, x[i + 6], 9, -1069501632);
        c = md5_gg(c, d, a, b, x[i + 11], 14, 643717713);
        b = md5_gg(b, c, d, a, x[i], 20, -373897302);
        a = md5_gg(a, b, c, d, x[i + 5], 5, -701558691);
        d = md5_gg(d, a, b, c, x[i + 10], 9, 38016083);
        c = md5_gg(c, d, a, b, x[i + 15], 14, -660478335);
        b = md5_gg(b, c, d, a, x[i + 4], 20, -405537848);
        a = md5_gg(a, b, c, d, x[i + 9], 5, 568446438);
        d = md5_gg(d, a, b, c, x[i + 14], 9, -1019803690);
        c = md5_gg(c, d, a, b, x[i + 3], 14, -187363961);
        b = md5_gg(b, c, d, a, x[i + 8], 20, 1163531501);
        a = md5_gg(a, b, c, d, x[i + 13], 5, -1444681467);
        d = md5_gg(d, a, b, c, x[i + 2], 9, -51403784);
        c = md5_gg(c, d, a, b, x[i + 7], 14, 1735328473);
        b = md5_gg(b, c, d, a, x[i + 12], 20, -1926607734);
        a = md5_hh(a, b, c, d, x[i + 5], 4, -378558);
        d = md5_hh(d, a, b, c, x[i + 8], 11, -2022574463);
        c = md5_hh(c, d, a, b, x[i + 11], 16, 1839030562);
        b = md5_hh(b, c, d, a, x[i + 14], 23, -35309556);
        a = md5_hh(a, b, c, d, x[i + 1], 4, -1530992060);
        d = md5_hh(d, a, b, c, x[i + 4], 11, 1272893353);
        c = md5_hh(c, d, a, b, x[i + 7], 16, -155497632);
        b = md5_hh(b, c, d, a, x[i + 10], 23, -1094730640);
        a = md5_hh(a, b, c, d, x[i + 13], 4, 681279174);
        d = md5_hh(d, a, b, c, x[i], 11, -358537222);
        c = md5_hh(c, d, a, b, x[i + 3], 16, -722521979);
        b = md5_hh(b, c, d, a, x[i + 6], 23, 76029189);
        a = md5_hh(a, b, c, d, x[i + 9], 4, -640364487);
        d = md5_hh(d, a, b, c, x[i + 12], 11, -421815835);
        c = md5_hh(c, d, a, b, x[i + 15], 16, 530742520);
        b = md5_hh(b, c, d, a, x[i + 2], 23, -995338651);
        a = md5_ii(a, b, c, d, x[i], 6, -198630844);
        d = md5_ii(d, a, b, c, x[i + 7], 10, 1126891415);
        c = md5_ii(c, d, a, b, x[i + 14], 15, -1416354905);
        b = md5_ii(b, c, d, a, x[i + 5], 21, -57434055);
        a = md5_ii(a, b, c, d, x[i + 12], 6, 1700485571);
        d = md5_ii(d, a, b, c, x[i + 3], 10, -1894986606);
        c = md5_ii(c, d, a, b, x[i + 10], 15, -1051523);
        b = md5_ii(b, c, d, a, x[i + 1], 21, -2054922799);
        a = md5_ii(a, b, c, d, x[i + 8], 6, 1873313359);
        d = md5_ii(d, a, b, c, x[i + 15], 10, -30611744);
        c = md5_ii(c, d, a, b, x[i + 6], 15, -1560198380);
        b = md5_ii(b, c, d, a, x[i + 13], 21, 1309151649);
        a = md5_ii(a, b, c, d, x[i + 4], 6, -145523070);
        d = md5_ii(d, a, b, c, x[i + 11], 10, -1120210379);
        c = md5_ii(c, d, a, b, x[i + 2], 15, 718787259);
        b = md5_ii(b, c, d, a, x[i + 9], 21, -343485551);
        a = safe_add(a, olda);
        b = safe_add(b, oldb);
        c = safe_add(c, oldc);
        d = safe_add(d, oldd);
      }
      return [a, b, c, d];
    }
    function binl2rstr(input) {
      var output = '';
      for (var i = 0; i < input.length * 32; i += 8) {
        output += String.fromCharCode((input[i >> 5] >>> i % 32) & 0xff);
      }
      return output;
    }
    function rstr2binl(input) {
      var output = [];
      output[(input.length >> 2) - 1] = undefined;
      for (var i = 0; i < output.length; i += 1) output[i] = 0;
      for (var j = 0; j < input.length * 8; j += 8) {
        output[j >> 5] |= (input.charCodeAt(j / 8) & 0xff) << j % 32;
      }
      return output;
    }
    function rstr_md5(s) {
      return binl2rstr(binl_md5(rstr2binl(s), s.length * 8));
    }
    function str2rstr_utf8(input) {
      return unescape(encodeURIComponent(input));
    }
    function rstr2hex(input) {
      var hex_tab = '0123456789abcdef';
      var output = '';
      for (var i = 0; i < input.length; i += 1) {
        var x = input.charCodeAt(i);
        output += hex_tab.charAt((x >>> 4) & 0x0f) + hex_tab.charAt(x & 0x0f);
      }
      return output;
    }
    return function (string) {
      return rstr2hex(rstr_md5(str2rstr_utf8(string)));
    };
  })();
  /* eslint-enable */

  /* -------------------------------------------------------------- */
  /*  Hashing helpers                                                */
  /* -------------------------------------------------------------- */

  function sha256Hex(input) {
    if (!input) return Promise.resolve(null);
    var buf = new TextEncoder().encode(input);
    if (!crypto || !crypto.subtle) return Promise.resolve(null);
    return crypto.subtle.digest('SHA-256', buf).then(function (h) {
      var bytes = new Uint8Array(h);
      var out = '';
      for (var i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
      }
      return out;
    }).catch(function () { return null; });
  }

  /* -------------------------------------------------------------- */
  /*  Fingerprint                                                    */
  /* -------------------------------------------------------------- */

  function canvasSignature() {
    try {
      var c = document.createElement('canvas');
      c.width = 200; c.height = 50;
      var ctx = c.getContext('2d');
      if (!ctx) return '';
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 200, 50);
      ctx.fillStyle = '#069';
      ctx.fillText('unstuck:fp', 2, 2);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('unstuck:fp', 4, 17);
      return c.toDataURL();
    } catch (e) {
      return '';
    }
  }

  function fingerprintInput() {
    var screenSig = [
      screen.width, screen.height, screen.colorDepth || screen.pixelDepth || ''
    ].join('x');
    var tz = '';
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {}
    var langs = '';
    try {
      langs = (navigator.languages && navigator.languages.join(',')) || navigator.language || '';
    } catch (e) {}
    return [
      canvasSignature(),
      screenSig,
      tz,
      navigator.userAgent || '',
      langs,
    ].join('||');
  }

  /* -------------------------------------------------------------- */
  /*  URL pattern match — mirrors backend rule kinds                 */
  /* -------------------------------------------------------------- */

  function urlMatches(url, rule) {
    if (!rule || !rule.pattern) return false;
    switch (rule.kind) {
      case 'starts_with':
        return url.indexOf(rule.pattern) === 0;
      case 'regex':
        try { return new RegExp(rule.pattern).test(url); } catch (e) { return false; }
      case 'contains':
      default:
        return url.indexOf(rule.pattern) !== -1;
    }
  }

  function isExcluded(url, excludedUrls) {
    if (!excludedUrls || !excludedUrls.length) return false;
    for (var i = 0; i < excludedUrls.length; i++) {
      if (urlMatches(url, excludedUrls[i])) return true;
    }
    return false;
  }

  function highestPageScore(url, pageScores) {
    if (!pageScores || !pageScores.length) return 0;
    var best = 0;
    for (var i = 0; i < pageScores.length; i++) {
      var rule = pageScores[i];
      if (urlMatches(url, rule)) {
        var n = Number(rule.score) || 0;
        if (Math.abs(n) > Math.abs(best)) best = n;
      }
    }
    return best;
  }

  function visitCountBonus(visitCountScores, visitCountVal) {
    if (!visitCountScores || !visitCountScores.length) return 0;
    var bonus = 0;
    for (var i = 0; i < visitCountScores.length; i++) {
      var rule = visitCountScores[i];
      var min = Number(rule.min_visits) || 0;
      var n = Number(rule.score) || 0;
      if (visitCountVal >= min) bonus = n;
    }
    return bonus;
  }

  /* -------------------------------------------------------------- */
  /*  Engagement score (per-session running total)                   */
  /* -------------------------------------------------------------- */

  function getEngagement() {
    var raw = sessionStorage.getItem(ENGAGEMENT_KEY);
    var n = parseFloat(raw);
    return isFinite(n) ? n : 0;
  }
  function setEngagement(value) {
    sessionStorage.setItem(ENGAGEMENT_KEY, String(value));
  }

  /* -------------------------------------------------------------- */
  /*  Event sender                                                   */
  /* -------------------------------------------------------------- */

  var eventQueue = [];
  var policy = null; // populated by /v1/config response
  // Persisted fingerprint hash for this session. Computed once during
  // bootstrap and shipped on every /v1/events POST so the backend can
  // persist it on clickstream_events — required for the cross-customer
  // cache key to actually work (was previously NULL on every clickstream
  // row, breaking the moat).
  var fingerprintHash = null;

  // Script-side country fallback. Vercel rewrites to external URLs
  // don't forward x-vercel-ip-* headers, so the EF can't read country
  // from edge geo. We send what we can detect client-side via
  // navigator.language ("en-US" -> "US"). Less accurate than IP-geo
  // (a US user with UK browser settings reads as GB) but good enough
  // to gate Vector + RB2B, both US-person-only vendors.
  function detectCountryFromBrowser() {
    try {
      var langs = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language];
      for (var i = 0; i < langs.length; i++) {
        var l = langs[i];
        if (!l) continue;
        var parts = l.split('-');
        if (parts.length >= 2 && parts[1].length === 2) {
          return parts[1].toUpperCase();
        }
      }
    } catch (e) {}
    return null;
  }
  var browserCountry = detectCountryFromBrowser();

  // Bot-classification signals for the backend classifier. navigator.webdriver
  // is the single strongest headless tell (near-zero false positives); screen
  // dims catch headless that spoofs a real UA (0x0 / 1x1 are pure automation
  // artifacts). The EF treats both as optional inputs.
  var isWebdriver = false;
  try { isWebdriver = navigator.webdriver === true; } catch (e) {}
  var screenW = null, screenH = null;
  try {
    if (window.screen) {
      screenW = window.screen.width || null;
      screenH = window.screen.height || null;
    }
  } catch (e) {}

  function shouldHold() {
    if (!waitForConsentAttr) return false;
    if (policy && policy.wait_for_consent === false) return false;
    return !consentGranted;
  }

  function rawSend(eventType, extra) {
    var body = {
      pixel_key: dataKey,
      visitor_id: vid,
      session_id: sid,
      event_type: eventType,
      url: location.href,
      referrer: document.referrer || undefined,
      visit_count: visitCount,
      engagement_score: getEngagement(),
      fingerprint_hash: fingerprintHash,
      browser_country: browserCountry,
      webdriver: isWebdriver,
      screen_w: screenW,
      screen_h: screenH,
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
      }
    }
    try {
      fetch(HOST + '/v1/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  function sendEvent(eventType, extra) {
    if (shouldHold()) {
      eventQueue.push([eventType, extra]);
      return;
    }
    rawSend(eventType, extra);
  }

  function flushQueue() {
    while (eventQueue.length) {
      var entry = eventQueue.shift();
      rawSend(entry[0], entry[1]);
    }
  }

  /* -------------------------------------------------------------- */
  /*  Vendor pixel injection                                         */
  /* -------------------------------------------------------------- */

  var injectedVendors = {};

  function injectVendor(vp) {
    if (!vp || !vp.name || injectedVendors[vp.name]) return;
    injectedVendors[vp.name] = true;
    if (vp.name === 'vector') {
      try {
        window.vector = window.vector || {};
        window.vector.partnerId = vp.partner_id || (vp.partnerId || '');
        var s = document.createElement('script');
        s.async = true;
        s.src = 'https://cdn.vector.co/pixel.js';
        s.onload = function () {
          try {
            if (window.vector && typeof window.vector.load === 'function') {
              window.vector.load(vp.pixel_id);
            }
          } catch (e) {}
        };
        document.head.appendChild(s);
      } catch (e) {}
    } else if (vp.name === 'snitcher_radar') {
      try {
        window.snitcher = window.snitcher || {};
        window.snitcher.partnerId = vp.partner_id || '';
        var rs = document.createElement('script');
        rs.async = true;
        rs.src =
          'https://radar.snitcher.com/script/radar.js?id=' +
          encodeURIComponent(vp.pixel_id || '');
        rs.onload = function () {
          // Snitcher Radar exposes a session_uuid we forward to the
          // backend so vendor-merge-worker can call /company/find
          // server-side later. Poll up to 5s for the global to appear.
          var tries = 0;
          var pollId = setInterval(function () {
            tries++;
            var sessionUuid =
              (window.snitcher &&
                (window.snitcher.sessionId || window.snitcher.session_uuid)) ||
              null;
            if (sessionUuid) {
              clearInterval(pollId);
              sendEvent('snitcher_session_captured', {
                snitcher_session_uuid: sessionUuid,
              });
            } else if (tries >= 25) {
              clearInterval(pollId);
            }
          }, 200);
        };
        document.head.appendChild(rs);
      } catch (e) {}
    }
  }

  function injectAll(vendorPixels) {
    if (!vendorPixels || !vendorPixels.length) return;
    for (var i = 0; i < vendorPixels.length; i++) injectVendor(vendorPixels[i]);
  }

  /* -------------------------------------------------------------- */
  /*  URL-param identify capture                                     */
  /* -------------------------------------------------------------- */

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
    params.forEach(function (value, key) {
      if (key.indexOf('u_trait_') === 0) traits[key.slice(8)] = value;
    });
    publicIdentify(emailValue, traits);
    params.delete('u_email');
    params.delete('u_eid');
    Object.keys(traits).forEach(function (k) { params.delete('u_trait_' + k); });
    var search = params.toString();
    var newUrl = location.pathname + (search ? '?' + search : '') + location.hash;
    try { history.replaceState(null, '', newUrl); } catch (e) {}
  }

  /* -------------------------------------------------------------- */
  /*  Public API + identify (HEM hashing)                            */
  /* -------------------------------------------------------------- */

  function publicIdentify(email, traits) {
    if (!email) return;
    var lower = String(email).trim().toLowerCase();
    if (!lower) return;
    var emailMd5 = md5(lower);
    sha256Hex(lower).then(function (emailSha256) {
      sendEvent('identify', {
        email: lower,
        email_md5: emailMd5,
        email_sha256: emailSha256,
        traits: traits || {},
      });
    });
  }

  /* -------------------------------------------------------------- */
  /*  Engagement score reapply on every page-view                    */
  /* -------------------------------------------------------------- */

  function applyPageEngagement(url) {
    if (!policy) return;
    var page = highestPageScore(url, policy.page_scores);
    var bonus = visitCountBonus(policy.visit_count_scores, visitCount);
    var total = getEngagement() + page + bonus;
    setEngagement(total);
  }

  /* -------------------------------------------------------------- */
  /*  Bootstrap                                                      */
  /* -------------------------------------------------------------- */

  captureUrlIdentify();

  // Fingerprint runs synchronously enough to be ready by the /v1/config
  // call. The promise lets us continue without blocking if Web Crypto is
  // missing — we just send a null fingerprint. Stash on module scope so
  // every subsequent rawSend() ships it on /v1/events too.
  sha256Hex(fingerprintInput()).then(function (fpHash) {
    fingerprintHash = fpHash;
    return fetch(HOST + '/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data_key: dataKey,
        vid: vid,
        sid: sid,
        fingerprint_hash: fpHash,
        ua: navigator.userAgent,
        url: location.href,
        referrer: document.referrer || undefined,
        opt_out: false,
        consent: consentGranted ? 'granted' : 'absent',
        browser_country: browserCountry,
        webdriver: isWebdriver,
        screen_w: screenW,
        screen_h: screenH,
      }),
    });
  }).then(function (r) { return r.json(); }).then(function (cfg) {
    policy = cfg || {};

    // Excluded URL → suppress everything for this page.
    if (isExcluded(location.href, policy.excluded_urls)) return;

    applyPageEngagement(location.href);

    if (!policy.skip_vendors) injectAll(policy.vendor_pixels);

    sendEvent('page_view');
  }).catch(function () {
    sendEvent('page_view');
  });

  /* -------------------------------------------------------------- */
  /*  Public Unstuck.* API                                           */
  /* -------------------------------------------------------------- */

  var queue = window.UnstuckQueue || [];
  window.Unstuck = window.Unstuck || {};
  window.Unstuck.identify = publicIdentify;
  window.Unstuck.track = function (eventName, properties) {
    sendEvent('custom', { event_name: eventName, properties: properties || {} });
  };
  window.Unstuck.page = function (properties) {
    if (policy && isExcluded(location.href, policy.excluded_urls)) return;
    applyPageEngagement(location.href);
    sendEvent('page_view', properties ? { properties: properties } : undefined);
  };
  window.Unstuck.giveCookieConsent = function () {
    consentGranted = true;
    try { sessionStorage.setItem(CONSENT_FLAG_KEY, '1'); } catch (e) {}
    flushQueue();
  };

  // Flush calls queued before this script loaded.
  while (queue.length) {
    var call = queue.shift();
    var method = call[0];
    var args = call.slice(1);
    if (typeof window.Unstuck[method] === 'function') {
      window.Unstuck[method].apply(null, args);
    }
  }

  /* -------------------------------------------------------------- */
  /*  Auto-tracking: form submit / download / outbound / SPA         */
  /* -------------------------------------------------------------- */

  var DOWNLOAD_EXT = /\.(pdf|doc|docx|xls|xlsx|zip|csv|ppt|pptx)(\?|$)/i;

  document.addEventListener('submit', function (ev) {
    try {
      var form = ev.target;
      if (!form || form.nodeName !== 'FORM') return;
      var emailInput = form.querySelector('input[type="email"], input[name*="email" i]');
      var emailValue = emailInput ? emailInput.value : '';
      if (emailValue && emailValue.indexOf('@') !== -1) {
        publicIdentify(emailValue, { source: 'form_fill', form_id: form.id || null });
      } else {
        sendEvent('form_submit', { form_id: form.id || null });
      }
    } catch (e) {}
  }, true);

  document.addEventListener('click', function (ev) {
    try {
      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      if (!a || !a.href) return;
      var href = a.href;
      if (DOWNLOAD_EXT.test(href)) {
        sendEvent('download', { href: href });
        return;
      }
      var host = '';
      try { host = new URL(href).host; } catch (e) {}
      if (host && host !== location.host) {
        sendEvent('outbound_click', { href: href, host: host });
      }
    } catch (e) {}
  }, true);

  // SPA page-view tracking via popstate + pushState/replaceState wrap.
  function spaPageView() {
    if (policy && isExcluded(location.href, policy.excluded_urls)) return;
    applyPageEngagement(location.href);
    sendEvent('page_view', { spa: true });
  }
  window.addEventListener('popstate', spaPageView);
  ['pushState', 'replaceState'].forEach(function (method) {
    var original = history[method];
    if (typeof original !== 'function') return;
    history[method] = function () {
      var result = original.apply(this, arguments);
      setTimeout(spaPageView, 0);
      return result;
    };
  });
})();
