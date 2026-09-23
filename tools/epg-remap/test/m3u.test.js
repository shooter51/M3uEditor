import { createReadStream } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseExtinf, parseM3u, toPlaylistChannels } from '../src/m3u.js';
import { fixture } from './helpers.js';

describe('parseExtinf', () => {
  it('extracts attributes and the display name', () => {
    const e = parseExtinf(
      '#EXTINF:-1 tvg-id="ESPN" tvg-name="US| ESPN HD" tvg-logo="https://l/e.png" group-title="US| Sports",US| ESPN HD',
    );
    expect(e).toEqual({ tvgId: 'ESPN', tvgName: 'US| ESPN HD', tvgLogo: 'https://l/e.png', group: 'US| Sports', name: 'US| ESPN HD' });
  });

  it('keeps commas inside quoted attributes and inside the name', () => {
    const e = parseExtinf('#EXTINF:-1 tvg-name="A, B" group-title="X,Y",PPV 01: A vs B, Round 2');
    expect(e.tvgName).toBe('A, B');
    expect(e.group).toBe('X,Y');
    expect(e.name).toBe('PPV 01: A vs B, Round 2');
  });

  it('falls back to tvg-name when there is no display name', () => {
    expect(parseExtinf('#EXTINF:-1 tvg-name="Only Name"').name).toBe('Only Name');
    expect(parseExtinf('#EXTINF:-1').name).toBe('');
  });
});

describe('parseM3u', () => {
  it('streams the fixture and skips VOD', async () => {
    const { entries, stats } = await parseM3u(createReadStream(fixture('playlist.m3u')));
    expect(stats).toEqual({ total: 18, vodSkipped: 2 });
    expect(entries).toHaveLength(16);
    expect(entries.every((e) => !('url' in e))).toBe(true);
  });

  it('can keep VOD, and ignores stray URLs and comments', async () => {
    const text = '#EXTM3U\nhttp://orphan\n#EXTINF:-1,Film\n#EXTGRP:x\nhttp://h/movie/1.mkv\n\n';
    const kept = await parseM3u(text, { skipVod: false });
    expect(kept.entries.map((e) => e.name)).toEqual(['Film']);
    const skipped = await parseM3u(text);
    expect(skipped.entries).toEqual([]);
  });

  it('handles CRLF line endings', async () => {
    const { entries } = await parseM3u('#EXTM3U\r\n#EXTINF:-1 tvg-id="A",Alpha\r\nhttp://h/live/1.ts\r\n');
    expect(entries[0]).toMatchObject({ tvgId: 'A', name: 'Alpha' });
  });
});

describe('toPlaylistChannels', () => {
  it('collapses shared tvg-ids and falls back to names', () => {
    const channels = toPlaylistChannels([
      { tvgId: 'ESPN', tvgName: 'ESPN HD', tvgLogo: '', group: '', name: 'ESPN HD' },
      { tvgId: 'ESPN', tvgName: 'ESPN FHD', tvgLogo: '', group: '', name: 'ESPN FHD' },
      { tvgId: '', tvgName: 'PPV 1', tvgLogo: '', group: '', name: 'PPV 1: A vs B' },
      { tvgId: '', tvgName: '', tvgLogo: '', group: '', name: 'Named' },
      { tvgId: '', tvgName: '', tvgLogo: '', group: '', name: '' },
    ]);
    expect(channels.map((c) => [c.id, c.idFallback])).toEqual([
      ['ESPN', false],
      ['PPV 1', true],
      ['Named', true],
    ]);
    expect(channels[0].aliases).toEqual(['ESPN FHD']);
    expect(channels[1].name).toBe('PPV 1: A vs B');
  });
});
