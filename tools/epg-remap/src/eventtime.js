// Listed start times in event-channel names, converted to the viewer's time zone.
//
// Providers write times in several formats and zones. A name's own label wins ("EDT", "GMT",
// "ET"); UFC-style "start:" fields are UTC; otherwise the zone comes from the provider tag in
// the name ("(WNBA 01)" -> UTC) or the default (Eastern). Measured on a real account: ESPN+,
// BTN+, MiLB, Peacock and FloSports list games 8 AM-11 PM (Eastern); WNBA and STAN cluster
// around 23:00-02:00 (UTC).

export const DEFAULT_TIME_OPTIONS = Object.freeze({
  sourceZone: 'America/New_York',
  zonesByTag: { WNBA: 'UTC', STAN: 'UTC' },
  displayZone: 'America/Los_Angeles',
  displayLabel: 'PT',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_RE = MONTHS.join('|');
const DAY_RE = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun';

const ZONE_ABBREVIATIONS = {
  ET: 'America/New_York', EDT: 'America/New_York', EST: 'America/New_York',
  CT: 'America/Chicago', CDT: 'America/Chicago', CST: 'America/Chicago',
  MT: 'America/Denver', MDT: 'America/Denver', MST: 'America/Denver',
  PT: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PST: 'America/Los_Angeles',
  GMT: 'UTC', UTC: 'UTC', Z: 'UTC', BST: 'Europe/London',
};

const monthIndex = (name) => MONTHS.findIndex((m) => m.toLowerCase() === name.slice(0, 3).toLowerCase());
const to24h = (h, ampm) => {
  if (!ampm) return h;
  const pm = /p/i.test(ampm);
  return (h % 12) + (pm ? 12 : 0);
};

// Each pattern yields { month (0-11), day, hour, minute, year?, zone? } or { empty: true }.
// `zone` is set only when the name itself says which zone; otherwise the caller decides.
export const TIME_PATTERNS = [
  {
    // start:2026-09-23 00:55:00 stop:2026-09-23 05:00:00  (UTC)
    re: /\s*start:\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::\d{2})?(?:\s*stop:\s*[\d-]+ [\d:]+)?/i,
    parts: (m) => ({ year: +m[1], month: +m[2] - 1, day: +m[3], hour: +m[4], minute: +m[5], zone: 'UTC' }),
  },
  {
    // (2026-09-22 20:00:10); year 2098 marks an idle slot
    re: /\(?\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?\s*\)?/,
    parts: (m) => (+m[1] >= 2090 ? { empty: true } : { year: +m[1], month: +m[2] - 1, day: +m[3], hour: +m[4], minute: +m[5] }),
  },
  {
    // Tue 22 Sep 10:00 EDT (US)
    re: new RegExp(`\\b(?:${DAY_RE})\\s+(\\d{1,2})\\s+(${MONTH_RE})\\s+(\\d{1,2}):(\\d{2})(?:\\s+([A-Z]{2,4}))?(?:\\s*\\(US\\))?`),
    parts: (m) => ({ month: monthIndex(m[2]), day: +m[1], hour: +m[3], minute: +m[4], zone: ZONE_ABBREVIATIONS[m[5]] }),
  },
  {
    // 22-09-2026 | 00:00 (GMT)
    re: /\b(\d{2})-(\d{2})-(\d{4})\b(?:\s*\|\s*|\s+)(\d{1,2}):(\d{2})(?:\s*\(([A-Z]{2,4})\))?/,
    parts: (m) => ({ year: +m[3], month: +m[2] - 1, day: +m[1], hour: +m[4], minute: +m[5], zone: ZONE_ABBREVIATIONS[m[6]] }),
  },
  {
    // (9.22 9:15 PM ET)
    re: /\s*\((\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([AP]M)\s*([A-Z]{2,4})?\)/i,
    parts: (m) => ({ month: +m[1] - 1, day: +m[2], hour: to24h(+m[3], m[5]), minute: +m[4], zone: ZONE_ABBREVIATIONS[m[6]?.toUpperCase()] }),
  },
  {
    // @ Sep 20 6:30 PM
    re: new RegExp(`\\s*@\\s*(${MONTH_RE})\\s+(\\d{1,2})\\s+(\\d{1,2}):(\\d{2})\\s*([AP]M)`, 'i'),
    parts: (m) => ({ month: monthIndex(m[1]), day: +m[2], hour: to24h(+m[3], m[5]), minute: +m[4] }),
  },
  {
    // - 22/10 11:30   (day/month)
    re: /\s+-\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*$/,
    parts: (m) => ({ month: +m[2] - 1, day: +m[1], hour: +m[3], minute: +m[4] }),
  },
];

// Offset of `zone` from UTC, in minutes, at the given instant.
export function zoneOffsetMinutes(instantMs, zone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
}

// Wall-clock time in `zone` -> Date. Second pass settles DST boundaries.
export function zonedToDate({ year, month, day, hour, minute }, zone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  let t = wall - zoneOffsetMinutes(wall, zone) * 60000;
  t = wall - zoneOffsetMinutes(t, zone) * 60000;
  return new Date(t);
}

// Names without a year: pick the year that puts the date closest to now.
export function inferYear(parts, now) {
  const y = now.getUTCFullYear();
  let best = y;
  for (const candidate of [y - 1, y, y + 1]) {
    const d = Date.UTC(candidate, parts.month, parts.day);
    if (Math.abs(d - now.getTime()) < Math.abs(Date.UTC(best, parts.month, parts.day) - now.getTime())) best = candidate;
  }
  return best;
}

export function providerTag(name) {
  const m = /\(\s*([A-Za-z+]+)(?:\s+[A-Za-z+]+)?\s*\d+\s*\)/.exec(String(name ?? ''));
  return m ? m[1].toUpperCase() : null;
}

// "Sep 22 5:00 PM PT"
export function formatInZone(date, zone, label) {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
  return `${s.replace(',', '').replace(/ /g, ' ')}${label ? ` ${label}` : ''}`;
}

// Rewrite absolute times written into programme text ("10/04/2026 07:00 PM (US/Eastern)")
// into the display zone ("10/04/2026 04:00 PM (PT)"). Only this exact labeled shape is touched.
const TZ_LABELS = {
  'US/Eastern': 'America/New_York', 'US/Central': 'America/Chicago',
  'US/Mountain': 'America/Denver', 'US/Pacific': 'America/Los_Angeles',
};
const LABELED_MDY = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)\s*\((US\/(?:Eastern|Central|Mountain|Pacific))\)/g;

export function localizeTimesInText(text, opts = DEFAULT_TIME_OPTIONS) {
  return String(text).replace(LABELED_MDY, (whole, mo, d, y, h, mi, ap, tz) => {
    const src = TZ_LABELS[tz];
    if (!src) return whole;
    let hour = +h % 12;
    if (/p/i.test(ap)) hour += 12;
    const date = zonedToDate({ year: +y, month: +mo - 1, day: +d, hour, minute: +mi }, src);
    if (Number.isNaN(date.getTime())) return whole;
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: opts.displayZone, month: '2-digit', day: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).formatToParts(date).map((x) => [x.type, x.value]),
    );
    const label = opts.displayLabel ? ` (${opts.displayLabel})` : '';
    return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute} ${p.dayPeriod}${label}`;
  });
}

// A bare clock with am/pm ("8:15pm") and no date/zone: assume the source zone (Eastern) using
// today's date for the DST offset, and rewrite to the display zone ("5:15pm PT"). Requires the
// am/pm suffix attached (no space), so "7:00" or "3 am" in a show name is left alone.
export function localizeBareClock(text, now = new Date(), opts = DEFAULT_TIME_OPTIONS) {
  const d = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: opts.sourceZone, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(now).map((x) => [x.type, x.value]),
  );
  return String(text).replace(/\b(\d{1,2})(?::(\d{2}))?([ap]m)\b/gi, (whole, h, mi, ap) => {
    if (+h < 1 || +h > 12 || (mi && +mi > 59)) return whole;
    const hour = (+h % 12) + (/p/i.test(ap) ? 12 : 0);
    const date = zonedToDate({ year: +d.year, month: +d.month - 1, day: +d.day, hour, minute: mi ? +mi : 0 }, opts.sourceZone);
    if (Number.isNaN(date.getTime())) return whole;
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: opts.displayZone, hour: 'numeric', minute: '2-digit', hour12: true })
        .formatToParts(date).map((x) => [x.type, x.value]),
    );
    const mins = mi ? `:${p.minute}` : '';
    return `${p.hour}${mins}${p.dayPeriod.toLowerCase()}${opts.displayLabel ? ` ${opts.displayLabel}` : ''}`;
  });
}

// Run the localizer over the text inside title/sub-title/desc of a programme's children.
const LOCALIZE_IN = new Set(['title', 'sub-title', 'desc']);
export function localizeProgrammeChildren(children, opts = DEFAULT_TIME_OPTIONS) {
  let changed = false;
  const out = children.map((c) => {
    if (typeof c === 'string' || !LOCALIZE_IN.has(c.name)) return c;
    const kids = c.children.map((t) => (typeof t === 'string' ? localizeTimesInText(t, opts) : t));
    if (kids.some((t, i) => t !== c.children[i])) changed = true;
    return { ...c, children: kids };
  });
  return changed ? out : children;
}

// Resolve parsed parts to an instant, or null if the parts are not a real date.
export function resolveStart(parts, name, now, opts = DEFAULT_TIME_OPTIONS) {
  const year = parts.year ?? inferYear(parts, now);
  if (!(parts.month >= 0 && parts.month <= 11 && parts.day >= 1 && parts.day <= 31 && parts.hour <= 23 && parts.minute <= 59)) {
    return null;
  }
  const tag = providerTag(name);
  const zone = parts.zone ?? (tag && opts.zonesByTag?.[tag]) ?? opts.sourceZone;
  const date = zonedToDate({ ...parts, year }, zone);
  return Number.isNaN(date.getTime()) ? null : date;
}
