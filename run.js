const fs = require('fs');

function rewriteJS(js) {
  if (!js || typeof js !== 'string') return js;
  try {
    // We should not use lookbehinds as they might not be supported universally or may be tricky.
    js = js.replace(/\bwindow\.location\b/g, '(window.__pxLoc||window.location)');
    js = js.replace(/\bdocument\.location\b/g, '(window.__pxLoc||document.location)');
    js = js.replace(/\blocation\.(href|hostname|host|origin|protocol|port|pathname|search|hash|assign|replace|reload)\b/g, '(window.__pxLoc||location).$1');
    return js;
  } catch { return js; }
}

const js = `
    function updateInfo() {
      document.getElementById('hostname').textContent = window.location.hostname;
      document.getElementById('url').textContent = window.location.href;
    }
    updateInfo();
`;

console.log(rewriteJS(js));
