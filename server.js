const http = require("http");
const https = require("https");
const { URL } = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;

// ─── User-Agent rotation ───────────────────────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── URL helpers ───────────────────────────────────────────────────────
function getBaseUrl(urlStr) {
  try { const u = new URL(urlStr); return u.protocol + "//" + u.host; } catch { return ""; }
}

function resolveUrl(relative, base) {
  if (!relative || relative.startsWith("data:") || relative.startsWith("blob:") || relative.startsWith("javascript:") || relative.startsWith("mailto:") || relative.startsWith("tel:") || relative === "#" || relative.startsWith("#")) return relative;
  try { return new URL(relative, base).href; } catch { return relative; }
}

function proxyUrl(absoluteUrl, type) {
  if (!absoluteUrl || absoluteUrl.startsWith("data:") || absoluteUrl.startsWith("blob:") || absoluteUrl.startsWith("javascript:") || absoluteUrl.startsWith("mailto:") || absoluteUrl.startsWith("tel:") || absoluteUrl === "#" || absoluteUrl.startsWith("#")) return absoluteUrl;
  return "/proxy?url=" + encodeURIComponent(absoluteUrl) + "&type=" + (type || "resource");
}

// ─── Cookie store ──────────────────────────────────────────────────────
const cookieStore = new Map();
function getCookies(urlStr) { try { return cookieStore.get(new URL(urlStr).host) || ""; } catch { return ""; } }
function storeCookies(urlStr, headers) {
  try {
    const host = new URL(urlStr).host;
    const existing = (cookieStore.get(host) || "").split("; ").filter(Boolean);
    const raw = headers["set-cookie"];
    if (!raw) return;
    const cookies = Array.isArray(raw) ? raw : [raw];
    for (const c of cookies) {
      const nv = c.split(";")[0].trim();
      if (!nv) continue;
      const name = nv.split("=")[0];
      const idx = existing.findIndex(p => p.startsWith(name + "="));
      if (idx !== -1) existing[idx] = nv; else existing.push(nv);
    }
    cookieStore.set(host, existing.join("; "));
  } catch {}
}

// ─── Attribute rewriting ───────────────────────────────────────────────
const URL_ATTRS = ["href","src","action","poster","data-src","data-srcset","data-href","data-url","data-background","data-image","data-poster","background","cite","formaction","icon","manifest"];

function rewriteAttr(html, attr, pageUrl) {
  const dq = new RegExp("(" + attr + ')\\s*=\\s*"([^"]*)"', "gi");
  const sq = new RegExp("(" + attr + ")\\s*=\\s*'([^']*)'", "gi");
  html = html.replace(dq, function(m, a, v) {
    const resolved = resolveUrl(v.trim(), pageUrl);
    const type = (a.toLowerCase() === "href" || a.toLowerCase() === "action") ? "page" : "resource";
    return a + '="' + proxyUrl(resolved, type) + '"';
  });
  html = html.replace(sq, function(m, a, v) {
    const resolved = resolveUrl(v.trim(), pageUrl);
    const type = (a.toLowerCase() === "href" || a.toLowerCase() === "action") ? "page" : "resource";
    return a + "='" + proxyUrl(resolved, type) + "'";
  });
  return html;
}

function rewriteSrcset(html, pageUrl) {
  return html.replace(/srcset\s*=\s*"([^"]*)"/gi, function(m, v) {
    const parts = v.split(",").map(function(part) {
      const t = part.trim(); const si = t.indexOf(" ");
      if (si === -1) return proxyUrl(resolveUrl(t, pageUrl), "resource");
      return proxyUrl(resolveUrl(t.substring(0, si), pageUrl), "resource") + t.substring(si);
    });
    return 'srcset="' + parts.join(", ") + '"';
  });
}

function rewriteCssUrls(css, pageUrl) {
  css = css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, function(m, q, v) {
    if (v.startsWith("data:") || v.startsWith("blob:")) return m;
    return "url(" + q + proxyUrl(resolveUrl(v.trim(), pageUrl), "resource") + q + ")";
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, function(m, q, v) {
    return "@import " + q + proxyUrl(resolveUrl(v.trim(), pageUrl), "css") + q;
  });
  return css;
}

function rewriteStyleBlocks(html, pageUrl) {
  return html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, function(m, o, c, cl) {
    return o + rewriteCssUrls(c, pageUrl) + cl;
  });
}

function rewriteInlineStyles(html, pageUrl) {
  return html.replace(/style\s*=\s*"([^"]*)"/gi, function(m, v) {
    return 'style="' + rewriteCssUrls(v, pageUrl) + '"';
  });
}

// ─── Injected navigation script ────────────────────────────────────────
function getInjectedScript(pageUrl) {
  return `<script>
(function() {
  var PROXY_PAGE_URL = ${JSON.stringify(pageUrl)};
  try { window.parent.postMessage({ type: 'proxy-loaded' }, '*'); if (document.title) window.parent.postMessage({ type: 'proxy-title', title: document.title }, '*'); } catch(e) {}
  var titleObs = new MutationObserver(function() { try { window.parent.postMessage({ type: 'proxy-title', title: document.title }, '*'); } catch(e) {} });
  var titleEl = document.querySelector('title'); if (titleEl) titleObs.observe(titleEl, { childList: true, characterData: true, subtree: true });
  function rurl(u) { if (!u||u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('javascript:')||u.startsWith('mailto:')||u.startsWith('tel:')||u==='#') return u; try { return new URL(u, PROXY_PAGE_URL).href; } catch { return u; } }
  function purl(a, t) { if (!a||a.startsWith('data:')||a.startsWith('blob:')||a.startsWith('javascript:')||a.startsWith('mailto:')||a.startsWith('tel:')||a==='#'||a.startsWith('#')) return a; return '/proxy?url='+encodeURIComponent(a)+'&type='+(t||'page'); }
  document.addEventListener('click', function(e) {
    var link = e.target; while (link && link.tagName !== 'A') link = link.parentElement;
    if (!link || !link.href) return;
    var href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (href.indexOf('/proxy') === 0) { try { var p = new URLSearchParams(href.split('?')[1]); var ru = p.get('url'); if (ru) window.parent.postMessage({ type: 'proxy-navigate', url: ru }, '*'); } catch(e) {} return; }
    var abs = rurl(href); e.preventDefault(); window.parent.postMessage({ type: 'proxy-navigate', url: abs }, '*'); window.location.href = purl(abs, 'page');
  }, true);
  document.addEventListener('submit', function(e) {
    var form = e.target; if (!form) return;
    var action = form.getAttribute('action') || window.location.href;
    if (action.indexOf('/proxy') === 0) return;
    var abs = rurl(action); e.preventDefault();
    if (form.method && form.method.toLowerCase() === 'get') {
      var fd = new FormData(form); var sp = new URLSearchParams(); fd.forEach(function(v, k) { sp.append(k, v); });
      var target = abs + (abs.includes('?') ? '&' : '?') + sp.toString();
      window.parent.postMessage({ type: 'proxy-navigate', url: target }, '*'); window.location.href = purl(target, 'page');
    } else { form.action = purl(abs, 'page'); form.submit(); }
  }, true);
  var of = window.fetch; window.fetch = function(i, o) {
    if (typeof i === 'string' && !i.startsWith('/proxy') && !i.startsWith('data:') && !i.startsWith('blob:')) i = purl(rurl(i), 'resource');
    else if (i && i.url && !i.url.startsWith('/proxy') && !i.url.startsWith('data:') && !i.url.startsWith('blob:')) i = new Request(purl(rurl(i.url), 'resource'), i);
    return of.call(this, i, o);
  };
  var oxo = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function(m, u) {
    if (typeof u === 'string' && !u.startsWith('/proxy') && !u.startsWith('data:') && !u.startsWith('blob:')) arguments[1] = purl(rurl(u), 'resource');
    return oxo.apply(this, arguments);
  };
  var obs = new MutationObserver(function(muts) { muts.forEach(function(m) { m.addedNodes.forEach(function(n) { if (n.nodeType !== 1) return; rwn(n); if (n.querySelectorAll) n.querySelectorAll('[src],[href],[action],[poster],[data-src]').forEach(rwn); }); }); });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  function rwn(n) { if (!n||!n.getAttribute) return; ['src','data-src','poster'].forEach(function(a) { var v = n.getAttribute(a); if (v&&!v.startsWith('/proxy')&&!v.startsWith('data:')&&!v.startsWith('blob:')&&!v.startsWith('#')) n.setAttribute(a, purl(rurl(v), 'resource')); }); }
})();
</script>`;
}

// ─── Full HTML rewriting ───────────────────────────────────────────────
function rewriteHtml(html, pageUrl) {
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, "");
  html = html.replace(/\s+integrity\s*=\s*["'][^"']*["']/gi, "");
  html = html.replace(/\s+nonce\s*=\s*["'][^"']*["']/gi, "");
  html = rewriteSrcset(html, pageUrl);
  html = rewriteStyleBlocks(html, pageUrl);
  html = rewriteInlineStyles(html, pageUrl);
  for (const attr of URL_ATTRS) html = rewriteAttr(html, attr, pageUrl);
  const script = getInjectedScript(pageUrl);
  if (html.includes("</head>")) html = html.replace("</head>", script + "</head>");
  else if (html.includes("<body")) html = html.replace(/<body([^>]*)>/, "<body$1>" + script);
  else html = script + html;
  return html;
}

// ─── Fetch with decompression ──────────────────────────────────────────
function fetchUrl(urlStr, options) {
  return new Promise(function(resolve, reject) {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const reqOpts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = lib.request(reqOpts, function(res) {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = resolveUrl(res.headers.location, urlStr);
        return fetchUrl(next, options).then(resolve).catch(reject);
      }
      const chunks = [];
      const encoding = (res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
      stream.on("data", function(c) { chunks.push(c); });
      stream.on("end", function() { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: urlStr }); });
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, function() { req.destroy(); reject(new Error("Timeout")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Error page ────────────────────────────────────────────────────────
function errorPage(title, msg) {
  return `<!DOCTYPE html><html><head><title>${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#151822;color:#d4dbe8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}.e{max-width:480px;text-align:center}h1{font-size:1.25rem;margin-bottom:.75rem;color:#e8ecf2}p{color:#7a849a;font-size:.875rem;line-height:1.5;word-break:break-word}</style></head><body><div class="e"><h1>${title}</h1><p>${msg}</p></div><script>try{window.parent.postMessage({type:'proxy-loaded'},'*');}catch(e){}</script></body></html>`;
}

// ─── UI HTML ───────────────────────────────────────────────────────────
const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebGate Proxy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #151822; color: #d4dbe8; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    .toolbar { background: #1a1e2e; border-bottom: 1px solid #2a2f3f; flex-shrink: 0; }
    .brand-bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid #2a2f3f; }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
    .brand svg { width: 20px; height: 20px; color: #3b82f6; }
    .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: rgba(59,130,246,0.15); color: #3b82f6; font-family: monospace; }
    .dl-btn { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; border: none; background: #3b82f6; color: white; font-size: 12px; font-weight: 500; cursor: pointer; }
    .dl-btn:hover { background: #2563eb; }
    .nav-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
    .nav-btn { background: none; border: none; color: #7a849a; padding: 6px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; }
    .nav-btn:hover { background: #2a2f3f; }
    .nav-btn:disabled { opacity: 0.3; cursor: default; }
    .nav-btn svg { width: 16px; height: 16px; }
    .url-form { flex: 1; display: flex; align-items: center; background: #151822; border-radius: 8px; border: 1px solid #2a2f3f; transition: border-color 0.2s; }
    .url-form:focus-within { border-color: #3b82f6; }
    .url-form svg { width: 14px; height: 14px; margin-left: 12px; color: #7a849a; }
    .url-form input { flex: 1; background: transparent; border: none; outline: none; color: #d4dbe8; font-size: 13px; padding: 8px; font-family: monospace; }
    .url-form input::placeholder { color: #4a5068; }
    .url-form button { background: none; border: none; color: #7a849a; padding: 8px 12px; cursor: pointer; display: flex; }
    .url-form button:hover { color: #3b82f6; }
    .content { flex: 1; position: relative; }
    .content iframe { width: 100%; height: 100%; border: none; }
    .welcome { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 24px; }
    .welcome-icon { padding: 16px; border-radius: 16px; background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.2); margin-bottom: 16px; }
    .welcome-icon svg { width: 48px; height: 48px; color: #3b82f6; }
    .welcome h1 { font-size: 24px; margin-bottom: 8px; }
    .welcome p { color: #7a849a; font-size: 14px; text-align: center; max-width: 380px; margin-bottom: 24px; }
    .search-form { width: 100%; max-width: 420px; display: flex; align-items: center; background: #1a1e2e; border-radius: 12px; border: 1px solid #2a2f3f; }
    .search-form:focus-within { border-color: #3b82f6; }
    .search-form svg { width: 20px; height: 20px; margin-left: 16px; color: #7a849a; }
    .search-form input { flex: 1; background: transparent; border: none; outline: none; color: #d4dbe8; padding: 12px; font-size: 14px; }
    .search-form input::placeholder { color: #4a5068; }
    .search-form button { background: none; border: none; color: #3b82f6; padding: 12px 16px; cursor: pointer; display: flex; }
    .quick-links { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 16px; }
    .quick-link { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; background: #1a1e2e; border: 1px solid #2a2f3f; color: #d4dbe8; font-size: 13px; cursor: pointer; }
    .quick-link:hover { border-color: rgba(59,130,246,0.4); }
    .quick-link svg { width: 16px; height: 16px; color: #7a849a; }
    .loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(21,24,34,0.8); z-index: 10; }
    .spinner { width: 32px; height: 32px; border: 3px solid #2a2f3f; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hidden { display: none !important; }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 16px; }
    .feat-badge { font-size: 11px; padding: 4px 8px; border-radius: 12px; background: rgba(59,130,246,0.1); color: #3b82f6; border: 1px solid rgba(59,130,246,0.2); }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="brand-bar">
      <div class="brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        WebGate Proxy
        <span class="badge">v1.0</span>
      </div>
    </div>
    <div class="nav-bar">
      <button class="nav-btn" id="backBtn" disabled onclick="goBack()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
      <button class="nav-btn" id="fwdBtn" disabled onclick="goForward()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </button>
      <button class="nav-btn" id="refreshBtn" disabled onclick="refresh()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
      </button>
      <form class="url-form" onsubmit="return navigateTo(document.getElementById('urlInput').value)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="text" id="urlInput" placeholder="Search or enter URL..." autocomplete="off">
        <button type="submit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </form>
    </div>
  </div>
  <div class="content" id="contentArea">
    <div class="welcome" id="welcomeScreen">
      <div class="welcome-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      </div>
      <h1>WebGate Proxy</h1>
      <p>Browse any website through an encrypted proxy. All traffic is routed through the server with full URL rewriting.</p>
      <form class="search-form" onsubmit="return searchGoogle()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="text" id="searchInput" placeholder="Search Google...">
        <button type="submit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </form>
      <div class="quick-links">
        <button class="quick-link" onclick="navigateTo('https://www.google.com')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
          Google
        </button>
        <button class="quick-link" onclick="navigateTo('https://www.wikipedia.org')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
          Wikipedia
        </button>
        <button class="quick-link" onclick="navigateTo('https://duckduckgo.com')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          DuckDuckGo
        </button>
        <button class="quick-link" onclick="navigateTo('https://github.com')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
          GitHub
        </button>
      </div>
      <div class="badges">
        <span class="feat-badge">URL Rewriting</span>
        <span class="feat-badge">Header Stripping</span>
        <span class="feat-badge">Resource Proxying</span>
        <span class="feat-badge">Easy Rehosting</span>
      </div>
    </div>
    <div class="loading hidden" id="loadingScreen">
      <div style="text-align:center">
        <div class="spinner"></div>
        <p style="margin-top:12px;font-size:13px;color:#7a849a">Loading through proxy...</p>
      </div>
    </div>
    <iframe id="proxyFrame" class="hidden" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals"></iframe>
  </div>
  <script>
    var history = [], historyIdx = -1, currentUrl = "";
    function normalizeUrl(input) {
      var t = input.trim(); if (!t) return "";
      if (!t.includes(".") || (t.includes(" ") && !t.startsWith("http"))) return "https://www.google.com/search?q=" + encodeURIComponent(t);
      if (!t.startsWith("http://") && !t.startsWith("https://")) t = "https://" + t;
      return t;
    }
    function navigateTo(url) {
      var n = normalizeUrl(url); if (!n) return false;
      currentUrl = n;
      document.getElementById("urlInput").value = n;
      document.getElementById("welcomeScreen").classList.add("hidden");
      document.getElementById("loadingScreen").classList.remove("hidden");
      var frame = document.getElementById("proxyFrame");
      frame.classList.remove("hidden");
      frame.src = "/proxy?url=" + encodeURIComponent(n) + "&type=page";
      history = history.slice(0, historyIdx + 1); history.push(n); historyIdx = history.length - 1;
      updateNavBtns();
      document.getElementById("refreshBtn").disabled = false;
      return false;
    }
    function searchGoogle() {
      var q = document.getElementById("searchInput").value.trim();
      if (q) navigateTo("https://www.google.com/search?q=" + encodeURIComponent(q));
      return false;
    }
    function goBack() { if (historyIdx > 0) { historyIdx--; var u = history[historyIdx]; currentUrl = u; document.getElementById("urlInput").value = u; document.getElementById("proxyFrame").src = "/proxy?url=" + encodeURIComponent(u) + "&type=page"; updateNavBtns(); } }
    function goForward() { if (historyIdx < history.length - 1) { historyIdx++; var u = history[historyIdx]; currentUrl = u; document.getElementById("urlInput").value = u; document.getElementById("proxyFrame").src = "/proxy?url=" + encodeURIComponent(u) + "&type=page"; updateNavBtns(); } }
    function refresh() { if (currentUrl) { document.getElementById("loadingScreen").classList.remove("hidden"); document.getElementById("proxyFrame").src = "/proxy?url=" + encodeURIComponent(currentUrl) + "&type=page"; } }
    function updateNavBtns() { document.getElementById("backBtn").disabled = historyIdx <= 0; document.getElementById("fwdBtn").disabled = historyIdx >= history.length - 1; }
    window.addEventListener("message", function(e) {
      if (e.data && e.data.type === "proxy-navigate") { var u = e.data.url; if (u && u !== currentUrl) { currentUrl = u; document.getElementById("urlInput").value = u; history = history.slice(0, historyIdx + 1); history.push(u); historyIdx = history.length - 1; updateNavBtns(); } }
      if (e.data && e.data.type === "proxy-loaded") { document.getElementById("loadingScreen").classList.add("hidden"); }
      if (e.data && e.data.type === "proxy-title") { document.title = e.data.title + " - WebGate"; }
    });
    document.getElementById("proxyFrame").addEventListener("load", function() { document.getElementById("loadingScreen").classList.add("hidden"); });
  </script>
</body>
</html>`;

// ─── Content type detection ────────────────────────────────────────────
function getCategory(ct) {
  ct = (ct || "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("xhtml")) return "html";
  if (ct.includes("text/css")) return "css";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "js";
  return "other";
}

// ─── Blocked security headers ──────────────────────────────────────────
const BLOCKED_HEADERS = new Set(["content-security-policy","content-security-policy-report-only","x-frame-options","x-content-type-options","x-xss-protection","strict-transport-security","permissions-policy","cross-origin-embedder-policy","cross-origin-opener-policy","cross-origin-resource-policy","referrer-policy","content-encoding","transfer-encoding","content-length"]);

// ─── Request handler ───────────────────────────────────────────────────
const server = http.createServer(async function(req, res) {
  const u = new URL(req.url, "http://localhost");

  // Serve UI
  if (u.pathname === "/" || u.pathname === "") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(UI_HTML);
    return;
  }

  // Proxy route
  if (u.pathname === "/proxy") {
    const targetUrl = u.searchParams.get("url");
    const type = u.searchParams.get("type") || "resource";

    if (!targetUrl) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(errorPage("No URL", "Please enter a URL to proxy."));
      return;
    }

    let parsed;
    try { parsed = new URL(targetUrl); } catch {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(errorPage("Invalid URL", "The URL is not valid."));
      return;
    }

    try {
      const reqHeaders = {
        "User-Agent": randomUA(),
        "Accept": type === "page" ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" : "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Referer": parsed.origin + "/",
        "Origin": parsed.origin,
      };
      const cookies = getCookies(targetUrl);
      if (cookies) reqHeaders["Cookie"] = cookies;

      let body = null;
      if (req.method === "POST") {
        body = await new Promise(function(resolve) {
          const chunks = []; req.on("data", function(c) { chunks.push(c); }); req.on("end", function() { resolve(Buffer.concat(chunks).toString()); });
        });
        if (req.headers["content-type"]) reqHeaders["Content-Type"] = req.headers["content-type"];
      }

      const response = await fetchUrl(targetUrl, { method: req.method || "GET", headers: reqHeaders, body });
      storeCookies(targetUrl, response.headers);

      const ct = response.headers["content-type"] || "application/octet-stream";
      const cat = getCategory(ct);

      // Build clean response headers
      const respHeaders = { "Access-Control-Allow-Origin": "*" };
      for (const [k, v] of Object.entries(response.headers)) {
        if (!BLOCKED_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
      }

      if (cat === "html") {
        const html = response.body.toString("utf-8");
        const rewritten = rewriteHtml(html, response.url);
        respHeaders["Content-Type"] = "text/html; charset=utf-8";
        delete respHeaders["content-length"];
        res.writeHead(response.status, respHeaders);
        res.end(rewritten);
      } else if (cat === "css") {
        const css = response.body.toString("utf-8");
        const rewritten = rewriteCssUrls(css, response.url);
        respHeaders["Content-Type"] = ct;
        delete respHeaders["content-length"];
        res.writeHead(response.status, respHeaders);
        res.end(rewritten);
      } else if (cat === "js") {
        let js = response.body.toString("utf-8");
        js = js.replace(/fetch\s*\(\s*["'](https?:\/\/[^"']+)["']/g, function(m, url) {
          return 'fetch("' + proxyUrl(url, "resource") + '"';
        });
        respHeaders["Content-Type"] = ct;
        delete respHeaders["content-length"];
        res.writeHead(response.status, respHeaders);
        res.end(js);
      } else {
        respHeaders["Content-Type"] = ct;
        respHeaders["Content-Length"] = response.body.length;
        respHeaders["Cache-Control"] = "public, max-age=3600";
        res.writeHead(response.status, respHeaders);
        res.end(response.body);
      }
    } catch (err) {
      console.error("Proxy error:", err.message);
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end(errorPage("Failed to Load", err.message));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end(errorPage("Not Found", "The requested page was not found. Go to <a href='/' style='color:#3b82f6'>/</a> to use the proxy."));
});

server.listen(PORT, function() {
  console.log("WebGate Proxy running on http://localhost:" + PORT);
});
