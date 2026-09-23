import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachePaths, fetchPlaylist, fetchSource } from '../src/sources.js';
import { fakeFetch, M3U_URL, tempDir } from './helpers.js';

const URL_US2 = 'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz';
let tmp;
beforeEach(async () => {
  tmp = await tempDir();
});
afterEach(() => tmp.cleanup());

describe('fetchSource', () => {
  it('downloads, caches, then revalidates with conditional headers', async () => {
    const f = fakeFetch();
    const first = await fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: f });
    expect(first.note).toBe('');
    const meta = JSON.parse(await readFile(cachePaths(tmp.dir, URL_US2).meta, 'utf8'));
    expect(meta.etag).toBe('"epg_ripper_US2-v1"');

    const f304 = fakeFetch({ US2: () => new Response(null, { status: 304 }) });
    const second = await fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: f304 });
    expect(second).toEqual({ file: first.file, note: 'not modified' });
    expect(f304.calls[0].headers['if-none-match']).toBe('"epg_ripper_US2-v1"');
  });

  it('falls back to the cache on network error, HTTP error, or broken body', async () => {
    await fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: fakeFetch() });
    const net = fakeFetch({ US2: () => { throw new Error('ENOTFOUND'); } });
    expect((await fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: net })).note).toMatch(/fetch failed.*cached/);
    const http = fakeFetch({ US2: () => new Response('x', { status: 520 }) });
    expect((await fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: http })).note).toMatch(/HTTP 520; using cached/);
    const broken = fakeFetch({
      US2: () => new Response(new ReadableStream({ start: (c) => c.error(new Error('reset')) })),
    });
    expect((await fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: broken })).note).toMatch(/download failed/);
  });

  it('throws when there is no cache to fall back to', async () => {
    const net = fakeFetch({ US2: () => { throw new Error('ENOTFOUND'); } });
    await expect(fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: net })).rejects.toThrow(/fetch .* failed: ENOTFOUND/);
    const http = fakeFetch({ US2: () => new Response('x', { status: 520 }) });
    await expect(fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: http })).rejects.toThrow(/HTTP 520/);
    const broken = fakeFetch({
      US2: () => new Response(new ReadableStream({ start: (c) => c.error(new Error('reset')) })),
    });
    await expect(fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: broken })).rejects.toThrow(/download .* failed/);
  });

  it('ignores a corrupt meta file', async () => {
    const { data, meta } = cachePaths(tmp.dir, URL_US2);
    await mkdir(tmp.dir, { recursive: true });
    await writeFile(data, 'x');
    await writeFile(meta, '{');
    const f = fakeFetch();
    await fetchSource(URL_US2, { cacheDir: tmp.dir, fetchImpl: f });
    expect(f.calls[0].headers['if-none-match']).toBeUndefined();
  });
});

describe('fetchPlaylist', () => {
  it('returns a stream', async () => {
    const s = await fetchPlaylist(M3U_URL, { fetchImpl: fakeFetch() });
    let text = '';
    for await (const c of s) text += c;
    expect(text).toMatch(/^#EXTM3U/);
  });

  it('never puts the URL in its errors', async () => {
    const err1 = await fetchPlaylist(M3U_URL, {
      fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
    }).catch((e) => e);
    expect(err1.message).toBe('playlist fetch failed: TypeError ECONNREFUSED');
    const err2 = await fetchPlaylist(M3U_URL, { fetchImpl: async () => { throw new Error('x'); } }).catch((e) => e);
    expect(err2.message).toBe('playlist fetch failed: Error');
    const err3 = await fetchPlaylist(M3U_URL, { fetchImpl: async () => new Response('', { status: 401 }) }).catch((e) => e);
    expect(err3.message).toBe('playlist fetch failed: HTTP 401');
  });

});
