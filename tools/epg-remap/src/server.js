import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createGunzip } from 'node:zlib';

// Serves the generated guide and regenerates it every refreshHours. A failed refresh keeps
// serving the last good file. Only one generation runs at a time.
export function createEpgServer({ config, generate, log = () => {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  const state = { lastSuccess: null, lastError: null, running: null };
  const outFile = path.join(config.outDir, config.outputFile);
  const reportFile = path.join(config.outDir, config.reportFile);
  const prefix = config.accessToken ? `/${config.accessToken}` : '';

  function regenerate() {
    if (state.running) return state.running;
    state.running = (async () => {
      try {
        const result = await generate();
        state.lastSuccess = new Date();
        state.lastError = null;
        return result;
      } catch (err) {
        state.lastError = err.message;
        log(`generation failed: ${err.message}`);
        return null;
      } finally {
        state.running = null;
      }
    })();
    return state.running;
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      log(`request error: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  async function route(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/healthz') {
      const body = JSON.stringify({
        ok: Boolean(state.lastSuccess) && !state.lastError,
        lastSuccess: state.lastSuccess?.toISOString() ?? null,
        lastError: state.lastError,
        generating: Boolean(state.running),
      });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (pathname === `${prefix}/epg.xml.gz`) {
      return sendFile(req, res, outFile, 'application/gzip', false);
    }
    if (pathname === `${prefix}/epg.xml`) {
      return sendFile(req, res, outFile, 'application/xml; charset=utf-8', true);
    }
    if (pathname === `${prefix}/report.txt`) {
      if (config.reportAuth && !authorized(req.headers.authorization, config.reportAuth)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="epg-remap report"' });
        return res.end();
      }
      return sendFile(req, res, reportFile, 'text/plain; charset=utf-8', false);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  }

  async function sendFile(req, res, file, type, gunzip) {
    let info;
    try {
      info = await stat(file);
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '60' });
      return res.end('guide not generated yet\n');
    }
    const lastModified = info.mtime.toUTCString();
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}${gunzip ? '-x' : ''}"`;
    const headers = { 'content-type': type, 'last-modified': lastModified, etag, 'cache-control': 'public, max-age=3600' };
    const ims = Date.parse(req.headers['if-modified-since'] ?? '');
    if (req.headers['if-none-match'] === etag || (!req.headers['if-none-match'] && ims >= Math.floor(info.mtimeMs / 1000) * 1000)) {
      res.writeHead(304, headers);
      return res.end();
    }
    if (!gunzip) headers['content-length'] = info.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file);
    const body = gunzip ? stream.pipe(createGunzip()) : stream;
    body.on('error', () => res.destroy());
    body.pipe(res);
  }

  let timer = null;
  return {
    server,
    state,
    regenerate,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
      log(`serving on http://${config.host}:${server.address().port}${prefix}/epg.xml.gz`);
      timer = setIntervalImpl(() => regenerate(), config.refreshHours * 3_600_000);
      // Serve right away; the first generation runs in the background.
      regenerate();
      return server.address().port;
    },
    async stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
      await new Promise((resolve) => server.close(() => resolve()));
      await state.running;
    },
  };
}

export function authorized(header, expected) {
  if (!header || !header.startsWith('Basic ')) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), 'base64').toString('utf8'));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}
