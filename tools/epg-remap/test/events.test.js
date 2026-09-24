import { describe, expect, it } from 'vitest';
import { eventGuideTitle, parseEventName } from '../src/events.js';

const NOW = new Date('2026-09-22T19:30:00Z');
const guide = (name) => eventGuideTitle(parseEventName(name, { now: NOW }), name);

describe('parseEventName (real provider formats)', () => {
  it.each([
    ['US (ESPN+ 323) | NHL: EDM vs. WPG • TB vs. NSH (2026-09-22 20:00:10)', 'NHL: EDM vs. WPG • TB vs. NSH (Sep 22 5:00 PM PT)'],
    ['US (Peacock 002) | Away Feed: MIN at SF (2026-09-23 15:30:00)', 'Away Feed: MIN at SF (Sep 23 12:30 PM PT)'],
    [
      '(FLSP 301) | live:  Framingham State vs Plymouth State _ Field Hockey (Framingham State vs Plymouth State) (2026-09-24 16:00:10)',
      'Framingham State vs Plymouth State · Field Hockey (Sep 24 1:00 PM PT)',
    ],
    ['ENDED | TP USCA VS. SCAF | Tue 22 Sep 10:00 EDT (US) | 8K EXCLUSIVE | US: FIFA+ PPV 3', 'Ended: TP USCA VS. SCAF (Sep 22 7:00 AM PT)'],
    ['End | Dream vs. Liberty | all | 22-09-2026 | 00:00 (GMT) | 8K EXCLUSIVE | US: SOCCER PPV 1', 'Ended: Dream vs. Liberty (Sep 21 5:00 PM PT)'],
    ['LIVE | Team A vs Team B | 8K EXCLUSIVE | US: MLS PPV 9', 'LIVE: Team A vs Team B'],
    ['UPCOMING | Team A vs Team B', 'Team A vs Team B'],
    ['Inter Miami CF vs San Diego FC @ Sep 20 6:30 PM :MLS  01', 'Inter Miami CF vs San Diego FC (Sep 20 3:30 PM PT)'],
    ['Flo (FLSP) 10: 2025 New Jersey Bears vs Pennsylvania Huntsmen - 22/10 11:30', '2025 New Jersey Bears vs Pennsylvania Huntsmen (Oct 22 8:30 AM PT)'],
    [
      'UFC 00 : DANA WHITES CONTENDER SERIES: SEASON 10, WEEK 7 start:2026-09-23 00:55:00 stop:2026-09-23 05:00:00',
      'DANA WHITES CONTENDER SERIES: SEASON 10, WEEK 7 (Sep 22 5:55 PM PT)',
    ],
    ['LIVE EVENT 02 - 6pm FloRacing Night Lincoln Park', '3pm PT FloRacing Night Lincoln Park'],
    ['PPV EVENT 01: Kings Speedway (9.22 9:15 PM ET)', 'Kings Speedway (Sep 22 6:15 PM PT)'],
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
    expect(guide('(FLSP 1) | hockey: A vs B (Home) (2026-09-23 22:00:00)')).toBe('hockey: A vs B (Home) (Sep 23 7:00 PM PT)');
  });
});

describe('event times', () => {
  it('uses UTC for WNBA and STAN tags, Eastern otherwise', () => {
    expect(guide('US (WNBA 01) | Sun at Mystics (2026-09-22 23:30:00)')).toBe('Sun at Mystics (Sep 22 4:30 PM PT)');
    expect(guide('(STAN 12) | Rugby: A vs B (2026-09-22 10:00:00)')).toBe('Rugby: A vs B (Sep 22 3:00 AM PT)');
    expect(guide('US (ESPN+ 1) | A vs B (2026-01-15 15:30:00)')).toBe('A vs B (Jan 15 12:30 PM PT)');
  });

  it('honours a zone written in the name', () => {
    expect(guide('LIVE | A vs B | Tue 22 Sep 10:00 CDT (US)')).toBe('LIVE: A vs B (Sep 22 8:00 AM PT)');
    expect(guide('A vs B | 22-09-2026 | 18:00 (BST)')).toBe('A vs B (Sep 22 10:00 AM PT)');
  });

  it('can show another zone', () => {
    const time = { sourceZone: 'America/New_York', zonesByTag: {}, displayZone: 'America/Chicago', displayLabel: 'CT' };
    const p = parseEventName('US (ESPN+ 1) | A vs B (2026-09-22 20:00:00)', { now: NOW, time });
    expect(p.when).toBe('Sep 22 7:00 PM CT');
    expect(p.start.toISOString()).toBe('2026-09-23T00:00:00.000Z');
  });

  it('keeps the raw text when the date is impossible', () => {
    expect(guide('A vs B - 45/13 25:99')).toBe('A vs B (45/13 25:99)');
  });

  it('infers the year from now for dates without one', async () => {
    const { inferYear } = await import('../src/eventtime.js');
    expect(inferYear({ month: 0, day: 2 }, new Date('2026-12-30T00:00:00Z'))).toBe(2027);
    expect(inferYear({ month: 11, day: 30 }, new Date('2026-01-02T00:00:00Z'))).toBe(2025);
    expect(inferYear({ month: 5, day: 1 }, new Date('2026-06-02T00:00:00Z'))).toBe(2026);
  });

  it('works without options (defaults)', () => {
    expect(parseEventName('A vs B').empty).toBe(false);
  });
});

describe('localizeTimesInText', () => {
  it('rewrites (US/Eastern) times in programme text to Pacific', async () => {
    const { localizeTimesInText } = await import('../src/eventtime.js');
    expect(localizeTimesInText('Next game: GSW at LA Clippers at 10/04/2026 07:00 PM (US/Eastern)'))
      .toBe('Next game: GSW at LA Clippers at 10/04/2026 04:00 PM (PT)');
    expect(localizeTimesInText('1/2/2026 12:00 PM (US/Central)')).toBe('01/02/2026 10:00 AM (PT)');
    expect(localizeTimesInText('no time here')).toBe('no time here');
  });

  it('localizes only title/sub-title/desc text of a programme', async () => {
    const { localizeProgrammeChildren } = await import('../src/eventtime.js');
    const kids = [
      { name: 'title', attrs: {}, children: ['Game at 10/04/2026 07:00 PM (US/Eastern)'] },
      { name: 'category', attrs: {}, children: ['10/04/2026 07:00 PM (US/Eastern)'] },
    ];
    const out = localizeProgrammeChildren(kids);
    expect(out[0].children[0]).toContain('04:00 PM (PT)');
    expect(out[1].children[0]).toBe('10/04/2026 07:00 PM (US/Eastern)');
  });
});

describe('localizeBareClock', () => {
  it('converts bare am/pm clock times (assumed Eastern) to the display zone', async () => {
    const { localizeBareClock } = await import('../src/eventtime.js');
    const now = new Date('2026-09-23T19:30:00Z');
    expect(localizeBareClock('MNF 8:15pm Eagles at Bears', now)).toBe('MNF 5:15pm PT Eagles at Bears');
    expect(localizeBareClock('1pm Chargers at Bills', now)).toBe('10am PT Chargers at Bills');
    expect(localizeBareClock('no clock here', now)).toBe('no clock here');
    expect(localizeBareClock('at 7:00 sharp', now)).toBe('at 7:00 sharp');
    expect(localizeBareClock('3 am wakeup', now)).toBe('3 am wakeup');
    expect(localizeBareClock('6pm main card', now)).toBe('3pm PT main card');
  });

  it('does not truncate a clock time in an event title', () => {
    const now = new Date('2026-09-23T19:30:00Z');
    expect(guide('NFL | - MNF 8:15pm Eagles at Bears').replace(/^.*?(\d)/, '$1')).toContain('5:15pm PT');
  });
});
