import { describe, expect, it } from 'vitest';
import { getM3uUrl, makeRedactor, secretFragments } from '../src/secrets.js';
import { M3U_URL } from './helpers.js';

describe('getM3uUrl', () => {
  it('returns a normalized URL', () => {
    expect(getM3uUrl({ M3U_URL: ` ${M3U_URL} ` })).toBe(M3U_URL);
  });
  it.each([[{}], [{ M3U_URL: '  ' }], [{ M3U_URL: 'nope' }], [{ M3U_URL: 'ftp://x/y' }]])('rejects %j without echoing it', (env) => {
    try {
      getM3uUrl(env);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).toMatch(/M3U_URL/);
      if (env.M3U_URL?.trim()) expect(err.message).not.toContain(env.M3U_URL.trim());
    }
  });
});

describe('redaction', () => {
  const redact = makeRedactor(M3U_URL);

  it('removes the URL, encoded URL and credential values', () => {
    const text = `failed ${M3U_URL} / ${encodeURIComponent(M3U_URL)} user=fixtureuser pass=fixturepass`;
    const out = redact(text);
    expect(out).not.toMatch(/fixtureuser|fixturepass|get\.php\?/);
  });

  it('includes error causes', () => {
    const err = new Error(`boom ${M3U_URL}`, { cause: { code: 'ECONNRESET' } });
    expect(redact(err)).toBe('boom [REDACTED] (cause: ECONNRESET)');
    expect(redact(new Error('x', { cause: new Error('inner fixturepass') }))).toBe('x (cause: inner [REDACTED])');
    expect(redact(new Error('x', { cause: 'str' }))).toBe('x (cause: str)');
  });

  it('covers userinfo and Xtream-style path credentials', () => {
    const frags = secretFragments('https://alice123:hunter22@host.example/live/alice123/hunter22');
    expect(frags).toEqual(expect.arrayContaining(['alice123', 'hunter22']));
  });

  it('is a no-op with no URL and tolerates non-URLs', () => {
    expect(makeRedactor(undefined)('text')).toBe('text');
    expect(secretFragments('not-a-url-secret')).toEqual(['not-a-url-secret']);
  });
});
