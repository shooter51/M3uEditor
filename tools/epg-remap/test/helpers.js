import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { loadConfig } from '../src/config.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (name) => path.join(FIXTURES, name);

// Plain M3U link (not Xtream-shaped), so the M3U path is exercised by default.
export const M3U_URL = 'https://provider.example/playlist.m3u?username=fixtureuser&password=fixturepass';
export const XTREAM_URL = 'https://provider.example/get.php?username=fixtureuser&password=fixturepass&type=m3u_plus';
export const ENV = { M3U_URL };
export const NOW = new Date('2026-09-22T19:30:00Z');

const ROUTES = {
  'playlist.m3u': 'playlist.m3u',
  epg_ripper_US2: 'epg_us2.xml.gz',
  epg_ripper_FANDUEL1: 'epg_fanduel.xml',
};

// Fake fetch backed by committed fixtures. `overrides` maps a URL substring to a function
// returning a Response (or throwing) so tests can inject failures.
export function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    for (const [key, fn] of Object.entries(overrides)) if (url.includes(key)) return fn(url, init);
    if (url.includes('player_api.php')) return xtreamResponse(url);
    const key = Object.keys(ROUTES).find((k) => url.includes(k));
    if (!key) return new Response('nope', { status: 404 });
    return new Response(readFileSync(fixture(ROUTES[key])), { headers: { etag: `"${key}-v1"` } });
  };
  impl.calls = calls;
  return impl;
}

export async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'epg-remap-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function testConfig(dir, extra = {}) {
  return loadConfig(null, {
    overrides: fixture('overrides.json'),
    outDir: path.join(dir, 'out'),
    cacheDir: path.join(dir, 'cache'),
    ...extra,
  });
}

export const streamOf = (text) => Readable.from([Buffer.from(text)]);

// Minimal Xtream panel backed by fixtures: login, categories, streams (optionally by category).
function xtreamResponse(url) {
  const params = new URL(url).searchParams;
  if (params.get('password') !== 'fixturepass') return Response.json({ user_info: { auth: 0 } });
  const action = params.get('action');
  if (!action) return new Response(readFileSync(fixture('xtream_account.json')));
  if (action === 'get_live_categories') return new Response(readFileSync(fixture('xtream_categories.json')));
  if (action === 'get_live_streams') {
    const all = JSON.parse(readFileSync(fixture('xtream_streams.json'), 'utf8'));
    const cat = params.get('category_id');
    return Response.json(cat ? all.filter((s) => s.category_id === cat) : all);
  }
  return new Response('unknown action', { status: 400 });
}
