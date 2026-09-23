import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SOURCES = [
  'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_FANDUEL1.xml.gz',
  // Sports: team/regional networks, DirecTV sports, DraftKings, Peacock channels.
  'https://epgshare01.online/epgshare01/epg_ripper_US_SPORTS1.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_DIRECTVSPORTS1.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_DRAFTKINGS1.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_PEACOCK1.xml.gz',
  // Local affiliates, keyed by call sign (large: ~55 MB compressed, cached and revalidated).
  'https://epgshare01.online/epgshare01/epg_ripper_US_LOCALS1.xml.gz',
  // Free streaming (FAST) channels.
  'https://i.mjh.nz/Roku/all.xml.gz',
  'https://i.mjh.nz/Plex/us.xml.gz',
  'https://i.mjh.nz/PlutoTV/us.xml.gz',
  'https://i.mjh.nz/SamsungTVPlus/us.xml.gz',
];

// Channels whose name or group looks like a one-off event: "PPV 03: Team A vs Team B",
// "EVENT 12", "Team A @ Team B", "UFC 300: ..."
export const DEFAULT_EVENT_PATTERN =
  '\\bPPV\\b|\\bEVENTS?\\b|\\bvs\\.?\\s|\\s@\\s|^[^:]*\\d+\\s*:\\s*\\S';

export const DEFAULTS = Object.freeze({
  sources: DEFAULT_SOURCES,
  threshold: 0.85,
  regionPreference: 'west', // tie between East/West variants for an unqualified name: west | east | none
  overrides: 'overrides.json',
  outDir: 'out',
  cacheDir: 'cache',
  outputFile: 'epg.xml.gz',
  reportFile: 'report.txt',
  eventPattern: DEFAULT_EVENT_PATTERN,
  // Playlist rows that are list separators ("##### PPV HD/4K #####", "## 24/7 CRIME ##");
  // they are skipped entirely: never matched, never given placeholders.
  placeholderExclude: '^\\W*[#=*~_]{2,}|[#=*~_]{2,}\\W*$',
  reviewFloor: 0.6, // below this, a candidate isn't worth reviewing; the channel is "unmatched"
  parseEventNames: true, // guide shows the game parsed from the channel name, not the raw name
  placeholderHours: 24,
  placeholderSlotHours: 4,
  skipVod: true,
  playlistSource: 'auto', // auto | m3u | xtream (auto: Xtream API when M3U_URL is a get.php link)
  groupFilter: '', // regex on group-title / Xtream category; empty = all groups
  host: '0.0.0.0',
  port: 8080,
  refreshHours: 6,
  accessToken: '', // optional secret path segment: /<token>/epg.xml.gz
  reportAuth: '', // optional "user:pass" basic auth for /report.txt
  fetchTimeoutMs: 120_000,
});

export async function loadConfig(configPath, cliOverrides = {}, { required = false } = {}) {
  let fileConfig = {};
  if (configPath) {
    try {
      fileConfig = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT' || required) {
        throw new Error(`Cannot read config ${configPath}: ${err.message}`);
      }
    }
  }
  const baseDir = configPath ? path.dirname(path.resolve(configPath)) : process.cwd();
  const merged = { ...DEFAULTS, ...fileConfig, ...stripUndefined(cliOverrides) };
  for (const key of ['overrides', 'outDir', 'cacheDir']) {
    if (key === 'overrides' && /^https:\/\//i.test(merged[key])) continue;
    merged[key] = path.resolve(baseDir, merged[key]);
  }
  return validateConfig(merged);
}

export function validateConfig(cfg) {
  const errors = [];
  if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) {
    errors.push('sources must be a non-empty array');
  } else {
    for (const s of cfg.sources) {
      let url;
      try {
        url = new URL(s);
      } catch {
        errors.push(`source is not a URL: ${s}`);
        continue;
      }
      // Plain http returns Cloudflare 520 on epgshare01.
      if (url.protocol !== 'https:') errors.push(`source must be https: ${s}`);
    }
  }
  if (!(cfg.threshold > 0 && cfg.threshold <= 1)) errors.push('threshold must be in (0, 1]');
  if (!(cfg.reviewFloor >= 0 && cfg.reviewFloor <= cfg.threshold)) errors.push('reviewFloor must be in [0, threshold]');
  if (!['west', 'east', 'none'].includes(cfg.regionPreference)) {
    errors.push('regionPreference must be west, east or none');
  }
  cfg.port = Number(cfg.port);
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) errors.push('port must be 0-65535');
  if (!(cfg.refreshHours > 0)) errors.push('refreshHours must be > 0');
  if (!(cfg.placeholderSlotHours > 0) || !(cfg.placeholderHours >= cfg.placeholderSlotHours)) {
    errors.push('placeholderHours must be >= placeholderSlotHours > 0');
  }
  for (const key of ['eventPattern', 'groupFilter', 'placeholderExclude']) {
    try {
      new RegExp(cfg[key], 'i');
    } catch {
      errors.push(`${key} is not a valid regex`);
    }
  }
  if (!['auto', 'm3u', 'xtream'].includes(cfg.playlistSource)) errors.push('playlistSource must be auto, m3u or xtream');
  if (cfg.accessToken && !/^[A-Za-z0-9_-]{8,}$/.test(cfg.accessToken)) {
    errors.push('accessToken must be 8+ chars of [A-Za-z0-9_-]');
  }
  if (cfg.reportAuth && !/^[^:]+:.+$/.test(cfg.reportAuth)) errors.push('reportAuth must be "user:pass"');
  if (errors.length) throw new Error(`Invalid config:\n  - ${errors.join('\n  - ')}`);
  return cfg;
}

// `file` is a local path or an https URL (fetched on every run, so a pushed edit applies on the
// next refresh without a redeploy).
export async function loadOverrides(file, { fetchImpl = fetch } = {}) {
  let raw;
  if (/^https:\/\//i.test(file)) {
    let res;
    try {
      res = await fetchImpl(file, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new Error(`cannot fetch overrides ${file}: ${err.message}`);
    }
    if (res.status === 404) return new Map();
    if (!res.ok) throw new Error(`cannot fetch overrides ${file}: HTTP ${res.status}`);
    raw = await res.text();
  } else {
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return new Map();
      throw err;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`overrides file is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('overrides file must be an object of { "playlist-tvg-id": "epg-channel-id" | null }');
  }
  const map = new Map();
  for (const [k, v] of Object.entries(parsed)) {
    // null = "this channel has no guide": never match it (placeholders still apply).
    if (v !== null && (typeof v !== 'string' || !v)) {
      throw new Error(`override for "${k}" must be an EPG channel id or null`);
    }
    map.set(k, v);
  }
  return map;
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
