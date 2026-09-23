import { describe, expect, it } from 'vitest';
import { matchChannels, regionRank } from '../src/matcher.js';

const epg = (id, names, source = 0) => ({ key: `${source}\u0000${id}`, id, source, displayNames: names });
const pl = (id, name, extra = {}) => ({ id, name, tvgName: '', tvgId: id, aliases: [], group: '', ...extra });

const EPG = [
  epg('ESPN.HD.us2', ['ESPN HD']),
  epg('ESPNews.HD.us2', ['ESPN News HD']),
  epg('HBO.East.us2', ['HBO East']),
  epg('HBO.West.us2', ['HBO West']),
  epg('Discovery.Channel.us2', ['Discovery Channel']),
  epg('Weather.Nation.us2', ['WeatherNation']),
];

const byPlaylist = (result) => Object.fromEntries(result.matched.map((m) => [m.playlist.id, m]));

describe('matchChannels', () => {
  it('HD/SD suffix collision: both variants land on the same EPG channel', () => {
    const r = matchChannels([pl('ESPN', 'US| ESPN HD'), pl('ESPN.SD', 'US| ESPN SD')], EPG);
    const m = byPlaylist(r);
    expect(m.ESPN.epg.id).toBe('ESPN.HD.us2');
    expect(m['ESPN.SD'].epg.id).toBe('ESPN.HD.us2');
    expect(m.ESPN.method).toBe('exact');
  });

  it('regional collision: unqualified prefers West, qualified gets its own region', () => {
    const r = matchChannels([pl('HBO', 'US| HBO'), pl('HBO.E', 'US| HBO (East)'), pl('HBO.P', 'HBO (Pacific)')], EPG);
    const m = byPlaylist(r);
    expect(m.HBO.epg.id).toBe('HBO.West.us2');
    expect(m.HBO.tie).toBe(true);
    expect(m['HBO.E'].epg.id).toBe('HBO.East.us2');
    expect(m['HBO.P'].epg.id).toBe('HBO.West.us2');
  });

  it('regionPreference east / none', () => {
    expect(byPlaylist(matchChannels([pl('HBO', 'HBO')], EPG, new Map(), { regionPreference: 'east' })).HBO.epg.id).toBe(
      'HBO.East.us2',
    );
    // none: falls back to source order
    expect(byPlaylist(matchChannels([pl('HBO', 'HBO')], EPG, new Map(), { regionPreference: 'none' })).HBO.epg.id).toBe(
      'HBO.East.us2',
    );
  });

  it('prefers an unregioned feed over the wrong region', () => {
    const r = matchChannels([pl('X', 'Starz (East)')], [epg('Starz.West', ['Starz West']), epg('Starz.us', ['Starz'])]);
    expect(r.matched[0].epg.id).toBe('Starz.us');
  });

  it('fuzzy matches typos above the threshold', () => {
    const r = matchChannels([pl('DISC', 'US| Discovery Chanel')], EPG);
    expect(r.matched[0]).toMatchObject({ method: 'fuzzy' });
    expect(r.matched[0].score).toBeGreaterThan(0.85);
  });

  it('never auto-accepts below threshold; sends to review', () => {
    const r = matchChannels([pl('M', 'Mystery Channel')], EPG);
    expect(r.matched).toEqual([]);
    expect(r.review[0].epg.id).toBe('Discovery.Channel.us2');
    expect(r.review[0].score).toBeLessThan(0.85);
    // but a lower threshold accepts it
    expect(matchChannels([pl('M', 'Mystery Channel')], EPG, new Map(), { threshold: 0.5 }).matched).toHaveLength(1);
  });

  it('a strict subset name does not steal a different channel', () => {
    const r = matchChannels([pl('N', 'ESPN News')], [epg('ESPN.HD.us2', ['ESPN HD'])]);
    expect(r.matched).toEqual([]);
  });

  it('channels with no shared tokens are unmatched; EPG with no counterpart is unused', () => {
    const r = matchChannels([pl('L', 'Local Access 7'), pl('E', '')], EPG);
    expect(r.unmatched.map((p) => p.id)).toEqual(['L', 'E']);
    expect(r.unusedEpg.map((c) => c.id)).toContain('Weather.Nation.us2');
  });

  it('overrides always win, even over an exact match', () => {
    const r = matchChannels([pl('ESPN', 'ESPN HD')], EPG, new Map([['ESPN', 'Weather.Nation.us2']]));
    expect(r.matched[0]).toMatchObject({ method: 'override', score: 1 });
    expect(r.matched[0].epg.id).toBe('Weather.Nation.us2');
  });

  it('overrides can be keyed by tvg-id when the channel id differs', () => {
    const p = pl('ESPN', 'ESPN HD', { tvgId: 'ESPN' });
    p.id = 'fallback';
    const r = matchChannels([p], EPG, new Map([['ESPN', 'HBO.West.us2']]));
    expect(r.matched[0].epg.id).toBe('HBO.West.us2');
  });

  it('a broken override is reported and fuzzy matching still runs', () => {
    const r = matchChannels([pl('ESPN', 'ESPN HD')], EPG, new Map([['ESPN', 'Nope']]));
    expect(r.brokenOverrides).toEqual([{ playlistId: 'ESPN', epgId: 'Nope' }]);
    expect(r.matched[0].method).toBe('exact');
  });

  it('uses tvg-name and aliases as extra queries', () => {
    const r = matchChannels([pl('Z', 'Channel 999', { tvgName: 'WeatherNation', aliases: ['WN'] })], EPG);
    expect(r.matched[0].epg.id).toBe('Weather.Nation.us2');
  });

  it('matches on the name embedded in the EPG id when display names are missing', () => {
    const r = matchChannels([pl('F', 'Food Network')], [epg('Food.Network.us2', [])]);
    expect(r.matched[0].epg.id).toBe('Food.Network.us2');
  });

  it('ignores filler words on either side', () => {
    const r = matchChannels(
      [pl('W', 'US| Weather Channel'), pl('F', 'US| Fox News')],
      [epg('The.Weather.Channel.HD.us2', ['The Weather Channel HD']), epg('Fox.News.Channel.HD.us2', [])],
    );
    expect(r.matched.map((m) => [m.playlist.id, m.epg.id, m.method])).toEqual([
      ['W', 'The.Weather.Channel.HD.us2', 'exact'],
      ['F', 'Fox.News.Channel.HD.us2', 'exact'],
    ]);
  });

  it('skips EPG display names that normalize to nothing', () => {
    const r = matchChannels([pl('F', 'Fox')], [epg('x', ['***', 'Fox'])]);
    expect(r.matched).toHaveLength(1);
  });
});

describe('regionRank', () => {
  it('orders candidates', () => {
    expect(regionRank('east', 'east', 'west')).toBe(0);
    expect(regionRank(null, 'east', 'west')).toBe(1);
    expect(regionRank('west', 'east', 'west')).toBe(2);
    expect(regionRank('west', null, 'west')).toBe(0);
    expect(regionRank(null, null, 'west')).toBe(1);
    expect(regionRank('east', null, 'west')).toBe(2);
    expect(regionRank('west', null, 'none')).toBe(2);
  });
});
