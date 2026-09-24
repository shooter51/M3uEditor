import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import sax from 'sax';

// ---------- reading ----------

// Opens a cached source file, gunzipping only if it actually is gzip (magic 1f 8b), since
// some hosts serve .xml.gz already decoded.
export async function openXmlFile(file) {
  const fh = await open(file, 'r');
  const { buffer, bytesRead } = await fh.read(Buffer.alloc(2), 0, 2, 0);
  await fh.close();
  const raw = createReadStream(file);
  if (bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const gunzip = createGunzip();
    raw.on('error', (err) => gunzip.destroy(err));
    return raw.pipe(gunzip);
  }
  return raw;
}

// Streams an XMLTV document and hands each top-level <channel>/<programme> to a callback as a
// small element tree { name, attrs, children }. Only one element is held at a time. The input
// is pulled chunk by chunk and `afterChunk` is awaited between chunks, which is where a
// consumer applies backpressure (e.g. waiting for the gzip writer to drain).
export async function streamXmltv(readable, { onChannel, onProgramme, afterChunk } = {}) {
  const parser = sax.parser(false, { lowercase: true, trim: false, normalize: false });
  const stats = { channels: 0, programmes: 0, parseErrors: 0, sawTv: false };
  const stack = [];
  let current = null; // root of the element being captured
  let capturing = [];

  parser.onerror = () => {
    stats.parseErrors++;
    parser.error = null;
    parser.resume();
  };
  parser.onopentag = (node) => {
    stack.push(node.name);
    if (stack.length === 1 && node.name === 'tv') stats.sawTv = true;
    const wanted =
      stack.length === 2 &&
      stack[0] === 'tv' &&
      ((node.name === 'channel' && onChannel) || (node.name === 'programme' && onProgramme));
    if (!current && !wanted) return;
    const el = { name: node.name, attrs: { ...node.attributes }, children: [] };
    if (!current) {
      current = el;
      capturing = [el];
    } else {
      capturing[capturing.length - 1].children.push(el);
      capturing.push(el);
    }
  };
  parser.ontext = parser.oncdata = (text) => {
    if (current && text.trim()) capturing[capturing.length - 1].children.push(text);
  };
  parser.onclosetag = () => {
    stack.pop();
    if (!current) return;
    capturing.pop();
    if (capturing.length === 0) {
      const done = current;
      current = null;
      if (done.name === 'channel') {
        stats.channels++;
        onChannel(done);
      } else {
        stats.programmes++;
        onProgramme(done);
      }
    }
  };

  readable.setEncoding('utf8');
  for await (const chunk of readable) {
    parser.write(chunk);
    if (afterChunk) await afterChunk();
  }
  parser.close();
  return stats;
}

export function childText(el, name) {
  const child = el.children.find((c) => typeof c !== 'string' && c.name === name);
  if (!child) return '';
  return child.children.filter((c) => typeof c === 'string').join('').trim();
}

export function childTexts(el, name) {
  return el.children
    .filter((c) => typeof c !== 'string' && c.name === name)
    .map((c) => c.children.filter((t) => typeof t === 'string').join('').trim())
    .filter(Boolean);
}

// ---------- writing ----------

// Characters that are illegal in XML 1.0 and would make the output unparseable.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function escapeText(s) {
  return String(s).replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;').replace(/\r?\n|\r/g, '&#10;').replace(/\t/g, '&#9;');
}

export function serializeElement(el, indent = '  ') {
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  if (el.children.length === 0) return `${indent}<${el.name}${attrs} />`;
  const onlyText = el.children.every((c) => typeof c === 'string');
  if (onlyText) return `${indent}<${el.name}${attrs}>${escapeText(el.children.join(''))}</${el.name}>`;
  const inner = el.children
    .map((c) => (typeof c === 'string' ? `${indent}  ${escapeText(c.trim())}` : serializeElement(c, `${indent}  `)))
    .join('\n');
  return `${indent}<${el.name}${attrs}>\n${inner}\n${indent}</${el.name}>`;
}

export class XmltvWriter {
  constructor(file) {
    this.gzip = createGzip({ level: 9 });
    this.done = pipeline(this.gzip, createWriteStream(file));
    this.done.catch(() => {}); // surfaced by end()
  }

  async write(chunk) {
    if (!this.gzip.write(chunk)) await this.drain();
  }

  // Synchronous write for use inside parser callbacks; pair with drain() between chunks.
  writeElement(el) {
    return this.gzip.write(`${serializeElement(el)}\n`);
  }

  async drain() {
    if (this.gzip.writableNeedDrain) await once(this.gzip, 'drain');
  }

  async start() {
    await this.write(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="epg-remap">\n',
    );
  }

  async element(el) {
    await this.write(`${serializeElement(el)}\n`);
  }

  async end() {
    this.gzip.end('</tv>\n');
    await this.done;
  }

  async abort() {
    this.gzip.destroy();
    await this.done.catch(() => {});
  }
}
