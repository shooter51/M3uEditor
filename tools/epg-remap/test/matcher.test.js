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
    // even a low threshold won't accept it: "mystery" has no counterpart in the candidate
    const low = matchChannels([pl('M', 'Mystery Channel')], EPG, new Map(), { threshold: 0.5, reviewFloor: 0.4 });
    expect(low.matched).toHaveLength(0);
    expect(low.review).toHaveLength(1);
    // while a genuine typo is accepted at a lower threshold
    expect(matchChannels([pl('W', 'Wether Nation')], EPG, new Map(), { threshold: 0.5 }).matched).toHaveLength(1);
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

  it('does not auto-accept a one-letter brand difference', () => {
    const r = matchChannels([pl('N', 'US: NBC SPORTS NETWORK')], [epg('CBS.Sports.Network.HD.us2', ['CBS Sports Network HD'])]);
    expect(r.matched).toEqual([]);
    expect(r.review[0].score).toBeCloseTo(0.84);
  });

  it('candidates below the review floor count as unmatched', () => {
    const r = matchChannels([pl('M', 'Mystery Channel')], EPG, new Map(), { reviewFloor: 0.8 });
    expect(r.review).toEqual([]);
    expect(r.unmatched.map((p) => p.id)).toEqual(['M']);
  });

  it('matches local affiliates by call sign, preferring the main feed', () => {
    const locals = [epg('WBTS-LD.us_locals1', ['WBTS-LD']), epg('WBTS-CD.us_locals1', ['WBTS-CD']), epg('NBC.Sports.Boston.HD.us2', ['NBC Sports Boston HD'])];
    const r = matchChannels([pl('B', 'US: NBC 10 (WBTS) BOSTON (S) ᴿᴬᵂ')], locals);
    expect(r.matched[0]).toMatchObject({ method: 'callsign', score: 1 });
    expect(r.matched[0].epg.id).toBe('WBTS-CD.us_locals1');
    // tvg-name can carry the call sign too; unknown call signs fall through to name matching
    expect(matchChannels([pl('X', 'Boston 10', { tvgName: 'NBC (WBTS)' })], locals).matched[0].method).toBe('callsign');
    const unknown = matchChannels([pl('Y', 'NBC Sports Boston (WZZZ)')], locals);
    expect(unknown.matched).toEqual([]);
    expect(unknown.review[0].epg.id).toBe('NBC.Sports.Boston.HD.us2');
  });

  it('a null override blocks a fuzzy match too, keyed by playlist id or tvg-id', () => {
    const texas = [epg('MLB-TexasRangers.us', ['MLB - Texas Rangers'])];
    expect(matchChannels([pl('24/7: TEXAS RANGER', '24/7: TEXAS RANGER', { tvgId: '' })], texas).matched).toHaveLength(1);
    const byId = matchChannels([pl('24/7: TEXAS RANGER', '24/7: TEXAS RANGER', { tvgId: '' })], texas, new Map([['24/7: TEXAS RANGER', null]]));
    expect(byId.matched).toEqual([]);
    const p = pl('fallback-id', '24/7: TEXAS RANGER', { tvgId: 'walker.us' });
    expect(matchChannels([p], texas, new Map([['walker.us', null]])).matched).toEqual([]);
  });

  it('a null override blocks any match', () => {
    const r = matchChannels([pl('ESPN', 'ESPN HD')], EPG, new Map([['ESPN', null]]));
    expect(r.matched).toEqual([]);
    expect(r.unmatched.map((p) => p.id)).toEqual(['ESPN']);
  });

  it('numbers must agree for a fuzzy match', () => {
    const r = matchChannels([pl('S', 'US: SPECTRUM NEWS 13 HD')], [epg('ny1', ['Spectrum News - NY1 - STVA'])]);
    expect(r.matched).toEqual([]);
  });

  it('matches a leading call sign when the station exists', () => {
    const locals = [epg('KTLA-DT.us_locals1', ['KTLA-DT'])];
    expect(matchChannels([pl('K', 'US: KTLA LOS ANGELES HD')], locals).matched[0]).toMatchObject({ method: 'callsign' });
    // a leading word that looks like a call sign but has no station stays unmatched
    expect(matchChannels([pl('W', 'US: WILD LIFE HD')], locals).matched).toEqual([]);
  });

  it('bare call signs count only with a network word and a known station', () => {
    const locals = [epg('WCBS-DT.us_locals1', ['WCBS-DT'])];
    expect(matchChannels([pl('C', 'US: CBS 2 WCBS (NEW YORK) HD')], locals).matched[0].method).toBe('callsign');
    expect(matchChannels([pl('D', 'US: CBS 2 WXYZ')], locals).matched).toEqual([]);
  });

  it('keeps a platform prefix that is part of the name', () => {
    const r = matchChannels([pl('L', 'NBA: LEAGUE PASS 1')], [epg('NBA.League.Pass.1.us2', ['NBA League Pass 1'])]);
    expect(r.matched[0].method).toBe('exact');
  });

  it('uses a call-sign tvg-id when the station exists', () => {
    const locals = [epg('WSFL-DT.us_locals1', ['WSFL-DT'])];
    const hit = matchChannels([pl('WSFL.us', 'US: CW 39 HD [MIAMI]', { tvgId: 'WSFL.us' })], locals);
    expect(hit.matched[0]).toMatchObject({ method: 'callsign' });
    const miss = matchChannels([pl('WZZZ.us', 'US: CW 39 HD [MIAMI]', { tvgId: 'WZZZ.us' })], locals);
    expect(miss.matched).toEqual([]);
  });

  it('loose exact forms match, but a precise exact match wins', () => {
    const feeds = [epg('FS1.Fox.Sports.1.HD.us2', ['FS1 Fox Sports 1 HD']), epg('Bravo.us', ['Bravo'])];
    const r = matchChannels([pl('F', 'US: FOX SPORTS 1'), pl('B', 'US: NBC BRAVO (EAST)')], feeds);
    expect(r.matched.map((m) => [m.playlist.id, m.epg.id, m.score])).toEqual([
      ['F', 'FS1.Fox.Sports.1.HD.us2', 0.99],
      ['B', 'Bravo.us', 0.99],
    ]);
    const both = matchChannels([pl('C', 'CBS News Boston')], [epg('nbc', ['NBC News Boston']), epg('cbs', ['CBS News Boston'])]);
    expect(both.matched[0].epg.id).toBe('cbs');
    // loose forms never feed fuzzy scoring
    expect(matchChannels([pl('G', 'NBC Bravx')], [epg('Bravo.us', ['Bravo'])]).matched).toEqual([]);
  });

  it('overrides still beat call signs', () => {
    const locals = [epg('WBTS-CD.us_locals1', ['WBTS-CD']), epg('Other.us', ['Other'])];
    const r = matchChannels([pl('B', 'NBC (WBTS)')], locals, new Map([['B', 'Other.us']]));
    expect(r.matched[0].method).toBe('override');
  });

  it('reads EPG-style provider tvg-ids as names', () => {
    const r = matchChannels([pl('investigationdiscovery.us', 'ID')], [epg('Investigation.Discovery.HD.us2', ['Investigation Discovery HD'])]);
    expect(r.matched[0]).toMatchObject({ method: 'exact' });
  });

  it('matches league-prefixed team channels', () => {
    const r = matchChannels([pl('M', 'NBA: MEMPHIS GRIZZLIES ᴴᴰ')], [epg('NBA-MemphisGrizzlies.us', ['NBA - Memphis Grizzlies'])]);
    expect(r.matched[0].method).toBe('exact');
  });

  it('does not auto-accept a one-word spelling match', () => {
    const r = matchChannels([pl('W', 'US: THE WILDS')], [epg('x', ['The Wild Wild West'])]);
    expect(r.matched).toEqual([]);
  });

  it('ignores very common words when collecting candidates', () => {
    const many = Array.from({ length: 200 }, (_, i) => epg(`n${i}`, [`News ${i} Zone`]));
    const r = matchChannels([pl('Q', 'Quirky News')], [...many, epg('quirky', ['Quirky Newz'])]);
    expect(r.review.concat(r.matched).map((m) => m.epg.id)).toContain('quirky');
    // all-common query still finds something via its rarest word
    const r2 = matchChannels([pl('Z', 'News Zone')], many);
    expect(r2.matched.length + r2.review.length).toBe(1);
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
