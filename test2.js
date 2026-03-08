var LORG = "https://sturdy-bassoon";
var PFX = "/proxy/";
var TURL = "https://thssandbox.com/apps/gnomesteder/cool-stuff/hostname.html";
var ORIGIN = "https://thssandbox.com";
var HOSTNAME = "thssandbox.com";

var realLocationHref = "https://sturdy-bassoon/proxy/aHR0cHM6Ly90aHNzYW5kYm94LmNvbS9hcHBzL2dub21lc3RlZGVyL2Nvb2wtc3R1ZmYvaG9zdG5hbWUuaHRtbA";

function getRealHref() { return realLocationHref; }
var _currentTargetUrl = TURL || (ORIGIN + '/');

function getProxiedUrl() {
  var real = getRealHref();
  if (real.indexOf(LORG + PFX) === 0) {
    var rest = real.slice((LORG + PFX).length);
    if (rest && /^https?:\/\//.test(rest)) return rest;
  }
  return _currentTargetUrl;
}

function getProxiedParsed() {
  try { return new URL(getProxiedUrl()); } catch(e) { return null; }
}

var __pxLoc = {
  get hostname() { var p = getProxiedParsed(); return p ? p.hostname : HOSTNAME; }
};

console.log("Proxied URL:", getProxiedUrl());
console.log("Parsed Hostname:", __pxLoc.hostname);
