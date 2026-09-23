import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, loadConfig, loadOverrides, validateConfig } from '../src/config.js';
import { tempDir } from './helpers.js';

let tmp;
beforeEach(async () => {
  tmp = await tempDir();
});
afterEach(() => tmp.cleanup());

describe('loadConfig', () => {
  it('uses defaults when the file is missing', async () => {
    const cfg = await loadConfig(path.join(tmp.dir, 'nope.json'));
    expect(cfg.sources).toEqual(DEFAULTS.sources);
    expect(cfg.sources).toHaveLength(6);
    expect(cfg.threshold).toBe(0.85);
    expect(cfg.refreshHours).toBe(6);
    expect(cfg.outDir).toBe(path.join(tmp.dir, 'out'));
  });

  it('works without any path', async () => {
    const cfg = await loadConfig(null);
    expect(path.isAbsolute(cfg.cacheDir)).toBe(true);
  });

  it('merges file then CLI overrides, resolving paths relative to the config', async () => {
    const file = path.join(tmp.dir, 'config.json');
    await writeFile(file, JSON.stringify({ threshold: 0.9, port: 9000, outDir: 'guide' }));
    const cfg = await loadConfig(file, { port: '9100', host: undefined });
    expect(cfg.threshold).toBe(0.9);
    expect(cfg.port).toBe(9100);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.outDir).toBe(path.join(tmp.dir, 'guide'));
  });

  it('fails on a required missing file or bad JSON', async () => {
    await expect(loadConfig(path.join(tmp.dir, 'nope.json'), {}, { required: true })).rejects.toThrow(/Cannot read config/);
    const bad = path.join(tmp.dir, 'bad.json');
    await writeFile(bad, '{');
    await expect(loadConfig(bad)).rejects.toThrow(/Cannot read config/);
  });
});

describe('validateConfig', () => {
  const base = () => ({ ...DEFAULTS });
  it.each([
    [{ sources: [] }, 'non-empty'],
    [{ sources: ['http://epgshare01.online/x.xml.gz'] }, 'must be https'],
    [{ sources: ['not a url'] }, 'not a URL'],
    [{ threshold: 0 }, 'threshold'],
    [{ threshold: 1.5 }, 'threshold'],
    [{ regionPreference: 'north' }, 'regionPreference'],
    [{ port: 70000 }, 'port'],
    [{ port: -1 }, 'port'],
    [{ refreshHours: 0 }, 'refreshHours'],
    [{ placeholderHours: 2 }, 'placeholderHours'],
    [{ eventPattern: '(' }, 'eventPattern'],
    [{ placeholderExclude: '[' }, 'placeholderExclude'],
    [{ reviewFloor: 0.9 }, 'reviewFloor'],
    [{ accessToken: 'short' }, 'accessToken'],
    [{ reportAuth: 'nocolon' }, 'reportAuth'],
  ])('rejects %j', (patch, message) => {
    expect(() => validateConfig({ ...base(), ...patch })).toThrow(message);
  });

  it('accepts a valid token and auth', () => {
    expect(validateConfig({ ...base(), accessToken: 'abcdEFGH_1234', reportAuth: 'tom:secret' }).accessToken).toBe('abcdEFGH_1234');
  });
});

describe('loadOverrides', () => {
  it('returns an empty map when missing', async () => {
    expect((await loadOverrides(path.join(tmp.dir, 'none.json'))).size).toBe(0);
  });

  it('parses a valid file', async () => {
    const f = path.join(tmp.dir, 'o.json');
    await writeFile(f, '{"ESPN":"ESPN.HD.us2"}');
    expect([...(await loadOverrides(f))]).toEqual([['ESPN', 'ESPN.HD.us2']]);
  });

  it.each([
    ['{', 'not valid JSON'],
    ['[]', 'must be an object'],
    ['null', 'must be an object'],
    ['{"a":1}', 'non-empty string'],
    ['{"a":""}', 'non-empty string'],
  ])('rejects %s', async (body, message) => {
    const f = path.join(tmp.dir, 'o.json');
    await writeFile(f, body);
    await expect(loadOverrides(f)).rejects.toThrow(message);
  });

  it('rethrows other read errors', async () => {
    await expect(loadOverrides(tmp.dir)).rejects.toThrow();
  });
});
