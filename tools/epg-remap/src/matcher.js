import { nameFromEpgId, nameVariants } from './normalize.js';
import { tokenSetSimilarity } from './similarity.js';

const EPS = 1e-9;

// epgChannels: [{ key, id, source, order, displayNames: [] }]
// Each EPG channel is indexed under all of its display names plus the name embedded in its id.
export function buildEpgIndex(epgChannels) {
  const forms = [];
  const byKey = new Map();
  const byToken = new Map();
  const byId = new Map();
  epgChannels.forEach((ch, idx) => {
    if (!byId.has(ch.id)) byId.set(ch.id, idx);
    const names = [...ch.displayNames];
    const fromId = nameFromEpgId(ch.id);
    if (fromId) names.push(fromId);
    const seen = new Set();
    for (const norm of names.flatMap(nameVariants)) {
      if (!norm.tokens.length) continue;
      const sig = `${norm.key}|${norm.region}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const formIdx = forms.push({ channelIdx: idx, ...norm }) - 1;
      push(byKey, norm.key, formIdx);
      for (const t of new Set(norm.tokens)) push(byToken, t, formIdx);
    }
  });
  return { channels: epgChannels, forms, byKey, byToken, byId };
}

// Returns { matched, review, unmatched, brokenOverrides, unusedEpg }.
export function matchChannels(playlistChannels, epgChannels, overrides = new Map(), opts = {}) {
  const { threshold = 0.85, regionPreference = 'west' } = opts;
  const index = buildEpgIndex(epgChannels);
  const matched = [];
  const review = [];
  const unmatched = [];
  const brokenOverrides = [];

  for (const p of playlistChannels) {
    const overrideId = overrides.get(p.id) ?? (p.tvgId ? overrides.get(p.tvgId) : undefined);
    if (overrideId !== undefined) {
      const idx = index.byId.get(overrideId);
      if (idx !== undefined) {
        matched.push({ playlist: p, epg: epgChannels[idx], score: 1, method: 'override', tie: false });
        continue;
      }
      brokenOverrides.push({ playlistId: p.id, epgId: overrideId });
    }

    const best = bestCandidate(p, index, regionPreference);
    if (!best) {
      unmatched.push(p);
    } else if (best.score + EPS >= threshold) {
      matched.push({
        playlist: p,
        epg: epgChannels[best.channelIdx],
        score: best.score,
        method: best.exact ? 'exact' : 'fuzzy',
        tie: best.tie,
      });
    } else {
      review.push({ playlist: p, epg: epgChannels[best.channelIdx], score: best.score });
    }
  }

  const used = new Set(matched.map((m) => m.epg.key));
  const unusedEpg = epgChannels.filter((c) => !used.has(c.key));
  return { matched, review, unmatched, brokenOverrides, unusedEpg };
}

function queriesFor(p) {
  const out = [];
  const seen = new Set();
  for (const n of [p.name, p.tvgName, p.tvgId, ...p.aliases]) {
    if (!n) continue;
    for (const norm of nameVariants(n)) {
      if (!norm.tokens.length || seen.has(norm.key)) continue;
      seen.add(norm.key);
      out.push(norm);
    }
  }
  return out;
}

function bestCandidate(p, index, regionPreference) {
  const queries = queriesFor(p);
  if (!queries.length) return null;
  const wantRegion = queries.find((q) => q.region)?.region ?? null;

  // Best score per EPG channel across every (query, form) pair.
  const perChannel = new Map();
  for (const q of queries) {
    const candidateForms = new Set(index.byKey.get(q.key) ?? []);
    for (const t of q.tokens) for (const f of index.byToken.get(t) ?? []) candidateForms.add(f);
    for (const formIdx of candidateForms) {
      const form = index.forms[formIdx];
      const exact = form.key === q.key;
      const score = exact ? 1 : tokenSetSimilarity(q.tokens, form.tokens);
      const prev = perChannel.get(form.channelIdx);
      if (!prev || score > prev.score + EPS || (Math.abs(score - prev.score) <= EPS && exact && !prev.exact)) {
        perChannel.set(form.channelIdx, { channelIdx: form.channelIdx, score, exact, region: form.region });
      }
    }
  }
  if (!perChannel.size) return null;

  const ranked = [...perChannel.values()].sort(
    (a, b) =>
      b.score - a.score ||
      regionRank(a.region, wantRegion, regionPreference) - regionRank(b.region, wantRegion, regionPreference) ||
      a.channelIdx - b.channelIdx,
  );
  const top = ranked[0];
  const tie = ranked.length > 1 && Math.abs(ranked[1].score - top.score) <= EPS;
  return { ...top, tie };
}

// Lower is better. A qualified playlist name ("HBO (East)") wants the same region; an
// unqualified one prefers the configured default, then un-regioned feeds, then anything else.
export function regionRank(region, wantRegion, preference) {
  if (wantRegion) {
    if (region === wantRegion) return 0;
    return region ? 2 : 1;
  }
  if (preference !== 'none' && region === preference) return 0;
  if (!region) return 1;
  return 2;
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
