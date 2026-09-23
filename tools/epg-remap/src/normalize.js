// Channel-name normalization shared by playlist and EPG sides.
//   "US| ESPN HD"        -> tokens [espn]
//   "USA: HBO (Pacific)" -> tokens [hbo], region "west"
//   "HBO East HD"        -> tokens [hbo], region "east"
//   "The Weather Channel" -> tokens [weather]
//   "AT&T: FOOD NETWORK ᴿᴬᵂ" -> tokens [food, network]

const COUNTRY_PREFIX = /^\s*(?:us|usa|u\.s\.a?\.?)\s*(?:\||:|-)\s*/i;
// Provider/platform tags before a colon or pipe: "AT&T: ", "TV: ", "RK: ", "PRIME: ", "PPV 03: ".
const SHORT_PREFIX = /^\s*[\p{L}\p{N}&+ ]{1,8}\s*[:|]\s*(?=\S)/u;
// League tags on team channels: "NBA - Boston Celtics", "MLB - Chicago Cubs".
const LEAGUE_PREFIX = /^\s*(?:nba|wnba|nfl|nhl|mlb|mls|milb|ncaa[a-z]*)\s+-\s+(?=\S)/i;
// Bracketed source tags: "[PK16] Real Housewives".
const BRACKET_TAG = /^\s*\[[^\]]{1,16}\]\s*/;
// Loop-channel tags: "24/7: The Andy Griffith Show", "US: 24/7 Family Guy", "Crime 24/7".
const LOOP_TAG = /(^|\s)24\s*\/\s*7\s*:?(?=\s|$)/g;
// Renamed networks, applied to both sides so either spelling meets the other.
const RENAMES = [
  [/\bbally sports\b/g, 'fanduel sports'],
  // Old Fox regional sports networks are the same FanDuel regionals (not FS1/FS2).
  [/\bfox sports (?!\d|one|two|deportes|soccer|racing|extra|yes|4k|on\b)(?=[a-z])/g, 'fanduel sports '],
  [/\bat&t sportsnet\b/g, 'sportsnet'],
  [/\bat ?& ?t sports ?net\b/g, 'sportsnet'],
  [/\bnbc sports washington\b/g, 'monumental sports network'],
  [/\bnbc sports chicago\b/g, 'chicago sports network'],
  [/\bcsn\b/g, 'nbc sports'],
  [/\bnat geo\b/g, 'national geographic'],
  [/^tcm\b/g, 'turner classic movies'],
  [/^own\b/g, 'oprah winfrey network'],
  [/\bdisney jr\b/g, 'disney junior'],
  [/\bespn news\b/g, 'espnews'],
  [/\s*-?\s*\bmusic television\b/g, ''],
  [/\s*&\s*/g, ' and '],
];
// Trailing feed-provider tags on EPG names: "Spectrum News 1 - Worcester - STVA".
const TRAILING_TAGS = new Set(['stva']);
// Feed codes like "(A)", "(D)", "(PC)"; longer parentheticals ("(NECN)") are kept.
const FEED_CODE = /\(\s*[\p{L}\p{N}]{1,3}\s*\)/gu;
// Quality / feed tags. Superscript decorations like "ᴿᴬᵂ ⁶⁰ᶠᵖˢ" or "⁽ᴮᴷ⁾" casefold to these too.
const QUALITY = new Set([
  'hd', 'fhd', 'uhd', '4k', '8k', 'sd', 'hdr', 'hevc', 'h265', '1080p', '720p',
  'raw', '60fps', '50fps', '30fps', 'vip', 'bk', 'backup',
]);
const REGIONS = {
  east: 'east',
  eastern: 'east',
  west: 'west',
  western: 'west',
  pacific: 'west',
  mountain: 'mountain',
  central: 'central',
};
// Words that carry no identity: "The Weather Channel" ~ "Weather", "Fox News Channel" ~ "Fox News".
const LEADING_FILLER = new Set(['the']);
const TRAILING_FILLER = new Set(['channel']);
export const isFillerToken = (t) => LEADING_FILLER.has(t) || TRAILING_FILLER.has(t);
const PAREN_REGION = /\(\s*(east|eastern|west|western|pacific|mountain|central)\s*\)/gi;

export function casefold(s) {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export function normalizeName(name, { stripFiller = true, stripPrefix = true } = {}) {
  let s = casefold(String(name ?? ''));
  // Some providers stack prefixes ("US| USA: ...").
  for (let prev = null; prev !== s; ) {
    prev = s;
    s = s.replace(COUNTRY_PREFIX, '');
  }
  s = s.replace(BRACKET_TAG, '');
  if (stripPrefix) s = s.replace(SHORT_PREFIX, '');
  s = s.replace(LEAGUE_PREFIX, '');
  // "24/7:" can itself be the prefix ("24/7: Rome"); strip it wherever it sits, keeping at
  // least one word.
  const unlooped = s.replace(LOOP_TAG, ' ').trim();
  if (/[\p{L}\p{N}]/u.test(unlooped)) s = unlooped;
  for (const [re, to] of RENAMES) s = s.replace(re, to);
  let region = null;
  s = s.replace(PAREN_REGION, (_, r) => {
    region = REGIONS[r.toLowerCase()];
    return ' ';
  });
  s = s.replace(FEED_CODE, ' ');
  const tokens = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Strip trailing quality / bare regional words in any order: "HBO East HD", "HBO HD East".
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (QUALITY.has(last) || TRAILING_TAGS.has(last)) {
      tokens.pop();
    } else if (REGIONS[last]) {
      region ??= REGIONS[last];
      tokens.pop();
    } else if (stripFiller && TRAILING_FILLER.has(last)) {
      tokens.pop();
    } else {
      break;
    }
  }
  if (stripFiller && tokens.length > 1 && LEADING_FILLER.has(tokens[0])) tokens.shift();
  // "MTV2: Music Television HD": if dropping the prefix leaves nothing but a quality tag,
  // the prefix was the name.
  if (stripPrefix && (tokens.length === 0 || (tokens.length === 1 && QUALITY.has(tokens[0])))) {
    const kept = normalizeName(name, { stripFiller, stripPrefix: false });
    if (kept.tokens.length > tokens.length || (kept.tokens.length && !QUALITY.has(kept.tokens[0]))) return kept;
  }
  return { tokens, key: tokens.join(''), region };
}

// XMLTV ids like "ESPN.HD.us2" or "HBO.East.us2" carry a readable name before the
// country suffix. Return that name, or null if the id doesn't look like one.
export function nameFromEpgId(id) {
  const parts = String(id ?? '').split('.').filter(Boolean);
  if (parts.length < 2) return null;
  if (/^[a-z]{2}\d*$/i.test(parts[parts.length - 1])) parts.pop();
  return parts.join(' ').replace(/[-_]/g, ' ');
}

// Both the filler-stripped and literal forms, so "Fox News" meets "Fox News Channel" while
// "Discovery Chanel" (typo) can still fuzzy-match "Discovery Channel".
// A third form keeps a "XXX:" prefix, for names where it is part of the channel
// ("NBA: League Pass 1" ~ "NBA League Pass 1").
//
// Looser forms are flagged exactOnly: they may only produce an exact key match, and the
// matcher scores those just below a real exact match so the precise form always wins.
//  - without a leading broadcast-network word: "NBC Bravo" ~ "Bravo", "NBC Golf Channel" ~ "Golf"
//    (only if a distinctive word remains, so "Fox News" never becomes a bare "News");
//  - without a leading acronym tag: "FS1 Fox Sports 1" ~ "Fox Sports 1", "SNY SportsNet New York";
//  - without a trailing "TV"/"Network": "Newsmax TV" ~ "Newsmax".
const NETWORK_FAMILY = new Set(['nbc', 'abc', 'cbs', 'fox', 'cw']);
const GENERIC_WORDS = new Set([
  'news', 'sports', 'sport', 'business', 'network', 'tv', 'live', 'local', 'now', 'channel', 'plus',
  'deportes', 'noticias', 'weather', 'movies', 'kids', 'classic', 'east', 'west', 'hd', 'one', 'us',
]);
const LOOSE_TRAILING = new Set(['tv', 'network']);
export function nameVariants(name) {
  const out = [];
  const add = (v, exactOnly = false) => {
    if (!v.tokens.length) return;
    if (out.some((o) => o.key === v.key && o.tokens.join(' ') === v.tokens.join(' '))) return;
    out.push(exactOnly ? { ...v, exactOnly: true } : v);
  };
  for (const opts of [{}, { stripFiller: false }, { stripPrefix: false }]) add(normalizeName(name, opts));
  const base = out[0];
  if (!base) return out;
  const t = base.tokens;
  if (t.length >= 2 && NETWORK_FAMILY.has(t[0]) && t.slice(1).some((w) => /[a-z]{3,}/.test(w) && !GENERIC_WORDS.has(w))) {
    add(tokensVariant(t.slice(1), base.region), true);
  }
  if (t.length >= 3 && t[0].length <= 5 && /^[a-z]+\d*$/.test(t[0]) && isAcronymOf(t[0], t.slice(1))) {
    add(tokensVariant(t.slice(1), base.region), true);
  }
  if (t.length >= 2 && LOOSE_TRAILING.has(t[t.length - 1])) add(tokensVariant(t.slice(0, -1), base.region), true);
  return out;
}

function tokensVariant(tokens, region) {
  return { tokens, key: tokens.join(''), region };
}

// "fs1" ~ [fox, sports, 1], "sny" ~ [sportsnet, new, york], "chsn" ~ [chicago, sports, network]:
// the tag's letters appear, in order, among the leading letters of the following words.
function isAcronymOf(tag, words) {
  const letters = tag.replace(/\d+$/, '');
  const digits = tag.slice(letters.length);
  if (letters.length < 2) return false;
  if (digits && !words.includes(digits)) return false;
  let i = 0;
  for (const w of words) {
    if (i < letters.length && w[0] === letters[i]) i++;
    if (i < letters.length && w.length > 1 && /^[a-z]/.test(w) && w.includes(letters[i]) && letters[i] !== w[0]) {
      // allow inner-word letters for compound words ("sportsnet" -> s, n)
      const rest = w.slice(1);
      while (i < letters.length && rest.includes(letters[i])) i++;
    }
  }
  return i === letters.length;
}

// US broadcast call sign in a channel name: "NBC 10 (WBTS) BOSTON" -> "WBTS". Only the
// parenthesized form is trusted; bare four-letter words are too often ordinary words.
const CALL_SIGN_IN_NAME = /\(\s*([KW][A-Z]{2,3})(?:[-\s]?(?:DT|TV|LD|CD|HD)\d*)?\s*\)/;
// Parenthesized words that look like call signs but are feed labels: "OXYGEN (WEST)".
const NOT_CALL_SIGNS = new Set(['WEST', 'KIDS', 'WILD', 'WIFE', 'WORK', 'WOW', 'KIX']);
export function callSignFromName(name) {
  const m = CALL_SIGN_IN_NAME.exec(String(name ?? '').toUpperCase());
  return m && !NOT_CALL_SIGNS.has(m[1]) ? m[1] : null;
}

// Provider tvg-ids are often the station's call sign: "WALA.us", "WGN.us", "WNBC-DT.us".
const CALL_SIGN_TVG_ID = /^([KW][A-Z]{2,3})(?:-(?:DT|TV|LD|CD)\d*)?\.[A-Z]{2}\d?$/;
export function callSignFromTvgId(tvgId) {
  const m = CALL_SIGN_TVG_ID.exec(String(tvgId ?? '').toUpperCase());
  return m && !NOT_CALL_SIGNS.has(m[1]) ? m[1] : null;
}

// Bare call signs ("CBS 2 WCBS (NEW YORK)") are only candidates when the name also names a
// broadcast network; the caller must still confirm the station exists in the guide.
const NETWORK_WORD = /\b(?:NBC|CBS|ABC|FOX|CW|PBS|MYNETWORK|TELEMUNDO|UNIVISION|ION)\b/;
// A call sign as the first word of the name ("KTLA Los Angeles", "WPIX New York"), even with
// no network word. Leading position + the caller's "exists in the guide" check make a false
// positive very unlikely. Country and quality prefixes are stripped first.
const LEADING_STRIP = /^\s*(?:us|usa|u\.s\.a?\.?)\s*(?:\||:|-)\s*/i;
export function leadingCallSign(name) {
  const first = String(name ?? '').replace(LEADING_STRIP, '').trim().split(/[^\p{L}\p{N}]+/u)[0] || '';
  const up = first.toUpperCase();
  return /^[KW][A-Z]{3}$/.test(up) && !NOT_CALL_SIGNS.has(up) ? up : null;
}
export function bareCallSignsFromName(name) {
  const upper = String(name ?? '').toUpperCase();
  if (!NETWORK_WORD.test(upper)) return [];
  return [...upper.matchAll(/\b([KW][A-Z]{3})\b/g)].map((m) => m[1]).filter((s) => !NOT_CALL_SIGNS.has(s));
}

// Call sign and feed rank from a locals EPG id: "WNBC-DT.us_locals1" -> { sign: WNBC, rank }.
// The main feed (-DT / -TV) outranks low-power (-CD/-LD) and subchannels (-DT2...).
// Requires the broadcast suffix ("-DT", "-LD"...), so ids like "West.TV.us2" are not stations.
const CALL_SIGN_ID = /^([KW][A-Z]{2,3})-(DT|TV|LD|CD)(\d*)_?(?:\.|$)/;
export function callSignFromEpgId(id) {
  const m = CALL_SIGN_ID.exec(String(id ?? '').toUpperCase());
  if (!m) return null;
  const [, sign, kind, sub] = m;
  const base = { DT: 0, TV: 0, CD: 2, LD: 3 }[kind];
  return { sign, rank: base * 10 + (sub ? Number(sub) : 0) };
}
