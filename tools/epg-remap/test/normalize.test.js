import { describe, expect, it } from 'vitest';
import { casefold, nameFromEpgId, nameVariants, normalizeName } from '../src/normalize.js';
import { levenshtein, ratio, tokenSetSimilarity } from '../src/similarity.js';

describe('normalizeName', () => {
  it.each([
    ['US| ESPN HD', 'espn', null],
    ['USA: ESPN FHD', 'espn', null],
    ['US- ESPN SD', 'espn', null],
    ['US|USA: ESPN 4K', 'espn', null],
    ['U.S.A: Cinemax UHD', 'cinemax', null],
    ['HBO (East)', 'hbo', 'east'],
    ['HBO (Pacific) HD', 'hbo', 'west'],
    ['HBO East HD', 'hbo', 'east'],
    ['HBO HD West', 'hbo', 'west'],
    ['Showtime (Mountain)', 'showtime', 'mountain'],
    ['Starz Central', 'starz', 'central'],
    ['A&E', 'aande', null],
    ['Télémundo', 'telemundo', null],
    ['ESPN 2', 'espn2', null],
    ['The Weather Channel HD', 'weather', null],
    ['Fox News Channel', 'foxnews', null],
    ['The CW', 'cw', null],
  ])('%s -> %s', (input, key, region) => {
    const n = normalizeName(input);
    expect(n.key).toBe(key);
    expect(n.region).toBe(region);
  });

  it('never strips the only token', () => {
    expect(normalizeName('HD').tokens).toEqual(['hd']);
    expect(normalizeName('West').tokens).toEqual(['west']);
    expect(normalizeName('The').tokens).toEqual(['the']);
    expect(normalizeName('Channel').tokens).toEqual(['channel']);
  });

  it('can keep filler words', () => {
    expect(normalizeName('The Weather Channel', { stripFiller: false }).key).toBe('theweatherchannel');
    expect(nameVariants('The Weather Channel').map((v) => v.key)).toEqual(['weather', 'theweatherchannel']);
    expect(nameVariants('NBA: League Pass 1').map((v) => v.key)).toEqual(['leaguepass1', 'nbaleaguepass1']);
    expect(nameVariants('ESPN').map((v) => v.key)).toEqual(['espn']);
  });

  it('handles empty and nullish input', () => {
    expect(normalizeName('').tokens).toEqual([]);
    expect(normalizeName(undefined).key).toBe('');
  });

  it('casefolds and drops diacritics', () => {
    expect(casefold('ÉSPN Ñ')).toBe('espn n');
  });
});

describe('nameFromEpgId', () => {
  it.each([
    ['ESPN.HD.us2', 'ESPN HD'],
    ['HBO.East.us', 'HBO East'],
    ['Food-Network.us2', 'Food Network'],
    ['A.B', 'A B'],
    ['plainid', null],
    ['', null],
    [undefined, null],
  ])('%s -> %s', (id, expected) => {
    expect(nameFromEpgId(id)).toBe(expected);
  });
});

describe('similarity', () => {
  it('levenshtein basics', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('ratio of empty strings is 1', () => {
    expect(ratio('', '')).toBe(1);
  });

  it('is order-insensitive', () => {
    expect(tokenSetSimilarity(['food', 'network'], ['network', 'food'])).toBe(1);
  });

  it('does not treat a strict subset as a perfect match', () => {
    expect(tokenSetSimilarity(['espn'], ['espn', 'news'])).toBeLessThan(0.85);
  });

  it('tolerates small typos', () => {
    expect(tokenSetSimilarity(['discovery', 'chanel'], ['discovery', 'channel'])).toBeGreaterThan(0.9);
  });

  it('joins split tokens', () => {
    expect(tokenSetSimilarity(['espn', '2'], ['espn2'])).toBe(1);
  });

  it('handles empty token lists', () => {
    expect(tokenSetSimilarity([], [])).toBe(1);
    expect(tokenSetSimilarity(['a'], [])).toBe(0);
  });
});

describe('provider decorations', () => {
  it.each([
    ['AT&T: FOOD NETWORK ᴿᴬᵂ', 'foodnetwork'],
    ['TV: SCRIPPS NEWS ᴿᴬᵂ', 'scrippsnews'],
    ['PRIME: FANDUEL SPORTS NETWORK EXTRA ᴿᴬᵂ', 'fanduelsportsnetworkextra'],
    ['US: NBC SPORTS BOSTON (A) ᴿᴬᵂ', 'nbcsportsboston'],
    ['US: NBC NEW ENGLAND CABLE NEWS (NECN) (D) ᴿᴬᵂ', 'nbcnewenglandcablenewsnecn'],
    ['World Fishing Network HD (US)', 'worldfishingnetwork'],
    ['PPV 03: Team A vs Team B', 'teamavsteamb'],
    ['Very Long Prefix: Name', 'verylongprefixname'],
    ['NBA - Boston Celtics', 'bostonceltics'],
    ['[PK16] Real Housewives', 'realhousewives'],
    ['Spectrum News 1 - Austin', 'spectrumnews1austin'],
  ])('%s -> %s', (name, key) => {
    expect(normalizeName(name).key).toBe(key);
  });
});

describe('shortTokensAgree', () => {
  it('blocks brand near-misses but allows extra EPG tags and joined digits', async () => {
    const { shortTokensAgree } = await import('../src/similarity.js');
    expect(shortTokensAgree(['nbc', 'sports', 'network'], ['cbs', 'sports', 'network'])).toBe(false);
    expect(shortTokensAgree(['fxx'], ['fx'])).toBe(false);
    expect(shortTokensAgree(['chicago', 'sports', 'network'], ['chsn', 'chicago', 'sports', 'network'])).toBe(true);
    expect(shortTokensAgree(['espn', '2'], ['espn2'])).toBe(true);
    expect(shortTokensAgree(['discovery', 'chanel'], ['discovery', 'channel'])).toBe(true);
    expect(shortTokensAgree(['showtime'], ['showtime', '2'])).toBe(false);
    expect(shortTokensAgree(['espn2'], ['espn', '2'])).toBe(true);
    expect(shortTokensAgree(['bally', 'sports', 'arizona'], ['arizona', 'family', 'sports'])).toBe(false);
    expect(shortTokensAgree(['cbs', 'sports', 'galazo', 'network'], ['cbs', 'sports', 'golazo', 'network'])).toBe(true);
  });
});

describe('call signs', async () => {
  const { callSignFromName, callSignFromEpgId } = await import('../src/normalize.js');
  it.each([
    ['US: NBC 10 (WBTS) BOSTON (S) ᴿᴬᵂ', 'WBTS'],
    ['US: CBS (WCBS-DT) NEW YORK', 'WCBS'],
    ['US: NBC 30 (WGBC-DT2) MERIDIAN (H)', 'WGBC'],
    ['US: FOX (KTTV) LOS ANGELES', 'KTTV'],
    ['US: NBC OXYGEN (WEST) ᴿᴬᵂ', null],
    ['US: NBC (D)', null],
    ['WABC NEW YORK', null],
    [undefined, null],
  ])('name %s -> %s', (name, sign) => {
    expect(callSignFromName(name)).toBe(sign);
  });
  it.each([
    ['WNBC-DT.us_locals1', { sign: 'WNBC', rank: 0 }],
    ['WCBS-DT_.us_locals1', { sign: 'WCBS', rank: 0 }],
    ['WSVN-DT2.us_locals1', { sign: 'WSVN', rank: 2 }],
    ['WBTS-CD.us_locals1', { sign: 'WBTS', rank: 20 }],
    ['KXBF-LD.us_locals1', { sign: 'KXBF', rank: 30 }],
    ['West.TV.us2', null],
    ['K39FE-D.us_locals1', null],
    [undefined, null],
  ])('epg id %s', (id, expected) => {
    expect(callSignFromEpgId(id)).toEqual(expected);
  });
});

describe('leading call signs', async () => {
  const { leadingCallSign } = await import('../src/normalize.js');
  it.each([
    ['US: KTLA LOS ANGELES HD', 'KTLA'],
    ['WPIX New York', 'WPIX'],
    ['US: KCAL 9 LOS ANGELES', 'KCAL'],
    ['WEST Movies HD', null],
    ['US: WILD TV', null],
    ['US: HBO WEST', null],
    ['ESPN News', null],
    [undefined, null],
  ])('%s -> %s', (name, sign) => {
    expect(leadingCallSign(name)).toBe(sign);
  });
});

describe('bare call signs', async () => {
  const { bareCallSignsFromName } = await import('../src/normalize.js');
  it('needs a network word', () => {
    expect(bareCallSignsFromName('US: CBS 2 WCBS (NEW YORK) HD')).toEqual(['WCBS']);
    expect(bareCallSignsFromName('KIDS WORLD WXYZ')).toEqual([]);
    expect(bareCallSignsFromName('FOX KIDS WNYW')).toEqual(['WNYW']);
    expect(bareCallSignsFromName(undefined)).toEqual([]);
  });
});

describe('call sign from tvg-id', async () => {
  const { callSignFromTvgId } = await import('../src/normalize.js');
  it.each([
    ['WALA.us', 'WALA'],
    ['WGN.us', 'WGN'],
    ['wnbc-dt.us2', 'WNBC'],
    ['ESPN.us', null],
    ['West.us', null],
    ['KXYZ', null],
    [undefined, null],
  ])('%s -> %s', (id, sign) => {
    expect(callSignFromTvgId(id)).toBe(sign);
  });
});

describe('renames and loose variants', async () => {
  const { nameVariants, normalizeName } = await import('../src/normalize.js');
  const keys = (n) => nameVariants(n).map((v) => (v.exactOnly ? '~' : '') + v.key);
  it.each([
    ['FS1 Fox Sports 1 HD', ['fs1foxsports1', '~foxsports1']],
    ['SNY SportsNet New York HD', ['snysportsnetnewyork', '~sportsnetnewyork']],
    ['US: NBC BRAVO (EAST)', ['nbcbravo', '~bravo']],
    ['US: FOX NEWS', ['foxnews']],
    ['US: FOX SPORTS 1', ['foxsports1']],
    ['Newsmax TV HD', ['newsmaxtv', '~newsmax']],
    ['MTV2: Music Television HD', ['mtv2']],
    ['ESPN Deportes', ['espndeportes']],
  ])('%s', (name, expected) => {
    expect(keys(name)).toEqual(expected);
  });
  it.each([
    ['US: FOX SPORTS SUN HD', 'fanduelsportssun'],
    ['TV: TCM', 'turnerclassicmovies'],
    ['TV: OWN', 'oprahwinfreynetwork'],
    ['US: NBC SPORTS WASHINGTON', 'monumentalsportsnetwork'],
    ['US: CSN PHILADELPHIA HD', 'nbcsportsphiladelphia'],
    ['AT&T: NAT GEO WILD', 'nationalgeographicwild'],
    ['US: DISNEY JR WEST HD', 'disneyjunior'],
    ['MTV - Music Television HD (Pacific)', 'mtv'],
    ['US: ESPN NEWS HD', 'espnews'],
    ['Weeds & Nurse Jackie', 'weedsandnursejackie'],
  ])('%s -> %s', (name, key) => {
    expect(normalizeName(name).key).toBe(key);
  });
  it('keeps a prefix when nothing else would remain', () => {
    expect(normalizeName('HD').key).toBe('hd');
  });
});
