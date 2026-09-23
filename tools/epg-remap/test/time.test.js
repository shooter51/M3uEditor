import { describe, expect, it } from 'vitest';
import { formatXmltvTime, normalizeXmltvTime, OUTPUT_TS, parseXmltvTime } from '../src/time.js';

describe('XMLTV time', () => {
  it.each([
    ['20260922180000 +0000', '20260922180000 +0000'],
    ['20260922150000 -0500', '20260922200000 +0000'],
    ['20260922150000 +05:30', '20260922093000 +0000'],
    ['20260922180000', '20260922180000 +0000'],
    ['202609221800', '20260922180000 +0000'],
    ['20260922', '20260922000000 +0000'],
    ['20260922180000 Z', '20260922180000 +0000'],
    ['20260922180000 UTC', '20260922180000 +0000'],
    ['20261231230000 -0200', '20270101010000 +0000'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeXmltvTime(input)).toBe(out);
    expect(out).toMatch(OUTPUT_TS);
  });

  it.each(['', 'garbage', '2026-09-22 18:00', '20260230120000 +0000', '20260922250000', '20260922180000 +1599', undefined])(
    'rejects %s',
    (input) => {
      expect(parseXmltvTime(input)).toBeNull();
      expect(normalizeXmltvTime(input)).toBeNull();
    },
  );

  it('formats in UTC', () => {
    expect(formatXmltvTime(new Date('2026-01-02T03:04:05Z'))).toBe('20260102030405 +0000');
  });
});
