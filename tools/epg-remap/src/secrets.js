// The M3U URL carries provider credentials. It is read from the environment only,
// never logged, never written to disk. Everything that could echo it goes through redact().

const MIN_SECRET_LENGTH = 4;
const CREDENTIAL_PARAMS = ['username', 'password', 'user', 'pass', 'token', 'key'];

export function getM3uUrl(env = process.env) {
  const raw = env.M3U_URL;
  if (!raw || !raw.trim()) {
    throw new Error('M3U_URL is not set (put it in .env or the environment)');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('M3U_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('M3U_URL must be http(s)');
  }
  return url.toString();
}

// Every substring of the URL that identifies the account: the URL itself (raw and encoded),
// userinfo, and credential-looking query values.
export function secretFragments(rawUrl) {
  if (!rawUrl) return [];
  const out = new Set([rawUrl, encodeURIComponent(rawUrl)]);
  try {
    const url = new URL(rawUrl);
    out.add(url.toString());
    if (url.username) out.add(decodeURIComponent(url.username));
    if (url.password) out.add(decodeURIComponent(url.password));
    for (const [k, v] of url.searchParams) {
      if (CREDENTIAL_PARAMS.includes(k.toLowerCase())) {
        out.add(v);
        out.add(encodeURIComponent(v));
      }
    }
    // Xtream-style path credentials: /live/<user>/<pass>/...
    for (const seg of url.pathname.split('/')) {
      if (seg && url.search === '' && /^[^.]+$/.test(seg) && seg.length >= 6) out.add(seg);
    }
  } catch {
    // not a URL; the raw string is still covered
  }
  return [...out]
    .filter((s) => s && s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

export function makeRedactor(rawUrl) {
  const fragments = secretFragments(rawUrl);
  return (value) => {
    let text = value instanceof Error ? `${value.message}${causeText(value)}` : String(value);
    for (const f of fragments) text = text.split(f).join('[REDACTED]');
    return text;
  };
}

function causeText(err) {
  const cause = err.cause;
  if (!cause) return '';
  return ` (cause: ${cause.code || cause.message || String(cause)})`;
}
