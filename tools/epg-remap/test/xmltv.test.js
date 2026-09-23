import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  childText,
  childTexts,
  escapeAttr,
  escapeText,
  openXmlFile,
  serializeElement,
  streamXmltv,
  XmltvWriter,
} from '../src/xmltv.js';
import { validateXmltv, validateXmltvFile } from '../src/validate.js';
import { fixture, streamOf, tempDir } from './helpers.js';

let tmp;
beforeEach(async () => {
  tmp = await tempDir();
});
afterEach(() => tmp.cleanup());

describe('streamXmltv', () => {
  it('reads channels and programmes from the gzipped fixture', async () => {
    const channels = [];
    const programmes = [];
    const stats = await streamXmltv(await openXmlFile(fixture('epg_us2.xml.gz')), {
      onChannel: (el) => channels.push(el),
      onProgramme: (el) => programmes.push(el),
    });
    expect(stats).toMatchObject({ channels: 9, programmes: 14, sawTv: true });
    expect(channels[0].attrs.id).toBe('ESPN.HD.us2');
    expect(childTexts(channels[0], 'display-name')).toEqual(['ESPN HD']);
    expect(childText(programmes[0], 'sub-title')).toBe('Evening & Late');
    expect(childText(programmes[0], 'missing')).toBe('');
  });

  it('reads plain (non-gzip) files and skips unrequested elements', async () => {
    const channels = [];
    const stats = await streamXmltv(await openXmlFile(fixture('epg_fanduel.xml')), { onChannel: (el) => channels.push(el) });
    expect(channels).toHaveLength(2);
    expect(stats.programmes).toBe(0);
  });

  it('survives a truncated feed, counting the parse error, and captures CDATA', async () => {
    const xml = '<tv><channel id="a"><display-name><![CDATA[A & B]]></display-name></channel><programme channel="a" start="1"><title>T</title></programme><programme';
    const got = [];
    const stats = await streamXmltv(streamOf(xml), { onChannel: (el) => got.push(el), onProgramme: () => {} });
    expect(childText(got[0], 'display-name')).toBe('A & B');
    expect(stats.parseErrors).toBeGreaterThan(0);
  });

  it('ignores channel elements that are not direct children of <tv>', async () => {
    const got = [];
    await streamXmltv(streamOf('<root><channel id="x"/></root>'), { onChannel: (el) => got.push(el) });
    expect(got).toEqual([]);
  });

  it('awaits afterChunk between chunks', async () => {
    let calls = 0;
    await streamXmltv(streamOf('<tv></tv>'), { afterChunk: async () => calls++ });
    expect(calls).toBe(1);
  });

  it('openXmlFile handles a tiny file', async () => {
    const f = path.join(tmp.dir, 'one.xml');
    await writeFile(f, 'x');
    const stats = await streamXmltv(await openXmlFile(f), {});
    expect(stats.sawTv).toBe(false);
  });
});

describe('serialization', () => {
  it('escapes text and attributes and strips invalid XML chars', () => {
    expect(escapeText('a & <b> \u0001')).toBe('a &amp; &lt;b&gt; ');
    expect(escapeAttr('"q"\n\t')).toBe('&quot;q&quot;&#10;&#9;');
  });

  it('serializes nested and mixed content', () => {
    const el = {
      name: 'programme',
      attrs: { channel: 'A&B' },
      children: [{ name: 'title', attrs: {}, children: ['T'] }, 'loose text', { name: 'icon', attrs: { src: 'x' }, children: [] }],
    };
    expect(serializeElement(el)).toBe(
      '  <programme channel="A&amp;B">\n    <title>T</title>\n    loose text\n    <icon src="x" />\n  </programme>',
    );
  });
});

describe('XmltvWriter + validate', () => {
  const channel = { name: 'channel', attrs: { id: 'a' }, children: [{ name: 'display-name', attrs: {}, children: ['A'] }] };
  const prog = (attrs, title = true) => ({
    name: 'programme',
    attrs: { channel: 'a', start: '20260922180000 +0000', stop: '20260922190000 +0000', ...attrs },
    children: title ? [{ name: 'title', attrs: {}, children: ['T'] }] : [],
  });

  async function write(elements) {
    const file = path.join(tmp.dir, 'out.xml.gz');
    const w = new XmltvWriter(file);
    await w.start();
    for (const el of elements) await w.element(el);
    w.writeElement(prog({ start: '20260922200000 +0000', stop: '20260922210000 +0000' }));
    await w.drain();
    await w.end();
    return file;
  }

  it('writes a file that validates', async () => {
    const res = await validateXmltvFile(await write([channel, prog({})]));
    expect(res).toMatchObject({ ok: true, channels: 1, programmes: 2 });
  });

  it('abort() discards cleanly', async () => {
    const w = new XmltvWriter(path.join(tmp.dir, 'aborted.gz'));
    await w.start();
    await w.abort();
  });

  it.each([
    ['<tv><programme channel="a" start="20260922180000 +0000"><title>T</title></programme></tv>', 'undeclared channel'],
    ['<tv><channel id="a"/><channel id="a"/></tv>', 'duplicate'],
    ['<tv><channel/></tv>', 'without id'],
    ['<tv><channel id="a"/><programme channel="a" start="bad"><title>T</title></programme></tv>', 'bad start'],
    ['<tv><channel id="a"/><programme channel="a" start="20260922180000 +0000" stop="x"><title>T</title></programme></tv>', 'bad stop'],
    ['<tv><channel id="a"/><programme channel="a" start="20260922180000 +0000"></programme></tv>', 'without <title>'],
    ['<tv><channel id="a"/><programme channel="a" start="20260922180000 +0000"><title>T</title></programme><channel id="b"/></tv>', 'after a <programme>'],
    ['<foo/>', 'expected <tv>'],
    ['<tv><channel id="a"></tv>', 'not well-formed'],
    ['', 'no <tv> root'],
  ])('rejects %s', async (xml, message) => {
    const res = await validateXmltv(streamOf(xml));
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain(message);
  });

  it('caps the number of reported errors', async () => {
    const progs = Array.from({ length: 30 }, () => '<programme channel="zz" start="20260922180000 +0000"><title>T</title></programme>').join('');
    const res = await validateXmltv(streamOf(`<tv>${progs}</tv>`));
    expect(res.errors).toHaveLength(20);
  });

  it('reports unreadable files', async () => {
    const res = await validateXmltvFile(path.join(tmp.dir, 'missing.gz'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('cannot read output');
  });

  it('reports a corrupt gzip', async () => {
    const f = path.join(tmp.dir, 'corrupt.gz');
    await writeFile(f, gzipSync('<tv></tv>').subarray(0, 12));
    const res = await validateXmltvFile(f);
    expect(res.ok).toBe(false);
  });

  it('validates the committed fixture as input would fail (undeclared ghost channel)', async () => {
    const res = await validateXmltv(await openXmlFile(fixture('epg_us2.xml.gz')));
    expect(res.ok).toBe(false);
  });

  it('streams via createReadStream too', async () => {
    const res = await validateXmltv(createReadStream(fixture('epg_fanduel.xml')));
    expect(res.ok).toBe(true);
  });
});
