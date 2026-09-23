import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envOverrides, main } from '../src/cli.js';
import { ENV, fakeFetch, fixture, M3U_URL, tempDir } from './helpers.js';

let tmp;
let configFile;
beforeEach(async () => {
  tmp = await tempDir();
  configFile = path.join(tmp.dir, 'config.json');
  await writeFile(
    configFile,
    JSON.stringify({ overrides: fixture('overrides.json'), outDir: 'out', cacheDir: 'cache', host: '127.0.0.1' }),
  );
});
afterEach(() => tmp.cleanup());

function io(extra = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    deps: {
      env: { ...ENV },
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      fetchImpl: fakeFetch(),
      loadEnvFile: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      ...extra,
    },
  };
}

describe('cli', () => {
  it('--help', async () => {
    const t = io();
    expect(await main(['--help'], t.deps)).toBe(0);
    expect(t.out.join('')).toContain('Usage: epg-remap');
  });

  it('rejects unknown flags and conflicting modes', async () => {
    const t = io();
    expect(await main(['--bogus'], t.deps)).toBe(2);
    expect(await main(['--dry-run', '--serve'], t.deps)).toBe(2);
    expect(t.err.join('')).toContain('cannot be combined');
  });

  it('--dry-run prints the report and writes nothing', async () => {
    const t = io();
    expect(await main(['--dry-run', '-c', configFile], t.deps)).toBe(0);
    const out = t.out.join('');
    expect(out).toContain('== MATCHED (8) ==');
    expect(out).toContain('dry run');
    await expect(readFile(path.join(tmp.dir, 'out', 'epg.xml.gz'))).rejects.toThrow();
  });

  it('writes output and prints a summary', async () => {
    const t = io();
    expect(await main(['-c', configFile, '--out', path.join(tmp.dir, 'guide')], t.deps)).toBe(0);
    expect(t.out.join('')).toMatch(/wrote .*guide\/epg\.xml\.gz[\s\S]*8 matched, 1 need review, 3 unmatched, 2 placeholders/);
    expect(t.err.join('')).not.toContain('fixturepass');
  });

  it('reports generation errors with exit 1 and redacts them', async () => {
    const t = io({ env: { M3U_URL } });
    t.deps.fetchImpl = fakeFetch({ 'playlist.m3u': () => new Response('', { status: 403 }) });
    expect(await main(['-c', configFile], t.deps)).toBe(1);
    expect(t.err.join('')).toContain('HTTP 403');
  });

  it('config errors exit 2', async () => {
    const t = io();
    expect(await main(['-c', path.join(tmp.dir, 'missing.json')], t.deps)).toBe(2);
    expect(t.err.join('')).toContain('Cannot read config');
  });

  it('env file handling', async () => {
    const loaded = [];
    const t = io({ loadEnvFile: (f) => loaded.push(f) });
    expect(await main(['--dry-run', '-c', configFile, '--env', 'custom.env'], t.deps)).toBe(0);
    expect(loaded).toEqual(['custom.env']);

    const t2 = io();
    expect(await main(['--dry-run', '-c', configFile, '--env', 'nope.env'], t2.deps)).toBe(2);
    expect(t2.err.join('')).toContain('cannot load env file: ENOENT');

    const t3 = io({ loadEnvFile: () => { throw new Error('EACCES'); } });
    expect(await main(['--dry-run', '-c', configFile], t3.deps)).toBe(2);
  });

  it('--serve starts, serves, and shuts down cleanly', async () => {
    let epg;
    const t = io({ onServerStarted: (s) => { epg = s; } });
    const done = main(['--serve', '-c', configFile, '--port', '0'], t.deps);
    await expect.poll(() => epg).toBeDefined();
    await epg.state.running;
    const port = epg.server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/epg.xml.gz`);
    expect(res.status).toBe(200);
    await epg.shutdown();
    expect(await done).toBe(0);
    expect(t.err.join('')).toMatch(/serving on http:\/\/127\.0\.0\.1:\d+\/epg\.xml\.gz/);
  });

  it('--serve reports a bind failure', async () => {
    const t = io();
    expect(await main(['--serve', '-c', configFile, '--host', '203.0.113.1', '--port', '1'], t.deps)).toBe(1);
    expect(t.err.join('')).toContain('cannot start server');
  });
});

describe('envOverrides', () => {
  it('maps env vars and ignores empties', () => {
    expect(
      envOverrides({ EPG_ACCESS_TOKEN: 'tok12345', EPG_REPORT_AUTH: 'a:b', EPG_REFRESH_HOURS: '12', EPG_THRESHOLD: '0.9', EPG_REGION_PREFERENCE: 'east' }),
    ).toEqual({ accessToken: 'tok12345', reportAuth: 'a:b', refreshHours: 12, threshold: 0.9, regionPreference: 'east' });
    expect(envOverrides({ EPG_THRESHOLD: '' })).toEqual({
      accessToken: undefined,
      reportAuth: undefined,
      refreshHours: undefined,
      threshold: undefined,
      regionPreference: undefined,
    });
  });

  it('env settings reach the server config', async () => {
    let epg;
    const t = io({ onServerStarted: (s) => { epg = s; } });
    t.deps.env = { ...ENV, EPG_ACCESS_TOKEN: 'envToken123', PORT: '0' };
    const done = main(['--serve', '-c', configFile], t.deps);
    await expect.poll(() => epg).toBeDefined();
    await epg.state.running;
    const port = epg.server.address().port;
    expect((await fetch(`http://127.0.0.1:${port}/envToken123/epg.xml.gz`)).status).toBe(200);
    await epg.shutdown();
    await done;
  });
});
