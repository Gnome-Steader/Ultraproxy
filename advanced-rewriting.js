'use strict';

/**
 * Isolated URL/CSS rewriting helpers for UltraProxy.
 * Not imported by server.js yet; existing runtime files remain untouched.
 * Provides conservative URL rewriting and media-header helpers for later tests.
 * Does not spoof browser identity or bypass CAPTCHA controls.
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

function rewriteUrl(value, baseUrl, toProxyUrl = createProxyPath) {
  const target = resolveTargetUrl(value, baseUrl);
  return target ? toProxyUrl(target) : value;
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
    if (baseHref) $('base[href]').first().attr('href', baseUrl);
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

module.exports = {
  isSkippableUrl,
  resolveTargetUrl,
  createProxyPath,
  rewriteUrl,
  rewriteCss,
  rewriteSrcset,
  rewriteHtml,
  pickMediaResponseHeaders
};
