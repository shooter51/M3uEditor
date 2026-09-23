import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorized, createEpgServer } from '../src/server.js';
import { tempDir, testConfig } from './helpers.js';

let tmp;
let epg;
beforeEach(async () => {
  tmp = await tempDir();
});
afterEach(async () => {
  if (epg) await epg.stop().catch(() => {});
  epg = null;
  await tmp.cleanup();
});

async function startServer(extra = {}, generate = async () => ({})) {
  const config = await testConfig(tmp.dir, { port: 8080, host: '127.0.0.1', ...extra });
  config.port = 0; // ephemeral
  const intervals = [];
  const logs = [];
  epg = createEpgServer({
    config,
    generate,
    log: (m) => logs.push(m),
    setIntervalImpl: (fn, ms) => {
      intervals.push({ fn, ms });
      return 1;
    },
    clearIntervalImpl: () => {},
  });
  const port = await epg.start();
  return { config, base: `http://127.0.0.1:${port}`, intervals, logs };
}

async function writeOutputs(config) {
  await mkdir(config.outDir, { recursive: true });
  await writeFile(path.join(config.outDir, 'epg.xml.gz'), gzipSync('<tv></tv>\n'));
  await writeFile(path.join(config.outDir, 'report.txt'), 'report\n');
}

describe('server', () => {
  it('returns 503 before the first generation, then serves the file', async () => {
    const { config, base } = await startServer();
    expect((await fetch(`${base}/epg.xml.gz`)).status).toBe(503);
    await writeOutputs(config);
    const res = await fetch(`${base}/epg.xml.gz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(gzipSync('<tv></tv>\n'));
  });

  it('serves decompressed XML, report, HEAD, 304s, 404 and 405', async () => {
    const { config, base } = await startServer();
    await writeOutputs(config);
    const t = new Date('2026-09-22T12:00:00Z');
    await utimes(path.join(config.outDir, 'epg.xml.gz'), t, t);

    const xml = await fetch(`${base}/epg.xml`);
    expect(await xml.text()).toBe('<tv></tv>\n');
    expect(await (await fetch(`${base}/report.txt`)).text()).toBe('report\n');

    const head = await fetch(`${base}/epg.xml.gz`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    const etag = head.headers.get('etag');
    expect((await fetch(`${base}/epg.xml.gz`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await fetch(`${base}/epg.xml.gz`, { headers: { 'if-modified-since': t.toUTCString() } })).status).toBe(304);
    expect(
      (await fetch(`${base}/epg.xml.gz`, { headers: { 'if-modified-since': new Date('2026-09-21').toUTCString() } })).status,
    ).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/epg.xml.gz`, { method: 'POST' })).status).toBe(405);
  });

  it('requires the access token path and report auth when configured', async () => {
    const { config, base } = await startServer({ accessToken: 'secretToken123', reportAuth: 'tom:pw' });
    await writeOutputs(config);
    expect((await fetch(`${base}/epg.xml.gz`)).status).toBe(404);
    expect((await fetch(`${base}/secretToken123/epg.xml.gz`)).status).toBe(200);
    const short = await fetch(`${base}/secretToken123`);
    expect(short.status).toBe(200);
    expect(short.headers.get('content-type')).toBe('application/gzip');
    expect((await fetch(`${base}/secretToken123/report.txt`)).status).toBe(401);
    const auth = { authorization: `Basic ${Buffer.from('tom:pw').toString('base64')}` };
    expect((await fetch(`${base}/secretToken123/report.txt`, { headers: auth })).status).toBe(200);
  });

  it('healthz reflects generation state; failures keep serving the old file', async () => {
    let fail = false;
    let calls = 0;
    const { config, base, intervals, logs } = await startServer({}, async () => {
      calls++;
      if (fail) throw new Error('upstream 520');
      return {};
    });
    await epg.state.running;
    expect(intervals[0].ms).toBe(6 * 3_600_000);
    let health = await (await fetch(`${base}/healthz`)).json();
    expect(health).toMatchObject({ ok: true, lastError: null, generating: false });

    await writeOutputs(config);
    fail = true;
    await intervals[0].fn();
    await epg.state.running;
    health = await (await fetch(`${base}/healthz`)).json();
    expect(health.ok).toBe(false);
    expect(health.lastError).toBe('upstream 520');
    expect(logs.some((l) => l.includes('generation failed'))).toBe(true);
    expect((await fetch(`${base}/epg.xml.gz`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`, { method: 'HEAD' })).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('runs only one generation at a time', async () => {
    let release;
    let calls = 0;
    await startServer({}, () => {
      calls++;
      return new Promise((r) => {
        release = r;
      });
    });
    const a = epg.regenerate();
    const b = epg.regenerate();
    expect(a).toBe(b);
    release({});
    await a;
    expect(calls).toBe(1);
  });

  it('fails to start on a busy port', async () => {
    const { config } = await startServer();
    const port = epg.server.address().port;
    const other = createEpgServer({ config: { ...config, port }, generate: async () => ({}) });
    await expect(other.start()).rejects.toThrow();
  });

  it('returns 500 when a handler throws', async () => {
    const { logs } = await startServer();
    const res = { headersSent: false, status: 0, writeHead(code) { this.status = code; }, end() { this.ended = true; } };
    const badUrl = { toString() { throw new Error('bad url'); } };
    epg.server.emit('request', { method: 'GET', url: badUrl, headers: {} }, res);
    await new Promise((r) => setImmediate(r));
    expect(res.status).toBe(500);
    expect(res.ended).toBe(true);
    expect(logs.some((l) => l.includes('bad url'))).toBe(true);
  });
});

describe('authorized', () => {
  it('checks basic auth in constant time', () => {
    const h = (s) => `Basic ${Buffer.from(s).toString('base64')}`;
    expect(authorized(h('a:b'), 'a:b')).toBe(true);
    expect(authorized(h('a:c'), 'a:b')).toBe(false);
    expect(authorized(h('a:bb'), 'a:b')).toBe(false);
    expect(authorized('Bearer x', 'a:b')).toBe(false);
    expect(authorized(undefined, 'a:b')).toBe(false);
  });
});
