import { describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_PATTERN } from '../src/config.js';
import { isEventChannel, placeholderChannelElement, placeholderProgrammes, placeholderSlots } from '../src/placeholders.js';
import { NOW } from './helpers.js';

describe('isEventChannel', () => {
  it.each([
    ['PPV 03: Team A vs Team B', '', true],
    ['EVENT 12', '', true],
    ['Team A @ Team B', '', true],
    ['UFC 300: Main Card', '', true],
    ['Some Channel', 'PPV Events', true],
    ['US| ESPN HD', 'US| Sports', false],
    ['US| Local Access 7', 'US| Locals', false],
  ])('%s [%s] -> %s', (name, group, expected) => {
    expect(isEventChannel({ name, group }, DEFAULT_EVENT_PATTERN)).toBe(expected);
  });

  it('accepts a RegExp and checks tvg-name', () => {
    expect(isEventChannel({ name: 'x', tvgName: 'Live Event' }, /live event/i)).toBe(true);
  });
});

describe('placeholder slots', () => {
  it('covers now..now+24h in 4h slots aligned to UTC', () => {
    const slots = placeholderSlots(NOW, 24, 4); // 19:30Z
    expect(slots[0][0].toISOString()).toBe('2026-09-22T16:00:00.000Z');
    expect(slots.at(-1)[1].getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 24 * 3_600_000);
    expect(slots).toHaveLength(7);
    for (let i = 1; i < slots.length; i++) expect(slots[i][0].getTime()).toBe(slots[i - 1][1].getTime());
  });

  it('builds programmes titled with the display name', () => {
    const ch = { id: 'PPV 03', name: 'PPV 03: Team A vs Team B', logo: '' };
    const progs = placeholderProgrammes(ch, NOW, 24, 4);
    expect(progs[0].attrs).toEqual({ start: '20260922160000 +0000', stop: '20260922200000 +0000', channel: 'PPV 03' });
    expect(progs[0].children[0].children).toEqual(['PPV 03: Team A vs Team B']);
  });

  it('channel element carries the logo when present', () => {
    expect(placeholderChannelElement({ id: 'a', name: 'A', logo: 'https://l/a.png' }).children[1].attrs.src).toBe('https://l/a.png');
    expect(placeholderChannelElement({ id: 'a', name: 'A', logo: '' }).children).toHaveLength(1);
  });
});
