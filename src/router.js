// router.js — lightweight internal router for /mockcloud/* UI API endpoints

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(
      '^' +
      pattern.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) +
      '(?:\\?.*)?$'
    );
    this.routes.push({ method: method?.toUpperCase(), re, keys, handler });
  }

  get(p, h)    { this.add('GET',    p, h); }
  post(p, h)   { this.add('POST',   p, h); }
  put(p, h)    { this.add('PUT',    p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  async dispatch(req, res) {
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams.entries());

    for (const route of this.routes) {
      if (route.method && route.method !== req.method) continue;
      const m = url.pathname.match(route.re);
      if (!m) continue;

      req.params = {};
      route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });

      try {
        await route.handler(req, res);
      } catch (e) {
        console.error('[Router] Handler error:', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      }
      return true;
    }
    return false;
  }
}
