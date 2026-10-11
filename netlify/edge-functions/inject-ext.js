// Adds PropDesk's extension scripts (js/*.js) to the app page so UI updates can ship
// as small files without re-uploading the large index.html. If index.html already
// includes a script, it is not added twice. Any failure returns the page untouched.
const SCRIPTS = ['/js/intel-ws.js'];

export default async (request, context) => {
  const res = await context.next();
  try {
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return res;
    const html = await res.clone().text();
    if (!html.includes('</body>') || !html.includes('page-listing-ws')) return res;
    const tags = SCRIPTS.filter((s) => !html.includes(s)).map((s) => `<script src="${s}"></script>`).join('\n');
    if (!tags) return res;
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(html.replace('</body>', tags + '\n</body>'), { status: res.status, headers });
  } catch (e) {
    return res;
  }
};

export const config = {
  path: '/*',
  excludedPath: ['/js/*', '/.netlify/*', '/*.png', '/*.json', '/*.js', '/*.sql', '/*.ico'],
};
