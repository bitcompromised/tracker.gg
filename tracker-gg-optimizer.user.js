// ==UserScript==
// @name         Tracker.gg Optimizer
// @namespace    https://tracker.gg/
// @version      1.2.0
// @description  Cuts tracker.gg's CPU and memory use: blocks the ad/prebid/cookie-sync stack (19+ third-party iframes), kills the floating Primis video player, reaps stray frames, collapses ad space, and adds a live perf HUD. Alt+O for settings.
// @author       eadan
// @match        https://tracker.gg/*
// @match        https://*.tracker.gg/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/*
 * Measured on a stock tracker.gg/valorant load:
 *   82 MB JS heap | 25 iframes (19 third-party) | 47 scripts | 2 HLS videos
 *   ...against a site DOM of only ~1,400 nodes.
 * Virtually all of the cost is the ad stack. Every third-party frame is its own
 * JS realm with its own timers, rAF loops and heap, and the Primis player keeps
 * a video decoder running. Killing those is the whole optimization.
 */

(function () {
  'use strict';

  /** Page context. Tampermonkey sandboxes the script, so patching must target the real window. */
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  const DEFAULTS = {
    blockAds:       true,  // ad networks, prebid bidders, cookie syncs
    blockAnalytics: true,  // GA/GTM, Comscore, CF Insights
    killVideoAds:   true,  // floating Primis/sekindo player + its video decode
    reapFrames:     true,  // periodically remove third-party iframes that slip through
    hideSlots:      true,  // hide + collapse leftover ad containers
    pauseHidden:    true,  // stop media/animation work while the tab is in the background
    contentVis:     true,  // skip rendering off-screen cards
    lazyImages:     true,  // loading=lazy / decoding=async on off-screen images
    noBlur:         true,  // drop backdrop-filter (GPU-expensive, purely cosmetic)
    preconnect:     true,  // early connections to the API + CDN
    reduceMotion:   false, // near-instant animations/transitions
    unstickNav:     false, // let the top nav scroll away
    showHud:        false, // live heap / iframe / node counter
  };

  const store = {
    get(k) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, DEFAULTS[k]);
        const v = localStorage.getItem('trnopt:' + k);
        return v === null ? DEFAULTS[k] : JSON.parse(v);
      } catch (e) { return DEFAULTS[k]; }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(k, v);
        else localStorage.setItem('trnopt:' + k, JSON.stringify(v));
      } catch (e) { /* private mode */ }
    },
  };

  const cfg = {};
  for (const k of Object.keys(DEFAULTS)) cfg[k] = store.get(k);

  /* ------------------------------------------------------------------ *
   * Host lists
   * ------------------------------------------------------------------ */

  // Never blocked: site API, assets, push, payments, fonts.
  // Matched against the URL's hostname, not the whole URL — ad requests routinely
  // carry "tracker.gg" inside their query string (?url=https%3A%2F%2Ftracker.gg%2F),
  // and a substring test would wave those straight through.
  const ALLOW_HOSTS = [
    'tracker.gg', 'trackercdn.com', 'thetrackernetwork.com',
    'stripe.com', 'fonts.gstatic.com', 'fonts.googleapis.com',
    'firebase.googleapis.com', 'firebaseio.com', 'gstatic.com',
  ];

  const AD_HOSTS = [
    // primary monetization
    'nitropay.com', 'nit.ro', 'nitrocnct.com',
    'doubleclick.net', 'googlesyndication.com', 'googletagservices.com',
    'adtrafficquality.google', 'ad-delivery.net',
    'confiant-integrations.net', 'amazon-adsystem.com', 'btloader.com',
    'id5-sync.com', 'privacymanager.io', 'p7cloud.net', 'cpx.to',
    'arcspan.com', 'captify.co.uk', 'liveramp.com', 'rlcdn.com',
    // video ads
    'primis.tech', 'sekindo.com', 'imasdk.googleapis.com',
    // prebid bidders / cookie syncs observed on the page
    'pubmatic.com', 'openx.net', 'rubiconproject.com', '3lift.com',
    'adnxs.com', 'criteo.com', 'criteo.net', 'indexww.com', 'sonobi.com',
    'inmobi.com', 'yellowblue.io', 'casalemedia.com', 'smartadserver.com',
    'bidswitch.net', 'sharethrough.com', 'media.net', 'teads.tv',
    'taboola.com', 'outbrain.com', 'moatads.com', 'adsafeprotected.com',
    'doubleverify.com', 'quantserve.com', 'crwdcntrl.net', 'demdex.net',
    'adform.net', 'adroll.com', 'agkn.com', 'bluekai.com', 'onetag-sys.com',
    'gumgum.com', 'triplelift.com', 'sovrn.com', 'lijit.com', 'ay.delivery',
    'omnitagjs.com', 'nativo.com', 'ntv.io', 'servenobid.com',
    // second-wave syncs, caught by auditing what still got through
    'adsrvr.org', 'postrelease.com', '33across.com', 'hadronid.net',
    'fastclick.net', 'ad.gt', '1rx.io', 'contextweb.com', 'deepintent.com',
    'admanmedia.com', 'dns-finder.com', 'adsymptotic.com', 'tapad.com',
    'zemanta.com', 'pippio.com', 'crsspxl.com', 'adlooxtracking.com',
  ];

  // Host families that vary by subdomain or ccTLD.
  const AD_HOST_RE = /^(pagead\d*|securepubads|adservice|partnerad|pixel|sync|match|cs|cm)\.(google|googlesyndication|doubleclick)\./i;

  const ANALYTICS_HOSTS = [
    'googletagmanager.com', 'google-analytics.com', 'analytics.google.com',
    'scorecardresearch.com', 'cloudflareinsights.com',
    'sentry.io', 'datadoghq.com', 'hotjar.com', 'clarity.ms',
    'fullstory.com', 'mouseflow.com', 'segment.io', 'segment.com',
    'amplitude.com', 'mixpanel.com', 'newrelic.com', 'nr-data.net',
  ];

  // Iframes from these origins are legitimate and survive the reaper.
  const FRAME_ALLOW = [
    'tracker.gg', 'trackercdn.com', 'thetrackernetwork.com', 'stripe.com',
    'google.com', 'gstatic.com', 'youtube.com', 'youtube-nocookie.com',
    'twitch.tv', 'vimeo.com',
  ];

  const blocked = new Map(); // host -> count
  let blockedTotal = 0;
  let framesReaped = 0;

  /** Suffix match, so "sync.adnxs.com" hits "adnxs.com" but "notadnxs.com" does not. */
  function hostIn(host, list) {
    for (const d of list) if (host === d || host.endsWith('.' + d)) return true;
    return false;
  }

  function noteBlock(host) {
    blocked.set(host, (blocked.get(host) || 0) + 1);
    blockedTotal++;
  }

  function isBlocked(url) {
    if (!url || typeof url !== 'string') return false;
    if (/^(data|blob|about|javascript):/i.test(url)) return false;

    let host, path;
    try {
      const u = new URL(url, location.href);
      host = u.hostname.toLowerCase();
      path = u.pathname.toLowerCase();
    } catch (e) { return false; }

    if (host === location.hostname) return false;   // same-origin, incl. the CF challenge
    if (url.toLowerCase().includes('recaptcha')) return false;

    if (hostIn(host, ALLOW_HOSTS)) {
      // The CDN is otherwise essential, but it also serves the ad wrapper.
      if (cfg.blockAds && path.includes('trn-moolah')) { noteBlock(host + path); return true; }
      return false;
    }

    if (cfg.blockAds && (hostIn(host, AD_HOSTS) || AD_HOST_RE.test(host))) { noteBlock(host); return true; }
    if (cfg.blockAnalytics && hostIn(host, ANALYTICS_HOSTS)) { noteBlock(host); return true; }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Network interception — the cheapest fix is the request never firing
   * ------------------------------------------------------------------ */

  // 1. Element creation: neutralize src on script/iframe/img before the request starts.
  const createElement = W.Document.prototype.createElement;
  W.Document.prototype.createElement = function (tag, opts) {
    const el = createElement.call(this, tag, opts);
    const t = String(tag || '').toLowerCase();
    if (t === 'script' || t === 'iframe' || t === 'img') {
      let real = '';
      try {
        Object.defineProperty(el, 'src', {
          configurable: true,
          get() { return real; },
          set(v) {
            if (isBlocked(String(v))) { real = ''; return; }
            real = v;
            el.setAttribute('src', v);
          },
        });
      } catch (e) { /* redefinition refused; the observer below still catches it */ }
    }
    return el;
  };

  // 2. Insertion guards, for nodes built via setAttribute or innerHTML.
  function guardInsert(name) {
    const orig = W.Node.prototype[name];
    W.Node.prototype[name] = function (node) {
      try {
        if (node && node.nodeType === 1 && (node.tagName === 'SCRIPT' || node.tagName === 'IFRAME')) {
          const src = node.getAttribute && node.getAttribute('src');
          if (src && isBlocked(src)) return node; // report success, insert nothing
        }
      } catch (e) { /* fall through to the real insert */ }
      return orig.apply(this, arguments);
    };
  }
  guardInsert('appendChild');
  guardInsert('insertBefore');

  // 3. fetch / XHR / sendBeacon.
  const origFetch = W.fetch;
  if (typeof origFetch === 'function') {
    W.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (isBlocked(url)) return Promise.resolve(new W.Response('', { status: 204, statusText: 'blocked' }));
      return origFetch.apply(this, arguments);
    };
  }

  const origOpen = W.XMLHttpRequest.prototype.open;
  W.XMLHttpRequest.prototype.open = function (method, url) {
    if (isBlocked(String(url))) {
      this.__trnBlocked = true;
      return origOpen.call(this, method, 'data:text/plain,');
    }
    return origOpen.apply(this, arguments);
  };
  const origSend = W.XMLHttpRequest.prototype.send;
  W.XMLHttpRequest.prototype.send = function () {
    if (this.__trnBlocked) return;
    return origSend.apply(this, arguments);
  };

  if (W.navigator && W.navigator.sendBeacon) {
    const origBeacon = W.navigator.sendBeacon.bind(W.navigator);
    W.navigator.sendBeacon = function (url) {
      if (isBlocked(String(url))) return true;
      return origBeacon.apply(null, arguments);
    };
  }

  /* ------------------------------------------------------------------ *
   * Stubs — the site calls these directly; without them it throws
   * ------------------------------------------------------------------ */

  function noop() {}

  /** Callable, chainable, never-throwing placeholder. */
  function makeStub() {
    return new Proxy(function () {}, {
      get(t, k) {
        if (k === 'then' || k === Symbol.toStringTag) return undefined;
        if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') return () => '';
        if (k === 'length') return 0;
        if (k === 'push' || k === 'unshift') return () => 0;
        if (k === 'cmd' || k === 'que' || k === 'queue') return { push: noop, length: 0 };
        return makeStub();
      },
      set() { return true; },
      apply() { return makeStub(); },
      construct() { return makeStub(); },
      has() { return true; },
    });
  }

  function lockStub(name, value) {
    try {
      Object.defineProperty(W, name, {
        configurable: false,
        get() { return value; },
        set() { /* ignore the real library if it ever loads */ },
      });
    } catch (e) { try { W[name] = value; } catch (e2) {} }
  }

  if (cfg.blockAds) {
    // NitroPay is the top-level ad manager on tracker.gg.
    lockStub('nitroAds', {
      loaded: true, version: '0.0.0-stub', siteId: 0, geo: 'us', regionCode: 'US',
      abp: false,        // never report an ad blocker
      acceptable: true, gptSlots: [], blocklist: [],
      queue: { push(fn) { try { if (typeof fn === 'function') fn(); } catch (e) {} }, length: 0 },
      createAd: () => makeStub(),
      addUserToken: noop, clearUserTokens: noop, navigate: noop, setLevel: noop, stop: noop,
    });

    lockStub('googletag', {
      cmd: { push: noop, length: 0 }, apiReady: false, pubadsReady: false,
      pubads: () => makeStub(), defineSlot: () => makeStub(), defineOutOfPageSlot: () => makeStub(),
      sizeMapping: () => makeStub(), enableServices: noop, display: noop, destroySlots: noop,
    });

    lockStub('pbjs', {
      que: { push: noop }, cmd: { push: noop }, libLoaded: false,
      requestBids: noop, setConfig: noop, addAdUnits: noop, getBidResponses: () => ({}),
      getHighestCpmBids: () => [], onEvent: noop, offEvent: noop, setTargetingForGPTAsync: noop,
    });

    lockStub('apstag', {
      init: noop, fetchBids: (o, cb) => { try { if (cb) cb([]); } catch (e) {} },
      setDisplayBids: noop, targetingKeys: () => [], _Q: [],
    });

    lockStub('confiant', makeStub());
    lockStub('Primis', makeStub());
  }

  if (cfg.blockAnalytics) {
    try { W.dataLayer = { push: noop, length: 0 }; } catch (e) {}
    try { W.ga = noop; W.gtag = noop; } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * Styles
   * ------------------------------------------------------------------ */

  const AD_SELECTORS = [
    // Deliberately narrow. A broad [class*="ad"] rule would also hide the site's
    // ad-block bait element, which is exactly what detection scripts measure.
    'div.ad',
    '[id^="Tracker.gg_"]',
    '[id^="nn_"]', '[class^="nn_"]',
    '[id^="nitro"]',
    'ins.adsbygoogle',
    'iframe[id^="google_ads_iframe"]',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication"]',
    'iframe[src*="safeframe"]',
    'iframe[src*="amazon-adsystem"]',
    'iframe[src*="user_sync"]',
    'iframe[src*="usync"]',
    'iframe[src*="syncframe"]',
  ];

  const VIDEO_AD_SELECTORS = [
    '[id*="primis" i]', '[class*="primis" i]',
    '[id^="sekindo"]', '[id*="Sekindo"]', 'iframe[src*="sekindo"]',
    '#adContainerDiv', '#adVpaid', '#adIma', '#adDisplayBanner',
    '#adCover', '#dcAdCover', '#adBreakDiv', '#adBreakPreloader',
  ];

  function addStyle(css, id) {
    const s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }

  const css = [];
  if (cfg.hideSlots) {
    css.push(AD_SELECTORS.join(',') +
      '{display:none!important;min-height:0!important;height:0!important;margin:0!important;padding:0!important}');
  }
  if (cfg.killVideoAds) css.push(VIDEO_AD_SELECTORS.join(',') + '{display:none!important}');
  // Fixed-position decorative backdrop: full-viewport paint cost, no content.
  css.push('.trn-scroll-peek{display:none!important}');
  if (cfg.noBlur) css.push('*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}');
  if (cfg.contentVis) css.push('.app-card,.v3-card,.trn-card{content-visibility:auto;contain-intrinsic-size:auto 320px}');
  if (cfg.unstickNav) css.push('.trn-navigation{position:relative!important;top:auto!important}');
  if (cfg.reduceMotion) {
    css.push('*,*::before,*::after{animation-duration:.001ms!important;animation-delay:0ms!important;' +
      'transition-duration:.001ms!important;transition-delay:0ms!important;scroll-behavior:auto!important}');
  }
  addStyle(css.join('\n'), 'trn-optimizer-style');

  if (cfg.preconnect) {
    for (const href of ['https://api.tracker.gg', 'https://trackercdn.com']) {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = href;
      l.crossOrigin = 'anonymous';
      (document.head || document.documentElement).appendChild(l);
    }
  }

  /* ------------------------------------------------------------------ *
   * DOM cleanup
   * ------------------------------------------------------------------ */

  const KILL = AD_SELECTORS.concat(cfg.killVideoAds ? VIDEO_AD_SELECTORS : []).join(',');
  const BAD_MEDIA = /primis|sekindo|doubleclick|googlesyndication|imasdk|p7cloud/i;

  function isEmptyish(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if ((el.textContent || '').trim()) return false;
    if (el.querySelector('img,svg,canvas,video,input,button,a')) return false;
    return el.getBoundingClientRect().height <= 4 || el.children.length === 0;
  }

  /** Ad slots sit inside wrappers that reserve height; drop those too. */
  function collapseWrapper(node) {
    let p = node.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      if (p.id === 'app' || p.tagName === 'MAIN' || p.tagName === 'BODY') break;
      if (isEmptyish(p)) p.style.setProperty('display', 'none', 'important');
      p = p.parentElement;
    }
  }

  /**
   * Remove third-party iframes outright. This is the single biggest memory win:
   * each surviving frame is its own JS realm holding several MB plus timers.
   */
  function reapFrames(root) {
    if (!cfg.reapFrames || !root.querySelectorAll) return;
    for (const f of root.querySelectorAll('iframe')) {
      const src = f.getAttribute('src') || f.src || '';
      if (!src || src.startsWith('about:')) continue; // usually the site's own or Stripe's
      let host;
      try { host = new URL(src, location.href).hostname.toLowerCase(); } catch (e) { continue; }
      if (host === location.hostname || hostIn(host, FRAME_ALLOW)) continue;
      f.remove();
      framesReaped++;
    }
  }

  function scrub(root) {
    if (!root || root.nodeType !== 1) return;

    let nodes = [];
    try {
      if (root.matches && root.matches(KILL)) nodes.push(root);
      if (root.querySelectorAll) nodes = nodes.concat([].slice.call(root.querySelectorAll(KILL)));
    } catch (e) { return; }

    for (const n of nodes) {
      if (n.__trnKilled) continue;
      n.__trnKilled = true;
      collapseWrapper(n);
      n.remove();
    }

    reapFrames(root);

    if (cfg.killVideoAds && root.querySelectorAll) {
      for (const v of root.querySelectorAll('video')) {
        const src = v.currentSrc || v.src || '';
        if (BAD_MEDIA.test(src)) {
          try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
          v.remove();
        }
      }
    }

    if (cfg.lazyImages && root.querySelectorAll) {
      for (const img of root.querySelectorAll('img:not([data-trn-lazy])')) {
        img.dataset.trnLazy = '1';
        img.decoding = 'async';
        // Above-the-fold images stay eager so the first paint does not regress.
        if (!img.getAttribute('loading') && img.getBoundingClientRect().top > innerHeight) {
          img.loading = 'lazy';
        }
      }
    }
  }

  let pending = false;
  const observer = new MutationObserver((records) => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      for (const r of records) for (const n of r.addedNodes) scrub(n);
    });
  });

  function start() {
    scrub(document.documentElement);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });

  document.addEventListener('DOMContentLoaded', () => scrub(document.documentElement));
  W.addEventListener('load', () => setTimeout(() => scrub(document.documentElement), 500));

  // Late-injected frames (cookie syncs arrive seconds after load). Cheap, so a
  // slow interval is enough; it stops entirely while the tab is hidden.
  setInterval(() => {
    if (document.hidden) return;
    reapFrames(document);
  }, 5000);

  // tracker.gg is an SPA: re-scrub on route change.
  for (const m of ['pushState', 'replaceState']) {
    const orig = W.history[m];
    W.history[m] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(() => scrub(document.documentElement), 100);
      return r;
    };
  }
  W.addEventListener('popstate', () => setTimeout(() => scrub(document.documentElement), 100));

  /* ------------------------------------------------------------------ *
   * Background-tab quieting
   * ------------------------------------------------------------------ */

  if (cfg.pauseHidden) {
    let pausedStyle = null;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        for (const v of document.querySelectorAll('video,audio')) {
          if (!v.paused) { v.__trnAutoPaused = true; try { v.pause(); } catch (e) {} }
        }
        if (!pausedStyle) {
          pausedStyle = addStyle('*,*::before,*::after{animation-play-state:paused!important}', 'trn-optimizer-paused');
        }
      } else {
        for (const v of document.querySelectorAll('video,audio')) {
          if (v.__trnAutoPaused) { v.__trnAutoPaused = false; v.play().catch(() => {}); }
        }
        if (pausedStyle) { pausedStyle.remove(); pausedStyle = null; }
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Perf HUD
   * ------------------------------------------------------------------ */

  let hud = null;
  let hudTimer = null;

  function stats() {
    const mem = W.performance && W.performance.memory;
    return {
      heap: mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'n/a',
      frames: document.querySelectorAll('iframe').length,
      nodes: document.getElementsByTagName('*').length,
      blocked: blockedTotal,
      reaped: framesReaped,
    };
  }

  function renderHud() {
    if (!hud) return;
    const s = stats();
    hud.textContent = `heap ${s.heap} · frames ${s.frames} · nodes ${s.nodes} · blocked ${s.blocked}`;
  }

  function setHud(on) {
    if (on && !hud) {
      hud = document.createElement('div');
      hud.style.cssText =
        'position:fixed;left:8px;bottom:8px;z-index:2147483646;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'color:#9aa3b6;background:rgba(15,17,23,.88);border:1px solid #2a2e3a;border-radius:6px;padding:4px 8px;' +
        'pointer-events:none;white-space:nowrap';
      (document.body || document.documentElement).appendChild(hud);
      renderHud();
      hudTimer = setInterval(renderHud, 2000);
    } else if (!on && hud) {
      clearInterval(hudTimer);
      hud.remove();
      hud = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Settings panel (Alt+O, or the userscript menu)
   * ------------------------------------------------------------------ */

  const LABELS = {
    blockAds:       ['Block ads & bidders', 'NitroPay, GPT/Prebid, Amazon, cookie syncs'],
    blockAnalytics: ['Block analytics', 'GA/GTM, Comscore, CF Insights'],
    killVideoAds:   ['Kill floating video player', 'Primis/sekindo + its video decoder'],
    reapFrames:     ['Reap third-party iframes', 'Biggest memory win — each frame is its own JS heap'],
    hideSlots:      ['Hide & collapse ad slots', 'Removes the reserved empty space'],
    pauseHidden:    ['Quiet background tab', 'Pause media + animations when hidden'],
    contentVis:     ['Skip off-screen rendering', 'content-visibility on cards'],
    lazyImages:     ['Lazy-load images', 'Off-screen images load on demand'],
    noBlur:         ['Disable blur effects', 'backdrop-filter is GPU-expensive'],
    preconnect:     ['Preconnect to API/CDN', 'Shaves the first-request handshake'],
    reduceMotion:   ['Reduce motion', 'Near-instant animations'],
    unstickNav:     ['Unstick top nav', 'Nav scrolls away with the page'],
    showHud:        ['Show perf HUD', 'Live heap / frame / node counter'],
  };

  const LIVE = { showHud: setHud }; // toggles that apply without a reload

  let panelHost = null;

  function togglePanel() {
    if (panelHost) { panelHost.remove(); panelHost = null; return; }

    panelHost = document.createElement('div');
    panelHost.style.cssText = 'position:fixed;inset:auto 16px 16px auto;z-index:2147483647';
    const root = panelHost.attachShadow({ mode: 'open' });

    const rows = Object.keys(DEFAULTS).map((k) => `
      <label class="row">
        <input type="checkbox" data-k="${k}" ${cfg[k] ? 'checked' : ''}>
        <span><b>${LABELS[k][0]}</b><em>${LABELS[k][1]}</em></span>
      </label>`).join('');

    const top = [...blocked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([h, c]) => `<li><span>${h}</span><b>${c}</b></li>`).join('') || '<li><span>nothing yet</span></li>';

    const s = stats();

    root.innerHTML = `
      <style>
        :host{all:initial}
        .panel{font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#e6e8ee;
          background:#14161c;border:1px solid #2a2e3a;border-radius:10px;width:310px;
          box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden}
        header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;
          background:#1b1e27;border-bottom:1px solid #2a2e3a;font-weight:600}
        button{all:unset;cursor:pointer;color:#8b93a7;padding:0 4px}
        button:hover{color:#fff}
        .body{padding:4px 12px 8px;max-height:52vh;overflow:auto}
        .row{display:flex;gap:9px;align-items:flex-start;padding:7px 0;cursor:pointer;border-bottom:1px solid #20242e}
        .row:last-of-type{border-bottom:0}
        .row input{margin-top:2px;accent-color:#4a9eff}
        .row b{display:block;font-weight:500}
        .row em{display:block;font-style:normal;color:#7d8598;font-size:11px}
        .stats{border-top:1px solid #2a2e3a;padding:9px 12px;background:#11131a}
        .stats h4{margin:0 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#7d8598}
        .stats ul{margin:0;padding:0;list-style:none;font-size:11px;color:#9aa3b6}
        .stats li{display:flex;justify-content:space-between;gap:8px}
        .stats li b{color:#4a9eff;font-weight:500}
        .now{display:flex;gap:10px;margin-bottom:7px;font:11px ui-monospace,Menlo,monospace;color:#9aa3b6}
        .now i{font-style:normal;color:#4a9eff}
        .note{padding:8px 12px;font-size:11px;color:#7d8598;background:#11131a;border-top:1px solid #2a2e3a}
      </style>
      <div class="panel">
        <header><span>Tracker.gg Optimizer</span><button id="x">✕</button></header>
        <div class="body">${rows}</div>
        <div class="stats">
          <div class="now">heap <i>${s.heap}</i> frames <i>${s.frames}</i> nodes <i>${s.nodes}</i></div>
          <h4>Blocked this page — ${blockedTotal} request${blockedTotal === 1 ? '' : 's'}</h4>
          <ul>${top}</ul>
        </div>
        <div class="note">Most toggles apply on reload.</div>
      </div>`;

    root.getElementById('x').onclick = togglePanel;
    root.querySelectorAll('input[data-k]').forEach((box) => {
      box.onchange = () => {
        const k = box.dataset.k;
        cfg[k] = box.checked;
        store.set(k, box.checked);
        if (LIVE[k]) LIVE[k](box.checked);
      };
    });

    document.body.appendChild(panelHost);
  }

  W.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      togglePanel();
    }
  });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('⚙ Settings (Alt+O)', togglePanel);
    GM_registerMenuCommand('📊 Log blocked requests', () => {
      console.table([...blocked.entries()].map(([host, count]) => ({ host, count })));
      console.log('[trn-optimizer]', stats());
    });
  }

  if (cfg.showHud) {
    if (document.body) setHud(true);
    else document.addEventListener('DOMContentLoaded', () => setHud(true), { once: true });
  }
})();
