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

export function normalizeName(name, { stripFiller = true } = {}) {
  let s = casefold(String(name ?? ''));
  // Some providers stack prefixes ("US| USA: ...").
  for (let prev = null; prev !== s; ) {
    prev = s;
    s = s.replace(COUNTRY_PREFIX, '');
  }
  s = s.replace(BRACKET_TAG, '').replace(SHORT_PREFIX, '').replace(LEAGUE_PREFIX, '');
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
    if (QUALITY.has(last)) {
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
export function nameVariants(name) {
  const a = normalizeName(name);
  const b = normalizeName(name, { stripFiller: false });
  return a.key === b.key ? [a] : [a, b];
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
