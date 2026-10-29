/* UltraProxy client runtime — runs inside every proxied page and worker (injected by the server).
 * Works together with src/rewrite/js.js: the rewritten page code calls the $up$* helpers defined at the bottom.
 * Design notes (why this is more robust than the old injected script):
 *  - location/top/parent are handled at their use sites (via the rewriter) instead of by overriding window
 *    properties, so a nested captcha iframe still sees its REAL parent while frame-busting checks see "no parent".
 *  - postMessage carries the sender's real origin so event.origin checks (reCAPTCHA, hCaptcha, Turnstile, OAuth) pass.
 *  - Cookies live in a server-side jar; document.cookie is a mirror. Storage/IndexedDB are namespaced per site.
 *  - Every URL sink (attributes, properties, innerHTML, fetch, XHR, workers, websockets, CSS) is routed through px().
 */
(function () {
  'use strict';
  var G = typeof self !== 'undefined' ? self : globalThis;
  var SYM = Symbol.for('up.client');
  if (G[SYM]) return;
  var errs = [];
  var api = { errs: errs };
  try { Object.defineProperty(G, SYM, { value: api }); } catch (e) { return; }

  var isWin = typeof window !== 'undefined' && G === window && typeof document !== 'undefined';
  var PREFIX = '/proxy/';
  var SELF = G.location.origin;
  var cfg = G.__up || {};
  try { delete G.__up; } catch (e) { /* ignore */ }
  var MSG = '__up_pm';

  function guard(name, fn) { try { fn(); } catch (e) { errs.push(name + ': ' + (e && e.message)); } }

  // ── native function disguise ──────────────────────────────────────────────
  var hooked = new WeakMap();
  var nativeToString = Function.prototype.toString;
  function mark(fn, name) { hooked.set(fn, 'function ' + name + '() { [native code] }'); return fn; }
  var fakeToString = mark(function toString() { var h = hooked.get(this); return h !== undefined ? h : nativeToString.call(this); }, 'toString');
  Object.defineProperty(Function.prototype, 'toString', { value: fakeToString, writable: true, configurable: true });

  function method(obj, name, wrap) {
    if (!obj) return null;
    var d = Object.getOwnPropertyDescriptor(obj, name);
    if (!d || typeof d.value !== 'function') return null;
    Object.defineProperty(obj, name, { value: mark(wrap(d.value), name), writable: d.writable, configurable: true, enumerable: d.enumerable });
    return d.value;
  }
  function acc(obj, prop, gm, sm) {
    if (!obj) return null;
    var d = Object.getOwnPropertyDescriptor(obj, prop);
    if (!d || !d.configurable) return null;
    var nd = { configurable: true, enumerable: d.enumerable };
    if (d.get) nd.get = mark(function () { var v = d.get.call(this); return gm ? gm(v, this) : v; }, 'get ' + prop);
    if (d.set) nd.set = mark(function (v) { return d.set.call(this, sm ? sm(v, this) : v); }, 'set ' + prop);
    Object.defineProperty(obj, prop, nd);
    return d;
  }
  function ctor(name, onArgs) {
    var C = G[name];
    if (typeof C !== 'function') return;
    var P = new Proxy(C, { construct: function (t, args, nt) { onArgs(args, C); return Reflect.construct(t, args, nt); } });
    mark(P, name);
    Object.defineProperty(G, name, { value: P, writable: true, configurable: true });
  }
  function def(name, value) { Object.defineProperty(G, name, { value: value, configurable: false, writable: false, enumerable: false }); }

  // ── URL mapping ───────────────────────────────────────────────────────────
  function decodeHref(href) {
    if (!href) return null;
    try {
      var u = new URL(href, G.location.href);
      if (u.origin !== SELF || u.pathname.indexOf(PREFIX) !== 0) return null;
      var rest = (u.pathname.slice(PREFIX.length) + u.search).replace(/^(https?):\/(?!\/)/i, '$1://');
      return /^https?:\/\//i.test(rest) ? rest + u.hash : null;
    } catch (e) { return null; }
  }
  function docRealUrl() { return decodeHref(G.location.href) || cfg.base || G.location.href; }
  function base() { return (!isWin || cfg.hb) ? (cfg.base || docRealUrl()) : docRealUrl(); }
  function realOrigin() { try { return new URL(docRealUrl()).origin; } catch (e) { return SELF; } }

  var SKIP = /^(data:|blob:|javascript:|mailto:|tel:|about:|#|sms:)/i;
  function px(u, b) {
    if (u === undefined || u === null) return u;
    var t = String(u).trim();
    if (!t || SKIP.test(t) || t.indexOf(PREFIX) === 0) return u;
    var abs;
    try {
      abs = new URL(t, b || base());
      if (abs.origin === SELF) {
        if (abs.pathname.indexOf(PREFIX) === 0) return u;                 // already a proxied absolute URL
        abs = new URL(abs.pathname + abs.search + abs.hash, b || base()); // "escaped" URL -> belongs to the real site
      }
    } catch (e) { return u; }
    return /^https?:$/.test(abs.protocol) ? PREFIX + abs.href : u;
  }
  function pxValue(v) { return px(v); }
  function unpx(u) {
    if (typeof u !== 'string' || !u) return u;
    return decodeHref(u) || u;
  }
  function wsUrl(u) {
    var abs;
    try { abs = new URL(String(u), base()); } catch (e) { return u; }
    if (abs.protocol === 'http:') abs.protocol = 'ws:'; else if (abs.protocol === 'https:') abs.protocol = 'wss:';
    if (!/^wss?:$/.test(abs.protocol)) return u;
    return (G.location.protocol === 'https:' ? 'wss://' : 'ws://') + G.location.host + '/up/ws?u=' + encodeURIComponent(abs.href) + '&o=' + encodeURIComponent(realOrigin());
  }
  function srcset(v) {
    return String(v).replace(/(\S+)(\s+[\d.]+[wx])?(\s*,\s*|\s*$)/g, function (m, u, d, sep) {
      var tail = '';
      if (!d && u.charAt(u.length - 1) === ',') { u = u.slice(0, -1); tail = ','; }
      return px(u) + (d || '') + tail + sep;
    });
  }
  function cssText(t) {
    if (typeof t !== 'string' || !/url\(|@import|image-set\(/i.test(t)) return t;
    return t.replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, function (m, q, u) { var p = px(u.trim()); return p === u.trim() ? m : 'url(' + q + p + q + ')'; })
            .replace(/@import\s+(['"])([^'"]+)\1/gi, function (m, q, u) { return '@import ' + q + px(u) + q; });
  }

  // ── natives we need un-hooked ─────────────────────────────────────────────
  var nat = {
    fetch: G.fetch, XHR: G.XMLHttpRequest,
    xhrOpen: G.XMLHttpRequest && G.XMLHttpRequest.prototype.open,
    createObjectURL: G.URL && G.URL.createObjectURL,
  };
  if (isWin) {
    var ep = Element.prototype;
    nat.setAttribute = ep.setAttribute; nat.getAttribute = ep.getAttribute; nat.createElement = Document.prototype.createElement;
    var ih = Object.getOwnPropertyDescriptor(ep, 'innerHTML') || {};
    nat.getInner = ih.get; nat.setInner = ih.set;
    var tc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent') || {};
    nat.setText = tc.set;
  }

  // ── synchronous JS rewrite (eval / dynamically created inline scripts) ────
  var rwCache = new Map();
  function syncRewrite(code, mod) {
    var key = (mod ? 'm' : 's') + code;
    if (rwCache.has(key)) return rwCache.get(key);
    var out = code;
    try {
      var x = new nat.XHR();
      nat.xhrOpen.call(x, 'POST', '/up/rewrite?u=' + encodeURIComponent(base()) + (mod ? '&m=1' : ''), false);
      x.send(code);
      if (x.status === 200 && typeof x.responseText === 'string') out = x.responseText;
    } catch (e) { /* keep original */ }
    if (rwCache.size > 300) rwCache.clear();
    rwCache.set(key, out);
    return out;
  }
  var JS_WORDS = /\b(location|top|parent|eval|postMessage|import|export)\b/;
  function inlineJS(code) { return typeof code === 'string' && JS_WORDS.test(code) ? syncRewrite(code, false) : code; }

  // ── location / top / parent ───────────────────────────────────────────────
  var ours = new WeakSet();
  var locProxies = new WeakMap();
  function isLocation(v) {
    try { var s = Object.prototype.toString.call(v); return s === '[object Location]' || s === '[object WorkerLocation]'; } catch (e) { return false; }
  }
  function makeLocation(L) {
    var real = function () { return decodeHref(L.href) || L.href; };
    var part = function (p) { try { return new URL(real())[p]; } catch (e) { return ''; } };
    var setPart = function (p, v) { try { var u = new URL(real()); u[p] = v; L.href = px(u.href); } catch (e) { /* ignore */ } };
    var o = {
      get href() { return real(); }, set href(v) { L.href = px(v); },
      get origin() { return part('origin'); },
      get protocol() { return part('protocol'); }, set protocol(v) { setPart('protocol', v); },
      get host() { return part('host'); }, set host(v) { setPart('host', v); },
      get hostname() { return part('hostname'); }, set hostname(v) { setPart('hostname', v); },
      get port() { return part('port'); }, set port(v) { setPart('port', v); },
      get pathname() { return part('pathname'); }, set pathname(v) { setPart('pathname', v); },
      get search() { return part('search'); }, set search(v) { setPart('search', v); },
      get hash() { return L.hash; }, set hash(v) { L.hash = v; },
      assign: function (u) { L.assign(px(u)); },
      replace: function (u) { L.replace(px(u)); },
      reload: function () { L.reload(); },
      toString: function () { return real(); },
      toJSON: function () { return real(); },
      get ancestorOrigins() { return L.ancestorOrigins; },
    };
    o[Symbol.toPrimitive] = function () { return real(); };
    ours.add(o);
    return o;
  }
  function isProxied(win) { try { return !!win[SYM]; } catch (e) { return false; } }
  function wrappedParent() { var p = G.parent; return p === G || !isProxied(p) ? G : p; }
  function wrappedTop() {
    var cur = G;
    for (;;) { var p = cur.parent; if (p === cur || !isProxied(p)) return cur; cur = p; }
  }
  function w(v) {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
    if (ours.has(v)) return v;
    if (isLocation(v)) { var p = locProxies.get(v); if (!p) { p = makeLocation(v); locProxies.set(v, p); } return p; }
    if (isWin) { if (v === G.top) return wrappedTop(); if (v === G.parent) return wrappedParent(); }
    return v;
  }
  function tryAssign(lhs, rhs) {
    if (lhs && typeof lhs === 'object' && !ours.has(lhs) && isLocation(lhs)) { w(lhs).href = rhs; return true; }
    return false;
  }

  // ── postMessage with real origins ─────────────────────────────────────────
  function pm(target) {
    var args = Array.prototype.slice.call(arguments, 1);
    var isW = false;
    try { isW = !!target && typeof target === 'object' && target.window === target; } catch (e) { /* cross-origin */ }
    if (isW && args.length) {
      var data = {}; data[MSG] = 1; data.o = realOrigin(); data.d = args[0];
      var opt = args[1];
      if (opt && typeof opt === 'object') args = [data, Object.assign({}, opt, { targetOrigin: '*' })];
      else args = [data, '*'].concat(args.slice(2));
    }
    return target.postMessage.apply(target, args);
  }
  function isWrapped(d) { try { return d !== null && typeof d === 'object' && d[MSG] === 1 && 'd' in d; } catch (e) { return false; } }

  // ── cookies: server-side jar, mirrored here ───────────────────────────────
  var jar = new Map();
  String(cfg.cookies || '').split(/;\s*/).forEach(function (p) { var i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i), { v: p.slice(i + 1), exp: 0 }); });
  var pending = Promise.resolve();
  function cookieGet() {
    var now = Date.now(), out = [];
    jar.forEach(function (c, k) { if (c.exp && c.exp < now) jar.delete(k); else out.push((k ? k + '=' : '') + c.v); });
    return out.join('; ');
  }
  function cookieSet(str) {
    str = String(str);
    var parts = str.split(';'), nv = parts.shift(), i = nv.indexOf('=');
    var name = i < 0 ? '' : nv.slice(0, i).trim(), val = i < 0 ? nv.trim() : nv.slice(i + 1).trim();
    var exp = 0, maxAge = null;
    parts.forEach(function (p) {
      var kv = p.split('='), k = kv.shift().trim().toLowerCase(), v = kv.join('=').trim();
      if (k === 'max-age') { var n = parseInt(v, 10); if (!isNaN(n)) maxAge = n <= 0 ? 1 : Date.now() + n * 1000; }
      else if (k === 'expires') { var t = Date.parse(v); if (!isNaN(t)) exp = t <= Date.now() ? 1 : t; }
    });
    if (maxAge !== null) exp = maxAge;
    if (exp && exp <= Date.now()) jar.delete(name); else jar.set(name, { v: val, exp: exp });
    var body = JSON.stringify({ u: docRealUrl(), c: str });
    pending = pending.then(function () { return nat.fetch.call(G, '/up/cookie', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true, credentials: 'same-origin' }); }).catch(function () { /* ignore */ });
  }
  var syncTimer = 0, lastSync = 0;
  function scheduleCookieSync() {
    if (!isWin || syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = 0; lastSync = Date.now();
      pending.then(function () { return nat.fetch.call(G, '/up/cookies?u=' + encodeURIComponent(docRealUrl()), { credentials: 'same-origin' }); })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          jar.clear();
          String(j.cookies || '').split(/;\s*/).forEach(function (p) { var i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i), { v: p.slice(i + 1), exp: 0 }); });
        }).catch(function () { /* ignore */ });
    }, Math.max(1200, 4000 - (Date.now() - lastSync)));
  }

  // ── namespaced storage (every site shares the proxy origin; keep them apart) ──
  function nsStorage(native, ns) {
    var keys = function () { var out = []; for (var i = 0; i < native.length; i++) { var k = native.key(i); if (k.indexOf(ns) === 0) out.push(k.slice(ns.length)); } return out; };
    var apiObj = {
      getItem: function (k) { return native.getItem(ns + k); }, setItem: function (k, v) { native.setItem(ns + k, v); },
      removeItem: function (k) { native.removeItem(ns + k); }, clear: function () { keys().forEach(function (k) { native.removeItem(ns + k); }); },
      key: function (i) { var k = keys()[i]; return k === undefined ? null : k; },
    };
    return new Proxy(apiObj, {
      get: function (t, p) {
        if (p === 'length') return keys().length;
        if (typeof p === 'symbol' || p in t) return t[p];
        var v = native.getItem(ns + p); return v === null ? undefined : v;
      },
      set: function (t, p, v) { native.setItem(ns + String(p), String(v)); return true; },
      deleteProperty: function (t, p) { native.removeItem(ns + String(p)); return true; },
      has: function (t, p) { return p in t || (typeof p === 'string' && native.getItem(ns + p) !== null); },
      ownKeys: function () { return keys(); },
      getOwnPropertyDescriptor: function (t, p) { var v = typeof p === 'string' ? native.getItem(ns + p) : null; return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
    });
  }

  // ── DOM URL sinks ─────────────────────────────────────────────────────────
  var URL_ATTRS = { href: 'a area link image use feimage', 'xlink:href': '*', src: 'img script iframe frame embed source track audio video input', poster: 'video', action: 'form', formaction: 'button input', data: 'object', background: 'body table td th' };
  function isUrlAttr(el, n) { var s = URL_ATTRS[n]; return !!s && (s === '*' || (' ' + s + ' ').indexOf(' ' + el.localName + ' ') >= 0); }
  function fixEl(el) {
    if (!el || el.nodeType !== 1) return;
    for (var n in URL_ATTRS) {
      if (!isUrlAttr(el, n)) continue;
      var v = nat.getAttribute.call(el, n);
      if (v) { var p = px(v); if (p !== v) nat.setAttribute.call(el, n, p); }
    }
    var ss = nat.getAttribute.call(el, 'srcset'); if (ss) { var s2 = srcset(ss); if (s2 !== ss) nat.setAttribute.call(el, 'srcset', s2); }
    if (el.hasAttribute('integrity')) el.removeAttribute('integrity');
  }
  var FIX_SEL = '[href],[src],[poster],[action],[formaction],[data],[srcset],[integrity],[background]';
  function fixTree(n) {
    fixEl(n);
    if (n.querySelectorAll) { var all = n.querySelectorAll(FIX_SEL); for (var i = 0; i < all.length; i++) fixEl(all[i]); }
  }
  var FRAG = /\s(?:href|src|srcset|imagesrcset|action|poster|data|formaction|style|integrity|xlink:href|background)\s*=|<script|<style/i;
  function fragment(html) {
    if (typeof html !== 'string' || !FRAG.test(html)) return html;
    try {
      var t = nat.createElement.call(document, 'template');
      nat.setInner.call(t, html);
      var all = t.content.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i]; fixEl(el);
        var st = el.getAttribute('style'); if (st) { var s2 = cssText(st); if (s2 !== st) nat.setAttribute.call(el, 'style', s2); }
        if (el.localName === 'script' && !el.getAttribute('src')) { var c = el.textContent, r = inlineJS(c); if (r !== c) nat.setText.call(el, r); }
        else if (el.localName === 'style') { var c2 = el.textContent, r2 = cssText(c2); if (r2 !== c2) nat.setText.call(el, r2); }
      }
      return nat.getInner.call(t);
    } catch (e) { return html; }
  }

  // ═════════════════════════ install hooks ═════════════════════════
  guard('fetch', function () {
    method(G, 'fetch', function (orig) { return function fetch(input, init) { if (!(typeof Request === 'function' && input instanceof Request)) input = px(input); var p = orig.call(this, input, init); scheduleCookieSync(); return p; }; });
    ctor('Request', function (args, C) { if (args.length && !(args[0] instanceof C)) args[0] = px(args[0]); });
    acc(G.Response && G.Response.prototype, 'url', unpx);
    acc(G.Request && G.Request.prototype, 'url', unpx);
  });
  guard('xhr', function () {
    var X = G.XMLHttpRequest && G.XMLHttpRequest.prototype;
    method(X, 'open', function (orig) { return function open(m, u) { var a = Array.prototype.slice.call(arguments); a[1] = px(u); this.addEventListener('loadend', scheduleCookieSync); return orig.apply(this, a); }; });
    acc(X, 'responseURL', unpx);
  });
  guard('sink-ctors', function () {
    ctor('EventSource', function (a) { a[0] = px(a[0]); });
    ctor('WebSocket', function (a) { a[0] = wsUrl(a[0]); });
    acc(G.WebSocket && G.WebSocket.prototype, 'url', function (v) { try { var t = new URL(v).searchParams.get('u'); return t || v; } catch (e) { return v; } });
    var workerUrl = function (u, opts) {
      var s = String(u);
      if (/^blob:/i.test(s)) {
        if (opts && opts.type === 'module') return s;
        var code = 'self.__up=' + JSON.stringify({ base: docRealUrl(), worker: true }) + ';try{importScripts(' + JSON.stringify(SELF + '/up/client.js') + ')}catch(e){}\nimportScripts(' + JSON.stringify(s) + ');';
        return nat.createObjectURL.call(G.URL, new Blob([code], { type: 'text/javascript' }));
      }
      return px(s);
    };
    ctor('Worker', function (a) { a[0] = workerUrl(a[0], a[1]); });
    ctor('SharedWorker', function (a) { a[0] = workerUrl(a[0], a[1]); });
    if (typeof G.importScripts === 'function') method(G, 'importScripts', function (orig) { return function importScripts() { return orig.apply(this, Array.prototype.slice.call(arguments).map(function (u) { return px(u); })); }; });
    if (G.navigator) method(G.Navigator && G.Navigator.prototype, 'sendBeacon', function (orig) { return function sendBeacon(u, d) { return orig.call(this, px(u), d); }; });
    if (G.FontFace) ctor('FontFace', function (a) { if (typeof a[1] === 'string') a[1] = cssText(a[1]); });
    // service workers would fight over our own scope; make "not supported" the visible answer
    try { delete G.Navigator.prototype.serviceWorker; } catch (e) { /* ignore */ }
    try { delete G.WorkerNavigator.prototype.serviceWorker; } catch (e) { /* ignore */ }
    // do not leak the real IP through WebRTC
    ['RTCPeerConnection', 'webkitRTCPeerConnection'].forEach(function (n) { ctor(n, function (a) { a[0] = Object.assign({}, a[0], { iceTransportPolicy: 'relay' }); }); });
    ['setTimeout', 'setInterval'].forEach(function (n) { method(G, n, function (orig) { return function () { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = inlineJS(a[0]); return orig.apply(this, a); }; }); });
  });

  if (isWin) {
    guard('attrs', function () {
      method(Element.prototype, 'setAttribute', function (orig) { return function setAttribute(n, v) {
        var ln = String(n).toLowerCase();
        if (ln === 'integrity') return;
        if (isUrlAttr(this, ln)) v = px(v);
        else if (ln === 'srcset' || ln === 'imagesrcset') v = srcset(v);
        else if (ln === 'style') v = cssText(String(v));
        else if (ln.length > 2 && ln.charCodeAt(0) === 111 && ln.charCodeAt(1) === 110) v = inlineJS(String(v));
        return orig.call(this, n, v);
      }; });
      method(Element.prototype, 'setAttributeNS', function (orig) { return function setAttributeNS(ns, n, v) { var ln = String(n).toLowerCase(); if (isUrlAttr(this, ln)) v = px(v); return orig.call(this, ns, n, v); }; });
      method(Element.prototype, 'getAttribute', function (orig) { return function getAttribute(n) { var v = orig.call(this, n); return typeof v === 'string' && v && isUrlAttr(this, String(n).toLowerCase()) ? unpx(v) : v; }; });
      [['HTMLAnchorElement', 'href'], ['HTMLAreaElement', 'href'], ['HTMLLinkElement', 'href'], ['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'], ['HTMLIFrameElement', 'src'], ['HTMLFrameElement', 'src'], ['HTMLEmbedElement', 'src'], ['HTMLSourceElement', 'src'], ['HTMLTrackElement', 'src'], ['HTMLMediaElement', 'src'], ['HTMLInputElement', 'src'], ['HTMLVideoElement', 'poster'], ['HTMLFormElement', 'action'], ['HTMLObjectElement', 'data'], ['HTMLButtonElement', 'formAction'], ['HTMLInputElement', 'formAction']]
        .forEach(function (e) { acc(G[e[0]] && G[e[0]].prototype, e[1], unpx, pxValue); });
      [['HTMLImageElement', 'currentSrc'], ['HTMLMediaElement', 'currentSrc']].forEach(function (e) { acc(G[e[0]] && G[e[0]].prototype, e[1], unpx); });
      [['HTMLImageElement', 'srcset'], ['HTMLSourceElement', 'srcset']].forEach(function (e) { acc(G[e[0]] && G[e[0]].prototype, e[1], null, srcset); });
      [['HTMLScriptElement', 'integrity'], ['HTMLLinkElement', 'integrity']].forEach(function (e) { acc(G[e[0]] && G[e[0]].prototype, e[1], null, function () { return ''; }); });
      ['HTMLAnchorElement', 'HTMLAreaElement'].forEach(function (c) {
        ['origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search'].forEach(function (p) {
          acc(G[c] && G[c].prototype, p, function (v, self) { try { return new URL(self.href)[p]; } catch (e) { return v; } });
        });
      });
    });

    guard('html-strings', function () {
      acc(Element.prototype, 'innerHTML', null, fragment);
      acc(Element.prototype, 'outerHTML', null, fragment);
      if (G.ShadowRoot) acc(G.ShadowRoot.prototype, 'innerHTML', null, fragment);
      acc(G.HTMLIFrameElement && G.HTMLIFrameElement.prototype, 'srcdoc', null, fragment);
      method(Element.prototype, 'insertAdjacentHTML', function (orig) { return function insertAdjacentHTML(pos, html) { return orig.call(this, pos, fragment(html)); }; });
      ['write', 'writeln'].forEach(function (n) { method(Document.prototype, n, function (orig) { return function () { return orig.apply(this, Array.prototype.slice.call(arguments).map(fragment)); }; }); });
      method(G.DOMParser && G.DOMParser.prototype, 'parseFromString', function (orig) { return function parseFromString(s, t) { return orig.call(this, /html/i.test(t) ? fragment(s) : s, t); }; });
      method(G.Range && G.Range.prototype, 'createContextualFragment', function (orig) { return function createContextualFragment(s) { return orig.call(this, fragment(s)); }; });
    });

    guard('insertion', function () {
      var wrapIns = function (orig) { return function () {
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          if (a && a.nodeType) {
            if (a.nodeType === 3 && this.localName === 'script') { var r = inlineJS(a.data); if (r !== a.data) a.data = r; }
            else fixTree(a);
          }
        }
        return orig.apply(this, arguments);
      }; };
      [[Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']], [Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'insertAdjacentElement']], [Document.prototype, ['append', 'prepend']], [G.DocumentFragment && G.DocumentFragment.prototype, ['append', 'prepend']]]
        .forEach(function (e) { e[1].forEach(function (n) { method(e[0], n, wrapIns); }); });
      // dynamically created inline <script>/<style>
      acc(G.HTMLScriptElement && G.HTMLScriptElement.prototype, 'text', null, inlineJS);
      acc(G.HTMLScriptElement && G.HTMLScriptElement.prototype, 'innerText', null, inlineJS);
      acc(Node.prototype, 'textContent', null, function (v, self) { return self.localName === 'script' ? inlineJS(v) : self.localName === 'style' ? cssText(v) : v; });
      document.addEventListener('click', function (e) { var a = e.target && e.target.closest && e.target.closest('a[href],area[href]'); if (a) fixEl(a); }, true);
      document.addEventListener('submit', function (e) { if (e.target && e.target.localName === 'form') fixEl(e.target); }, true);
    });

    guard('css', function () {
      var S = G.CSSStyleDeclaration && G.CSSStyleDeclaration.prototype;
      method(S, 'setProperty', function (orig) { return function setProperty(n, v, p) { return orig.call(this, n, typeof v === 'string' ? cssText(v) : v, p); }; });
      acc(S, 'cssText', null, cssText);
      ['background', 'backgroundImage', 'listStyle', 'listStyleImage', 'borderImage', 'borderImageSource', 'maskImage', 'webkitMaskImage', 'content', 'cursor'].forEach(function (p) { acc(S, p, null, cssText); });
      var SS = G.CSSStyleSheet && G.CSSStyleSheet.prototype;
      method(SS, 'insertRule', function (orig) { return function insertRule(r, i) { return orig.call(this, cssText(r), i); }; });
      method(SS, 'replace', function (orig) { return function replace(t) { return orig.call(this, cssText(t)); }; });
      method(SS, 'replaceSync', function (orig) { return function replaceSync(t) { return orig.call(this, cssText(t)); }; });
    });

    guard('document', function () {
      var D = Document.prototype;
      Object.defineProperty(D, 'cookie', { configurable: true, enumerable: true, get: mark(function () { return cookieGet(); }, 'get cookie'), set: mark(function (v) { cookieSet(v); }, 'set cookie') });
      acc(D, 'referrer', function (v) { var r = decodeHref(v); return r ? r.split('#')[0] : (v && v.indexOf(SELF) === 0 ? '' : v); });
      acc(D, 'URL', function (v) { return unpx(v); });
      acc(D, 'documentURI', function (v) { return unpx(v); });
      acc(Node.prototype, 'baseURI', function (v) { return cfg.hb ? cfg.base : unpx(v); });
      Object.defineProperty(D, 'domain', { configurable: true, enumerable: true, get: mark(function () { try { return new URL(docRealUrl()).hostname; } catch (e) { return ''; } }, 'get domain'), set: mark(function () { /* ignore */ }, 'set domain') });
      Object.defineProperty(G, 'origin', { configurable: true, enumerable: true, get: mark(function () { return realOrigin(); }, 'get origin') });
      method(G, 'open', function (orig) { return function open(u) { var a = Array.prototype.slice.call(arguments); if (a[0] !== undefined && a[0] !== '') a[0] = px(a[0]); return orig.apply(this, a); }; });
      var notify = function () {
        try { if (G.parent !== G && !isProxied(G.parent)) G.parent.postMessage({ type: 'proxyNav', url: docRealUrl() }, '*'); } catch (e) { /* ignore */ }
      };
      ['pushState', 'replaceState'].forEach(function (n) { method(G.History && G.History.prototype, n, function (orig) { return function (s, t, u) { if (u !== undefined && u !== null) u = px(u); var r = orig.call(this, s, t, u); notify(); return r; }; }); });
      G.addEventListener('popstate', notify); G.addEventListener('hashchange', notify);
    });
  }

  guard('storage', function () {
    var ns = 'up:' + realOrigin() + '|';
    ['localStorage', 'sessionStorage'].forEach(function (n) {
      var native; try { native = G[n]; } catch (e) { return; }
      if (!native) return;
      var wrapped = nsStorage(native, ns);
      Object.defineProperty(G, n, { configurable: true, enumerable: true, get: mark(function () { return wrapped; }, 'get ' + n) });
    });
    var idb = G.IDBFactory && G.IDBFactory.prototype, ins = 'up:' + realOrigin() + '|';
    method(idb, 'open', function (orig) { return function open(name) { var a = Array.prototype.slice.call(arguments); a[0] = ins + name; return orig.apply(this, a); }; });
    method(idb, 'deleteDatabase', function (orig) { return function deleteDatabase(name) { return orig.call(this, ins + name); }; });
    method(idb, 'databases', function (orig) { return function databases() { return orig.call(this).then(function (l) { return l.filter(function (d) { return d.name.indexOf(ins) === 0; }).map(function (d) { return { name: d.name.slice(ins.length), version: d.version }; }); }); }; });
    acc(G.IDBDatabase && G.IDBDatabase.prototype, 'name', function (v) { return typeof v === 'string' && v.indexOf(ins) === 0 ? v.slice(ins.length) : v; });
  });

  guard('messages', function () {
    var M = G.MessageEvent && G.MessageEvent.prototype;
    var dataDesc = Object.getOwnPropertyDescriptor(M, 'data');
    acc(M, 'data', function (v) { return isWrapped(v) ? v.d : v; });
    acc(M, 'origin', function (v, self) { var d = dataDesc.get.call(self); return isWrapped(d) ? d.o : v; });
  });

  // ── helpers used by rewritten code (see src/rewrite/js.js) ────────────────
  def('$up$w', w);
  def('$up$try', tryAssign);
  def('$up$pm', pm);
  def('$up$ev', function (s) { return typeof s === 'string' ? inlineJS(s) : s; });
  def('$up$imp', function (spec, b) {
    var s = String(spec);
    return /^(https?:)?\/\/|^\/(?!proxy\/)|^\.\.?\//.test(s) ? px(s, b || base()) : spec;
  });
  api.px = px; api.unpx = unpx; api.w = w; api.fragment = fragment; api.cookieGet = cookieGet; api.cookieSet = cookieSet; api.wsUrl = wsUrl;
})();
