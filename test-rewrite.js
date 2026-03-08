const cheerio = require('cheerio');

function rewriteJS(js) {
  if (!js || typeof js !== 'string') return js;
  try {
    js = js.replace(/(?<![a-zA-Z0-9_$])window\.location\b/g, '(window.__pxLoc||window.location)');
    js = js.replace(/(?<![a-zA-Z0-9_$])document\.location\b/g, '(window.__pxLoc||document.location)');
    js = js.replace(/(?<![a-zA-Z0-9_$])location\.(href|hostname|host|origin|protocol|port|pathname|search|hash|assign|replace|reload)\b/g, '(window.__pxLoc||location).$1');
    return js;
  } catch { return js; }
}

const html = `
  <script>
    function updateInfo() {
      document.getElementById('hostname').textContent = window.location.hostname;
      document.getElementById('url').textContent = window.location.href;
    }
    updateInfo();
  </script>
`;

const $ = cheerio.load(html, { decodeEntities: false });
$('script').each((_,el) => {
    if (!$(el).attr('src')) {
      const c = $(el).html();
      if (c) {
        const rc = rewriteJS(c);
        if (rc !== c) $(el).html(rc);
      }
    }
});
console.log($.html());
