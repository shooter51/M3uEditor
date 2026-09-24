// XMLTV timestamps: "YYYYMMDDhhmmss +zzzz", with trailing parts optional in the wild.
// Output is always normalized to UTC: "YYYYMMDDHHMMSS +0000".

const TS = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;
export const OUTPUT_TS = /^\d{14} \+0000$/;

export function parseXmltvTime(value) {
  const m = TS.exec(String(value ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', tz] = m;
  const Y = +y;
  const M = +mo;
  const D = +d;
  const H = +h;
  const I = +mi;
  const S = +s;
  const ms = Date.UTC(Y, M - 1, D, H, I, S);
  // Reject rollover dates like Feb 30 or hour 25.
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== Y ||
    check.getUTCMonth() !== M - 1 ||
    check.getUTCDate() !== D ||
    check.getUTCHours() !== H ||
    check.getUTCMinutes() !== I ||
    check.getUTCSeconds() !== S
  ) {
    return null;
  }
  let offsetMin = 0;
  if (tz && /^[+-]/.test(tz)) {
    const digits = tz.replace(':', '');
    const sign = digits[0] === '-' ? -1 : 1;
    const oh = +digits.slice(1, 3);
    const om = +digits.slice(3, 5);
    if (oh > 14 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  return new Date(ms - offsetMin * 60_000);
}

export function formatXmltvTime(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    p(date.getUTCFullYear(), 4) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    ' +0000'
  );
}

export function normalizeXmltvTime(value) {
  const d = parseXmltvTime(value);
  return d ? formatXmltvTime(d) : null;
}
