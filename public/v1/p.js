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
 *  11. Demo engagement detection: recognise interactive-demo and
 *      demo-video embeds on the page (Storylane, Navattic, Supademo,
 *      Arcade, Wistia, ...), subscribe to the cross-frame events those
 *      platforms broadcast out of their iframes, and report
 *      demo_view / demo_progress / demo_complete / demo_lead_captured
 *      separately from page_view. The pixel never enters the demo
 *      iframe — that is blocked cross-origin on every platform. Every
 *      demo event ships human_interaction so the backend can discard
 *      email-security-scanner detonations (Defender Safe Links,
 *      Mimecast, Proofpoint all render pages with a real JS engine).
 *  12. DEMO MODE (data-demo-platform): the same file, pasted into a demo
 *      platform's own custom-code slot, so it runs ON the hosted demo
 *      page (app.storylane.io/share/<id>, app.arcade.software/share/<id>,
 *      ...). That page is off-site, so its events are Demo Viewed's, not
 *      Website Intent's, and they ship standalone:true for the backend to
 *      route on. Self-gated to the top-level document — see the block at
 *      the top of the IIFE.
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

  /* -------------------------------------------------------------- */
  /*  Demo mode — the hosted-demo pixel                              */
  /* -------------------------------------------------------------- */
  //
  // The snippet a customer pastes into their demo platform:
  //
  //   <script async src="https://pixel.unstuckengine.com/v1/p.js"
  //           data-key="<PIXEL_KEY>" data-demo-platform="storylane"></script>
  //
  // 8 of the 14 surveyed demo platforms let a customer inject arbitrary
  // JS into the page THEY host, which beats the per-provider webhook on
  // both axes: 66% of demos are ungated (no email for a webhook to
  // carry), and webhook access is tier-gated (Arcade's is Enterprise-
  // only). Running our own pixel there gets the full identity waterfall
  // at person level rather than the platform's account reveal.
  //
  // The platform is SELF-DECLARED and never inferred from the origin.
  // 11 of 14 platforms support custom domains, so demo.customer.com can
  // front any of them, and Reprise keeps its platform origin and the
  // custom one live for the SAME demo simultaneously. Origin stays an
  // auth gate on the backend (pixel_configs.config.demo_origins); it is
  // not the router.
  var demoPlatform = null;
  try {
    var demoPlatformAttr = script.getAttribute('data-demo-platform');
    if (demoPlatformAttr) {
      demoPlatform = String(demoPlatformAttr).trim().toLowerCase().slice(0, 64) || null;
    }
  } catch (e) {}
  var demoMode = !!demoPlatform;

  // The self-gate, and the reason a customer never has to keep two
  // copies of a demo. Every one of these platforms serves the same page
  // for the hosted share link and for the <iframe> a customer embeds on
  // their own site — Supademo uses an identical origin AND path for
  // both, so nothing in the URL can tell them apart. Being the top-level
  // document can: only the hosted case is off-site.
  //
  // Framed => this page belongs to the customer's own site, their own
  // pixel already reports the visit, and this copy does nothing at all —
  // no demo events, no page_view, not even a /v1/config call. That makes
  // double-counting impossible rather than merely unlikely.
  var isTopLevel = true;
  try {
    isTopLevel = window.self === window.top;
  } catch (e) {
    isTopLevel = false; // cross-origin parent — we are framed
  }
  if (demoMode && !isTopLevel) return;

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

  // UTM capture — first-touch per session. Parsed from the landing URL once,
  // persisted in sessionStorage so SPA navigation (which strips the query
  // string) doesn't lose attribution. Sent with every event as body.utm;
  // pixel-events-ingest already writes utm_source/... columns from it.
  var UTM_KEY = '__unstuck_utm';
  var sessionUtm = null;
  try {
    sessionUtm = JSON.parse(sessionStorage.getItem(UTM_KEY) || 'null');
    if (!sessionUtm) {
      var usp = new URLSearchParams(location.search);
      var u = {};
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
        var v = usp.get(k);
        if (v) u[k] = v;
      });
      if (Object.keys(u).length) {
        sessionUtm = u;
        sessionStorage.setItem(UTM_KEY, JSON.stringify(u));
      }
    }
  } catch (e) {}

  // Demo mode ships a deliberately narrow event vocabulary. The page
  // belongs to the demo platform, so page_view / heartbeat / exit /
  // download / outbound_click would all land in clickstream_events
  // against app.storylane.io and score as if the customer owned that
  // page. Only the demo events and `identify` — which the identity
  // waterfall runs on — leave a hosted demo page.
  var DEMO_MODE_EVENTS = {
    demo_view: 1,
    demo_progress: 1,
    demo_complete: 1,
    demo_lead_captured: 1,
    identify: 1
  };

  // Hosted-demo id, read from the URL. `Referer` will never carry it:
  // none of these hosts sets Referrer-Policy, so the browser default
  // strict-origin-when-cross-origin sends the origin and drops the path.
  // The script therefore reads location itself and ships the raw path
  // too, so the backend can re-derive if a pattern below is wrong.
  //
  //   storylane  app.storylane.io/share/<id>
  //   arcade     app.arcade.software/share/<id>
  //   supademo   app.supademo.com/demo/<id>
  //   consensus  play.goconsensus.com/<id>
  //   reprise    app.getreprise.com/launch/<id>/
  //   demoboost  app.demoboost.com/playback/<8char>
  //   vidyard    share.vidyard.com/watch/<id>, <sub>.hubs.vidyard.com/...
  //   walnut     app.teamwalnut.com/demo/?demoId=<uuid>  <- query, not path
  //
  // Every one of these except Walnut is "last meaningful path segment",
  // which parseDemoId() already computes for the embed path.
  function demoPagePath() {
    try {
      return (location.pathname || '/') + (location.search || '');
    } catch (e) {
      return null;
    }
  }
  function demoModeId() {
    try {
      if (demoPlatform === 'walnut') {
        var params = new URLSearchParams(location.search);
        var walnutId = params.get('demoId') || params.get('demoid');
        if (walnutId) return String(walnutId).slice(0, 128);
      }
      return parseDemoId(location.href);
    } catch (e) {
      return null;
    }
  }

  function rawSend(eventType, extra) {
    if (demoMode && !DEMO_MODE_EVENTS[eventType]) return;
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
      utm: sessionUtm || undefined,
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
      }
    }
    if (demoMode) {
      // standalone:true is what the backend routes on — with
      // demo_platform it means "off-site demo page", so the event goes
      // to demo_events (Demo Viewed) instead of clickstream_events
      // (Website Intent). The declared platform wins over anything
      // inferred, and the URL-derived id wins over a platform-supplied
      // one so every event in a session carries the SAME demo_id; the
      // backend's synthesised idempotency key depends on that.
      body.demo_platform = demoPlatform;
      body.demo_page_path = demoPagePath();
      body.standalone = true;
      var urlDemoId = demoModeId();
      if (urlDemoId) body.demo_id = urlDemoId;
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
        // Real Radar loader contract (docs.snitcher.com -> powered-by-snitcher/
        // radar/installation): a command-queue stub on window[namespace], then
        // radar.min.js (loaded from the CDN) reads config from the script tag's
        // data-settings attribute. The previous /script/radar.js?id= URL and
        // window.snitcher.sessionId polling were guesses -- no such endpoints
        // exist. Session correlation happens via the unstuck_link custom event
        // below: the per-session webhook payload carries it inside events[],
        // and vendor-webhook-snitcher digs out "<customer_id>|<vid>".
        var rSettings = {
          cdn: 'cdn.snitcher.com',
          apiEndpoint: 'radar.snitcher.com',
          profileId: vp.pixel_id || '',
          namespace: 'UnstuckRadar',
          waitForConsent: false,
          features: { formTracking: true },
        };
        var rq = window.UnstuckRadar;
        if (!rq || (!rq._loaded && !rq.initialized)) {
          rq = window.UnstuckRadar = window.UnstuckRadar || [];
          rq._loaded = true;
          var rMethods = ['track', 'page', 'identify', 'group', 'alias',
            'ready', 'on', 'off', 'once', 'register', 'reset',
            'giveCookieConsent', 'pageview'];
          for (var ri = 0; ri < rMethods.length; ri++) {
            (function (m) {
              rq[m] = function () {
                var args = [].slice.call(arguments);
                args.unshift(m);
                rq.push(args);
                return rq;
              };
            })(rMethods[ri]);
          }
          var rs = document.createElement('script');
          rs.async = true;
          rs.type = 'text/javascript';
          rs.id = '__radar__';
          rs.dataset.settings = JSON.stringify(rSettings);
          rs.src = 'https://' + rSettings.cdn + '/releases/latest/radar.min.js';
          document.head.appendChild(rs);
          rq.track('unstuck_link', { unstuck: vp.partner_id || '' });
        }
      } catch (e) {}
    } else if (vp.name === 'knock2' || vp.name === 'leadpipe') {
      try {
        // Person-level identification vendors that inject a plain async
        // script (pixel_id carries the vendor's script URL). Identifications
        // arrive server-side: knock2 via webhook, leadpipe via poll cron.
        var ks = document.createElement('script');
        ks.async = true;
        ks.src = vp.pixel_id || '';
        if (ks.src) document.head.appendChild(ks);
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

  var lastIdentifiedEmail = null;
  function publicIdentify(email, traits) {
    if (!email) return;
    var lower = String(email).trim().toLowerCase();
    if (!lower || lower.indexOf('@') < 1) return;
    if (lower === lastIdentifiedEmail) return; // dedup: form_field change + submit both fire
    lastIdentifiedEmail = lower;
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
        // Tells pixel-config-loader to gate this request on
        // config.demo_origins instead of allowed_origins — a hosted demo
        // page is on the platform's origin, which allowed_origins can
        // never contain.
        demo_platform: demoPlatform,
      }),
    });
  }).then(function (r) { return r.json(); }).then(function (cfg) {
    policy = cfg || {};

    // Demo detection gates on the policy (demo.enabled, demo.hosts,
    // excluded_urls), so release its buffered events and re-scan now that
    // any backend-supplied extra hosts are known.
    demoPolicyReady();

    // Excluded URL → suppress everything for this page.
    if (isExcluded(location.href, policy.excluded_urls)) return;

    applyPageEngagement(location.href);

    if (!policy.skip_vendors) injectAll(policy.vendor_pixels);

    sendEvent('page_view');
  }).catch(function () {
    demoPolicyReady();
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
    pageEnterTs = Date.now();
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
    sendExit();               // capture dwell of the page we're leaving
    pageEnterTs = Date.now();  // reset timer for the new page
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

  /* -------------------------------------------------------------- */
  /*  Dwell tracking (heartbeat + exit) — fills dwell_time_seconds     */
  /* -------------------------------------------------------------- */

  var pageEnterTs = Date.now();
  function dwellSecs() { return Math.max(0, Math.round((Date.now() - pageEnterTs) / 1000)); }

  // Periodic heartbeat while visible — keeps dwell fresh even if exit never lands.
  setInterval(function () {
    if (document.visibilityState === 'visible') {
      sendEvent('heartbeat', { dwell_time_seconds: dwellSecs() });
    }
  }, 20000);

  // Final dwell on leave. pagehide = reliable "gone"; visibilitychange->hidden
  // covers mobile tab-away. rawSend uses keepalive so the POST survives unload.
  var lastExitAt = 0;
  function sendExit() {
    var now = Date.now();
    if (now - lastExitAt < 1000) return; // dedup rapid double-fire
    lastExitAt = now;
    sendEvent('exit', { dwell_time_seconds: dwellSecs() });
  }
  window.addEventListener('pagehide', sendExit);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendExit();
  });

  /* -------------------------------------------------------------- */
  /*  Form capture hardening: email on change/blur (catches JS forms) */
  /* -------------------------------------------------------------- */

  // Next.js/SPA forms often submit via JS with no native 'submit' event, so the
  // submit listener above misses them. Capture the email the moment the field
  // changes/blurs — before the JS handler runs. Dedup lives in publicIdentify.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  document.addEventListener('change', function (ev) {
    try {
      var el = ev.target;
      if (!el || (el.nodeName !== 'INPUT' && el.nodeName !== 'TEXTAREA')) return;
      var type = (el.type || '').toLowerCase();
      if (type === 'password' || type === 'hidden') return;
      var name = (el.getAttribute('name') || '').toLowerCase();
      var val = (el.value || '').trim();
      // Capture by field type/name OR by VALUE — plain text inputs (e.g. a
      // "linkedin.com/in/them or them@co" field) carry emails too. The typed
      // value being a well-formed email is the signal, not the markup.
      var fieldSaysEmail = type === 'email' || name.indexOf('email') !== -1;
      if ((fieldSaysEmail && val.indexOf('@') > 0) || EMAIL_RE.test(val)) {
        publicIdentify(val, { source: 'form_field', input_name: name || null });
      }
    } catch (e) {}
  }, true);

  /* ================================================================== */
  /*  Demo engagement detection                                          */
  /*                                                                     */
  /*  The pixel NEVER enters the demo iframe — cross-origin access is    */
  /*  blocked on every platform. It stays on the parent page, works out  */
  /*  which demo platform is embedded, and subscribes to the events      */
  /*  those platforms deliberately broadcast out of their iframes.       */
  /*                                                                     */
  /*  Threat model: this adds a `message` listener to third-party pages. */
  /*  Every inbound message is origin-checked against the registry       */
  /*  below (exact host match) before a single field is read. We never   */
  /*  eval, never write message data into the DOM, and only read the     */
  /*  small set of fields each platform documents. An email arriving     */
  /*  over postMessage is handed to publicIdentify(), which already      */
  /*  lowercases / validates / dedups / hashes — there is no second      */
  /*  identity path.                                                     */
  /* ================================================================== */

  // ---- Host registry ------------------------------------------------
  //
  // `events: true` marks providers whose cross-frame event API we
  // subscribe to below. Everything else is detected by embed host alone
  // and produces only the shallow detection-time demo_view.
  //
  // `suffix: true` means "this host or any subdomain of it" — used for
  // platforms that serve each customer from their own subdomain. Suffix
  // matching applies to iframe-src detection ONLY; postMessage origin
  // validation always requires an exact host match, so widening
  // detection never widens the trust boundary.
  //
  // Every host below was checked against the vendor's embed docs or a
  // live production embed, EXCEPT embed.guidde.com and
  // play.instruqt.com, which are unconfirmed. Both are vendor-controlled
  // subdomains, so the trust boundary holds either way; the risk is only
  // that detection silently misses those two platforms.
  var DEMO_HOSTS = [
    /* Interactive demo platforms — event APIs implemented below. */
    { provider: 'storylane', host: 'app.storylane.io', events: true },
    { provider: 'storylane', host: 'js.storylane.io', events: true },
    { provider: 'navattic', host: 'capture.navattic.com', events: true },
    { provider: 'navattic', host: 'js.navattic.com', events: true },
    { provider: 'supademo', host: 'app.supademo.com', events: true },
    // Tourial rebranded to Navless.ai. The *embed* host is still
    // websitetours.tourial.com — app.tourial.com now redirects to
    // app.navless.ai, and navless.com is an unrelated business, so
    // neither belongs here.
    { provider: 'navless', host: 'websitetours.tourial.com', events: true },
    { provider: 'guidde', host: 'embed.guidde.com', events: true },
    { provider: 'instruqt', host: 'play.instruqt.com', events: true },

    /* Interactive demo platforms with no parent-page event API.
       Walnut states outright that tracking pixels are not supported in
       embedded demos; Consensus keeps its dataLayer inside the player
       frame. Both are served by the /v1/demo webhook path instead.
       Four of these use a different apex from their brand domain —
       teamwalnut.com, getreprise.com, demostack.app — so anything keyed
       on the brand name misses them. */
    { provider: 'arcade', host: 'demo.arcade.software', events: false },
    { provider: 'consensus', host: 'play.goconsensus.com', events: false },
    { provider: 'guideflow', host: 'app.guideflow.com', events: false },
    { provider: 'walnut', host: 'app.teamwalnut.com', events: false },
    { provider: 'reprise', host: 'app.getreprise.com', events: false },
    { provider: 'demostack', host: 'demostack.app', suffix: true, events: false },

    /* Demo video hosts. */
    { provider: 'wistia', host: 'fast.wistia.net', events: true },
    { provider: 'wistia', host: 'fast.wistia.com', events: true },
    { provider: 'vidyard', host: 'play.vidyard.com', events: true },
    { provider: 'tella', host: 'www.tella.tv', events: true },
    { provider: 'tella', host: 'tella.tv', events: true },
    { provider: 'loom', host: 'www.loom.com', path: '/embed', events: false }
  ];

  // Cross-frame event names, verbatim from each vendor's docs. Kept as
  // explicit allow-lists so an unexpected string from a demo origin is
  // ignored rather than forwarded to the backend.
  var STORYLANE_VIEW = { demo_open: 1, flow_start: 1 };
  var STORYLANE_PROGRESS = { step_view: 1, checklist_item_view: 1 };
  var STORYLANE_COMPLETE = { demo_finished: 1, flow_end: 1 };

  var SUPADEMO_VIEW = { 'Supademo:started': 1 };
  var SUPADEMO_PROGRESS = { 'Supademo:slideChange': 1, 'Supademo:progress': 1 };
  var SUPADEMO_COMPLETE = { 'Supademo:completed': 1 };

  var NAVATTIC_VIEW = { START_FLOW: 1 };
  var NAVATTIC_PROGRESS = {
    VIEW_STEP: 1, ENGAGE: 1, NAVIGATE: 1, COMPLETE_TASK: 1,
    START_CHECKLIST: 1, OPEN_CHECKLIST: 1, CLOSE_CHECKLIST: 1
  };
  var NAVATTIC_COMPLETE = { COMPLETE_FLOW: 1, CONVERTED: 1 };

  var NAVLESS_VIEW = { SESSION_START: 1, TOURIAL_VIEW: 1 };
  var NAVLESS_PROGRESS = { CLICK: 1, FORM_SUBMIT: 1 };

  var INSTRUQT_VIEW = { 'track.started': 1, 'track.ready': 1 };
  var INSTRUQT_PROGRESS = {
    'track.challenge_started': 1,
    'track.challenge_skipped': 1,
    'track.challenge_completed': 1
  };
  var INSTRUQT_COMPLETE = { 'track.completed': 1 };

  // ---- Module state -------------------------------------------------

  var demoRegistryCache = null;
  var demoDetected = {};       // host -> embed record (dedup: one per host)
  var demoStepSeen = {};       // provider -> { stepKey: 1 }
  var demoStepDepth = {};      // provider -> distinct step count
  var demoPending = [];        // events buffered until /v1/config resolves
  var demoPolicySettled = false;
  var demoObserver = null;
  var demoDetectCount = 0;     // total embeds ever registered
  var demoScanQueued = false;
  var demoInitDone = false;
  var wistiaHooked = false;
  var vidyardHooked = false;
  var navatticHooked = false;
  var hostedEmbed = null;      // demo mode: the page itself, as an embed record
  var dataLayerHooked = false;

  // ---- Human-interaction gate ---------------------------------------
  //
  // The anti-scanner control. Microsoft Defender Safe Links, Mimecast and
  // Proofpoint all detonate URLs in a real rendering browser before the
  // mail is delivered — they run this script. None of them publishes a
  // user agent or an egress IP range, so they can only be caught
  // behaviourally: a headless sandbox produces no pointerdown, no scroll
  // and no keydown. We never suppress client-side; every demo event
  // ships the flag and the backend decides.
  var humanInteraction = false;
  (function () {
    function markHuman() { humanInteraction = true; }
    var names = ['pointerdown', 'scroll', 'keydown'];
    for (var i = 0; i < names.length; i++) {
      try {
        window.addEventListener(names[i], markHuman, {
          passive: true, once: true, capture: true
        });
      } catch (e) {
        // Older browsers reject the options object; fall back to a plain
        // capture listener. markHuman is idempotent, so a listener that
        // never self-removes is harmless.
        try { window.addEventListener(names[i], markHuman, true); } catch (e2) {}
      }
    }
  })();

  // ---- Prerender gate -----------------------------------------------
  //
  // Chrome's Speculation Rules prerendering EXECUTES JavaScript, so a
  // naive pixel reports demos on pages the user never actually visited.
  // The Page Visibility API has no prerender state, so visibilityState
  // does not catch this — document.prerendering is the only signal.
  // Demo detection is held until activation. page_view behaviour is
  // deliberately unchanged in this revision.
  function isPrerendering() {
    try { return document.prerendering === true; } catch (e) { return false; }
  }
  function wasPrerendered() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      return !!(nav && nav.activationStart > 0);
    } catch (e) { return false; }
  }

  // ---- Small helpers ------------------------------------------------

  function demoStr(value) {
    return (typeof value === 'string' && value) ? value.slice(0, 512) : null;
  }
  function demoNum(value) {
    var n = typeof value === 'number' ? value : parseFloat(value);
    return isFinite(n) ? n : null;
  }
  function demoEmail(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim();
    if (v.length < 3 || v.length > 320) return null;
    return v.indexOf('@') > 0 ? v : null;
  }

  // Host of an origin string ("https://app.storylane.io:443" -> host).
  // Avoids `new URL` because sandboxed frames send the literal origin
  // "null", which throws.
  function hostFromOrigin(origin) {
    if (typeof origin !== 'string') return null;
    var i = origin.indexOf('://');
    if (i === -1) return null;
    var rest = origin.slice(i + 3);
    var slash = rest.indexOf('/');
    if (slash !== -1) rest = rest.slice(0, slash);
    var colon = rest.lastIndexOf(':');
    if (colon > 0 && rest.indexOf(']') === -1) rest = rest.slice(0, colon);
    return rest.toLowerCase() || null;
  }

  function buildDemoRegistry() {
    var list = DEMO_HOSTS.slice();
    // policy.demo.hosts — extra hosts supplied by the backend. Accepts
    // "app.example.com" or { host, provider, path, suffix }. Extras never
    // get an event API; they are detection-only.
    try {
      var extra = policy && policy.demo && policy.demo.hosts;
      if (extra && extra.length) {
        for (var i = 0; i < extra.length; i++) {
          var e = extra[i];
          var h = demoStr(typeof e === 'string' ? e : (e && e.host));
          if (!h) continue;
          list.push({
            provider: demoStr(e && e.provider) || 'custom',
            host: h.toLowerCase(),
            path: demoStr(e && e.path),
            suffix: !!(e && e.suffix),
            events: false
          });
        }
      }
    } catch (er) {}
    return list;
  }

  function demoRegistry() {
    if (!demoRegistryCache) demoRegistryCache = buildDemoRegistry();
    return demoRegistryCache;
  }

  // Exact-host lookup. Used for postMessage origin validation — never
  // suffix-matched, so a hostile *.walnut.io style origin can't slip in.
  function entryForHost(host) {
    if (!host) return null;
    var reg = demoRegistry();
    for (var i = 0; i < reg.length; i++) {
      if (reg[i].host === host) return reg[i];
    }
    return null;
  }

  // Detection-side match: exact host, or subdomain when suffix is set,
  // plus an optional path prefix (Loom only embeds under /embed).
  function entryForIframe(url) {
    var host, path;
    try {
      var u = new URL(url, location.href);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      host = u.host.toLowerCase();
      var portAt = host.lastIndexOf(':');
      if (portAt > 0 && host.indexOf(']') === -1) host = host.slice(0, portAt);
      path = u.pathname || '/';
    } catch (e) {
      return null;
    }
    var reg = demoRegistry();
    for (var i = 0; i < reg.length; i++) {
      var entry = reg[i];
      var hit = host === entry.host ||
        (entry.suffix && host.length > entry.host.length &&
          host.slice(-(entry.host.length + 1)) === '.' + entry.host);
      if (!hit) continue;
      if (entry.path && path.indexOf(entry.path) !== 0) continue;
      return entry;
    }
    return null;
  }

  // demo_id from the embed URL: last meaningful path segment, with the
  // generic wrapper segments and file extensions stripped.
  var DEMO_ID_SKIP = {
    embed: 1, embeds: 1, demo: 1, demos: 1, iframe: 1, share: 1,
    player: 1, play: 1, video: 1, videos: 1, medias: 1, watch: 1, v: 1, e: 1
  };
  function parseDemoId(url) {
    try {
      var parts = new URL(url, location.href).pathname.split('/');
      for (var i = parts.length - 1; i >= 0; i--) {
        var seg = parts[i].replace(/\.(html?|js|json)$/i, '');
        if (!seg) continue;
        if (Object.prototype.hasOwnProperty.call(DEMO_ID_SKIP, seg.toLowerCase())) continue;
        return seg.slice(0, 128);
      }
    } catch (e) {}
    return null;
  }

  // ---- Distinct-step accounting -------------------------------------

  function noteStep(provider, stepKey) {
    if (!demoStepSeen[provider]) {
      demoStepSeen[provider] = {};
      demoStepDepth[provider] = 0;
    }
    // No usable key from the platform → treat every report as a new step
    // so step_depth still grows monotonically.
    var key = (stepKey === null || stepKey === undefined || stepKey === '')
      ? '#' + (demoStepDepth[provider] + 1)
      : String(stepKey).slice(0, 128);
    if (!demoStepSeen[provider][key]) {
      demoStepSeen[provider][key] = 1;
      demoStepDepth[provider] += 1;
    }
    return demoStepDepth[provider];
  }
  function stepDepth(provider) {
    return demoStepDepth[provider] || null;
  }

  // ---- Emission -----------------------------------------------------

  function demoAllowed() {
    try {
      if (policy) {
        if (policy.demo && policy.demo.enabled === false) return false;
        if (isExcluded(location.href, policy.excluded_urls)) return false;
      }
    } catch (e) {}
    return true;
  }

  // ---- Hosted-page platform globals ---------------------------------
  //
  // Read at emit time, never cached and never assumed present: these are
  // the platform's own objects, they can load after us, and a custom-
  // domain build may not expose them at all.

  // Reprise puts replay_id / screen_id / environment on window.reprise.
  function repriseState() {
    try {
      var r = window.reprise;
      if (!r || typeof r !== 'object') return null;
      return {
        replayId: demoStr(r.replay_id),
        screenId: demoStr(r.screen_id),
        environment: demoStr(r.environment)
      };
    } catch (e) {
      return null;
    }
  }

  // Arcade is a Next.js app; the flow it is playing sits in the SSR
  // payload at __NEXT_DATA__.props.pageProps.
  function arcadeFlow() {
    try {
      var nd = window.__NEXT_DATA__;
      var pp = nd && nd.props && nd.props.pageProps;
      if (!pp || typeof pp !== 'object') return null;
      var flow = (pp.flow && typeof pp.flow === 'object') ? pp.flow : pp;
      var id = demoStr(flow.id) || demoStr(flow.flowId) || demoStr(pp.flowId);
      var name = demoStr(flow.name) || demoStr(pp.flowName) || demoStr(pp.title);
      if (!id && !name) return null;
      return { id: id, name: name };
    } catch (e) {
      return null;
    }
  }

  // Returns false when this emission must be dropped entirely.
  function applyPlatformGlobals(extra) {
    if (demoPlatform === 'reprise') {
      var rs = repriseState();
      if (rs) {
        // environment is "editor" | "preview" | "publish". Editor and
        // preview are the customer's own team building the demo —
        // scoring those would put a rep's dry run into their own
        // pipeline. An ABSENT global is not a verdict: it may simply not
        // have loaded yet, so we emit, same posture as every other
        // optional field here.
        if (rs.environment && rs.environment !== 'publish') return false;
        if (rs.replayId) extra.reprise_replay_id = rs.replayId;
        if (rs.screenId) extra.reprise_screen_id = rs.screenId;
      }
    } else if (demoPlatform === 'arcade') {
      var af = arcadeFlow();
      if (af) {
        if (af.id) extra.arcade_flow_id = af.id;
        if (af.name) extra.arcade_flow_name = af.name;
      }
    }
    return true;
  }

  function emitDemo(eventType, embed, fields) {
    try {
      var extra = {
        demo_provider: (embed && embed.provider) || null,
        demo_host: (embed && embed.host) || null,
        demo_id: (embed && embed.demoId) || null,
        demo_url: (embed && embed.src) || null,
        demo_event_name: null,
        step_index: null,
        step_depth: null,
        completion_pct: null,
        human_interaction: humanInteraction,
        detection: (embed && embed.detection) || null,
        prerendered: wasPrerendered()
      };
      if (fields) {
        for (var k in fields) {
          if (Object.prototype.hasOwnProperty.call(fields, k)) extra[k] = fields[k];
        }
      }
      if (demoMode && !applyPlatformGlobals(extra)) return;
      // Buffer until /v1/config lands: demo.enabled and excluded_urls both
      // live in the policy and must be honoured, exactly like page_view.
      if (!demoPolicySettled) {
        demoPending.push([eventType, extra]);
        return;
      }
      if (!demoAllowed()) return;
      sendEvent(eventType, extra);
    } catch (e) {}
  }

  // Called once /v1/config resolves (or fails). Releases buffered demo
  // events and re-scans, since policy.demo.hosts may add hosts.
  function demoPolicyReady() {
    try {
      demoRegistryCache = null;
      demoPolicySettled = true;
      while (demoPending.length) {
        var entry = demoPending.shift();
        if (demoAllowed()) sendEvent(entry[0], entry[1]);
      }
      if (demoInitDone) scanDemoEmbeds();
    } catch (e) {}
  }

  // ---- Detection ----------------------------------------------------

  function registerEmbed(entry, src, detection, demoId) {
    if (!entry) return null;
    var key = entry.host + '|' + entry.provider;
    if (demoDetected[key]) return demoDetected[key];
    var embed = {
      provider: entry.provider,
      host: entry.host,
      src: src ? demoStr(src) : null,
      demoId: demoId || (src ? parseDemoId(src) : null),
      detection: detection,
      hasEvents: !!entry.events
    };
    demoDetected[key] = embed;
    demoDetectCount++;

    // Shallow account-level signal: "a demo is on this page and the page
    // was loaded". `iframe_only` is the sentinel for detection-without-
    // engagement, so the backend can separate it from a real engagement
    // event — no scanner, unfurler or prerender ever advances a demo
    // step, so demo_progress / demo_complete carry the weight.
    //
    // Skipped when the embed was discovered *by* a cross-frame event:
    // that is engagement, and the handler is about to report it properly.
    // Labelling it shallow would be a lie.
    //
    // Also skipped in demo mode: registerHostedDemo() has already
    // reported this visit once, with better provenance. Storylane's
    // share page frames its own /demo/<id> player, so without this the
    // same visit would report twice.
    if (detection !== 'postmessage' && !demoMode) {
      emitDemo('demo_view', embed, { detection: 'iframe_only' });
    }

    attachProviderEvents(embed);
    return embed;
  }

  // Look up (or lazily create) the embed record a cross-frame event
  // belongs to. Messages can arrive from an iframe we never saw — inside
  // a shadow root, say — so origin validation is the authority, not the
  // DOM scan.
  function embedForOrigin(origin) {
    var host = hostFromOrigin(origin);
    if (!host) return null;
    var entry = entryForHost(host);
    if (!entry) return null;
    var key = entry.host + '|' + entry.provider;
    if (demoDetected[key]) return demoDetected[key];
    return registerEmbed(entry, null, 'postmessage');
  }

  // Demo mode: the page ITSELF is the demo, so register it as an embed
  // record and report the visit once. This is not a convenience — most
  // hosted players (Reprise, Walnut, Demoboost, Consensus, Arcade)
  // render in the top document with no iframe at all, so the DOM scan
  // finds nothing and without this no event would ever leave the page.
  function registerHostedDemo() {
    if (!demoMode) return null;
    if (hostedEmbed) return hostedEmbed;
    var host = null;
    var href = null;
    try { host = location.host.toLowerCase(); } catch (e) {}
    try { href = demoStr(location.href); } catch (e) {}
    hostedEmbed = {
      provider: demoPlatform,
      host: host,
      src: href,
      demoId: demoModeId(),
      detection: 'hosted_page',
      hasEvents: false
    };
    emitDemo('demo_view', hostedEmbed, { detection: 'hosted_page' });
    return hostedEmbed;
  }

  function scanDemoEmbeds() {
    try {
      var frames = document.querySelectorAll('iframe[src]');
      for (var i = 0; i < frames.length; i++) {
        var src = frames[i].getAttribute('src');
        if (!src) continue;
        var entry = entryForIframe(src);
        if (entry) registerEmbed(entry, src, 'iframe');
      }
    } catch (e) {}
    detectNavatticWithoutIframe();
    detectWistiaWithoutIframe();
  }

  // Navattic also embeds without an iframe: the loader script, elements
  // carrying data-navattic-* attributes, and a NavatticEmbed global. CSS
  // has no attribute-prefix selector, so the documented attributes are
  // enumerated.
  function detectNavatticWithoutIframe() {
    try {
      var entry = entryForHost('js.navattic.com');
      if (!entry) return;
      var key = entry.host + '|' + entry.provider;
      if (demoDetected[key]) return;
      if (window.NavatticEmbed || window.navattic) {
        registerEmbed(entry, null, 'global');
        return;
      }
      if (document.querySelector('script[src*="js.navattic.com"], script[src*="navattic.com/embeds"]')) {
        registerEmbed(entry, null, 'script');
        return;
      }
      if (document.querySelector(
        '[data-navattic],[data-navattic-id],[data-navattic-flow],' +
        '[data-navattic-embed],[data-navattic-project],[data-navattic-demo]'
      )) {
        registerEmbed(entry, null, 'attribute');
      }
    } catch (e) {}
  }

  // Wistia's modern embed is a <wistia-player media-id> custom element,
  // and the legacy inline embed is a .wistia_embed div — an iframe[src]
  // scan sees neither. The _wq / Wistia globals are the third tell.
  function detectWistiaWithoutIframe() {
    try {
      var entry = entryForHost('fast.wistia.net');
      if (!entry) return;
      var key = entry.host + '|' + entry.provider;
      if (demoDetected[key]) return;
      var el = null;
      try {
        el = document.querySelector('wistia-player[media-id],.wistia_embed,[class*="wistia_async_"]');
      } catch (e) {}
      if (el) {
        var mediaId = null;
        try { mediaId = demoStr(el.getAttribute('media-id')); } catch (e2) {}
        registerEmbed(entry, null, 'element', mediaId);
        return;
      }
      if (window._wq || window.Wistia) registerEmbed(entry, null, 'global');
    } catch (e) {}
  }

  function queueDemoScan() {
    if (demoScanQueued) return;
    demoScanQueued = true;
    setTimeout(function () {
      demoScanQueued = false;
      // Disconnect only when THIS scan matched something new. Keying off
      // "any demo detected" would tear the observer down on the first
      // unrelated DOM mutation after a bootstrap-time match, and a
      // lazy-loaded demo would then never be seen.
      var before = demoDetectCount;
      scanDemoEmbeds();
      if (demoObserver && demoDetectCount > before) {
        try { demoObserver.disconnect(); } catch (e) {}
        demoObserver = null;
      }
    }, 250);
  }

  function startDemoObserver() {
    try {
      if (!window.MutationObserver) return;
      demoObserver = new MutationObserver(queueDemoScan);
      demoObserver.observe(document.documentElement, {
        childList: true, subtree: true
      });
      // Hard stop: a page that never embeds a demo shouldn't keep an
      // observer alive for the whole session.
      setTimeout(function () {
        if (demoObserver) {
          try { demoObserver.disconnect(); } catch (e) {}
          demoObserver = null;
        }
      }, 30000);
    } catch (e) {}
  }

  // ---- Per-provider event subscription -------------------------------

  function attachProviderEvents(embed) {
    if (!embed || !embed.hasEvents) return;
    if (embed.provider === 'navattic') hookNavattic(embed);
    else if (embed.provider === 'wistia') hookWistia(embed);
    else if (embed.provider === 'vidyard') hookVidyard(embed);
    // storylane / supademo / navless / guidde / instruqt / tella are all
    // postMessage-based and served by the single listener below.
  }

  /* -- Storylane ----------------------------------------------------- */
  /* Cross-Frame Events. The envelope is
     { message: 'storylane-demo-event',
       payload: { event, demo: { id, url, name }, lead: { email, ... },
                  step: { id, index }, flow: { id, name } } }
     step.index is 1-based — used verbatim as step_index.                */
  function handleStorylane(embed, data) {
    if (!data || data.message !== 'storylane-demo-event') return;
    var payload = data.payload;
    if (!payload || typeof payload !== 'object') return;
    var name = demoStr(payload.event);
    if (!name) return;

    var demo = (payload.demo && typeof payload.demo === 'object') ? payload.demo : null;
    if (demo) {
      if (!embed.demoId) embed.demoId = demoStr(demo.id);
      if (!embed.src) embed.src = demoStr(demo.url);
    }

    if (name === 'lead_identify') {
      var lead = (payload.lead && typeof payload.lead === 'object') ? payload.lead : null;
      var email = lead ? demoEmail(lead.email) : null;
      if (email) {
        // Straight into the existing identity path — it lowercases,
        // validates, dedups and hashes. No second path.
        publicIdentify(email, { source: 'demo_storylane' });
      }
      emitDemo('demo_lead_captured', embed, { demo_event_name: name });
      return;
    }

    if (STORYLANE_PROGRESS[name]) {
      var step = (payload.step && typeof payload.step === 'object') ? payload.step : null;
      var idx = step ? demoNum(step.index) : null;
      var key = step ? (demoStr(step.id) || idx) : null;
      var depth = noteStep(embed.provider, key === null ? idx : key);
      emitDemo('demo_progress', embed, {
        demo_event_name: name, step_index: idx, step_depth: depth
      });
      return;
    }
    if (STORYLANE_COMPLETE[name]) {
      emitDemo('demo_complete', embed, {
        demo_event_name: name,
        step_depth: stepDepth(embed.provider),
        completion_pct: 100
      });
      return;
    }
    if (STORYLANE_VIEW[name]) {
      emitDemo('demo_view', embed, { demo_event_name: name });
    }
    // Everything else (page_view, convert_cta, primary_cta,
    // secondary_cta, open_external_url) is deliberately ignored: it is
    // in-demo UI noise, not demo engagement depth.
  }

  /* -- Supademo ------------------------------------------------------ */
  /* Embed Events API. Discriminated by data.source === 'Supademo'; the
     name is the Supademo:* string. Supademo:progress carries a
     `percentage` field.                                                 */
  function handleSupademo(embed, data) {
    if (!data || data.source !== 'Supademo') return;
    var name = demoStr(data.type) || demoStr(data.event);
    if (!name) return;
    var pct = demoNum(data.percentage);

    if (SUPADEMO_PROGRESS[name]) {
      var depth = noteStep(embed.provider, demoNum(data.index));
      emitDemo('demo_progress', embed, {
        demo_event_name: name,
        step_index: demoNum(data.index),
        step_depth: depth,
        completion_pct: pct
      });
      return;
    }
    if (SUPADEMO_COMPLETE[name]) {
      emitDemo('demo_complete', embed, {
        demo_event_name: name,
        step_depth: stepDepth(embed.provider),
        completion_pct: pct === null ? 100 : pct
      });
      return;
    }
    if (SUPADEMO_VIEW[name]) {
      emitDemo('demo_view', embed, { demo_event_name: name });
    }
    // Supademo:load and Supademo:close are lifecycle noise, not engagement.
  }

  /* -- Navless (formerly Tourial) ------------------------------------ */
  /* message events of type TOURIAL_EVENT. FORM_SUBMIT carries formId and
     zero field values — there is no email to read, so we don't look.     */
  function handleNavless(embed, data) {
    if (!data || data.type !== 'TOURIAL_EVENT') return;
    var payload = (data.payload && typeof data.payload === 'object') ? data.payload : null;
    var name = payload ? demoStr(payload.eventType) : null;
    if (!name) return;

    if (NAVLESS_PROGRESS[name]) {
      var formId = demoStr(payload.formId);
      var fields = {
        demo_event_name: name,
        step_depth: noteStep(embed.provider, name + ':' + (formId || ''))
      };
      if (formId) fields.form_id = formId;
      emitDemo('demo_progress', embed, fields);
      return;
    }
    if (NAVLESS_VIEW[name]) {
      emitDemo('demo_view', embed, { demo_event_name: name });
    }
  }

  /* -- Guidde -------------------------------------------------------- */
  /* Broadcasts a JSON *string*, shaped
     { context: 'player.js', version, event }. A 95%-watched milestone
     arrives as the event `guidde-mark-as-completed`.                     */
  function handleGuidde(embed, data) {
    var parsed = data;
    if (typeof data === 'string') {
      if (data.length > 4096) return;
      try { parsed = JSON.parse(data); } catch (e) { return; }
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.context !== 'player.js') return;
    var name = demoStr(parsed.event);
    if (!name) return;

    if (name === 'guidde-mark-as-completed' || name === 'ended') {
      emitDemo('demo_complete', embed, {
        demo_event_name: name, completion_pct: 100
      });
      return;
    }
    if (name === 'timeupdate' || name === 'progress' || name === 'seeked') {
      emitDemo('demo_progress', embed, {
        demo_event_name: name,
        step_depth: noteStep(embed.provider, name)
      });
      return;
    }
    if (name === 'play' || name === 'ready') {
      emitDemo('demo_view', embed, { demo_event_name: name });
    }
  }

  /* -- Instruqt ------------------------------------------------------ */
  /* track.* events. The payload shape is unconfirmed, so only the event
     name is read and nothing else is trusted.                            */
  function handleInstruqt(embed, data) {
    if (!data || typeof data !== 'object') return;
    var name = demoStr(data.event) || demoStr(data.type) || demoStr(data.action);
    if (!name || name.indexOf('track.') !== 0) return;

    if (INSTRUQT_COMPLETE[name]) {
      emitDemo('demo_complete', embed, {
        demo_event_name: name,
        step_depth: stepDepth(embed.provider),
        completion_pct: 100
      });
      return;
    }
    if (INSTRUQT_PROGRESS[name]) {
      emitDemo('demo_progress', embed, {
        demo_event_name: name,
        step_depth: noteStep(embed.provider, name)
      });
      return;
    }
    if (INSTRUQT_VIEW[name]) {
      emitDemo('demo_view', embed, { demo_event_name: name });
    }
  }

  /* -- Tella --------------------------------------------------------- */
  /* ready / playbackState / timeUpdate. timeUpdate fires roughly every
     250ms carrying currentTime + duration, so it is thresholded to
     25/50/75% rather than forwarded verbatim.                            */
  var tellaMilestones = {};
  function handleTella(embed, data) {
    if (!data || typeof data !== 'object') return;
    var name = demoStr(data.type) || demoStr(data.event);
    if (!name) return;

    if (name === 'timeUpdate') {
      var cur = demoNum(data.currentTime);
      var dur = demoNum(data.duration);
      if (cur === null || !dur || dur <= 0) return;
      var pct = Math.round((cur / dur) * 100);
      var bucket = pct >= 95 ? 95 : pct >= 75 ? 75 : pct >= 50 ? 50 : pct >= 25 ? 25 : 0;
      if (!bucket || tellaMilestones[bucket]) return;
      tellaMilestones[bucket] = 1;
      emitDemo(bucket >= 95 ? 'demo_complete' : 'demo_progress', embed, {
        demo_event_name: name,
        step_depth: noteStep(embed.provider, 'pct:' + bucket),
        completion_pct: bucket
      });
      return;
    }
    if (name === 'ready' || name === 'playbackState') {
      emitDemo('demo_view', embed, { demo_event_name: name });
    }
  }

  /* -- The single message listener ----------------------------------- */

  try {
    window.addEventListener('message', function (ev) {
      try {
        // Origin is the gate. Exact host match against the registry;
        // anything else is dropped without reading a single field.
        var embed = embedForOrigin(ev.origin);
        if (!embed || !embed.hasEvents) return;
        var data = ev.data;
        if (data === null || data === undefined) return;
        if (typeof data !== 'object' && typeof data !== 'string') return;

        if (embed.provider === 'storylane') handleStorylane(embed, data);
        else if (embed.provider === 'supademo') handleSupademo(embed, data);
        else if (embed.provider === 'navless') handleNavless(embed, data);
        else if (embed.provider === 'guidde') handleGuidde(embed, data);
        else if (embed.provider === 'instruqt') handleInstruqt(embed, data);
        else if (embed.provider === 'tella') handleTella(embed, data);
      } catch (e) {}
    }, false);
  } catch (e) {}

  /* -- Navattic (JS SDK) --------------------------------------------- */
  /* navattic.onEvent(cb). The global appears once embeds.js has loaded,
     so we poll for ~10s after detecting the embed and then give up.
     navattic.identify() is Navattic's to call, not ours.                 */
  function classifyNavattic(name) {
    if (NAVATTIC_COMPLETE[name]) return 'demo_complete';
    if (NAVATTIC_PROGRESS[name]) return 'demo_progress';
    if (NAVATTIC_VIEW[name]) return 'demo_view';
    return null;
  }

  // The email rides in a properties[] array. Only entries that are both
  // object === 'END_USER' and source === 'FORM' are self-declared —
  // source === 'ENRICHMENT' is Clearbit's inference about the company,
  // and feeding that into the identity cache would poison it.
  function navatticFormEmail(evt) {
    try {
      var props = evt && evt.properties;
      if (!props || !props.length) return null;
      for (var i = 0; i < props.length; i++) {
        var p = props[i];
        if (!p || p.object !== 'END_USER' || p.source !== 'FORM') continue;
        var email = demoEmail(p.value) || demoEmail(p.email);
        if (email) return email;
      }
    } catch (e) {}
    return null;
  }

  function hookNavattic(embed) {
    if (navatticHooked) return;
    navatticHooked = true;
    var waited = 0;
    var timer = setInterval(function () {
      try {
        var nv = window.navattic;
        if (!nv || typeof nv.onEvent !== 'function') {
          waited += 500;
          if (waited >= 10000) clearInterval(timer);
          return;
        }
        clearInterval(timer);
        nv.onEvent(function (evt) {
          try {
            if (!evt || typeof evt !== 'object') return;
            var name = demoStr(evt.type) || demoStr(evt.event) || demoStr(evt.name);
            if (!name) return;

            var email = navatticFormEmail(evt);
            if (email) {
              publicIdentify(email, { source: 'demo_navattic' });
              emitDemo('demo_lead_captured', embed, { demo_event_name: name });
            }

            var mapped = classifyNavattic(name);
            if (!mapped) return;
            var stepId = demoStr(evt.step_id) ||
              demoStr(evt.properties && evt.properties.step_id);
            var fields = { demo_event_name: name };
            if (mapped === 'demo_progress') {
              fields.step_depth = noteStep(embed.provider, stepId || name);
            } else if (mapped === 'demo_complete') {
              fields.step_depth = stepDepth(embed.provider);
              fields.completion_pct = 100;
            }
            emitDemo(mapped, embed, fields);
          } catch (e) {}
        });
      } catch (e) {
        clearInterval(timer);
      }
    }, 500);
  }

  /* -- Wistia (player API) ------------------------------------------- */
  /* _wq is the documented pre-load command queue, so pushing before
     E-v1.js arrives is correct. `conversion` hands the gated email to
     the parent page client-side; `percentwatchedchanged` is thresholded. */
  function hookWistia(embed) {
    if (wistiaHooked) return;
    wistiaHooked = true;
    try {
      var milestones = {};
      window._wq = window._wq || [];
      window._wq.push({
        id: '_all',
        onReady: function (video) {
          try {
            if (!embed.demoId && typeof video.hashedId === 'function') {
              embed.demoId = demoStr(video.hashedId());
            }
            emitDemo('demo_view', embed, { demo_event_name: 'onReady' });

            video.bind('conversion', function (type, email, firstName, lastName) {
              try {
                var clean = demoEmail(email);
                if (clean) {
                  var traits = { source: 'demo_wistia', conversion_type: demoStr(type) };
                  var fn = demoStr(firstName);
                  var ln = demoStr(lastName);
                  if (fn) traits.first_name = fn;
                  if (ln) traits.last_name = ln;
                  publicIdentify(clean, traits);
                }
                emitDemo('demo_lead_captured', embed, {
                  demo_event_name: 'conversion:' + (demoStr(type) || 'unknown')
                });
              } catch (e) {}
            });

            video.bind('percentwatchedchanged', function (percent) {
              try {
                var pct = Math.round((demoNum(percent) || 0) * 100);
                var bucket = pct >= 95 ? 95 : pct >= 75 ? 75 : pct >= 50 ? 50 : pct >= 25 ? 25 : 0;
                if (!bucket || milestones[bucket]) return;
                milestones[bucket] = 1;
                emitDemo(bucket >= 95 ? 'demo_complete' : 'demo_progress', embed, {
                  demo_event_name: 'percentwatchedchanged',
                  step_depth: noteStep(embed.provider, 'pct:' + bucket),
                  completion_pct: bucket
                });
              } catch (e) {}
            });
          } catch (e) {}
        }
      });
    } catch (e) {}
  }

  /* -- Vidyard (player API) ------------------------------------------ */
  /* The embed script invokes window.onVidyardAPI once ready, so we chain
     any handler the customer already installed rather than clobber it.   */
  function hookVidyard(embed) {
    if (vidyardHooked) return;
    vidyardHooked = true;
    try {
      var milestones = {};
      function bindPlayer(player) {
        try {
          if (!player || typeof player.on !== 'function') return;
          if (!embed.demoId) embed.demoId = demoStr(player.uuid);
          emitDemo('demo_view', embed, { demo_event_name: 'ready' });
          player.on('play', function () {
            emitDemo('demo_view', embed, { demo_event_name: 'play' });
          });
          if (typeof player.progressEvents === 'function') {
            player.progressEvents(function (pct) {
              try {
                var bucket = demoNum(pct);
                if (bucket === null || milestones[bucket]) return;
                milestones[bucket] = 1;
                emitDemo(bucket >= 95 ? 'demo_complete' : 'demo_progress', embed, {
                  demo_event_name: 'progressEvents',
                  step_depth: noteStep(embed.provider, 'pct:' + bucket),
                  completion_pct: bucket
                });
              } catch (e) {}
            }, [25, 50, 75, 95]);
          }
          player.on('videoComplete', function () {
            emitDemo('demo_complete', embed, {
              demo_event_name: 'videoComplete', completion_pct: 100
            });
          });
        } catch (e) {}
      }
      var previous = window.onVidyardAPI;
      window.onVidyardAPI = function (api) {
        try {
          if (typeof previous === 'function') previous(api);
        } catch (e) {}
        try {
          if (api && api.api && typeof api.api.addReadyListener === 'function') {
            api.api.addReadyListener(function (_, player) { bindPlayer(player); });
          }
        } catch (e) {}
      };
      if (window.VidyardV4) window.onVidyardAPI(window.VidyardV4);
    } catch (e) {}
  }

  /* -- GTM dataLayer (Consensus) -------------------------------------- */
  /* Consensus allows no raw <script> — only a GTM container — and pushes
     a `Lead Submitted` event carrying the viewer's email into dataLayer.
     That is the one place a gated Consensus demo hands us a person, so we
     drain what is already queued and wrap push for what follows. GTM
     loads async, so we poll for the array for ~10s exactly like
     hookNavattic. The email goes through publicIdentify — the single
     identity path — never a second one.                                  */
  function readDataLayerEntry(entry) {
    try {
      if (!entry || typeof entry !== 'object') return;
      var name = demoStr(entry.event);
      if (!name || name.toLowerCase().indexOf('lead') === -1) return;
      var email = demoEmail(entry.email) || demoEmail(entry.user_email);
      if (!email) return;
      publicIdentify(email, { source: 'demo_' + demoPlatform });
      emitDemo('demo_lead_captured', hostedEmbed || registerHostedDemo(), {
        demo_event_name: name
      });
    } catch (e) {}
  }

  function hookDataLayer() {
    if (!demoMode || dataLayerHooked) return;
    var waited = 0;
    var timer = setInterval(function () {
      try {
        var dl = window.dataLayer;
        if (!dl || typeof dl.push !== 'function' || typeof dl.length !== 'number') {
          waited += 500;
          if (waited >= 10000) clearInterval(timer);
          return;
        }
        clearInterval(timer);
        if (dataLayerHooked) return;
        dataLayerHooked = true;
        for (var i = 0; i < dl.length; i++) readDataLayerEntry(dl[i]);
        var originalPush = dl.push;
        dl.push = function () {
          var result = originalPush.apply(this, arguments);
          try {
            for (var j = 0; j < arguments.length; j++) readDataLayerEntry(arguments[j]);
          } catch (e) {}
          return result;
        };
      } catch (e) {
        clearInterval(timer);
      }
    }, 500);
  }

  /* -- Init ----------------------------------------------------------- */

  function initDemoDetection() {
    if (demoInitDone) return;
    demoInitDone = true;
    try {
      // Demo mode reports the hosted page first, so the visit is on record
      // before any platform event API has had a chance to load.
      registerHostedDemo();
      // The cross-frame listeners stay live in demo mode: Storylane's share
      // page frames its own /demo/<id> player, so step depth and completion
      // still arrive over postMessage.
      scanDemoEmbeds();
      startDemoObserver();
      hookDataLayer();
    } catch (e) {}
  }

  try {
    if (isPrerendering()) {
      // Prerendered pages run JS for a visit that may never happen. Hold
      // detection until the user actually activates the page.
      document.addEventListener('prerenderingchange', initDemoDetection, { once: true });
    } else {
      initDemoDetection();
    }
  } catch (e) {
    initDemoDetection();
  }
})();
