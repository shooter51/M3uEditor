// Event channels carry the game in their name, wrapped in provider labels and a listed time:
//   "US (ESPN+ 323) | NHL: EDM vs. WPG • TB vs. NSH (2026-09-22 20:00:10)"
//   "ENDED | TP USCA VS. SCAF | Tue 22 Sep 10:00 EDT (US) | 8K EXCLUSIVE | US: FIFA+ PPV 3"
//   "(FLSP 301) | live:  A vs B _ Field Hockey (A vs B) (2026-09-24 16:00:10)"
//   "Inter Miami CF vs San Diego FC @ Sep 20 6:30 PM :MLS  01"
//   "- NO EVENT STREAMING - | 8K EXCLUSIVE | US: MLS PPV 1"      (empty slot)
// parseEventName() pulls out a guide-friendly title, the listed time as the provider wrote
// it, and whether the slot is empty or finished. Listed times are kept verbatim: providers mix
// timezones (some Eastern, some UTC, often unlabeled), so they are shown, not scheduled.

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DAYS = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun';

const TIME_PATTERNS = [
  // start:2026-09-23 00:55:00 stop:2026-09-23 05:00:00
  { re: /\s*start:\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::\d{2})?(?:\s*stop:\s*[\d-]+ [\d:]+)?/i, fmt: (m) => `${monthName(m[2])} ${+m[3]} ${m[4]}:${m[5]}` },
  // (2026-09-22 20:00:10)
  { re: /\(?\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?\s*\)?/, fmt: (m) => (+m[1] >= 2090 ? null : `${monthName(m[2])} ${+m[3]} ${m[4]}:${m[5]}`) },
  // Tue 22 Sep 10:00 EDT (US)
  { re: new RegExp(`\\b(?:${DAYS})\\s+(\\d{1,2})\\s+(${MONTHS})\\s+(\\d{1,2}:\\d{2})(?:\\s+([A-Z]{2,4}))?(?:\\s*\\(US\\))?`), fmt: (m) => `${m[2]} ${m[1]} ${m[3]}${m[4] ? ` ${m[4]}` : ''}` },
  // 22-09-2026 | 00:00 (GMT)   (date and time may sit in separate pipe segments)
  { re: /\b(\d{2})-(\d{2})-(\d{4})\b(?:\s*\|\s*|\s+)(\d{1,2}:\d{2})(?:\s*\(([A-Z]{2,4})\))?/, fmt: (m) => `${monthName(m[2])} ${+m[1]} ${m[4]}${m[5] ? ` ${m[5]}` : ''}` },
  // @ Sep 20 6:30 PM
  { re: new RegExp(`\\s*@\\s*((?:${MONTHS})\\s+\\d{1,2}\\s+\\d{1,2}:\\d{2}\\s*[AP]M)`, 'i'), fmt: (m) => m[1] },
  // - 22/10 11:30
  { re: /\s+-\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:\d{2})\s*$/, fmt: (m) => `${monthName(m[2])} ${+m[1]} ${m[3]}` },
];

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

export function parseEventName(rawName) {
  const name = String(rawName ?? '').replace(/\s+/g, ' ').trim();
  let rest = name;
  let when = null;
  let emptyByTime = false;
  for (const { re, fmt } of TIME_PATTERNS) {
    const m = re.exec(rest);
    if (!m) continue;
    const formatted = fmt(m);
    if (formatted === null) emptyByTime = true;
    else when ??= formatted;
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
  if (EMPTY_MARKERS.test(name) || emptyByTime || bareSlot) return { title: null, when: null, status: null, empty: true };

  // The event is the most descriptive remaining segment.
  let title = segments.sort((a, b) => letters(b) - letters(a))[0] ?? '';
  title = cleanTitle(title);
  if (!title || letters(title) < 3 || isBareLabel(title)) {
    return { title: null, when, status, empty: true };
  }
  return { title, when, status, empty: false };
}

function cleanTitle(t) {
  let s = t;
  // "Flo (FLSP) 10: Title", "UFC 05 : Title", "PPV 03: Title" -> "Title" when a real title follows.
  s = s.replace(/^[^:|]{0,24}?\d+\s*:\s*(?=\S.{3,})/u, '');
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

function monthName(mm) {
  return MONTHS.split('|')[Number(mm) - 1] ?? mm;
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
