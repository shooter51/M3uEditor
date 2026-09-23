import {
  bareCallSignsFromName,
  callSignFromEpgId,
  callSignFromName,
  callSignFromTvgId,
  isFillerToken,
  leadingCallSign,
  nameFromEpgId,
  nameVariants,
} from './normalize.js';
import { shortTokensAgree, tokenSetSimilarity } from './similarity.js';

const EPS = 1e-9;
// Words shared by more EPG names than this ("tv", "news", "movies") are too common to pull in
// candidates on their own; a candidate must also share a rarer word.
const COMMON_TOKEN_LIMIT = 150;
const LOOSE_EXACT = 0.99;

// epgChannels: [{ key, id, source, order, displayNames: [] }]
// Each EPG channel is indexed under all of its display names plus the name embedded in its id.
export function buildEpgIndex(epgChannels) {
  const forms = [];
  const byKey = new Map();
  const byToken = new Map();
  const byId = new Map();
  const byCallSign = new Map(); // sign -> { idx, rank } of the best feed for that station
  epgChannels.forEach((ch, idx) => {
    if (!byId.has(ch.id)) byId.set(ch.id, idx);
    const cs = callSignFromEpgId(ch.id);
    if (cs && (!byCallSign.has(cs.sign) || cs.rank < byCallSign.get(cs.sign).rank)) {
      byCallSign.set(cs.sign, { idx, rank: cs.rank });
    }
    const names = [...ch.displayNames];
    const fromId = nameFromEpgId(ch.id);
    if (fromId) names.push(fromId);
    const seen = new Set();
    for (const norm of names.flatMap(nameVariants)) {
      if (!norm.tokens.length) continue;
      // Same joined key can come with different word splits ("WeatherNation" vs "Weather Nation");
      // keep both so the word index sees the split form.
      const sig = `${norm.tokens.join(' ')}|${norm.region}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const formIdx = forms.push({ channelIdx: idx, ...norm }) - 1;
      push(byKey, norm.key, formIdx);
      for (const t of new Set(norm.tokens)) push(byToken, t, formIdx);
    }
  });
  return { channels: epgChannels, forms, byKey, byToken, byId, byCallSign };
}

// Returns { matched, review, unmatched, brokenOverrides, unusedEpg }. Overrides map a playlist
// id to an EPG id (forced match) or to null (forced "no guide").
export function matchChannels(playlistChannels, epgChannels, overrides = new Map(), opts = {}) {
  const { threshold = 0.85, regionPreference = 'west', reviewFloor = 0.6 } = opts;
  const index = buildEpgIndex(epgChannels);
  const matched = [];
  const review = [];
  const unmatched = [];
  const brokenOverrides = [];

  for (const p of playlistChannels) {
    // `has`, not `??`: a null override (block) must not fall through to the tvg-id lookup.
    const overrideKey = overrides.has(p.id) ? p.id : p.tvgId && overrides.has(p.tvgId) ? p.tvgId : undefined;
    const overrideId = overrideKey === undefined ? undefined : overrides.get(overrideKey);
    if (overrideId === null) {
      // Explicitly marked as having no guide data.
      unmatched.push(p);
      continue;
    }
    if (overrideId !== undefined) {
      const idx = index.byId.get(overrideId);
      if (idx !== undefined) {
        matched.push({ playlist: p, epg: epgChannels[idx], score: 1, method: 'override', tie: false });
        continue;
      }
      brokenOverrides.push({ playlistId: p.id, epgId: overrideId });
    }

    // Local affiliates: a call sign in the name ("NBC 10 (WBTS) BOSTON") identifies the station
    // exactly, which beats any name similarity.
    const sign =
      callSignFromName(p.name) ??
      callSignFromName(p.tvgName) ??
      [callSignFromTvgId(p.tvgId)].find((s) => s && index.byCallSign.has(s)) ??
      bareCallSignsFromName(p.name).find((s) => index.byCallSign.has(s)) ??
      [leadingCallSign(p.name), leadingCallSign(p.tvgName)].find((s) => s && index.byCallSign.has(s));
    const station = sign ? index.byCallSign.get(sign) : undefined;
    if (station) {
      matched.push({ playlist: p, epg: epgChannels[station.idx], score: 1, method: 'callsign', tie: false });
      continue;
    }

    const best = bestCandidate(p, index, regionPreference, threshold, reviewFloor);
    // Hopeless candidates are noise in the review list; treat them as no match.
    if (!best || best.score + EPS < reviewFloor) {
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
  // Provider tvg-ids are often EPG-style ("investigationdiscovery.us"); read them like EPG ids.
  const idName = p.tvgId ? nameFromEpgId(p.tvgId) : null;
  for (const n of [p.name, p.tvgName, p.tvgId, idName, ...p.aliases]) {
    if (!n) continue;
    for (const norm of nameVariants(n)) {
      const sig = norm.tokens.join(' ');
      if (!norm.tokens.length || seen.has(sig)) continue;
      seen.add(sig);
      out.push(norm);
    }
  }
  return out;
}

function bestCandidate(p, index, regionPreference, threshold, minScore = 0) {
  const queries = queriesFor(p);
  if (!queries.length) return null;
  const wantRegion = queries.find((q) => q.region)?.region ?? null;

  // Best score per EPG channel across every (query, form) pair.
  const perChannel = new Map();
  for (const q of queries) {
    const candidateForms = new Set(index.byKey.get(q.key) ?? []);
    const lists = q.tokens.map((t) => index.byToken.get(t) ?? []).filter((l) => l.length);
    const rare = lists.filter((l) => l.length <= COMMON_TOKEN_LIMIT);
    // If every word is common, fall back to the rarest one alone.
    const use = rare.length ? rare : lists.sort((x, y) => x.length - y.length).slice(0, 1);
    for (const list of use) for (const f of list) candidateForms.add(f);
    for (const formIdx of candidateForms) {
      const form = index.forms[formIdx];
      const exact = form.key === q.key;
      const loose = q.exactOnly || form.exactOnly;
      if (loose && !exact) continue;
      // A match through a loosened form counts, but a precise exact match must outrank it.
      let score = exact ? (loose ? LOOSE_EXACT : 1) : tokenSetSimilarity(q.tokens, form.tokens, minScore);
      // Never auto-accept on a short-token mismatch, or a one-word name matched only by
      // spelling ("Wilds" ~ "Wild Wild West"); leave those for review.
      if (!exact && score + EPS >= threshold && (q.tokens.filter((t) => !isFillerToken(t)).length < 2 || !shortTokensAgree(q.tokens, form.tokens))) {
        score = Math.max(0, threshold - 0.01);
      }
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
