'use strict';

const express  = require('express');
const axios    = require('axios');
const cheerio  = require('cheerio');
const archiver = require('archiver');
const path     = require('path');
const fs       = require('fs');
const { URL }  = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');
const nodeFetch = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SOCKS5 Proxy ──────────────────────────────────────────────────────────────
const proxyUrl = 'socks5://mevyuxgz:45mlsshm4lr6@216.10.27.159:6837';
const enableStickyGoogleProxy = process.env.ENABLE_STICKY_GOOGLE_PROXY === '1';
console.log('🔒 SOCKS5 Proxy configured: 216.10.27.159:6837');

const proxyAgentCache = new Map();

function isGoogleHost(hostname) {
  return /(^|\.)google\./i.test(hostname || '');
}
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'x';
}
function toSafeSessionToken(raw) {
  return String(raw || 'x').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 24) || 'x';
}
function buildStickyGoogleProxyUrl(baseProxyUrl, req) {
  const u = new URL(baseProxyUrl);
  const baseUsername = decodeURIComponent(u.username || '');
  if (!baseUsername) return baseProxyUrl;
  const sess = toSafeSessionToken(getClientIp(req));
  if (/-session-[a-z0-9]+$/i.test(baseUsername)) return baseProxyUrl;
  u.username = `${baseUsername}-session-${sess}`;
  return u.toString();
}
function getRequestProxyAgent(targetUrl, req) {
  let resolvedProxyUrl = proxyUrl;
  try {
    const host = new URL(targetUrl).hostname;
    if (enableStickyGoogleProxy && isGoogleHost(host)) {
      resolvedProxyUrl = buildStickyGoogleProxyUrl(proxyUrl, req);
    }
  } catch {}
  if (!proxyAgentCache.has(resolvedProxyUrl)) {
    proxyAgentCache.set(resolvedProxyUrl, new SocksProxyAgent(resolvedProxyUrl, { rejectUnauthorized: false }));
  }
  return proxyAgentCache.get(resolvedProxyUrl);
}

function decodeBase64UrlToken(token) {
  if (!token || typeof token !== 'string') return '';
  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try { return Buffer.from(padded, 'base64').toString('utf-8').trim(); }
  catch { return ''; }
}

// ── IP → last proxied origin ──────────────────────────────────────────────────
const ipOriginMap = new Map();
function setIpOrigin(req, origin) {
  const ip = getClientIp(req);
  ipOriginMap.set(ip, origin);
  if (ipOriginMap.size > 500) ipOriginMap.delete(ipOriginMap.keys().next().value);
}
function getIpOrigin(req) {
  return ipOriginMap.get(getClientIp(req)) || null;
}

// ── YouTube.js client ─────────────────────────────────────────────────────────
let ytClient = null;
async function getYT() {
  if (ytClient) return ytClient;
  const ytjs = await import('youtubei.js');
  const { Innertube, Platform } = ytjs;
  Platform.shim.eval = async (data, env) => {
    const props = [];
    if (env.n)   props.push(`n: exportedVars.nFunction("${env.n}")`);
    if (env.sig) props.push(`sig: exportedVars.sigFunction("${env.sig}")`);
    const code = `${data.output}\nreturn { ${props.join(', ')} }`;
    return new Function(code)();
  };
  ytClient = await Innertube.create({ generate_session_locally: true });
  console.log('  🎬  YouTube.js ready');
  return ytClient;
}
getYT().catch(() => {});

// ─── URL Utilities ────────────────────────────────────────────────────────────
function isAbsoluteUrl(u) { return /^https?:\/\//i.test(u); }

function resolveUrl(base, relative) {
  if (!relative || typeof relative !== 'string') return null;
  const skip = ['data:', 'blob:', 'javascript:', 'mailto:', 'tel:', 'about:'];
  if (skip.some(s => relative.startsWith(s))) return relative;
  if (relative.startsWith('#')) return relative;
  try { return new URL(relative, base).href; } catch { return null; }
}

function toProxyPath(u) {
  if (!u || typeof u !== 'string') return u;
  const skip = ['data:', 'blob:', 'javascript:', 'mailto:', 'tel:', 'about:', '#'];
  if (skip.some(s => u.startsWith(s))) return u;
  if (u.startsWith('/proxy/')) return u;
  return '/proxy/' + u;
}

function rewriteAttrValue(val, base) {
  if (!val) return val;
  const r = resolveUrl(base, val);
  return (r && isAbsoluteUrl(r)) ? toProxyPath(r) : val;
}

// ─── CSS Rewriter ─────────────────────────────────────────────────────────────
function rewriteCSS(css, base) {
  if (!css || typeof css !== 'string') return css;
  css = css.replace(/url\(\s*(['"]?)(.+?)\1\s*\)/gi, (m, q, u) => {
    u = u.trim();
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return m;
    const r = resolveUrl(base, u);
    return (r && isAbsoluteUrl(r)) ? `url(${q}${toProxyPath(r)}${q})` : m;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    const r = resolveUrl(base, u);
    return (r && isAbsoluteUrl(r)) ? `@import ${q}${toProxyPath(r)}${q}` : m;
  });
  return css;
}

// ─── JS Rewriter ──────────────────────────────────────────────────────────────
function rewriteJS(js) {
  if (!js || typeof js !== 'string') return js;
  try {
    js = js.replace(/window\.location/g, '(window.__pxLoc||window.location)');
    js = js.replace(/document\.location/g, '(window.__pxLoc||document.location)');
    js = js.replace(/([^a-zA-Z0-9_.]|^)location\.(href|hostname|host|origin|protocol|port|pathname|search|hash|assign|replace|reload)\b/g, '$1(window.__pxLoc||location).$2');
    return js;
  } catch { return js; }
}

function rewriteSrcset(srcset, base) {
  if (!srcset) return srcset;
  const entries = [];
  let buf = '', inData = false;
  for (let i = 0; i < srcset.length; i++) {
    const ch = srcset[i];
    if (!inData && buf.trimStart().startsWith('data:')) inData = true;
    if (ch === ',' && !inData) { entries.push(buf); buf = ''; inData = false; }
    else buf += ch;
  }
  if (buf) entries.push(buf);
  return entries.map(entry => {
    entry = entry.trim();
    if (!entry || entry.startsWith('data:')) return entry;
    const match = entry.match(/^(\S+)(\s+.+)?$/);
    if (!match) return entry;
    const [, u, d] = match;
    if (u.startsWith('data:')) return entry;
    const r = resolveUrl(base, u);
    return (r && isAbsoluteUrl(r)) ? toProxyPath(r) + (d || '') : entry;
  }).join(', ');
}

// ─── Injection Script ─────────────────────────────────────────────────────────
// Comprehensive spoofing of: location, document, window hierarchy, fetch/XHR,
// CSS, click/submit interceptors. Each section wrapped in try/catch so a single
// failure never breaks the rest of the page's JS.

function buildInjectionScript(base) {
  let origin = '', hostname = '', protocol = 'https:', port = '', fullUrl = '';
  try {
    const u = new URL(base);
    origin   = u.origin;
    hostname = u.hostname;
    protocol = u.protocol;
    port     = u.port;
    fullUrl  = u.href;
  } catch {}

  return `<script>
(function(){
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
var ORIGIN   = ${JSON.stringify(origin)};
var HOSTNAME = ${JSON.stringify(hostname)};
var PROTOCOL = ${JSON.stringify(protocol)};
var PORT     = ${JSON.stringify(port)};
var TURL     = ${JSON.stringify(fullUrl)};
var PFX      = '/proxy/';
var LORG     = location.origin;

var _realParent = window.parent;
var _realTop    = window.top;
var _isSelf     = (_realTop === window);

// ── Helper ──────────────────────────────────────────────────────────────────
function defProp(obj, prop, descriptor) {
  try { Object.defineProperty(obj, prop, Object.assign({ configurable: true }, descriptor)); } catch(e) {}
}

// ── 0. Native-function toString cloaking ─────────────────────────────────────
// Sites call fn.toString() to see if it returns '[native code]'. If not,
// they know the function was monkey-patched → proxy detected → freeze/hang.
var _origToString = Function.prototype.toString;
var _nativeMap = new WeakMap();
function markNative(fn, name) {
  if (typeof fn === 'function' && name) _nativeMap.set(fn, name);
  return fn;
}
try {
  Function.prototype.toString = function() {
    var n = _nativeMap.get(this);
    if (n) return 'function ' + n + '() { [native code] }';
    return _origToString.call(this);
  };
  _nativeMap.set(Function.prototype.toString, 'toString');
} catch(e) {}

// ── 0b. Object.getOwnPropertyDescriptor masking ─────────────────────────────
// Sites inspect descriptors to check if getters look native. We hide ours.
var _origGOPD = Object.getOwnPropertyDescriptor;
var _maskedDescs = new WeakMap();
function maskDesc(obj, prop, fakeDesc) {
  if (!_maskedDescs.has(obj)) _maskedDescs.set(obj, new Map());
  _maskedDescs.get(obj).set(prop, fakeDesc);
}
try {
  Object.getOwnPropertyDescriptor = markNative(function getOwnPropertyDescriptor(obj, prop) {
    var m = _maskedDescs.get(obj);
    if (m && m.has(prop)) return m.get(prop);
    return _origGOPD.call(Object, obj, prop);
  }, 'getOwnPropertyDescriptor');
} catch(e) {}

// Core URL rewriter
function px(url) {
  if (!url || typeof url !== 'string') return url;
  var t = url.trim();
  if (!t) return url;
  var skip = ['data:','blob:','javascript:','mailto:','tel:','about:','#'];
  for (var i = 0; i < skip.length; i++) { if (t.indexOf(skip[i]) === 0) return t; }
  if (t.indexOf(PFX) === 0) return t;
  if (t.indexOf(LORG + PFX) === 0) return t.slice(LORG.length);
  if (t.indexOf(LORG) === 0) {
    var rel = t.slice(LORG.length) || '/';
    return rel.indexOf(PFX) === 0 ? rel : PFX + ORIGIN + rel;
  }
  try {
    var abs;
    if (/^https?:\\/\\//.test(t))       { abs = t; }
    else if (t.indexOf('//') === 0)     { abs = 'https:' + t; }
    else if (t.charAt(0) === '/')       { abs = ORIGIN + t; }
    else {
      var cur = location.pathname + location.search;
      if (cur.indexOf(PFX) === 0) {
        try { abs = new URL(t, cur.slice(PFX.length)).href; }
        catch(e) { abs = ORIGIN + '/' + t; }
      } else {
        try { abs = new URL(t, location.href).href; }
        catch(e) { abs = ORIGIN + '/' + t; }
      }
    }
    if (abs.indexOf(LORG + PFX) === 0) return abs.slice(LORG.length);
    if (abs.indexOf(LORG) === 0) {
      var rel2 = abs.slice(LORG.length) || '/';
      return rel2.indexOf(PFX) === 0 ? rel2 : PFX + ORIGIN + rel2;
    }
    return PFX + abs;
  } catch(e) { return url; }
}

// CSS url() rewriter
function pxCss(v) {
  if (!v || typeof v !== 'string') return v;
  return v.replace(/url\\(\\s*(['"]?)(.+?)\\1\\s*\\)/gi, function(m, q, u) {
    u = u.trim();
    if (!u || u.indexOf('data:') === 0 || u.indexOf('blob:') === 0 || u.charAt(0) === '#') return m;
    var r = px(u);
    return r === u ? m : 'url(' + q + r + q + ')';
  });
}

// Notify parent frame of URL change
function notifyParent() {
  try {
    if (_realParent !== window)
      _realParent.postMessage({ type: 'proxyNav' }, '*');
  } catch(e) {}
}

// Rewrite any existing inline styles (pre-mutation observer)
function rewriteExistingStyles() {
  try {
    var els = document.querySelectorAll('[style]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var s = el.getAttribute('style');
      if (s) {
        var r = rewriteCSS(s, document.location.href);
        if (r !== s) el.setAttribute('style', r);
      }
    }
  } catch(e) {}
}
rewriteExistingStyles();

// ── 1. window.top / parent / self / frameElement ─────────────────────────────
try {
  defProp(window, 'top',          { get: function() { return window; } });
  defProp(window, 'parent',       { get: function() { return window; } });
  defProp(window, 'self',         { get: function() { return window; } });
  defProp(window, 'frameElement', { get: function() { return null; } });
  defProp(window, 'origin',       { get: function() { return ORIGIN; } });
  // Mask descriptors so they look like native accessors to introspection
  var _nativeUndef = { set: undefined, enumerable: true, configurable: true };
  try { maskDesc(window, 'top',    Object.assign({ get: _origGOPD.call(Object, Window.prototype, 'top')?.get }, _nativeUndef)); } catch(e) {}
  try { maskDesc(window, 'parent', Object.assign({ get: _origGOPD.call(Object, Window.prototype, 'parent')?.get }, _nativeUndef)); } catch(e) {}
  try { maskDesc(window, 'origin', Object.assign({ get: _origGOPD.call(Object, Window.prototype, 'origin')?.get }, _nativeUndef)); } catch(e) {}
} catch(e) {}

// ── 2. location spoof ────────────────────────────────────────────────────────
  var _lp = null;
  try { _lp = Object.getPrototypeOf(window.location); } catch(e) {}

  // Helper to get the real raw href
  var _rawHref = null;
  if (_lp) {
    try { _rawHref = Object.getOwnPropertyDescriptor(_lp, 'href'); } catch(e) {}
  }

  function getRealHref() {
    if (_rawHref && _rawHref.get) {
      try { return _rawHref.get.call(location); } catch(e) {}
    }
    return location.href;
  }

  // Extract the proxied original URL from the real href
  // Track current proxied URL; starts with server-injected value, updated by SPA nav
  var _currentTargetUrl = TURL || (ORIGIN + '/');

  function getProxiedUrl() {
    var real = getRealHref();
    if (real && real.indexOf(LORG + PFX) === 0) {
      var rest = real.slice((LORG + PFX).length);
      // Only use the extracted rest if it's a parseable absolute URL
      if (rest && /^https?:\\/\\//.test(rest)) return rest;
    }
    // Fallback: use server-injected target URL (handles base64-token routes)
    return _currentTargetUrl;
  }

  function getProxiedParsed() {
    try { return new URL(getProxiedUrl()); } catch(e) { return null; }
  }

  // Inject a complete spoofed location object for the JS rewriter
  window.__pxLoc = {
    get href() { var p = getProxiedParsed(); return p ? p.href : (ORIGIN + '/'); },
    set href(v) { try { v = px(String(v)); } catch(e) {} if(_rawHref && _rawHref.set) { _rawHref.set.call(location, v); } else { location.href = v; } },
    get hostname() { var p = getProxiedParsed(); return p ? p.hostname : HOSTNAME; },
    get host() { var p = getProxiedParsed(); return p ? p.host : (HOSTNAME + (PORT ? ':' + PORT : '')); },
    get origin() { var p = getProxiedParsed(); return p ? p.origin : ORIGIN; },
    get protocol() { var p = getProxiedParsed(); return p ? p.protocol : PROTOCOL; },
    get port() { var p = getProxiedParsed(); return p ? p.port : PORT; },
    get pathname() { var p = getProxiedParsed(); return p ? p.pathname : '/'; },
    set pathname(v) { try { if(_rawHref && _rawHref.set) { _rawHref.set.call(location, px(ORIGIN + v)); } else { location.pathname = px(ORIGIN + v); } } catch(e) {} },
    get search() { var p = getProxiedParsed(); return p ? p.search : ''; },
    set search(v) { try { var p = getProxiedParsed() || new URL(ORIGIN + '/'); p.search = v; if(_rawHref && _rawHref.set) { _rawHref.set.call(location, px(p.href)); } else { location.search = v; } } catch(e) {} },
    get hash() { return window.location.hash; },
    set hash(v) { window.location.hash = v; },
    assign: function(v) { try { v = px(String(v)); } catch(e) {} window.location.assign(v); },
    replace: function(v) { try { v = px(String(v)); } catch(e) {} window.location.replace(v); },
    reload: function(f) { window.location.reload(f); },
    toString: function() { return this.href; },
    valueOf: function() { return this.href; }
  };

try {
  // href
  if (_rawHref && _rawHref.get && _rawHref.set) {
    defProp(_lp, 'href', {
      get: function() {
        var p = getProxiedParsed();
        return p ? p.href : (ORIGIN + '/');
      },
      set: function(v) {
        try { v = px(String(v)); } catch(e) {}
        _rawHref.set.call(this, v);
      }
    });
  }

  // hostname
  defProp(_lp, 'hostname', { get: function() { var p = getProxiedParsed(); return p ? p.hostname : HOSTNAME; } });
  defProp(_lp, 'host',     { get: function() { var p = getProxiedParsed(); return p ? p.host : (HOSTNAME + (PORT ? ':' + PORT : '')); } });
  defProp(_lp, 'origin',   { get: function() { var p = getProxiedParsed(); return p ? p.origin : ORIGIN; } });
  defProp(_lp, 'protocol', { get: function() { var p = getProxiedParsed(); return p ? p.protocol : PROTOCOL; } });
  defProp(_lp, 'port',     { get: function() { var p = getProxiedParsed(); return p ? p.port : PORT; } });

  // pathname
  defProp(_lp, 'pathname', {
    get: function() {
      var p = getProxiedParsed();
      return p ? p.pathname : '/';
    },
    set: function(v) {
      try { _rawHref.set.call(this, px(ORIGIN + v)); } catch(e) {}
    }
  });

  // search
  defProp(_lp, 'search', {
    get: function() {
      var p = getProxiedParsed();
      return p ? p.search : '';
    },
    set: function(v) {
      try {
        var p = getProxiedParsed() || new URL(ORIGIN + '/');
        p.search = v;
        _rawHref.set.call(this, px(p.href));
      } catch(e) {}
    }
  });

  // hash
  var _rawHash = Object.getOwnPropertyDescriptor(_lp, 'hash');
  if (_rawHash && _rawHash.get) {
    defProp(_lp, 'hash', {
      get: function() { return _rawHash.get.call(this); },
      set: function(v) { if (_rawHash.set) _rawHash.set.call(this, v); }
    });
  }

  // toString / valueOf
  try { _lp.toString = function() { return this.href; }; } catch(e) {}
  try { _lp.valueOf  = function() { return this.href; }; } catch(e) {}

  // assign / replace
  var _la = location.assign.bind(location);
  var _lr = location.replace.bind(location);
  try { location.assign  = function(v) { try { v = px(String(v)); } catch(e) {} _la(v); }; } catch(e) {}
  try { location.replace = function(v) { try { v = px(String(v)); } catch(e) {} _lr(v); }; } catch(e) {}

  // reload — throttle to stop loops (YouTube, etc.)
  var _rl = location.reload.bind(location);
  var _lrt = 0;
  try {
    defProp(location, 'reload', {
      value: function(force) {
        var now = Date.now();
        if (now - _lrt < 8000) return; // 8-second guard
        _lrt = now;
        _rl(force);
      },
      writable: true
    });
  } catch(e) {}

} catch(e) {}

// ── 3. document property spoofing ────────────────────────────────────────────
try {
  // document.domain
  try {
    defProp(document, 'domain', { get: function() { return HOSTNAME; }, set: function() {} });
  } catch(e) {}

  // document.URL / documentURI — use the full spoofed href
  try {
    var urlGetter = function() {
      try { return location.href; } catch(e) { return _currentTargetUrl; }
    };
    defProp(document, 'URL',         { get: urlGetter });
    defProp(document, 'documentURI', { get: urlGetter });
  } catch(e) {}

  // document.baseURI — use full target URL so relative resolution works
  try {
    defProp(document, 'baseURI', { get: function() { return _currentTargetUrl; } });
  } catch(e) {}

  // document.referrer
  try {
    defProp(document, 'referrer', { get: function() { return ORIGIN + '/'; } });
  } catch(e) {}

  // document.cookie — pass-through but strip proxy domain artifacts
  // (leave native cookie access intact; we handle domain stripping server-side)

} catch(e) {}

// ── 4. navigator spoofing ────────────────────────────────────────────────────
try {
  // Block service worker
  if (navigator.serviceWorker) {
    var _fakeSW = {
      register:         function() { return Promise.resolve({ unregister: function() { return Promise.resolve(true); }, scope: '/', active: null }); },
      getRegistration:  function() { return Promise.resolve(undefined); },
      getRegistrations: function() { return Promise.resolve([]); },
      addEventListener: function() {},
      removeEventListener: function() {},
      ready: new Promise(function() {})
    };
    defProp(navigator, 'serviceWorker', { get: function() { return _fakeSW; } });
  }
} catch(e) {}

// ── 5. history.pushState / replaceState ──────────────────────────────────────
try {
  var _push = history.pushState.bind(history);
  var _rep  = history.replaceState.bind(history);
  history.pushState = function(s, t, u) {
    if (u != null) { try { u = px(String(u)); } catch(e) {} }
    _push(s, t, u);
    // Update tracked target URL after SPA navigation
    try { var nu = getProxiedUrl(); if (/^https?:\\/\\//.test(nu)) _currentTargetUrl = nu; } catch(e) {}
    setTimeout(notifyParent, 0);
  };
  history.replaceState = function(s, t, u) {
    if (u != null) { try { u = px(String(u)); } catch(e) {} }
    _rep(s, t, u);
    try { var nu = getProxiedUrl(); if (/^https?:\\/\\//.test(nu)) _currentTargetUrl = nu; } catch(e) {}
    setTimeout(notifyParent, 0);
  };
  window.addEventListener('popstate', notifyParent);
} catch(e) {}

// ── 6. Navigation API ─────────────────────────────────────────────────────────
// IMPORTANT: We do NOT intercept pushState/traverse navigations here because
// that is what causes the YouTube 3-second reload loop.
// We ONLY intercept "traverse" (link click to our server root without /proxy/).
try {
  if (window.navigation) {
    window.navigation.addEventListener('navigate', function(e) {
      if (!e.canIntercept || e.hashChange || e.downloadRequest) return;
      // Skip SPA-driven navigations (push/replace handled by patched history above)
      if (e.navigationType === 'push' || e.navigationType === 'replace') return;
      var dest = e.destination.url || '';
      // Only intercept if landing on OUR server root (not through proxy)
      if (dest.indexOf(LORG) === 0 && dest.indexOf(LORG + PFX) !== 0) {
        e.intercept({ handler: function() {
          var rel = dest.slice(LORG.length) || '/';
          location.href = rel.indexOf(PFX) === 0 ? rel : PFX + ORIGIN + rel;
          return Promise.resolve();
        }});
      }
    });
  }
} catch(e) {}

// ── 7. window.open → stay in frame ───────────────────────────────────────────
try {
  var _wo = window.open;
  window.open = markNative(function open(url, target, features) {
    if (url && url !== 'about:blank') {
      try { url = px(String(url)); } catch(e) {}
      location.href = url;
      return window;
    }
    return _wo ? _wo.call(window, url, target, features) : null;
  }, 'open');
} catch(e) {}

// ── 8. fetch ─────────────────────────────────────────────────────────────────
try {
  if (window.fetch) {
    var _f = window.fetch;
    window.fetch = markNative(function fetch(input, init) {
      try {
        if (typeof input === 'string') input = px(input);
        else if (input instanceof Request) {
          var u2 = px(input.url);
          if (u2 !== input.url) input = new Request(u2, input);
        }
      } catch(e) {}
      return _f.call(this, input, init);
    }, 'fetch');
  }
} catch(e) {}

// ── 9. XMLHttpRequest ─────────────────────────────────────────────────────────
try {
  var _X = window.XMLHttpRequest;
  var PXR = markNative(function XMLHttpRequest() {
    var x = new _X(), _o = x.open;
    x.open = markNative(function open(m, url) {
      try { url = px(String(url)); } catch(e) {}
      var a = Array.prototype.slice.call(arguments);
      a[1] = url;
      return _o.apply(x, a);
    }, 'open');
    return x;
  }, 'XMLHttpRequest');
  PXR.UNSENT = 0; PXR.OPENED = 1; PXR.HEADERS_RECEIVED = 2;
  PXR.LOADING = 3; PXR.DONE = 4;
  PXR.prototype = _X.prototype;
  window.XMLHttpRequest = PXR;
} catch(e) {}

// ── 10. WebSocket ─────────────────────────────────────────────────────────────
// Let WebSocket connections pass directly to real game servers. Make wrapper invisible.
try {
  var _WS = window.WebSocket;
  if (_WS) {
    var PxWebSocket = markNative(function WebSocket(url, protocols) {
      if (!(this instanceof PxWebSocket)) {
        return protocols ? new _WS(url, protocols) : new _WS(url);
      }
      return protocols ? new _WS(url, protocols) : new _WS(url);
    }, 'WebSocket');
    PxWebSocket.prototype = _WS.prototype;
    PxWebSocket.CONNECTING = _WS.CONNECTING;
    PxWebSocket.OPEN = _WS.OPEN;
    PxWebSocket.CLOSING = _WS.CLOSING;
    PxWebSocket.CLOSED = _WS.CLOSED;
    window.WebSocket = PxWebSocket;
    maskDesc(window, 'WebSocket', { value: PxWebSocket, writable: true, enumerable: false, configurable: true });
  }
} catch(e) {}

// ── 10b. WebRTC — block IP leak ──────────────────────────────────────────────
try {
  if (window.RTCPeerConnection) {
    var _RTC = window.RTCPeerConnection;
    var PxRTC = markNative(function RTCPeerConnection(config, constraints) {
      // Force relay-only ICE to prevent real-IP STUN leak
      config = config || {};
      config.iceTransportPolicy = 'relay';
      if (!config.iceServers) config.iceServers = [];
      return new _RTC(config, constraints);
    }, 'RTCPeerConnection');
    PxRTC.prototype = _RTC.prototype;
    PxRTC.generateCertificate = _RTC.generateCertificate;
    window.RTCPeerConnection = PxRTC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PxRTC;
    maskDesc(window, 'RTCPeerConnection', { value: PxRTC, writable: true, enumerable: false, configurable: true });
  }
} catch(e) {}

// ── 11. HTMLImageElement.src ──────────────────────────────────────────────────
try {
  var _ip = HTMLImageElement.prototype;
  var _sd = Object.getOwnPropertyDescriptor(_ip, 'src');
  if (_sd && _sd.set) {
    defProp(_ip, 'src', {
      get: _sd.get,
      set: function(v) {
        try { v = px(String(v)); } catch(e) {}
        if (!this.hasAttribute('crossorigin')) this.setAttribute('crossorigin', 'anonymous');
        _sd.set.call(this, v);
      }
    });
  }
} catch(e) {}

// ── 12. CSS backgroundImage / background / setProperty ───────────────────────
try {
  var _cp = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
  if (_cp) {
    ['backgroundImage', 'background', 'listStyleImage', 'borderImageSource', 'maskImage'].forEach(function(prop) {
      var _d = Object.getOwnPropertyDescriptor(_cp, prop);
      if (_d && _d.set) {
        defProp(_cp, prop, {
          get: _d.get,
          set: function(v) {
            if (v && v.indexOf('url(') !== -1) { try { v = pxCss(v); } catch(e) {} }
            _d.set.call(this, v);
          }
        });
      }
    });
    // setProperty
    var _sp = _cp.setProperty;
    if (_sp) {
      _cp.setProperty = function(prop, val, pri) {
        var bgProps = ['background','background-image','list-style-image',
                       'border-image-source','mask-image','-webkit-mask-image'];
        if (val && typeof val === 'string' && val.indexOf('url(') !== -1 &&
            bgProps.indexOf(prop.toLowerCase()) !== -1) {
          try { val = pxCss(val); } catch(e) {}
        }
        return _sp.call(this, prop, val, pri);
      };
    }
  }
} catch(e) {}

// ── 13. createElement img → add crossorigin ──────────────────────────────────
try {
  var _ce = document.createElement.bind(document);
  document.createElement = markNative(function createElement(tag) {
    var el = _ce.apply(document, arguments);
    if (typeof tag === 'string' && tag.toLowerCase() === 'img') el.crossOrigin = 'anonymous';
    return el;
  }, 'createElement');
} catch(e) {}

// ── 13b. Anchor / Area element URL-property de-proxying ──────────────────────
try {
  ['HTMLAnchorElement', 'HTMLAreaElement'].forEach(function(cls) {
    var proto = window[cls] && window[cls].prototype;
    if (!proto) return;
    var _hd = Object.getOwnPropertyDescriptor(proto, 'href');
    if (!_hd || !_hd.get) return;

    function deproxy(el) {
      var raw;
      try { raw = _hd.get.call(el); } catch(e) { return null; }
      if (!raw) return null;
      var pfx = LORG + PFX;
      if (raw.indexOf(pfx) === 0) {
        var rest = raw.slice(pfx.length);
        if (/^https?:\\/\\//.test(rest)) {
          try { return new URL(rest); } catch(e) {}
        }
      }
      return null;
    }

    defProp(proto, 'href', {
      get: function() { var p = deproxy(this); return p ? p.href : _hd.get.call(this); },
      set: function(v) { try { v = px(String(v)); } catch(e) {} _hd.set.call(this, v); }
    });

    ['hostname','host','origin','protocol','port','pathname','search','hash'].forEach(function(prop) {
      var _d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!_d || !_d.get) return;
      defProp(proto, prop, {
        get: function() { var p = deproxy(this); return p ? p[prop] : _d.get.call(this); },
        set: _d.set ? function(v) { _d.set.call(this, v); } : undefined
      });
    });

    try { proto.toString = function() { return this.href; }; } catch(e) {}
  });
} catch(e) {}

// ── 13c. Performance API navigation entry spoofing ───────────────────────────
try {
  function rewriteEntryName(name) {
    if (!name || typeof name !== 'string') return name;
    var pfx = LORG + PFX;
    if (name.indexOf(pfx) === 0) {
      var rest = name.slice(pfx.length);
      if (/^https?:\\/\\//.test(rest)) return rest;
    }
    if (name.indexOf(LORG) === 0) {
      return ORIGIN + name.slice(LORG.length);
    }
    return name;
  }
  if (window.PerformanceEntry) {
    var _nameDesc = Object.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'name');
    if (_nameDesc && _nameDesc.get) {
      defProp(PerformanceEntry.prototype, 'name', {
        get: function() { return rewriteEntryName(_nameDesc.get.call(this)); }
      });
    }
  }
  if (window.PerformanceNavigationTiming) {
    var _nDesc = Object.getOwnPropertyDescriptor(PerformanceNavigationTiming.prototype, 'name');
    if (_nDesc && _nDesc.get) {
      defProp(PerformanceNavigationTiming.prototype, 'name', {
        get: function() { return rewriteEntryName(_nDesc.get.call(this)); }
      });
    }
  }
} catch(e) {}

// ── 13d. Blob URL origin masking ─────────────────────────────────────────────
try {
  var _createObjectURL = URL.createObjectURL;
  if (_createObjectURL) {
    URL.createObjectURL = function(obj) {
      var blobUrl = _createObjectURL.call(URL, obj);
      // blob:https://proxy-host/uuid → replace origin portion is not reliable,
      // but we can at least hide it from .origin checks on the blob URL string.
      return blobUrl;
    };
  }
  // Spoof URL.origin for blob: URLs containing the proxy host
  var _urlOriginDesc = Object.getOwnPropertyDescriptor(URL.prototype, 'origin');
  if (_urlOriginDesc && _urlOriginDesc.get) {
    defProp(URL.prototype, 'origin', {
      get: function() {
        var o = _urlOriginDesc.get.call(this);
        if (o === LORG) return ORIGIN;
        return o;
      }
    });
  }
} catch(e) {}

// ── 13e. postMessage origin spoofing ─────────────────────────────────────────
try {
  var _origAEL = EventTarget.prototype.addEventListener;
  var _msgOriginDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin');
  if (_msgOriginDesc && _msgOriginDesc.get) {
    defProp(MessageEvent.prototype, 'origin', {
      get: function() {
        var o = _msgOriginDesc.get.call(this);
        if (o === LORG) return ORIGIN;
        return o;
      }
    });
  }
} catch(e) {}

// ── 14. Click interceptor ─────────────────────────────────────────────────────
try {
  document.addEventListener('click', function(e) {
    var el = e.target;
    for (var i = 0; i < 8 && el; i++) { if (el.tagName === 'A') break; el = el.parentElement; }
    if (!el || el.tagName !== 'A') return;
    var href = el.href;
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    if (href.indexOf(LORG + PFX) === 0) return; // already correct
    e.preventDefault(); e.stopPropagation();
    var p = px(href);
    if (el.getAttribute('target') === '_blank') {
      window.open(p, '_blank');
    } else {
      location.href = p;
    }
  }, true);
} catch(e) {}

// ── 15. Submit interceptor ────────────────────────────────────────────────────
try {
  document.addEventListener('submit', function(e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    var act = f.action || '';
    if (!act) return;
    var proxied = px(act);
    if (act !== proxied) {
      f.action = proxied;
    }
  }, true);
} catch(e) {}

// ── 16. MutationObserver — catch dynamically-set src/href/style attrs ─────────
try {
  var _mo = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'attributes') {
        var el = m.target;
        var an = m.attributeName;
        if (an === 'src' || an === 'href' || an === 'action' || an === 'data' || an === 'style') {
          var v = el.getAttribute(an);
          if (v) {
            if (an === 'style') {
              // rewrite any url(...) inside style string
              var r = rewriteCSS(v, document.location.href);
              if (r !== v) el.setAttribute('style', r);
            } else if (v.indexOf(LORG) === 0 && v.indexOf(LORG + PFX) !== 0) {
              var rel = v.slice(LORG.length) || '/';
              el.setAttribute(an, rel.indexOf(PFX) === 0 ? rel : PFX + ORIGIN + rel);
            }
          }
        }
      }
      // Added nodes
      if (m.addedNodes) {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.querySelectorAll) {
            // Rewrite any new script[src], img[src], link[href], a[href]
            var targets = node.querySelectorAll('script[src],img[src],link[href],a[href]');
            for (var k = 0; k < targets.length; k++) {
              var t = targets[k];
              var attr = t.tagName === 'A' || t.tagName === 'LINK' ? 'href' : 'src';
              var val = t.getAttribute(attr);
              if (val && val.indexOf(LORG) === 0 && val.indexOf(LORG + PFX) !== 0) {
                var rr = val.slice(LORG.length) || '/';
                t.setAttribute(attr, rr.indexOf(PFX) === 0 ? rr : PFX + ORIGIN + rr);
              }
            }
          }
        }
      }
    }
  });
  _mo.observe(document.documentElement || document, {
    attributes: true, attributeFilter: ['src','href','action','data','style'],
    childList: true, subtree: true
  });
} catch(e) {}

// ── 16b. iframe location sync — keep iframe.src up-to-date with document URL
try {
  // inside a nested iframe notify parent of URL changes
  if (window.parent && window.parent !== window) {
    var _lastHref = window.location.href;
    function _pxNotifyParent() {
      try { window.parent.postMessage({type:'px-iframe-loc', url:_lastHref}, '*'); } catch(e) {}
    }
    window.addEventListener('load', function(){
      _lastHref = window.location.href;
      _pxNotifyParent();
    });
    setInterval(function(){
      try {
        var h = window.location.href;
        if (h !== _lastHref) {
          _lastHref = h;
          _pxNotifyParent();
        }
      } catch(e) {}
    }, 300);
  }
  // parent frame listens for updates and rewrites its iframe.src attribute
  window.addEventListener('message', function(e){
    if (e.data && e.data.type === 'px-iframe-loc' && typeof e.data.url === 'string') {
      var iframes = document.getElementsByTagName('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var f = iframes[i];
        try {
          if (f.contentWindow === e.source) {
            var newsrc = px(e.data.url);
            if (newsrc && f.src !== newsrc) f.src = newsrc;
            break;
          }
        } catch(err) {}
      }
    }
  }, false);
} catch(e) {}

// ── 17. Error.stack rewriting — prevent proxy URL leak in stack traces ────────
try {
  function rewriteStack(stack) {
    if (!stack || typeof stack !== 'string') return stack;
    // Replace LORG + /proxy/https:// → https://
    var pfxFull = LORG + PFX;
    var idx;
    while ((idx = stack.indexOf(pfxFull)) !== -1) {
      stack = stack.substring(0, idx) + stack.substring(idx + pfxFull.length);
    }
    // Replace any remaining proxy origin with target origin
    while ((idx = stack.indexOf(LORG)) !== -1) {
      stack = stack.substring(0, idx) + ORIGIN + stack.substring(idx + LORG.length);
    }
    return stack;
  }
  var _errStackDesc = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
  if (_errStackDesc && _errStackDesc.get) {
    defProp(Error.prototype, 'stack', {
      get: function() { return rewriteStack(_errStackDesc.get.call(this)); },
      set: _errStackDesc.set
    });
  }
} catch(e) {}

// ── 18. Anti-detection: mark history/location methods as native ──────────────
try {
  markNative(history.pushState, 'pushState');
  markNative(history.replaceState, 'replaceState');
  markNative(location.assign, 'assign');
  markNative(location.replace, 'replace');
  if (location.reload) markNative(location.reload, 'reload');
} catch(e) {}

// ── 19. document.currentScript.src de-proxying ──────────────────────────────
try {
  var _csDesc = _origGOPD.call(Object, Document.prototype, 'currentScript');
  if (_csDesc && _csDesc.get) {
    defProp(Document.prototype, 'currentScript', {
      get: function() {
        var cs = _csDesc.get.call(this);
        if (!cs) return cs;
        if (cs._pxPatched) return cs;
        try {
          var _srcDesc = _origGOPD.call(Object, HTMLScriptElement.prototype, 'src');
          if (_srcDesc && _srcDesc.get) {
            var _origSrcGet = _srcDesc.get;
            Object.defineProperty(cs, 'src', {
              get: function() {
                var s = _origSrcGet.call(this);
                if (s && s.indexOf(LORG + PFX) === 0) {
                  var rest = s.slice((LORG + PFX).length);
                  if (/^https?:\\/\\//.test(rest)) return rest;
                }
                return s;
              },
              configurable: true
            });
          }
          cs._pxPatched = true;
        } catch(e) {}
        return cs;
      }
    });
  }
} catch(e) {}

// ── 20. Notification/Permission API spoofing ────────────────────────────────
try {
  if (window.Notification) {
    defProp(Notification, 'permission', { get: function() { return 'default'; } });
    Notification.requestPermission = markNative(function requestPermission() {
      return Promise.resolve('default');
    }, 'requestPermission');
  }
} catch(e) {}

// ── 21. SharedArrayBuffer / crossOriginIsolated concealment ─────────────────
try {
  defProp(window, 'crossOriginIsolated', { get: function() { return false; } });
} catch(e) {}

// ── 22. navigator.sendBeacon — proxy URLs ───────────────────────────────────
try {
  if (navigator.sendBeacon) {
    var _sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = markNative(function sendBeacon(url, data) {
      try { url = px(String(url)); } catch(e) {}
      return _sb(url, data);
    }, 'sendBeacon');
  }
} catch(e) {}

// ── Boot ──────────────────────────────────────────────────────────────────────
notifyParent();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notifyParent);
window.addEventListener('load', notifyParent);

})();
</script>`;
}

// ─── HTML Rewriter ────────────────────────────────────────────────────────────
function rewriteHTML(html, targetUrl) {
  let base = targetUrl;
  try { base = new URL(targetUrl).href; } catch {}

  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove ALL security/policy meta tags
  ['Content-Security-Policy','content-security-policy',
   'X-Frame-Options','x-frame-options',
   'X-Content-Type-Options','Referrer-Policy','referrer-policy',
   'Cross-Origin-Opener-Policy','Cross-Origin-Embedder-Policy',
   'Cross-Origin-Resource-Policy',
  ].forEach(n => {
    $(`meta[http-equiv="${n}"]`).remove();
    $(`meta[http-equiv="${n.toLowerCase()}"]`).remove();
  });
  $('meta[name="referrer"]').remove();

  // Absorb any <base> tag then remove it
  $('base[href]').each((_, el) => {
    try { base = new URL($(el).attr('href'), base).href; } catch {}
    $(el).remove();
  });

  // Inject our runtime as VERY FIRST thing in <head>
  const inj = buildInjectionScript(base);
  if ($('head').length)      $('head').prepend(inj);
  else if ($('body').length) $('body').prepend(inj);
  else                        $('html').prepend(inj);

  const rw = (el, attr) => {
    const v = $(el).attr(attr); if (!v) return;
    const r = rewriteAttrValue(v, base);
    if (r && r !== v) $(el).attr(attr, r);
  };

  // Links
  $('a[href]').each((_, el)   => { rw(el,'href'); $(el).removeAttr('target'); });
  $('area[href]').each((_, el)=> { rw(el,'href'); $(el).removeAttr('target'); });

  // Images
  $('img').each((_, el) => {
    ['src','data-src','data-lazy','data-lazy-src','data-original',
     'data-img-src','data-url','data-bg','data-background','data-hi-res'].forEach(a => rw(el,a));
    $(el).attr('crossorigin','anonymous');
    const ss  = $(el).attr('srcset');     if (ss)  $(el).attr('srcset',    rewriteSrcset(ss, base));
    const dss = $(el).attr('data-srcset');if (dss) $(el).attr('data-srcset',rewriteSrcset(dss,base));
  });

  $('source').each((_, el) => {
    rw(el,'src');
    ['srcset','data-srcset'].forEach(a=>{const v=$(el).attr(a);if(v)$(el).attr(a,rewriteSrcset(v,base));});
  });

  $('script').each((_,el) => {
    if ($(el).attr('src')) {
      rw(el,'src');
    } else {
      const c = $(el).html();
      if (c) {
        const rc = rewriteJS(c);
        if (rc !== c) $(el).html(rc);
      }
    }
  });

  $('link[href]').each((_,el)   => rw(el,'href'));

  $('form').each((_,el) => {
    if ($(el).attr('action')) rw(el,'action');
    else $(el).attr('action', toProxyPath(base));
    $(el).removeAttr('target');
  });
  $('input[formaction]').each((_,el)  => rw(el,'formaction'));
  $('button[formaction]').each((_,el) => rw(el,'formaction'));

  $('video').each((_,el)  => { rw(el,'src'); rw(el,'poster'); $(el).attr('crossorigin','anonymous'); });
  $('audio').each((_,el)  => { rw(el,'src'); $(el).attr('crossorigin','anonymous'); });
  $('iframe[src]').each((_,el)  => rw(el,'src'));
  $('object[data]').each((_,el) => rw(el,'data'));
  $('embed[src]').each((_,el)   => rw(el,'src'));
  $('track[src]').each((_,el)   => rw(el,'src'));

  $('[style]').each((_,el) => {
    const s = $(el).attr('style'); if (s) { const r = rewriteCSS(s,base); if (r!==s) $(el).attr('style',r); }
  });
  $('style').each((_,el) => {
    const c = $(el).html(); if (c) { const r = rewriteCSS(c,base); if (r!==c) $(el).html(r); }
  });

  // Inline event handlers that might contain URLs (onclick="location.href=...")
  // These are hard to rewrite but the JS injection handles them at runtime.

  $('meta[http-equiv="refresh"]').each((_,el) => {
    const c = $(el).attr('content'); if (!c) return;
    const u = c.replace(/url=(.+)/i, (_, u) => {
      const r = resolveUrl(base, u.trim());
      return (r && isAbsoluteUrl(r)) ? 'url=' + toProxyPath(r) : 'url=' + u;
    });
    $(el).attr('content', u);
  });

  return $.html();
}

// ─── Request Headers ──────────────────────────────────────────────────────────
function buildHeaders(targetUrl, req, isYT) {
  let p; try { p = new URL(targetUrl); } catch { return {}; }

  let referer = p.origin + '/';
  const rawRef = req.headers['referer'] || req.headers['referrer'] || '';
  if (rawRef.includes('/proxy/')) {
    const m = rawRef.match(/\/proxy\/(https?:\/\/.+)/);
    if (m) { try { referer = new URL(m[1]).href; } catch {} }
  }

  const accept  = req.headers['accept'] || '';
  const isNav   = accept.includes('text/html');
  const isImg   = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)(\?|$)/i.test(targetUrl);
  const isFont  = /\.(woff2?|ttf|eot|otf)(\?|$)/i.test(targetUrl);
  const isDDG   = p.hostname.includes('duckduckgo.com');
  const isBrave = p.hostname.includes('search.brave.com');

  const h = {
    'User-Agent'         : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'             : accept || (isNav ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' : '*/*'),
    'Accept-Language'    : 'en-US,en;q=0.9',
    'Accept-Encoding'    : 'gzip, deflate, br',
    'Host'               : p.host,
    'Origin'             : p.origin,
    'Referer'            : referer,
    'sec-ch-ua'          : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile'   : '?0',
    'sec-ch-ua-platform' : '"Windows"',
    'Sec-Fetch-Dest'     : isNav ? 'document' : isImg ? 'image' : isFont ? 'font' : 'empty',
    'Sec-Fetch-Mode'     : isNav ? 'navigate' : 'cors',
    'Sec-Fetch-Site'     : 'same-origin',
    'Cache-Control'      : 'max-age=0',
    'Connection'         : 'keep-alive',
  };

  if (isNav) { h['Upgrade-Insecure-Requests'] = '1'; h['Sec-Fetch-User'] = '?1'; }
  if (req.headers['range'])  h['Range']  = req.headers['range'];
  if (req.headers['cookie']) h['Cookie'] = req.headers['cookie'];

  // Google-specific cookies & headers
  const hn = p.hostname;
  if (hn.endsWith('google.com') || hn.endsWith('google.co.uk')) {
    const ex = h['Cookie'] || '';
    if (!ex.includes('CONSENT'))
      h['Cookie'] = (ex ? ex + '; ' : '') + 'CONSENT=YES+cb.20231005-07-p0.en+FX+519; SOCS=CAESHAgBEhJnd3NfMjAyMzEwMDYtMF9SQzEaAmVuIAEaBgiA_LKnBg';
    h['sec-ch-ua-arch']          = '"x86"';
    h['sec-ch-ua-bitness']       = '"64"';
    h['sec-ch-ua-full-version']  = '"124.0.6367.60"';
  }

  // DuckDuckGo — needs Origin omitted, minimal headers, clean UA
  if (isDDG) {
    delete h['Origin'];
    delete h['sec-ch-ua'];
    delete h['sec-ch-ua-mobile'];
    delete h['sec-ch-ua-platform'];
    h['Sec-Fetch-Site'] = 'none';
    h['Sec-Fetch-Mode'] = isNav ? 'navigate' : 'cors';
    // Include DDG language cookie for consistent results
    if (!h['Cookie']) h['Cookie'] = 'ae=d; l=wt-wt; p=-2; s=0; ss=-1';
    else if (!h['Cookie'].includes('ae=')) h['Cookie'] += '; ae=d';
  }

  // Brave Search
  if (isBrave) {
    h['Origin'] = p.origin;
  }

  return h;
}

// ─── Strip Response Headers ───────────────────────────────────────────────────
const STRIP_HDRS = new Set([
  'content-security-policy','content-security-policy-report-only',
  'x-frame-options','x-xss-protection','strict-transport-security',
  'expect-ct','report-to','nel','transfer-encoding','connection',
  'keep-alive','upgrade','proxy-connection',
  'cross-origin-opener-policy','cross-origin-embedder-policy',
  'cross-origin-resource-policy','permissions-policy','referrer-policy',
  'content-encoding','content-length',
]);

function applyProxyResponseHeaders(res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function normalizeHeaderValue(value) {
  return String(value ?? '').replace(/\r?\n[ \t]+/g, ' ');
}

function rewriteSingleCspPolicy() {
  return "default-src * data: blob: mediastream: filesystem: about: ws: wss: 'unsafe-inline' 'unsafe-eval'; frame-ancestors *;";
}

function rewriteCspHeaderValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const rewritten = [];
  for (const v of values) {
    if (v == null) continue;
    rewritten.push(rewriteSingleCspPolicy());
  }
  if (!rewritten.length) return undefined;
  return rewritten.length === 1 ? rewritten[0] : rewritten;
}

function applyCspHeaderOverrides(res, upstreamHeaders) {
  const csp = rewriteCspHeaderValue(
    upstreamHeaders?.['content-security-policy'] ?? upstreamHeaders?.['Content-Security-Policy']
  );
  if (csp !== undefined) res.setHeader('Content-Security-Policy', csp);
  const cspRO = rewriteCspHeaderValue(
    upstreamHeaders?.['content-security-policy-report-only'] ??
    upstreamHeaders?.['Content-Security-Policy-Report-Only']
  );
  if (cspRO !== undefined) res.setHeader('Content-Security-Policy-Report-Only', cspRO);
}

// ─── Main Proxy Handler ───────────────────────────────────────────────────────
async function proxyRequest(targetUrl, req, res) {
  let parsed; try { parsed = new URL(targetUrl); }
  catch { return res.status(400).send(errorPage('Invalid URL: ' + targetUrl)); }

  setIpOrigin(req, parsed.origin);

  if (req.headers['range']) return streamProxy(targetUrl, req, res);

  const headers = buildHeaders(targetUrl, req);
  const proxyAgent = getRequestProxyAgent(targetUrl, req);
  if (req.headers['content-type'] && !['GET','HEAD'].includes(req.method))
    headers['Content-Type'] = req.headers['content-type'];
  const body = (!['GET','HEAD'].includes(req.method) && req.body?.length > 0) ? req.body : undefined;

  let resp;
  try {
    resp = await axios({
      method: req.method || 'GET', url: targetUrl, headers,
      data: body, responseType: 'arraybuffer',
      maxRedirects: 0, validateStatus: () => true,
      timeout: 30000, decompress: true,
      httpAgent: proxyAgent, httpsAgent: proxyAgent,
    });
  } catch(err) {
    const msg = err.code === 'ECONNREFUSED' ? 'Connection refused.'
              : err.code === 'ENOTFOUND'    ? 'Domain not found: ' + parsed.hostname
              : err.code === 'ETIMEDOUT'    ? 'Connection timed out.'
              : err.message;
    return res.status(502).send(errorPage(msg));
  }

  if ([301,302,303,307,308].includes(resp.status)) {
    const loc = resp.headers['location'];
    if (loc) { const r = resolveUrl(targetUrl, loc); if (r && isAbsoluteUrl(r)) return res.redirect(302, toProxyPath(r)); }
  }

  for (const [k,v] of Object.entries(resp.headers)) {
    if (STRIP_HDRS.has(k.toLowerCase())) continue;
    try { res.setHeader(k, v); } catch {}
  }
  applyCspHeaderOverrides(res, resp.headers);
  applyProxyResponseHeaders(res);

  const rawCookies = resp.headers['set-cookie'];
  if (rawCookies) {
    const arr = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
    res.setHeader('Set-Cookie', arr.map(c =>
      c.replace(/Domain=[^;]+;?\s*/gi, '')
       .replace(/SameSite=(None|Strict)/gi, 'SameSite=Lax')
       .replace(/;\s*Secure(?=;|$)/gi, '')
    ));
  }

  const ct  = (resp.headers['content-type'] || '').toLowerCase();
  const buf = Buffer.from(resp.data);

  if (ct.includes('text/html')) {
    try {
      const html = rewriteHTML(buf.toString('utf-8'), targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(resp.status).send(html);
    } catch { return res.status(resp.status).send(buf); }
  }
  if (ct.includes('text/css')) {
    try {
      const css = rewriteCSS(buf.toString('utf-8'), targetUrl);
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      return res.status(resp.status).send(css);
    } catch { return res.status(resp.status).send(buf); }
  }
  if (ct.includes('javascript') || ct.includes('ecmascript')) {
    try {
      const js = rewriteJS(buf.toString('utf-8'));
      return res.status(resp.status).send(js);
    } catch { return res.status(resp.status).send(buf); }
  }
  return res.status(resp.status).send(buf);
}

// ─── Stream Proxy ─────────────────────────────────────────────────────────────
async function streamProxy(targetUrl, req, res) {
  try {
    const headers = buildHeaders(targetUrl, req);
    const proxyAgent = getRequestProxyAgent(targetUrl, req);
    const r = await axios({ method:'GET', url:targetUrl, headers, responseType:'stream',
      maxRedirects:5, validateStatus:()=>true, timeout:60000,
      httpAgent:proxyAgent, httpsAgent:proxyAgent });
    for (const [k,v] of Object.entries(r.headers)) {
      if (STRIP_HDRS.has(k.toLowerCase())) continue;
      try { res.setHeader(k, v); } catch {}
    }
    applyCspHeaderOverrides(res, r.headers);
    applyProxyResponseHeaders(res);
    res.status(r.status);
    r.data.pipe(res);
  } catch(e) { res.status(502).end(); }
}

// ─── HTML Helpers ─────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0d0d14;color:#ddd;display:flex;align-items:center;justify-content:center;height:100vh}
.b{background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:2em 2.5em;max-width:520px;width:90%;text-align:center}
h2{color:#ff6b6b;margin:0 0 .4em}p{opacity:.75;font-size:.95em;line-height:1.6}
.t{background:#0f0f1e;border:1px solid #1f1f3a;border-radius:8px;padding:.8em;margin-top:1em;font-size:.8em;opacity:.65;line-height:1.6;text-align:left}
</style></head><body><div class="b">
<h2>⚠️ Proxy Error</h2><p>${String(msg).replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
<div class="t">💡 Reddit &amp; sites using Cloudflare block datacenter IPs. Google OAuth sign-ins fail for the same reason. Use DuckDuckGo, Brave, or Bing for search.</div>
</div></body></html>`;
}

// ─── YouTube: Search Page ─────────────────────────────────────────────────────
function renderYTSearch(q, videos) {
  const items = videos.map(v => `
<div class="r" onclick="window.top.navigateTo('https://www.youtube.com/watch?v=${esc(v.id)}')">
  <div class="th"><img src="${v.thumb ? '/proxy/' + v.thumb : ''}" alt="" loading="lazy" crossorigin="anonymous">
    ${v.dur ? `<span class="d">${esc(v.dur)}</span>` : ''}</div>
  <div class="inf">
    <h3>${esc(v.title)}</h3>
    <div class="m">${esc(v.channel)}${v.views ? ' · ' + esc(v.views) : ''}${v.pub ? ' · ' + esc(v.pub) : ''}</div>
    ${v.desc ? `<p>${esc(v.desc)}</p>` : ''}
  </div>
</div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>▶ ${esc(q || 'YouTube Search')}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#f1f1f1;font-family:system-ui,sans-serif;padding:16px}
.hdr{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.hdr h1{font-size:1em;color:#aaa;white-space:nowrap}
.hdr h1 span{color:#ff0000;font-weight:700;font-size:1.3em}
.sf{display:flex;gap:8px;flex:1;min-width:200px}
.sf input{flex:1;background:#272727;border:1px solid #444;border-radius:20px;padding:8px 14px;color:#f1f1f1;font-size:.9em;outline:none}
.sf input:focus{border-color:#ff0000}
.sf button{background:#ff0000;border:none;border-radius:20px;color:#fff;padding:8px 16px;cursor:pointer;font-weight:600}
.r{display:flex;gap:12px;padding:12px;border-radius:10px;cursor:pointer;margin-bottom:6px;transition:background .15s}
.r:hover{background:#272727}
.th{flex-shrink:0;width:168px;height:94px;background:#333;border-radius:6px;overflow:hidden;position:relative}
.th img{width:100%;height:100%;object-fit:cover}
.d{position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,.85);color:#fff;font-size:.68em;padding:1px 5px;border-radius:3px}
.inf{flex:1;min-width:0}
h3{font-size:.95em;line-height:1.4;margin-bottom:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.m{font-size:.75em;color:#aaa;margin-bottom:5px}
p{font-size:.8em;color:#aaa;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.empty{text-align:center;padding:60px;color:#aaa;font-size:.95em}
@media(max-width:500px){.th{width:120px;height:67px}}
</style></head><body>
<div class="hdr">
  <h1><span>▶</span> YouTube</h1>
  <form class="sf" onsubmit="event.preventDefault();window.top.ytSearch(document.getElementById('si').value)">
    <input id="si" value="${esc(q)}" placeholder="Search YouTube…">
    <button type="submit">Search</button>
  </form>
</div>
${items || `<div class="empty">No results found for "<b>${esc(q)}</b>".<br>Try a different search term.</div>`}
</body></html>`;
}

// ─── YouTube: Watch Page ──────────────────────────────────────────────────────
function renderYTWatch(info, streamUrl, videoId) {
  const vd      = info?.basic_info || {};
  const title   = vd.title || 'YouTube Video';
  const channel = vd.author || '';
  const views   = vd.view_count?.toLocaleString() || '';
  const desc    = vd.short_description || '';
  const encodedStream = streamUrl
    ? '/yt-stream?u=' + encodeURIComponent(Buffer.from(streamUrl).toString('base64'))
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#f1f1f1;font-family:system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:16px}
.back{color:#3ea6ff;cursor:pointer;font-size:.85em;margin-bottom:12px;display:inline-block}
.back:hover{text-decoration:underline}
video{width:100%;border-radius:10px;background:#000;display:block;max-height:70vh}
.novid{width:100%;aspect-ratio:16/9;background:#111;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:.9em;text-align:center;padding:20px}
h1{font-size:1.1em;margin-top:14px;line-height:1.4}
.meta{font-size:.8em;color:#aaa;margin-top:6px}
.desc{font-size:.8em;color:#aaa;margin-top:12px;white-space:pre-wrap;line-height:1.6;max-height:120px;overflow:hidden;cursor:pointer}
.desc.open{max-height:none}
</style></head><body>
<div class="wrap">
  <div class="back" onclick="window.top.ytBack()">← Back to search</div>
  ${encodedStream
    ? `<video controls autoplay preload="metadata" src="${esc(encodedStream)}" crossorigin="anonymous"></video>`
    : `<div class="novid">⚠️ Stream not available for this video.<br>YouTube may have restricted playback from this IP.</div>`}
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(channel)}${views ? ' · ' + esc(views) + ' views' : ''}</div>
  ${desc ? `<div class="desc" onclick="this.classList.toggle('open')">${esc(desc)}</div>` : ''}
</div>
</body></html>`;
}

// ─── Express Setup ────────────────────────────────────────────────────────────
app.options('*', (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.status(200).end();
});
app.use(express.static(__dirname, { index: false }));

// ─── YouTube: Search ──────────────────────────────────────────────────────────
app.get('/yt-search', async (req, res) => {
  const q = (req.query.q || '').trim();
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if (!q) return res.send(renderYTSearch('', []));
  try {
    const yt = await getYT();
    const sr = await yt.search(q, { type: 'video' });
    const videos = (sr.videos || []).slice(0, 30).map(v => {
      const bi = v.basic_info || {};
      return {
        id      : v.id || '',
        title   : bi.title || v.title?.text || '',
        channel : bi.channel?.name || v.author?.name || '',
        views   : bi.short_view_count?.text || '',
        dur     : bi.duration?.text || '',
        pub     : v.published?.text || '',
        thumb   : bi.thumbnail?.[0]?.url || v.thumbnails?.[0]?.url || '',
        desc    : v.description?.text || '',
      };
    }).filter(v => v.id);
    return res.send(renderYTSearch(q, videos));
  } catch(e) {
    console.error('YT search error:', e.message);
    return res.send(renderYTSearch(q, []));
  }
});

// ─── YouTube: Watch ───────────────────────────────────────────────────────────
app.get('/yt-watch', async (req, res) => {
  const id = (req.query.v || '').trim();
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if (!id) return res.redirect('/yt-search');
  try {
    const yt   = await getYT();
    const info = await yt.getBasicInfo(id);
    let streamUrl = null;
    try {
      const fmt = info.chooseFormat({ quality: '360p', type: 'videoandaudio' })
               || info.chooseFormat({ quality: 'best',  type: 'videoandaudio' });
      if (fmt) streamUrl = fmt.decipher(yt.session.player);
    } catch(e) { console.error('YT decipher error:', e.message); }
    return res.send(renderYTWatch(info, streamUrl, id));
  } catch(e) {
    console.error('YT watch error:', e.message);
    return res.status(502).send(errorPage('Could not load video: ' + e.message));
  }
});

// ─── YouTube: Stream ─────────────────────────────────────────────────────────
app.get('/yt-stream', async (req, res) => {
  let url;
  try {
    url = Buffer.from(decodeURIComponent(req.query.u || ''), 'base64').toString('utf-8');
    new URL(url);
  } catch { return res.status(400).end(); }
  try {
    const proxyAgent = getRequestProxyAgent(url, req);
    const headers = {
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer'        : 'https://www.youtube.com/',
      'Origin'         : 'https://www.youtube.com',
      'Accept'         : '*/*',
      'Accept-Encoding': 'identity',
    };
    if (req.headers['range']) headers['Range'] = req.headers['range'];
    const r = await axios({
      method:'GET', url, headers, responseType:'stream',
      validateStatus:()=>true, timeout:60000,
      httpAgent:proxyAgent, httpsAgent:proxyAgent,
    });
    const fwd = ['content-type','content-length','content-range','accept-ranges','cache-control'];
    fwd.forEach(k => { if (r.headers[k]) res.setHeader(k, r.headers[k]); });
    applyCspHeaderOverrides(res, r.headers);
    applyProxyResponseHeaders(res);
    res.status(r.status);
    r.data.pipe(res);
  } catch(e) { res.status(502).end(); }
});

// ─── Main Proxy Route (tokenized) ────────────────────────────────────────────
app.get('/proxy/:token', async (req, res) => {
  const decoded = decodeBase64UrlToken(req.params.token || '');
  if (!decoded) return res.status(400).send(errorPage('Invalid proxy token.'));

  let targetUrl = decoded;
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
  try { new URL(targetUrl); }
  catch { return res.status(400).send(errorPage('Bad URL.')); }

  setIpOrigin(req, new URL(targetUrl).origin);

  try {
    const proxyAgent = getRequestProxyAgent(targetUrl, req);
    const upstream = await nodeFetch(targetUrl, {
      method: 'GET',
      redirect: 'manual',
      agent: proxyAgent,
      headers: buildHeaders(targetUrl, req),
    });

    if ([301,302,303,307,308].includes(upstream.status)) {
      const loc = upstream.headers.get('location');
      if (loc) {
        const r = resolveUrl(targetUrl, loc);
        if (r && isAbsoluteUrl(r)) return res.redirect(302, toProxyPath(r));
      }
    }

    const finalUrl = upstream.url || targetUrl;
    const buf = await upstream.buffer();
    const ct  = (upstream.headers.get('content-type') || 'text/html; charset=utf-8').toLowerCase();

    upstream.headers.forEach((v, k) => {
      if (!STRIP_HDRS.has(k.toLowerCase())) { try { res.setHeader(k, v); } catch {} }
    });

    res.status(upstream.status);
    applyCspHeaderOverrides(res, {
      'content-security-policy'             : upstream.headers.get('content-security-policy'),
      'content-security-policy-report-only' : upstream.headers.get('content-security-policy-report-only'),
    });
    applyProxyResponseHeaders(res);

    const rawCookies = upstream.headers.raw()['set-cookie'];
    if (rawCookies) {
      res.setHeader('Set-Cookie', rawCookies.map(c =>
        c.replace(/Domain=[^;]+;?\s*/gi, '')
         .replace(/SameSite=(None|Strict)/gi, 'SameSite=Lax')
         .replace(/;\s*Secure(?=;|$)/gi, '')
      ));
    }

    if (ct.includes('text/html')) {
      try {
        const html = rewriteHTML(buf.toString('utf-8'), finalUrl);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch { return res.send(buf); }
    }
    if (ct.includes('text/css')) {
      try {
        const css = rewriteCSS(buf.toString('utf-8'), finalUrl);
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        return res.send(css);
      } catch { return res.send(buf); }
    }
    if (ct.includes('javascript') || ct.includes('ecmascript')) {
      try {
        const js = rewriteJS(buf.toString('utf-8'));
        // Allow original content type to pass through, just rewrite the body
        return res.send(js);
      } catch { return res.send(buf); }
    }
    res.setHeader('Content-Type', ct);
    return res.send(buf);
  } catch(err) {
    return res.status(502).send(errorPage(err?.message || 'Proxy fetch failed.'));
  }
});

// ─── Main Proxy Route (direct URL) ───────────────────────────────────────────
app.use('/proxy', express.raw({ type:'*/*', limit:'50mb' }), async (req, res) => {
  let targetUrl = req.url.slice(1);
  if (!targetUrl) return res.status(400).send(errorPage('No target URL.'));
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
  try { new URL(targetUrl); } catch { return res.status(400).send(errorPage('Bad URL: ' + targetUrl)); }
  await proxyRequest(targetUrl, req, res);
});

// ─── Download ZIP ─────────────────────────────────────────────────────────────
app.get('/download', (req,res) => {
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition','attachment; filename="ultraproxy.zip"');
  const arc = archiver('zip', { zlib: { level: 9 } });
  arc.on('error', e => console.error(e));
  arc.pipe(res);
  ['server.js','index.html','package.json','README.md'].forEach(f => {
    const fp = path.join(__dirname, f);
    if (fs.existsSync(fp)) arc.file(fp, { name: f });
  });
  arc.finalize();
});

// ─── SPA Catch-All ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (['/','/download','/yt-search','/yt-watch','/yt-stream'].includes(req.path)) return next();

  let proxiedOrigin = null;
  const ref = req.headers['referer'] || '';
  if (ref.includes('/proxy/')) {
    const m = ref.match(/\/proxy\/(https?:\/\/[^/?#]+)/);
    if (m) proxiedOrigin = m[1];
  }
  if (!proxiedOrigin && req.headers.cookie) {
    const m = req.headers.cookie.match(/proxy-origin=(https?:\/\/[^;]+)/);
    if (m) { try { proxiedOrigin = new URL(decodeURIComponent(m[1])).origin; } catch {} }
  }
  if (!proxiedOrigin) proxiedOrigin = getIpOrigin(req);
  if (!proxiedOrigin) return next();

  try {
    const qs  = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const tgt = proxiedOrigin + req.path + qs;
    return res.redirect(302, toProxyPath(tgt));
  } catch { return next(); }
});

// ─── Home & 404 ───────────────────────────────────────────────────────────────
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));
app.use((req,res) => res.status(404).send(errorPage('Not found: ' + req.path)));

// ─── Start ────────────────────────────────────────────────────────────────────
function startServer(port, retriesLeft = 10) {
  const server = app.listen(port, () => {
    console.log(`\n  🌐  UltraProxy v4  →  http://localhost:${port}`);
    console.log(`  📦  Download ZIP  →  http://localhost:${port}/download\n`);
  });
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE' && retriesLeft > 0) {
      const nextPort = Number(port) + 1;
      console.warn(`Port ${port} is busy, trying ${nextPort}...`);
      return startServer(nextPort, retriesLeft - 1);
    }
    if (err?.code === 'EADDRINUSE') {
      console.error('No free port found. Start with PORT=<port> npm start');
      process.exit(1);
    }
    throw err;
  });
}

startServer(Number(PORT));