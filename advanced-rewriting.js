'use strict';

/**
 * Isolated URL/CSS rewriting helpers for UltraProxy.
 * Optional response rewriting layer for UltraProxy. This file is not wired into
 * server.js automatically; callers opt in so existing runtime injection is preserved.
 * The plugin pipeline adapts Reflux-style middleware concepts. The conservative
 * JavaScript pass uses Scramjet-inspired context-aware rewriting principles, but
 * is not a port of Scramjet's Rust/OXC AST rewriter.
 */
const { URL } = require('node:url');

const SKIP_SCHEMES = /^(?:data|blob|javascript|mailto|tel|about|intent|android-app|chrome-extension):/i;
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

function isSkippableUrl(value) {
  return typeof value !== 'string' || !value.trim() ||
    value.trim().startsWith('#') || SKIP_SCHEMES.test(value.trim());
}

function resolveTargetUrl(value, baseUrl) {
  if (isSkippableUrl(value)) return null;
  try {
    const resolved = new URL(value.trim(), baseUrl);
    return HTTP_PROTOCOLS.has(resolved.protocol) ? resolved.href : null;
  } catch {
    return null;
  }
}

/* Builds the existing /proxy/<absolute-url> route shape. */
function createProxyPath(targetUrl, prefix = '/proxy/') {
  try {
    const url = new URL(targetUrl);
    return HTTP_PROTOCOLS.has(url.protocol) ? prefix + url.href : targetUrl;
  } catch {
    return targetUrl;
  }
}

function isAlreadyProxied(value, prefix = '/proxy/') {
  return typeof value === 'string' && value.startsWith(prefix);
}

function rewriteUrl(value, baseUrl, toProxyUrl = createProxyPath) {
  if (isSkippableUrl(value) || isAlreadyProxied(value)) return value;
  const target = resolveTargetUrl(value, baseUrl);
  if (!target) return value;
  try {
    const rewritten = toProxyUrl(target);
    return typeof rewritten === 'string' && rewritten ? rewritten : value;
  } catch {
    return value;
  }
}

/* Rewrite CSS url() and quoted @import references only. */
function rewriteCss(css, baseUrl, toProxyUrl = createProxyPath) {
  if (typeof css !== 'string' || !css) return css;
  let result = css.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi,
    (whole, quote, quoted, bare) => {
      const raw = (quoted !== undefined ? quoted : bare || '').trim();
      if (isSkippableUrl(raw)) return whole;
      const next = rewriteUrl(raw, baseUrl, toProxyUrl);
      return next === raw ? whole : 'url(' + (quote || '') + next + (quote || '') + ')';
    }
  );
  result = result.replace(/@import\s+(["'])(.*?)\1/gi, (whole, quote, raw) => {
    if (isSkippableUrl(raw)) return whole;
    const next = rewriteUrl(raw, baseUrl, toProxyUrl);
    return next === raw ? whole : '@import ' + quote + next + quote;
  });
  return result;
}

/* Rewrite srcset candidates and preserve density/width descriptors. */
function rewriteSrcset(srcset, baseUrl, toProxyUrl = createProxyPath) {
  if (typeof srcset !== 'string' || !srcset.trim()) return srcset;
  const out = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i])) i++;
    if (i >= srcset.length) break;
    const start = i;
    const isData = srcset.slice(i, i + 5).toLowerCase() === 'data:';
    while (i < srcset.length && (isData ? !/\s/.test(srcset[i]) : !/[\s,]/.test(srcset[i]))) i++;
    let url = srcset.slice(start, i);
    while (i < srcset.length && /\s/.test(srcset[i])) i++;
    const descriptorStart = i;
    while (i < srcset.length && srcset[i] !== ',') i++;
    const descriptor = srcset.slice(descriptorStart, i).trim();
    if (!isSkippableUrl(url)) url = rewriteUrl(url, baseUrl, toProxyUrl);
    out.push(url + (descriptor ? ' ' + descriptor : ''));
    if (i < srcset.length) i++;
  }
  return out.join(', ');
}

const URL_ATTRIBUTES = [
  'src', 'href', 'poster', 'action', 'formaction', 'data',
  'xlink:href', 'manifest', 'cite', 'background'
];

function shouldSkipAttribute(node, attr, value) {
  const tag = String(node.name || '').toLowerCase();
  const rel = String(node.attribs && node.attribs.rel || '').toLowerCase();
  if (isSkippableUrl(value)) return true;
  if (tag === 'link' && /canonical|alternate/.test(rel)) return true;
  /* Challenge-provider scripts stay direct; origin-bound site keys may still reject the proxy origin. */
  if (tag === 'script' && attr === 'src' &&
      /(?:google\.com\/recaptcha|gstatic\.com\/recaptcha|hcaptcha\.com)/i.test(value)) return true;
  return false;
}

/* Optional HTML rewriter using the project's existing cheerio dependency. */
function rewriteHtml(html, sourceUrl, toProxyUrl = createProxyPath) {
  if (typeof html !== 'string' || !html) return html;
  let cheerio;
  try { cheerio = require('cheerio'); } catch { return html; }
  try {
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    let baseUrl = sourceUrl;
    const baseHref = $('base[href]').first().attr('href');
    if (baseHref) baseUrl = resolveTargetUrl(baseHref, sourceUrl) || sourceUrl;

    $('*').each((_, node) => {
      const el = $(node);
      const tag = String(node.name || '').toLowerCase();
      for (const attr of URL_ATTRIBUTES) {
        const value = el.attr(attr);
        if (value == null || shouldSkipAttribute(node, attr, value)) continue;
        if (tag === 'link' && attr === 'href' &&
            /canonical|alternate|dns-prefetch|preconnect|icon/i.test(el.attr('rel') || '')) continue;
        el.attr(attr, rewriteUrl(value, baseUrl, toProxyUrl));
      }
      for (const attr of ['srcset', 'imagesrcset']) {
        const value = el.attr(attr);
        if (value != null) el.attr(attr, rewriteSrcset(value, baseUrl, toProxyUrl));
      }
      const style = el.attr('style');
      if (style) el.attr('style', rewriteCss(style, baseUrl, toProxyUrl));
      if (tag === 'style') {
        const text = el.html();
        if (text) el.text(rewriteCss(text, baseUrl, toProxyUrl));
      }
    });
    if (baseHref) $('base[href]').first().attr('href', rewriteUrl(baseUrl, sourceUrl, toProxyUrl));
    return $.html();
  } catch {
    return html;
  }
}

/* Headers a media proxy should consider preserving for video seeking/range responses. */
const MEDIA_RESPONSE_HEADERS = [
  'accept-ranges', 'content-length', 'content-range', 'content-type',
  'etag', 'last-modified', 'cache-control', 'expires'
];

function pickMediaResponseHeaders(headers = {}) {
  const out = {};
  for (const name of MEDIA_RESPONSE_HEADERS) {
    const key = Object.keys(headers).find(k => k.toLowerCase() === name);
    if (key != null && headers[key] != null) out[name] = headers[key];
  }
  return out;
}

/*
 * Lightweight JavaScript tokenizer. It skips comments and template literals,
 * and deliberately leaves escaped string literals alone. This lets us safely
 * handle common static URL arguments without pretending regexes are a full JS
 * parser or changing arbitrary strings in application code.
 */
function tokenizeJavaScript(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(source.length, i + 2);
      continue;
    }

    // Avoid treating quotes inside common regex literals as ordinary strings.
    if (ch === '/') {
      const previous = tokens[tokens.length - 1];
      const previousValue = previous && previous.value;
      const regexMayStart = !previous ||
        (previous.type === 'punct' && /^(?:\(|\{|\[|=|:|,|!|\?|;|&|\||\+|-|\*|%)$/.test(previousValue)) ||
        (previous.type === 'identifier' && /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await)$/.test(previousValue));
      if (regexMayStart) {
        const start = i++;
        let inCharacterClass = false;
        let escapedRegex = false;
        while (i < source.length) {
          const current = source[i++];
          if (escapedRegex) escapedRegex = false;
          else if (current === '\\') escapedRegex = true;
          else if (current === '[') inCharacterClass = true;
          else if (current === ']') inCharacterClass = false;
          else if (current === '/' && !inCharacterClass) break;
          else if (current === '\n' || current === '\r') break;
        }
        while (i < source.length && /[a-z]/i.test(source[i])) i++;
        tokens.push({ type: 'regex', start, end: i, value: '' });
        continue;
      }
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i++;
      let escaped = false;
      let hasEscape = false;
      while (i < source.length) {
        const current = source[i++];
        if (escaped) {
          hasEscape = true;
          escaped = false;
        } else if (current === '\\') {
          escaped = true;
        } else if (current === quote) {
          break;
        }
      }
      const closed = source[i - 1] === quote;
      tokens.push({
        type: 'string',
        start,
        end: i,
        quote,
        value: closed ? source.slice(start + 1, i - 1) : '',
        hasEscape,
        closed
      });
      continue;
    }

    // A template can contain nested expressions; conservatively leave it alone.
    if (ch.charCodeAt(0) === 96) {
      i++;
      let escaped = false;
      while (i < source.length) {
        const current = source[i++];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current.charCodeAt(0) === 96) break;
      }
      tokens.push({ type: 'template', start: i, end: i, value: '' });
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      tokens.push({ type: 'identifier', start, end: i, value: source.slice(start, i) });
      continue;
    }

    tokens.push({ type: 'punct', start: i, end: i + 1, value: ch });
    i++;
  }

  return tokens;
}

/*
 * Rewrite static URL strings in common browser APIs and module specifiers.
 * Dynamic expressions, escaped literals, templates, comments, and unrelated
 * strings remain untouched. For full syntax-aware transformations, callers can
 * provide an AST transform through options.transform.
 */
function rewriteJavaScript(source, baseUrl, toProxyUrl = createProxyPath, options = {}) {
  if (typeof source !== 'string' || !source || !baseUrl) return source;

  const tokens = tokenizeJavaScript(source);
  const edits = new Map();
  const urlTakingCalls = new Set([
    'fetch', 'importScripts', 'Worker', 'SharedWorker', 'EventSource', 'sendBeacon'
  ]);

  function considerString(index) {
    const token = tokens[index];
    if (!token || token.type !== 'string' || !token.closed || token.hasEscape) return;
    if (edits.has(token.start) || isSkippableUrl(token.value) || isAlreadyProxied(token.value)) return;
    const rewritten = rewriteUrl(token.value, baseUrl, toProxyUrl);
    if (rewritten !== token.value) {
      edits.set(token.start, {
        start: token.start,
        end: token.end,
        value: token.quote + rewritten + token.quote
      });
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'identifier') continue;

    // fetch('/api'), new Worker('./worker.js'), importScripts('chunk.js'), etc.
    if (urlTakingCalls.has(token.value) &&
        tokens[i + 1] && tokens[i + 1].value === '(' &&
        tokens[i + 2] && tokens[i + 2].type === 'string' &&
        tokens[i + 3] && (tokens[i + 3].value === ')' || tokens[i + 3].value === ',')) {
      considerString(i + 2);
    }

    // xhr.open('GET', '/api') — only touch the URL argument, not the method.
    if (token.value === 'open' && tokens[i - 1] && tokens[i - 1].value === '.' &&
        tokens[i + 1] && tokens[i + 1].value === '(' &&
        tokens[i + 2] && tokens[i + 2].type === 'string' &&
        tokens[i + 3] && tokens[i + 3].value === ',' &&
        tokens[i + 4] && tokens[i + 4].type === 'string') {
      considerString(i + 4);
    }

    // Dynamic import, side-effect import, and import ... from "module".
    if (token.value === 'import') {
      if (tokens[i + 1] && tokens[i + 1].value === '(' &&
          tokens[i + 2] && tokens[i + 2].type === 'string') {
        considerString(i + 2);
      } else if (tokens[i + 1] && tokens[i + 1].type === 'string') {
        considerString(i + 1);
      } else {
        for (let j = i + 1; j < Math.min(tokens.length, i + 32); j++) {
          if (tokens[j].value === ';' || tokens[j].value === '}') break;
          if (tokens[j].type === 'identifier' && tokens[j].value === 'from' &&
              tokens[j + 1] && tokens[j + 1].type === 'string') {
            considerString(j + 1);
            break;
          }
        }
      }
    }

    if (token.value === 'export') {
      for (let j = i + 1; j < Math.min(tokens.length, i + 32); j++) {
        if (tokens[j].value === ';' || tokens[j].value === '}') break;
        if (tokens[j].type === 'identifier' && tokens[j].value === 'from' &&
            tokens[j + 1] && tokens[j + 1].type === 'string') {
          considerString(j + 1);
          break;
        }
      }
    }
  }

  let output = source;
  for (const edit of Array.from(edits.values()).sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  }

  // Optional AST-based pass (Babel, OXC, etc.) without adding a mandatory parser
  // dependency to UltraProxy. If it fails, retain the conservative rewrite.
  if (typeof options.transform === 'function') {
    try {
      const transformed = options.transform(output, {
        baseUrl,
        toProxyUrl,
        isModule: Boolean(options.isModule),
        sourceUrl: options.sourceUrl || baseUrl
      });
      if (typeof transformed === 'string') output = transformed;
    } catch {}
  }

  return output;
}

function pluginMatches(plugin, context) {
  if (!plugin || !plugin.matches) return true;
  let hostname = '';
  try {
    hostname = new URL(context.baseUrl || context.sourceUrl || context.url).hostname.toLowerCase();
  } catch {}

  if (typeof plugin.matches === 'function') {
    try { return Boolean(plugin.matches({ ...context, hostname })); } catch { return false; }
  }
  if (plugin.matches instanceof RegExp) {
    plugin.matches.lastIndex = 0;
    return plugin.matches.test(hostname);
  }
  if (Array.isArray(plugin.matches)) {
    return plugin.matches.some(domain => {
      const normalized = String(domain).toLowerCase().replace(/^\./, '');
      return hostname === normalized || hostname.endsWith('.' + normalized);
    });
  }
  return false;
}

/*
 * Reflux-inspired response middleware pipeline. Plugins are ordered and may
 * optionally define matches, before, after, rewriteHtml, rewriteCss, or
 * rewriteJavaScript. This is an adapter for UltraProxy's rewriting layer, not
 * the Reflux package itself and not a network transport wrapper.
 */
function createRewritePipeline(options = {}) {
  const toProxyUrl = typeof options.toProxyUrl === 'function' ? options.toProxyUrl : createProxyPath;
  const plugins = [];

  function use(plugin) {
    if (!plugin || typeof plugin !== 'object') throw new TypeError('Rewrite plugin must be an object');
    plugins.push(plugin);
    return () => {
      const index = plugins.indexOf(plugin);
      if (index !== -1) plugins.splice(index, 1);
    };
  }

  function rewrite(type, input, context = {}) {
    if (typeof input !== 'string') return input;
    const baseUrl = context.baseUrl || context.sourceUrl || context.url;
    if (!baseUrl) return input;

    const ctx = { ...context, type, baseUrl, sourceUrl: context.sourceUrl || baseUrl, toProxyUrl };
    let output = input;

    try {
      if (type === 'html') output = rewriteHtml(output, baseUrl, toProxyUrl);
      else if (type === 'css') output = rewriteCss(output, baseUrl, toProxyUrl);
      else if (type === 'javascript' || type === 'js') {
        output = rewriteJavaScript(output, baseUrl, toProxyUrl, {
          isModule: Boolean(ctx.isModule),
          sourceUrl: ctx.sourceUrl,
          transform: options.transformJavaScript
        });
      }
    } catch {
      output = input;
    }

    for (const plugin of plugins) {
      if (!pluginMatches(plugin, ctx)) continue;
      try {
        if (typeof plugin.before === 'function') {
          const value = plugin.before(output, ctx);
          if (typeof value === 'string') output = value;
        }

        const handler = type === 'html' ? plugin.rewriteHtml :
          type === 'css' ? plugin.rewriteCss :
          (type === 'javascript' || type === 'js') ? plugin.rewriteJavaScript : null;
        if (typeof handler === 'function') {
          const value = handler(output, ctx);
          if (typeof value === 'string') output = value;
        }

        if (typeof plugin.after === 'function') {
          const value = plugin.after(output, ctx);
          if (typeof value === 'string') output = value;
        }
      } catch {
        // Isolate site-plugin failures so a plugin cannot break the whole response.
      }
    }

    return output;
  }

  return {
    use,
    rewrite,
    rewriteHtml: (html, context) => rewrite('html', html, context),
    rewriteCss: (css, context) => rewrite('css', css, context),
    rewriteJavaScript: (js, context) => rewrite('javascript', js, context),
    getPlugins: () => plugins.slice()
  };
}


module.exports = {
  isSkippableUrl,
  resolveTargetUrl,
  createProxyPath,
  rewriteUrl,
  rewriteCss,
  rewriteSrcset,
  rewriteHtml,
  rewriteJavaScript,
  tokenizeJavaScript,
  createRewritePipeline,
  pickMediaResponseHeaders
};
