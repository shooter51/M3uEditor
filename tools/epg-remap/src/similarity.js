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
export function tokenSetSimilarity(tokensA, tokensB) {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;
  const inter = [...a].filter((t) => b.has(t)).sort();
  const onlyA = [...a].filter((t) => !b.has(t)).sort();
  const onlyB = [...b].filter((t) => !a.has(t)).sort();
  const sideA = [...inter, ...onlyA].join(' ');
  const sideB = [...inter, ...onlyB].join(' ');
  const joined = ratio([...a].sort().join(''), [...b].sort().join(''));
  const inOrder = ratio(tokensA.join(''), tokensB.join(''));
  return Math.max(ratio(sideA, sideB), joined, inOrder);
}
