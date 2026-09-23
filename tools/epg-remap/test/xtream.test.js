import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { normalizeName } from '../src/normalize.js';
import { generate, loadPlaylist } from '../src/pipeline.js';
import { fetchXtreamEntries, parseXtreamUrl } from '../src/xtream.js';
import { fakeFetch, fixture, M3U_URL, NOW, tempDir, testConfig, XTREAM_URL } from './helpers.js';

const creds = parseXtreamUrl(XTREAM_URL);

describe('parseXtreamUrl', () => {
  it.each([
    ['http://h.example/get.php?username=u&password=p&type=m3u_plus', { base: 'http://h.example', username: 'u', password: 'p' }],
    ['http://h.example:8080/sub/player_api.php?username=u&password=p', { base: 'http://h.example:8080/sub', username: 'u', password: 'p' }],
    ['http://h.example/get.php?username=u', null],
    ['http://h.example/list.m3u?username=u&password=p', null],
    ['not a url', null],
  ])('%s', (url, expected) => {
    expect(parseXtreamUrl(url)).toEqual(expected);
  });
});

describe('fetchXtreamEntries', () => {
  it('reads all live streams, skipping adult, mapping epg_channel_id to tvg-id', async () => {
    const { entries, stats } = await fetchXtreamEntries(creds, { fetchImpl: fakeFetch() });
    expect(stats).toEqual({ total: 5, vodSkipped: 0, adultSkipped: 1, categories: 1 });
    expect(entries[0]).toEqual({
      tvgId: 'ESPN.us',
      tvgName: 'US: ESPN ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
      tvgLogo: 'https://logo.example/espn.png',
      group: 'US| SPORT ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
      name: 'US: ESPN ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
    });
    expect(entries.find((e) => e.name.startsWith('PPV')).tvgId).toBe('');
  });

  it('with a group filter, requests only matching categories', async () => {
    const f = fakeFetch();
    const { entries, stats } = await fetchXtreamEntries(creds, { fetchImpl: f, groupFilter: /^US\|/i });
    expect(entries.map((e) => e.name)).toEqual(['US: ESPN ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'US: HBO ᴴᴰ', 'PPV: UFC MAIN EVENT']);
    expect(entries[2].group).toBe('US| PPV EVENT');
    expect(stats).toMatchObject({ categories: 3, adultSkipped: 1 });
    expect(f.calls.filter((c) => c.url.includes('category_id=')).length).toBe(3);
  });

  it('dedupes streams listed in several categories', async () => {
    const dup = [{ stream_id: 1, name: 'A', category_id: '1' }];
    const f = fakeFetch({
      'action=get_live_categories': () => Response.json([{ category_id: '1', category_name: 'X' }, { category_id: '2', category_name: 'X2' }]),
      'action=get_live_streams': () => Response.json(dup),
    });
    const { entries } = await fetchXtreamEntries(creds, { fetchImpl: f, groupFilter: /X/ });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tvgId: '', tvgLogo: '', group: 'X' });
  });

  it('tolerates missing names and unknown categories', async () => {
    const f = fakeFetch({
      'action=get_live_categories': () => Response.json([{ category_id: 5 }]),
      'action=get_live_streams': () => Response.json([{ stream_id: 9, category_id: '77' }]),
    });
    const { entries } = await fetchXtreamEntries(creds, { fetchImpl: f });
    expect(entries[0]).toMatchObject({ name: '', group: '' });
  });

  it('rejects bad logins and bad responses without leaking the password', async () => {
    const wrong = parseXtreamUrl('https://provider.example/get.php?username=fixtureuser&password=nope');
    await expect(fetchXtreamEntries(wrong, { fetchImpl: fakeFetch() })).rejects.toThrow('xtream login rejected');

    const cases = [
      [{ 'player_api.php': () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } }, 'xtream login failed: TypeError ECONNRESET'],
      [{ 'player_api.php': () => { throw new Error('x'); } }, 'xtream login failed: Error'],
      [{ 'player_api.php': () => new Response('', { status: 599 }) }, 'xtream login failed: HTTP 599'],
      [{ 'player_api.php': () => new Response('<html>') }, 'xtream login failed: response is not JSON'],
      [{ 'player_api.php': () => Response.json(null) }, 'xtream login rejected'],
      [{ 'action=get_live_categories': () => Response.json({}) }, 'categories: unexpected response'],
      [{ 'action=get_live_streams': () => Response.json({}) }, 'streams: unexpected response'],
    ];
    for (const [overrides, message] of cases) {
      const err = await fetchXtreamEntries(creds, { fetchImpl: fakeFetch(overrides) }).catch((e) => e);
      expect(err.message).toContain(message);
      expect(err.message).not.toContain('fixturepass');
    }
  });
});

describe('loadPlaylist source selection', () => {
  it('auto uses the Xtream API for get.php links', async () => {
    const tmp = await tempDir();
    try {
      const config = await testConfig(tmp.dir);
      const logs = [];
      const { entries } = await loadPlaylist({ config, m3uUrl: XTREAM_URL, fetchImpl: fakeFetch(), log: (m) => logs.push(m) });
      expect(entries).toHaveLength(4);
      expect(logs).toEqual(['fetching playlist (Xtream API)']);
    } finally {
      await tmp.cleanup();
    }
  });

  it('m3u forces the M3U download; xtream requires credentials', async () => {
    const tmp = await tempDir();
    try {
      const m3u = await testConfig(tmp.dir, { playlistSource: 'm3u' });
      const f = fakeFetch({ 'get.php': () => new Response(`#EXTM3U\n#EXTINF:-1 group-title="US",A\nhttp://h/live/1.ts\n`) });
      const { entries } = await loadPlaylist({ config: m3u, m3uUrl: XTREAM_URL, fetchImpl: f });
      expect(entries.map((e) => e.name)).toEqual(['A']);

      const xt = await testConfig(tmp.dir, { playlistSource: 'xtream' });
      await expect(loadPlaylist({ config: xt, m3uUrl: M3U_URL, fetchImpl: fakeFetch() })).rejects.toThrow(/playlistSource is xtream/);
    } finally {
      await tmp.cleanup();
    }
  });

  it('applies the group filter to M3U playlists too', async () => {
    const tmp = await tempDir();
    try {
      const config = await testConfig(tmp.dir, { groupFilter: '^PPV' });
      const { entries, stats } = await loadPlaylist({ config, m3uUrl: M3U_URL, fetchImpl: fakeFetch() });
      expect(entries.map((e) => e.group)).toEqual(['PPV Events', 'PPV Events', 'PPV Events']);
      expect(stats.groupFiltered).toBe(13);
    } finally {
      await tmp.cleanup();
    }
  });

  it('config validation', async () => {
    await expect(loadConfig(null, { playlistSource: 'ftp' })).rejects.toThrow('playlistSource');
    await expect(loadConfig(null, { groupFilter: '(' })).rejects.toThrow('groupFilter is not a valid regex');
  });
});

describe('end to end with an Xtream account', () => {
  it('matches decorated names and writes the guide', async () => {
    const tmp = await tempDir();
    try {
      const config = await testConfig(tmp.dir, { groupFilter: '^US\\|', overrides: fixture('none.json') });
      const r = await generate({ config, env: { M3U_URL: XTREAM_URL }, fetchImpl: fakeFetch(), now: NOW });
      const m = Object.fromEntries(r.match.matched.map((x) => [x.playlist.id, x.epg.id]));
      expect(m).toEqual({ 'ESPN.us': 'ESPN.HD.us2', 'US: HBO ᴴᴰ': 'HBO.West.us2' });
      expect(r.placeholders.map((p) => p.id)).toEqual(['PPV: UFC MAIN EVENT']);
      expect(r.report).toMatch(/playlist: 4 entries, 3 categories read, 1 adult skipped, 3 channel ids/);
      expect(r.report).not.toContain('fixturepass');
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('decorated provider names', () => {
  it.each([
    ['US: ESPN ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'espn'],
    ['US: FOX NEWS ᴴᴰ', 'foxnews'],
    ['US: NBA TV ⁸ᴷ', 'nbatv'],
    ['US: PEACOCK ⱽᴵᴾ', 'peacock'],
    ['US: MLS ⁽ᴮᴷ⁾', 'mls'],
  ])('%s -> %s', (name, key) => {
    expect(normalizeName(name).key).toBe(key);
  });
});
