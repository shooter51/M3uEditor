import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Public EPG feeds are cached on disk in their compressed form so they can be streamed twice
// (channels, then programmes) without holding them in memory, and so refreshes can use
// conditional requests. The playlist is NEVER cached; see fetchPlaylist().

export function cachePaths(cacheDir, url) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return { data: path.join(cacheDir, `${hash}.xml.gz`), meta: path.join(cacheDir, `${hash}.json`) };
}

export async function fetchSource(url, { cacheDir, fetchImpl = fetch, timeoutMs = 120_000 }) {
  await mkdir(cacheDir, { recursive: true });
  const { data, meta } = cachePaths(cacheDir, url);
  const cached = await readMeta(meta, data);
  const headers = { 'user-agent': 'epg-remap/0.1' };
  if (cached?.etag) headers['if-none-match'] = cached.etag;
  if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (err) {
    if (cached) return { file: data, note: `fetch failed (${err.message}); using cached copy` };
    throw new Error(`fetch ${url} failed: ${err.message}`);
  }
  if (res.status === 304 && cached) return { file: data, note: 'not modified' };
  if (!res.ok || !res.body) {
    if (cached) return { file: data, note: `HTTP ${res.status}; using cached copy` };
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const tmp = `${data}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    await rename(tmp, data);
  } catch (err) {
    await rm(tmp, { force: true });
    if (cached) return { file: data, note: `download failed (${err.message}); using cached copy` };
    throw new Error(`download ${url} failed: ${err.message}`);
  }
  await writeFile(
    meta,
    JSON.stringify({ etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') }),
  );
  return { file: data, note: '' };
}

async function readMeta(meta, data) {
  try {
    await stat(data);
    return JSON.parse(await readFile(meta, 'utf8'));
  } catch {
    return null;
  }
}

// Returns a Node stream of the playlist body. Errors are generic on purpose; callers redact
// anyway, but nothing here ever interpolates the URL.
export async function fetchPlaylist(url, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': 'epg-remap/0.1' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (err) {
    throw new Error(`playlist fetch failed: ${err.name}${err.cause?.code ? ` ${err.cause.code}` : ''}`);
  }
  if (!res.ok || !res.body) throw new Error(`playlist fetch failed: HTTP ${res.status}`);
  return Readable.fromWeb(res.body);
}
