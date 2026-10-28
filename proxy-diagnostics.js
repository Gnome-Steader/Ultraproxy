'use strict';

/**
 * UltraProxy diagnostics for compatibility and proxy-detection reports.
 *
 * This module does not disguise proxy use, spoof browser APIs, rotate identities,
 * or bypass CAPTCHA / anti-abuse controls. It reports likely causes so operators
 * can make transparent configuration changes and distinguish IP reputation from
 * client-side rewriting bugs.
 *
 * Standalone by design: server.js is intentionally not modified or imported here.
 */

const { URL } = require('node:url');

const CHALLENGE_PATTERNS = [
  /captcha/i,
  /unusual traffic/i,
  /automated quer(?:y|ies)/i,
  /verify you are human/i,
  /access denied/i,
  /proxy detected/i,
  /vpn detected/i,
  /request blocked/i,
  /too many requests/i
];

const SENSITIVE_HOST_PATTERNS = [
  /(^|\.)google\./i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)googlevideo\.com$/i,
  /(^|\.)duckduckgo\.com$/i,
  /(^|\.)recaptcha\.net$/i,
  /(^|\.)hcaptcha\.com$/i,
  /(^|\.)cloudflare\.com$/i
];

const HEADER_NAMES = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'location',
  'server',
  'via',
  'x-cache',
  'cf-ray'
];

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function selectDiagnosticHeaders(headers = {}) {
  const selected = {};
  for (const name of HEADER_NAMES) {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
    if (key && headers[key] != null) selected[name] = String(headers[key]).slice(0, 300);
  }
  return selected;
}

/**
 * Returns evidence-based diagnostic findings. Inputs are observations from a
 * failed request, not instructions to bypass a site's access controls.
 *
 * @param {object} input
 * @param {string} input.targetUrl Target URL that was requested.
 * @param {number} [input.statusCode] Upstream HTTP status.
 * @param {object} [input.responseHeaders] Upstream response headers.
 * @param {string} [input.errorText] Visible error or challenge text.
 * @param {boolean} [input.usesUpstreamProxy] Whether requests leave through a third-party proxy.
 * @param {boolean} [input.rewritesJavaScript] Whether response JavaScript is modified.
 * @param {boolean} [input.overridesBrowserApis] Whether injected code overrides location, fetch, XHR, descriptors, or function behavior.
 * @param {boolean} [input.changesOrigin] Whether the target page is served from a different origin than the target site.
 * @returns {{targetHost: string|null, likelyChallenge: boolean, headers: object, findings: Array<{level:string, code:string, explanation:string, nextStep:string}>}}
 */
function diagnoseProxyFailure(input = {}) {
  const parsed = safeUrl(input.targetUrl);
  const targetHost = parsed ? parsed.hostname : null;
  const statusCode = Number.isInteger(input.statusCode) ? input.statusCode : null;
  const headers = selectDiagnosticHeaders(input.responseHeaders);
  const errorText = String(input.errorText || '');
  const likelyChallenge = CHALLENGE_PATTERNS.some((pattern) => pattern.test(errorText)) ||
    [403, 407, 429, 503].includes(statusCode);

  const findings = [];

  if (!parsed) {
    findings.push({
      level: 'error',
      code: 'INVALID_TARGET_URL',
      explanation: 'The target URL is missing or is not a valid HTTP(S) URL.',
      nextStep: 'Log the final resolved URL and validate it before making the upstream request.'
    });
  }

  if (input.usesUpstreamProxy) {
    findings.push({
      level: 'info',
      code: 'UPSTREAM_EGRESS_REPUTATION',
      explanation: 'The destination sees the upstream proxy exit IP, not the visitor IP. Reputation databases and ASN classifications can label that address as VPN, hosting, or proxy traffic.',
      nextStep: 'For a controlled comparison, test with the upstream proxy disabled or use an egress network you are authorized to operate. If only the proxy route is blocked, the cause is likely IP reputation or the provider policy; rewriting code cannot fix it.'
    });
  }

  if (input.overridesBrowserApis) {
    findings.push({
      level: 'warning',
      code: 'BROWSER_API_OVERRIDES',
      explanation: 'Overriding browser APIs or masking property descriptors can break feature detection, media playback, authentication, and challenge scripts. It can also create an inconsistent browser environment.',
      nextStep: 'Use a compatibility mode that leaves native browser APIs intact. Remove unnecessary monkey-patching rather than adding more masking.'
    });
  }

  if (input.rewritesJavaScript) {
    findings.push({
      level: 'warning',
      code: 'JAVASCRIPT_REWRITING',
      explanation: 'Text-based JavaScript rewriting can corrupt minified code, module imports, source maps, signed flows, or origin-sensitive application logic.',
      nextStep: 'Compare the original and rewritten response for the failing site. Prefer standards-based URL rewriting and skip rewriting scripts that do not require it.'
    });
  }

  if (input.changesOrigin) {
    findings.push({
      level: 'warning',
      code: 'ORIGIN_MISMATCH',
      explanation: 'Serving a site under the proxy origin changes origin, cookie, storage, CORS, and origin-bound CAPTCHA behavior. Some providers explicitly reject this configuration.',
      nextStep: 'Use the site through its intended origin where possible. Do not rewrite challenge scripts or attempt to bypass origin checks.'
    });
  }

  if (targetHost && SENSITIVE_HOST_PATTERNS.some((pattern) => pattern.test(targetHost))) {
    findings.push({
      level: 'info',
      code: 'SENSITIVE_SITE_COMPATIBILITY',
      explanation: 'This host commonly relies on strict origin, media, authentication, or anti-abuse checks. Aggressive response rewriting is a likely compatibility risk.',
      nextStep: 'Test a pass-through response path with no HTML/JavaScript injection and preserve legitimate request and media range semantics.'
    });
  }

  if (likelyChallenge) {
    findings.push({
      level: 'warning',
      code: 'UPSTREAM_CHALLENGE_OR_BLOCK',
      explanation: 'The status or error text suggests an upstream challenge or access restriction. This does not by itself prove that the browser fingerprint caused it.',
      nextStep: 'Record the upstream status, final URL, response headers, and visible error. Compare direct and proxied requests under the same account and policy; respect the site challenge instead of bypassing it.'
    });
  }

  if (statusCode === 206 && !headers['content-range']) {
    findings.push({
      level: 'warning',
      code: 'INCOMPLETE_RANGE_FORWARDING',
      explanation: 'The upstream returned Partial Content but no Content-Range header was captured. Video seeking and resumable downloads may fail.',
      nextStep: 'Forward the upstream Content-Range and Accept-Ranges headers and preserve the upstream status code.'
    });
  }

  if (findings.length === 0) {
    findings.push({
      level: 'info',
      code: 'INSUFFICIENT_EVIDENCE',
      explanation: 'The supplied observations do not identify a clear cause.',
      nextStep: 'Capture the upstream status, final URL, selected response headers, and exact visible error from a single failed request.'
    });
  }

  return { targetHost, likelyChallenge, headers, findings };
}

module.exports = {
  diagnoseProxyFailure,
  selectDiagnosticHeaders
};
