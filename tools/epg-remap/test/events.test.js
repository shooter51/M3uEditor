import { describe, expect, it } from 'vitest';
import { eventGuideTitle, parseEventName } from '../src/events.js';

const guide = (name) => eventGuideTitle(parseEventName(name), name);

describe('parseEventName (real provider formats)', () => {
  it.each([
    ['US (ESPN+ 323) | NHL: EDM vs. WPG • TB vs. NSH (2026-09-22 20:00:10)', 'NHL: EDM vs. WPG • TB vs. NSH (Sep 22 20:00)'],
    ['US (Peacock 002) | Away Feed: MIN at SF (2026-09-23 15:30:00)', 'Away Feed: MIN at SF (Sep 23 15:30)'],
    [
      '(FLSP 301) | live:  Framingham State vs Plymouth State _ Field Hockey (Framingham State vs Plymouth State) (2026-09-24 16:00:10)',
      'Framingham State vs Plymouth State · Field Hockey (Sep 24 16:00)',
    ],
    ['ENDED | TP USCA VS. SCAF | Tue 22 Sep 10:00 EDT (US) | 8K EXCLUSIVE | US: FIFA+ PPV 3', 'Ended: TP USCA VS. SCAF (Sep 22 10:00 EDT)'],
    ['End | Dream vs. Liberty | all | 22-09-2026 | 00:00 (GMT) | 8K EXCLUSIVE | US: SOCCER PPV 1', 'Ended: Dream vs. Liberty (Sep 22 00:00 GMT)'],
    ['LIVE | Team A vs Team B | 8K EXCLUSIVE | US: MLS PPV 9', 'LIVE: Team A vs Team B'],
    ['UPCOMING | Team A vs Team B', 'Team A vs Team B'],
    ['Inter Miami CF vs San Diego FC @ Sep 20 6:30 PM :MLS  01', 'Inter Miami CF vs San Diego FC (Sep 20 6:30 PM)'],
    ['Flo (FLSP) 10: 2025 New Jersey Bears vs Pennsylvania Huntsmen - 22/10 11:30', '2025 New Jersey Bears vs Pennsylvania Huntsmen (Oct 22 11:30)'],
    [
      'UFC 00 : DANA WHITES CONTENDER SERIES: SEASON 10, WEEK 7 start:2026-09-23 00:55:00 stop:2026-09-23 05:00:00',
      'DANA WHITES CONTENDER SERIES: SEASON 10, WEEK 7 (Sep 23 00:55)',
    ],
    ['LIVE EVENT 02 - 6pm FloRacing Night Lincoln Park', '6pm FloRacing Night Lincoln Park'],
    ['PPV EVENT 01: Kings Speedway (9.22 9:15 PM ET)', 'Kings Speedway (9.22 9:15 PM ET)'],
    ['PPV 03: Team A vs Team B', 'Team A vs Team B'],
    ['Boxing 7: Jake Paul vs Anthony Joshua', 'Jake Paul vs Anthony Joshua'],
    ['US: 24/7 NETFLIX 1', '24/7 NETFLIX 1'],
    ['US: THE MASTERS - CBS COVERAGE', 'THE MASTERS - CBS COVERAGE'],
    ['FINAL | Game Over vs Tie', 'Ended: Game Over vs Tie'],
  ])('%s', (name, expected) => {
    expect(guide(name)).toBe(expected);
  });

  it.each([
    '- NO EVENT STREAMING - | 8K EXCLUSIVE | US: MLS PPV 1',
    'NO EVENT STREAMING NOW - | 8K EXCLUSIVE | US: SOCCER PPV 81',
    'US (MiLB 011) |  (2098-12-31 08:00:01)',
    ':MLS  03',
    'UFC 09:',
    'PPV EVENT 04',
    'LIVE EVENT 33 -',
    'UEFA | 11 -',
    'PPV',
    '',
    undefined,
  ])('empty slot: %s', (name) => {
    const p = parseEventName(name);
    expect(p.empty).toBe(true);
    expect(guide(name)).toBe('No event scheduled');
  });

  it('falls back to the raw name when a parsed title is missing', () => {
    expect(eventGuideTitle({ empty: false, title: null, when: null, status: null }, 'Raw')).toBe('Raw');
    expect(eventGuideTitle({ empty: true }, 'Raw', 'Nothing on')).toBe('Nothing on');
  });

  it('keeps a parenthetical that is not a duplicate', () => {
    expect(guide('(FLSP 1) | hockey: A vs B (Home) (2026-09-23 22:00:00)')).toBe('hockey: A vs B (Home) (Sep 23 22:00)');
  });
});
