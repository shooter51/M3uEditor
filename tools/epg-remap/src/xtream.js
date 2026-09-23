// Xtream Codes panels often block get.php (the M3U download) and only answer player_api.php,
// which is also what TiviMate uses when logged in with Xtream credentials. The channel ids
// TiviMate matches against are the same `epg_channel_id` values this returns.

const TRUTHY = new Set([1, '1', true, 'true']);

// Returns { base, username, password } when the URL is an Xtream get.php / player_api.php
// link with credentials, else null.
export function parseXtreamUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/\/(get|player_api)\.php$/i.test(url.pathname)) return null;
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  if (!username || !password) return null;
  const base = `${url.origin}${url.pathname.replace(/\/(get|player_api)\.php$/i, '')}`;
  return { base, username, password };
}

function apiUrl({ base, username, password }, params) {
  const u = new URL(`${base}/player_api.php`);
  u.searchParams.set('username', username);
  u.searchParams.set('password', password);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function getJson(url, what, { fetchImpl, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': 'epg-remap/0.1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`xtream ${what} failed: ${err.name}${err.cause?.code ? ` ${err.cause.code}` : ''}`);
  }
  if (!res.ok) throw new Error(`xtream ${what} failed: HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`xtream ${what} failed: response is not JSON`);
  }
  return data;
}

// Live channels as playlist entries ({ tvgId, tvgName, tvgLogo, group, name }).
// With a group filter, only matching categories are requested, one at a time, so a
// 50k-channel account never has to be held in memory at once.
export async function fetchXtreamEntries(creds, { fetchImpl = fetch, timeoutMs = 120_000, groupFilter = null } = {}) {
  const opts = { fetchImpl, timeoutMs };
  const account = await getJson(apiUrl(creds, {}), 'login', opts);
  if (!account?.user_info || !TRUTHY.has(account.user_info.auth)) {
    throw new Error('xtream login rejected (check username/password)');
  }
  const categories = await getJson(apiUrl(creds, { action: 'get_live_categories' }), 'categories', opts);
  if (!Array.isArray(categories)) throw new Error('xtream categories: unexpected response');
  const names = new Map(categories.map((c) => [String(c.category_id), String(c.category_name ?? '').trim()]));

  let batches;
  if (groupFilter) {
    const wanted = categories.filter((c) => groupFilter.test(String(c.category_name ?? '')));
    batches = wanted.map((c) => ({ params: { action: 'get_live_streams', category_id: String(c.category_id) } }));
  } else {
    batches = [{ params: { action: 'get_live_streams' } }];
  }

  const entries = [];
  const seen = new Set();
  const stats = { total: 0, vodSkipped: 0, adultSkipped: 0, categories: batches.length };
  for (const { params } of batches) {
    const streams = await getJson(apiUrl(creds, params), 'streams', opts);
    if (!Array.isArray(streams)) throw new Error('xtream streams: unexpected response');
    for (const s of streams) {
      if (seen.has(s.stream_id)) continue;
      seen.add(s.stream_id);
      stats.total++;
      if (TRUTHY.has(s.is_adult)) {
        stats.adultSkipped++;
        continue;
      }
      const name = String(s.name ?? '').trim();
      entries.push({
        tvgId: String(s.epg_channel_id ?? '').trim(),
        tvgName: name,
        tvgLogo: String(s.stream_icon ?? '').trim(),
        group: names.get(String(params.category_id ?? s.category_id)) ?? '',
        name,
      });
    }
  }
  return { entries, stats };
}
