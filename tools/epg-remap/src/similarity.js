export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function ratio(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

// Token-set similarity in [0, 1]. Order-insensitive and duplicate-insensitive: shared tokens
// are lined up first, then the leftovers are compared. Unlike fuzzywuzzy's token_set_ratio it
// does NOT score a strict subset as 1.0, so "ESPN" vs "ESPN News" stays well below threshold.
// The joined forms are also compared so "ESPN2" and "ESPN 2" still meet.
// Cheap ceiling on ratio(): strings whose lengths differ this much can't score higher.
export function ratioUpperBound(lenA, lenB) {
  const max = Math.max(lenA, lenB);
  return max === 0 ? 1 : Math.min(lenA, lenB) / max;
}

export function tokenSetSimilarity(tokensA, tokensB, minScore = 0) {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;
  const inter = [...a].filter((t) => b.has(t)).sort();
  const onlyA = [...a].filter((t) => !b.has(t)).sort();
  const onlyB = [...b].filter((t) => !a.has(t)).sort();
  const sideA = [...inter, ...onlyA].join(' ');
  const sideB = [...inter, ...onlyB].join(' ');
  const sortedA = [...a].sort().join('');
  const sortedB = [...b].sort().join('');
  // Every ratio below is bounded by the length ratio of its inputs; bail out before any
  // Levenshtein work when none of them could reach minScore.
  if (
    minScore > 0 &&
    Math.max(ratioUpperBound(sideA.length, sideB.length), ratioUpperBound(sortedA.length, sortedB.length)) < minScore
  ) {
    return 0;
  }
  const joined = ratio(sortedA, sortedB);
  const inOrder = ratio(tokensA.join(''), tokensB.join(''));
  return Math.max(ratio(sideA, sideB), joined, inOrder);
}

// Guards a fuzzy score before it can be auto-accepted:
//  - short tokens are brand identifiers ("NBC" vs "CBS", "FXX" vs "FX"); each short token of
//    the playlist name must appear in the candidate, as a token or inside its joined form
//    ("2" in "espn2");
//  - longer playlist tokens need a close counterpart ("galazo"~"golazo"), so a leftover word
//    like "bally" in "Bally Sports Arizona" can't ride on "sports arizona";
//  - numbers distinguish channels ("Showtime" vs "Showtime 2", "News 13" vs "NY1"), so both
//    names must contain the same numbers.
// Extra words on the EPG side ("CHSN Chicago Sports Network") are fine.
export const SHORT_TOKEN = 4;
const CLOSE_TOKEN = 0.75;
export function shortTokensAgree(queryTokens, candidateTokens) {
  const joined = candidateTokens.join('');
  const covered = (t) =>
    candidateTokens.includes(t) ||
    joined.includes(t) ||
    (t.length > SHORT_TOKEN && candidateTokens.some((c) => ratio(t, c) >= CLOSE_TOKEN));
  // The numbers in both names must be the same set ("Spectrum News 13" is not "NY1").
  const numbers = (tokens) => [...new Set(tokens.join(' ').match(/\d+/g) ?? [])].sort().join(',');
  return queryTokens.every(covered) && numbers(queryTokens) === numbers(candidateTokens);
}
