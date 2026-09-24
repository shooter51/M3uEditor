// Event channels carry the game in their name, wrapped in provider labels and a listed time:
//   "US (ESPN+ 323) | NHL: EDM vs. WPG • TB vs. NSH (2026-09-22 20:00:10)"
//   "ENDED | TP USCA VS. SCAF | Tue 22 Sep 10:00 EDT (US) | 8K EXCLUSIVE | US: FIFA+ PPV 3"
//   "(FLSP 301) | live:  A vs B _ Field Hockey (A vs B) (2026-09-24 16:00:10)"
//   "Inter Miami CF vs San Diego FC @ Sep 20 6:30 PM :MLS  01"
//   "- NO EVENT STREAMING - | 8K EXCLUSIVE | US: MLS PPV 1"      (empty slot)
// parseEventName() pulls out a guide-friendly title, the listed start time converted to the
// viewer's zone (see eventtime.js for how the source zone is decided), and whether the slot
// is empty or finished.

import { DEFAULT_TIME_OPTIONS, TIME_PATTERNS, formatInZone, localizeBareClock, resolveStart } from './eventtime.js';

const EMPTY_MARKERS = /NO EVENTS? (?:STREAMING|SCHEDULED)|NO EVENT\b|OFF ?AIR|\bOFFLINE\b/i;
const STATUS = /^\s*(ENDED|END|FINISHED|FINAL|LIVE( NOW)?|UPCOMING|SOON)\s*$/i;

// Segments that label the slot rather than describe the event.
const LABEL_SEGMENTS = [
  /^\s*8K EXCLUSIVE\s*$/i,
  /^\s*all\s*$/i,
  /^\s*\(?US\)?\s*$/i,
  /^\s*\(?(?:US)?\)?\s*\(?\s*[\p{L}+&. ]{1,20}\s*\d{1,4}\s*\)?\s*$/u, // "US (ESPN+ 323)", "(FLSP 301)", "(US) (BTN+ 083)"
  /^\s*(?:US|USA)\s*:\s*[^|]*\b(?:PPV|EVENTS?)\b[^|]*?\d{1,4}\s*$/i, // "US: MLS PPV 35", "US: SOCCER PPV 81"
  /^\s*[\p{L}+&. ]{1,20}\s+\d{1,4}\s*-?\s*$/u, // "UEFA 11 -"
];

export function parseEventName(rawName, { now = new Date(), time = DEFAULT_TIME_OPTIONS } = {}) {
  const name = String(rawName ?? '').replace(/\s+/g, ' ').trim();
  let rest = name;
  let when = null;
  let start = null;
  let emptyByTime = false;
  for (const { re, parts } of TIME_PATTERNS) {
    const m = re.exec(rest);
    if (!m) continue;
    const p = parts(m);
    if (p.empty) {
      emptyByTime = true;
    } else if (!start && !when) {
      start = resolveStart(p, name, now, time);
      when = start ? formatInZone(start, time.displayZone, time.displayLabel) : m[0].replace(/[()@]/g, ' ').replace(/^[\s\-–:|]+/, '').trim();
    }
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
  }

  let status = null;
  const segments = rest
    .split('|')
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      if (STATUS.test(s)) {
        status ??= normalizeStatus(s);
        return false;
      }
      return !LABEL_SEGMENTS.some((re) => re.test(s));
    });

  // "UEFA | 11 -": a slot label split across segments.
  const bareSlot = /^[\p{L}+&. ]{1,20}\s*\|?\s*\d{1,4}\s*-?\s*$/u.test(name);
  if (EMPTY_MARKERS.test(name) || emptyByTime || bareSlot) return { title: null, when: null, start: null, status: null, empty: true };

  // The event is the most descriptive remaining segment.
  let title = segments.sort((a, b) => letters(b) - letters(a))[0] ?? '';
  title = localizeBareClock(cleanTitle(title), now, time);
  if (!title || letters(title) < 3 || isBareLabel(title)) {
    return { title: null, when, start, status, empty: true };
  }
  return { title, when, start, status, empty: false };
}

function cleanTitle(t) {
  let s = t;
  // Leading slot number like "01 - Title".
  s = s.replace(/^\s*\d{1,3}\s*[-–]\s+/, '');
  // "Flo (FLSP) 10: Title", "UFC 05 : Title", "PPV 03: Title" -> "Title" when a real title follows.
  s = s.replace(/^[^:|]{0,24}?\d+\s*:(?!\d{2})\s*(?=\S.{3,})/u, '');
  // "LIVE EVENT 01 - Title" -> "Title"
  s = s.replace(/^(?:LIVE\s+)?EVENTS?\s*\d+\s*[-:]\s*(?=\S)/i, '');
  // "Title :MLS 01" trailing slot label.
  s = s.replace(/\s*:\s*[\p{L}+&. ]{1,12}\s*\d{1,4}\s*$/u, '');
  // "live:  A vs B _ Field Hockey (A vs B)" -> "A vs B · Field Hockey"
  s = s.replace(/^live:\s*/i, '');
  s = s.replace(/\s*\(([^()]{3,})\)\s*$/, (whole, inner) => (s.replace(whole, '').toLowerCase().includes(inner.toLowerCase().trim()) ? '' : whole));
  s = s.replace(/\s+_\s+/g, ' · ').replace(/`/g, "'");
  s = s.replace(/^\s*(?:US|USA)\s*[:|]\s*/i, '');
  return s.replace(/\s+/g, ' ').replace(/^[\s\-:·|]+|[\s\-:·|]+$/g, '').trim();
}

function isBareLabel(t) {
  // "UFC 09", "PPV EVENT 04", "MLS 03", "US: 24/7 ..." stays a title
  return /^[\p{L}+&. ]{1,20}\s*\d{1,4}$/u.test(t) || /^(PPV|EVENT)S?$/i.test(t);
}

function letters(s) {
  return (s.match(/\p{L}/gu) ?? []).length;
}


function normalizeStatus(s) {
  const v = s.trim().toUpperCase();
  if (v.startsWith('END') || v === 'FINISHED' || v === 'FINAL') return 'ended';
  if (v.startsWith('LIVE')) return 'live';
  return 'upcoming';
}

// Guide-cell title for a parsed event.
export function eventGuideTitle(parsed, fallbackName, emptyTitle = 'No event scheduled') {
  if (parsed.empty) return emptyTitle;
  const prefix = parsed.status === 'ended' ? 'Ended: ' : parsed.status === 'live' ? 'LIVE: ' : '';
  const suffix = parsed.when ? ` (${parsed.when})` : '';
  return `${prefix}${parsed.title ?? fallbackName}${suffix}`;
}
