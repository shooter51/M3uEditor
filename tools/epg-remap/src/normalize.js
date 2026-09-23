// Channel-name normalization shared by playlist and EPG sides.
//   "US| ESPN HD"        -> tokens [espn]
//   "USA: HBO (Pacific)" -> tokens [hbo], region "west"
//   "HBO East HD"        -> tokens [hbo], region "east"
//   "The Weather Channel" -> tokens [weather]
//   "AT&T: FOOD NETWORK ᴿᴬᵂ" -> tokens [food, network]

const COUNTRY_PREFIX = /^\s*(?:us|usa|u\.s\.a?\.?)\s*(?:\||:|-)\s*/i;
// Provider/platform tags before a colon or pipe: "AT&T: ", "TV: ", "RK: ", "PRIME: ", "PPV 03: ".
const SHORT_PREFIX = /^\s*[\p{L}\p{N}&+ ]{1,8}\s*[:|]\s*(?=\S)/u;
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
  s = s.replace(SHORT_PREFIX, '');
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
