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
    ['A&E', 'ae', null],
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
