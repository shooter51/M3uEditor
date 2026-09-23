import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

const ATTR = /([A-Za-z0-9_-]+)="([^"]*)"/g;
const VOD_PATH = /\/(movie|movies|series)\//i;

// Parse one #EXTINF line. The display name follows the comma that ends the attribute list
// (first comma outside quotes), so a name that itself contains commas stays whole.
export function parseExtinf(line) {
  const body = line.replace(/^#EXTINF:/i, '');
  let inQuote = false;
  let split = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) {
      split = i;
      break;
    }
  }
  const head = split === -1 ? body : body.slice(0, split);
  const name = split === -1 ? '' : body.slice(split + 1).trim();
  const attrs = {};
  for (const m of head.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2];
  return {
    tvgId: (attrs['tvg-id'] ?? '').trim(),
    tvgName: (attrs['tvg-name'] ?? '').trim(),
    tvgLogo: (attrs['tvg-logo'] ?? '').trim(),
    group: (attrs['group-title'] ?? '').trim(),
    name: name || (attrs['tvg-name'] ?? '').trim(),
  };
}

// Streams the playlist line by line. Stream URLs contain credentials, so they are inspected
// (VOD vs live) and then dropped; entries never carry them.
export async function parseM3u(input, { skipVod = true } = {}) {
  const stream = typeof input === 'string' ? Readable.from([input]) : input;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const entries = [];
  let stats = { total: 0, vodSkipped: 0 };
  let pending = null;
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      pending = parseExtinf(line);
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!pending) continue;
    stats.total++;
    if (skipVod && VOD_PATH.test(line)) {
      stats.vodSkipped++;
    } else {
      entries.push(pending);
    }
    pending = null;
  }
  return { entries, stats };
}

// Collapse entries into playlist channels keyed by the id that goes into the EPG.
// Entries sharing a tvg-id share one channel; entries without one fall back to tvg-name,
// then the display name, and are flagged for the report.
export function toPlaylistChannels(entries) {
  const byId = new Map();
  for (const e of entries) {
    const id = e.tvgId || e.tvgName || e.name;
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      existing.aliases.push(e.name);
      continue;
    }
    byId.set(id, {
      id,
      idFallback: !e.tvgId,
      name: e.name || e.tvgName || id,
      tvgName: e.tvgName,
      tvgId: e.tvgId,
      logo: e.tvgLogo,
      group: e.group,
      aliases: [],
    });
  }
  return [...byId.values()];
}
