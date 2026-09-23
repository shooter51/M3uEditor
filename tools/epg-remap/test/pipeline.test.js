import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generate, remappedChannel, slimChildren } from '../src/pipeline.js';
import * as validate from '../src/validate.js';
import * as xmltv from '../src/xmltv.js';
import { ENV, fakeFetch, M3U_URL, NOW, tempDir, testConfig } from './helpers.js';

let tmp;
beforeEach(async () => {
  tmp = await tempDir();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

async function runFull(extra = {}, opts = {}) {
  const config = await testConfig(tmp.dir, extra);
  const logs = [];
  const result = await generate({ config, env: ENV, fetchImpl: fakeFetch(), now: NOW, log: (m) => logs.push(m), ...opts });
  return { config, result, logs };
}

const outputXml = async (config) => gunzipSync(await readFile(path.join(config.outDir, 'epg.xml.gz'))).toString('utf8');
const programmesFor = (xml, id) =>
  [...xml.matchAll(/<programme [^>]*channel="([^"]*)"[^>]*>\s*<title[^>]*>([^<]*)</g)].filter((m) => m[1] === id).map((m) => m[2]);

describe('generate (end to end on fixtures)', () => {
  it('writes validated, remapped XMLTV and a report', async () => {
    const { config, result } = await runFull();
    const xml = await outputXml(config);
    expect((await validate.validateXmltvFile(path.join(config.outDir, 'epg.xml.gz'))).ok).toBe(true);

    // Every id in the output is a playlist id, never an EPG id.
    const ids = [...xml.matchAll(/<channel id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(['CNN', 'DISC', 'ESPN', 'FD', 'FOOD', 'HBO', 'HBO.EAST', 'PPV 03', 'PPV04', 'US| ESPN SD'].sort());
    expect(xml).not.toMatch(/\.us2"/);
    expect(xml).not.toMatch(/channel="[^"]*\.us"/);

    // HD/SD collision: both playlist ids get ESPN's programmes.
    // Guide window (NOW = Sep 22 19:30Z, 6h back, 3 days ahead): next week and two days ago
    // are cut; this morning (ended 14:00, after 13:30) stays.
    expect(programmesFor(xml, 'ESPN')).toEqual(['SportsCenter', 'Earlier Today Show', 'NFL Live']);
    expect(result.output.outsideWindow).toBe(4);
    expect(programmesFor(xml, 'US| ESPN SD')).toEqual(['SportsCenter', 'Earlier Today Show', 'NFL Live']);
    // Idle event slots get no rows and no channel.
    expect(xml).not.toContain('channel="UFC09"');
    expect(result.report).toContain('(1 idle event slots with no event scheduled are left empty)');
    // Regional collision.
    expect(programmesFor(xml, 'HBO')).toEqual(['West Movie']);
    expect(programmesFor(xml, 'HBO.EAST')).toEqual(['East Movie']);
    // Override.
    expect(programmesFor(xml, 'FD')).toEqual(['Live Racing: Saratoga']);
    // PPV placeholder: event name visible in each 4h slot across 24h.
    expect(programmesFor(xml, 'PPV 03')).toEqual(Array(7).fill('Team A vs Team B'));
    expect(programmesFor(xml, 'PPV04')).toEqual(Array(7).fill('Fighter One vs. Fighter Two, Main Card'));
    expect(xml).toContain('<programme start="20260922160000 +0000" stop="20260922200000 +0000" channel="PPV 03">');
    // EPG entry with no playlist counterpart is dropped.
    expect(xml).not.toContain('Weather Now');
    expect(xml).not.toContain('Ghost Show');
    // Separator rows are skipped entirely: no channel, no placeholder, not in the report.
    expect(xml).not.toContain('#####');
    expect(xml).not.toContain('24/7 CRIME');
    expect(result.report).not.toContain('#####');

    // Timestamps normalized to UTC; offsets converted; bad ones dropped.
    expect(xml).toContain('start="20260922200000 +0000" stop="20260922210000 +0000" channel="ESPN"');
    for (const m of xml.matchAll(/(start|stop)="([^"]*)"/g)) expect(m[2]).toMatch(/^\d{14} \+0000$/);
    expect(xml).not.toContain('Broken Timestamp');
    expect(xml).toMatch(/<programme start="20260922180000 \+0000" channel="FOOD">\s*<title lang="en">Chopped/);
    expect(xml).toContain('start="20260922190000 +0000" channel="FOOD"');
    expect(result.output.droppedProgrammes).toBe(2);

    // Icons and rich children are preserved; entities round-trip.
    expect(xml).toContain('<icon src="https://img.example/sc.jpg" />');
    expect(xml).toContain('<icon src="https://logo.example/epg/espn.png" />');
    expect(xml).toContain('Evening &amp; Late');
    // Slimmed: guide-visible children kept, cast lists dropped.
    expect(xml).not.toContain('<credits>');
    expect(xml).toContain('<episode-num system="xmltv_ns">12.144.</episode-num>');

    const report = await readFile(result.output.reportFile, 'utf8');
    expect(report).toBe(result.report);
    expect(report).toMatch(/0\.9\d\d {2}DISC {2}"US\| Discovery Chanel" {2}-> {2}Discovery\.Channel\.HD\.us2/);
    expect(report).toContain('HBO.West.us2  "HBO West"  [exact, tie]');
    expect(report).toMatch(/NEEDS REVIEW[^\n]*\(2\) ==\n0\.8\d+ {2}NATGEOW[^\n]*National\.Geographic\.Wild[^\n]*\n0\.\d+ {2}Mystery Channel/);
    expect(report).toMatch(/UNMATCHED PLAYLIST CHANNELS \(1\) ==\nLOCAL7[^\n]*\n\n/);
    expect(report).toContain('Weather.Nation.us2  "WeatherNation"');
    expect(report).toContain('LOCAL7  ->  Does.Not.Exist.us');
    expect(report).toContain('"PPV 03"');
    expect(report).not.toContain('fixturepass');

    // No temp files left behind.
    expect((await readdir(config.outDir)).sort()).toEqual(['epg.xml.gz', 'report.txt']);
  });

  it('dry run writes nothing but returns the report', async () => {
    const { config, result } = await runFull({}, { dryRun: true });
    expect(result.output).toBeNull();
    expect(result.report).toContain('(dry run, nothing written)');
    await expect(readdir(config.outDir)).rejects.toThrow();
  });

  it('never leaks the M3U URL in logs, errors, report or output', async () => {
    const { config, result, logs } = await runFull();
    const everything = [logs.join('\n'), result.report, await outputXml(config)].join('\n');
    for (const secret of ['fixtureuser', 'fixturepass', M3U_URL]) expect(everything).not.toContain(secret);

    const failing = fakeFetch({
      'playlist.m3u': (url) => {
        throw new Error(`connect failed for ${url}`);
      },
    });
    // Fresh cache dir: no saved channel list to fall back on, so the error surfaces.
    const noCache = { ...config, cacheDir: path.join(tmp.dir, 'empty-cache') };
    const err = await generate({ config: noCache, env: ENV, fetchImpl: failing, now: NOW }).catch((e) => e);
    expect(err.message).toMatch(/playlist fetch failed/);
    expect(err.message).not.toContain('fixturepass');
  });

  it('redacts secrets that surface from deeper errors', async () => {
    const config = await testConfig(tmp.dir, { overrides: path.join(tmp.dir, 'fixturepass', 'o.json') });
    await writeFile(path.join(tmp.dir, 'x'), '');
    const err = await generate({
      config: { ...config, overrides: tmp.dir },
      env: ENV,
      fetchImpl: fakeFetch(),
      now: NOW,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const err2 = await generate({ config: { ...config, outDir: path.join(tmp.dir, 'x', 'fixturepass') }, env: ENV, fetchImpl: fakeFetch(), now: NOW }).catch((e) => e);
    expect(err2.message).toContain('[REDACTED]');
    expect(err2.message).not.toContain('fixturepass');
  });

  it('rejects a source that is not XMLTV', async () => {
    const config = await testConfig(tmp.dir);
    const f = fakeFetch({ FANDUEL1: () => new Response('<html>Cloudflare 520</html>') });
    await expect(generate({ config, env: ENV, fetchImpl: f, now: NOW })).rejects.toThrow(/is not an XMLTV document/);
  });

  it('keeps the previous output when validation fails', async () => {
    const { config } = await runFull();
    const before = await readFile(path.join(config.outDir, 'epg.xml.gz'));
    vi.spyOn(validate, 'validateXmltvFile').mockResolvedValue({ ok: false, errors: ['forced'] });
    await expect(generate({ config, env: ENV, fetchImpl: fakeFetch(), now: NOW })).rejects.toThrow(/failed validation[\s\S]*forced/);
    expect(await readFile(path.join(config.outDir, 'epg.xml.gz'))).toEqual(before);
    expect((await readdir(config.outDir)).sort()).toEqual(['epg.xml.gz', 'report.txt']);
  });

  it('cleans up the temp file when writing throws', async () => {
    const config = await testConfig(tmp.dir);
    vi.spyOn(xmltv.XmltvWriter.prototype, 'element').mockRejectedValue(new Error('disk full'));
    await expect(generate({ config, env: ENV, fetchImpl: fakeFetch(), now: NOW })).rejects.toThrow('disk full');
    expect(await readdir(config.outDir)).toEqual([]);
  });

  it('requires M3U_URL', async () => {
    const config = await testConfig(tmp.dir);
    await expect(generate({ config, env: {}, fetchImpl: fakeFetch() })).rejects.toThrow(/M3U_URL is not set/);
  });

  it('skips reading sources that nothing matched', async () => {
    const config = await testConfig(tmp.dir, { overrides: path.join(tmp.dir, 'none.json') });
    const { output } = await generate({ config, env: ENV, fetchImpl: fakeFetch(), now: NOW });
    expect(output.channels).toBeGreaterThan(0);
  });
});

describe('remappedChannel', () => {
  it('puts the playlist name first and drops a duplicate display-name', () => {
    const el = {
      name: 'channel',
      attrs: { id: 'X.us2' },
      children: ['stray', { name: 'display-name', attrs: {}, children: ['Same'] }, { name: 'icon', attrs: { src: 'i' }, children: [] }],
    };
    const out = remappedChannel(el, { id: 'P', name: 'Same' });
    expect(out.attrs.id).toBe('P');
    expect(out.children.map((c) => c.name)).toEqual(['display-name', 'icon']);
  });
});

describe('idle event slots', () => {
  it('can still be given "No event scheduled" rows', async () => {
    const t = await tempDir();
    try {
      const config = await testConfig(t.dir, { emptyEventPlaceholders: true });
      const { output } = await generate({ config, env: ENV, fetchImpl: fakeFetch(), now: NOW });
      const xml = gunzipSync(await readFile(output.file)).toString('utf8');
      expect(programmesFor(xml, 'UFC09')).toEqual(Array(7).fill('No event scheduled'));
    } finally {
      await t.cleanup();
    }
  });
});

describe('slimChildren', () => {
  it('keeps guide-visible children and at most two categories', () => {
    const el = (name, text = 'x') => ({ name, attrs: {}, children: [text] });
    const out = slimChildren([el('title'), 'loose', el('credits'), el('rating'), el('category', 'a'), el('category', 'b'), el('category', 'c'), el('icon'), el('previously-shown')]);
    expect(out.map((c) => c.name + (c.name === 'category' ? `:${c.children[0]}` : ''))).toEqual(['title', 'category:a', 'category:b', 'icon']);
  });

  it('can be turned off to keep everything', async () => {
    const t = await tempDir();
    try {
      const config = await testConfig(t.dir, { slimProgrammes: false });
      const { output } = await generate({ config, env: ENV, fetchImpl: fakeFetch(), now: NOW });
      expect(gunzipSync(await readFile(output.file)).toString('utf8')).toContain('<presenter>Wolf Blitzer</presenter>');
    } finally {
      await t.cleanup();
    }
  });
});

describe('playlist fallback cache', () => {
  it('reuses the last good channel list when the provider is down, within the age limit', async () => {
    const t = await tempDir();
    try {
      const config = await testConfig(t.dir);
      await generate({ config, env: ENV, fetchImpl: fakeFetch(), now: NOW, dryRun: true });
      const saved = await readFile(path.join(config.cacheDir, 'playlist-channels.json'), 'utf8');
      expect(saved).not.toContain('fixturepass');
      expect(saved).not.toContain('.ts');

      const down = fakeFetch({ 'playlist.m3u': () => new Response('', { status: 502 }) });
      const logs = [];
      const later = new Date(NOW.getTime() + 3_600_000);
      const r = await generate({ config, env: ENV, fetchImpl: down, now: later, dryRun: true, log: (m) => logs.push(m) });
      expect(r.match.matched.length).toBe(8);
      expect(r.report).toMatch(/PROVIDER UNAVAILABLE \(playlist fetch failed: HTTP 502\); using channel list saved 2026-09-22T19:30/);
      expect(logs.some((l) => l.includes('using channel list from'))).toBe(true);

      const tooOld = new Date(NOW.getTime() + 73 * 3_600_000);
      await expect(generate({ config, env: ENV, fetchImpl: down, now: tooOld, dryRun: true })).rejects.toThrow('HTTP 502');
    } finally {
      await t.cleanup();
    }
  });

  it('fails as before when there is no saved list', async () => {
    const t = await tempDir();
    try {
      const config = await testConfig(t.dir);
      const down = fakeFetch({ 'playlist.m3u': () => new Response('', { status: 502 }) });
      await expect(generate({ config, env: ENV, fetchImpl: down, now: NOW, dryRun: true })).rejects.toThrow('HTTP 502');
    } finally {
      await t.cleanup();
    }
  });
});
