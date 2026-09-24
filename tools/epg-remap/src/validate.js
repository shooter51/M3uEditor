import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import sax from 'sax';
import { OUTPUT_TS } from './time.js';

const MAX_ERRORS = 20;

// Strict re-parse of a generated file. Checks well-formedness plus the XMLTV rules that
// TiviMate depends on: channels declared before programmes, unique channel ids, every
// programme pointing at a declared channel, UTC timestamps, and a <title> on each programme.
export function validateXmltv(readable) {
  return new Promise((resolve) => {
    const parser = sax.createStream(true, {});
    const errors = [];
    const channelIds = new Set();
    const stack = [];
    let programmes = 0;
    let seenProgramme = false;
    let programme = null;
    let fatal = false;
    let sawRoot = false;

    const fail = (msg) => {
      if (errors.length < MAX_ERRORS) errors.push(msg);
    };

    parser.on('error', (err) => {
      fatal = true;
      fail(`XML not well-formed: ${err.message.split('\n')[0]}`);
      readable.destroy();
      finish();
    });
    parser.on('opentag', (node) => {
      stack.push(node.name);
      const a = node.attributes;
      if (stack.length === 1) sawRoot = true;
      if (stack.length === 1 && node.name !== 'tv') fail(`root element is <${node.name}>, expected <tv>`);
      if (stack.length !== 2) {
        if (programme && stack.length === 3 && node.name === 'title') programme.hasTitle = true;
        return;
      }
      if (node.name === 'channel') {
        if (seenProgramme) fail(`<channel id="${a.id}"> appears after a <programme>`);
        if (!a.id) fail('<channel> without id');
        else if (channelIds.has(a.id)) fail(`duplicate <channel id="${a.id}">`);
        else channelIds.add(a.id);
      } else if (node.name === 'programme') {
        seenProgramme = true;
        programmes++;
        programme = { channel: a.channel, hasTitle: false };
        if (!a.channel || !channelIds.has(a.channel)) fail(`<programme> for undeclared channel "${a.channel}"`);
        if (!OUTPUT_TS.test(a.start ?? '')) fail(`bad start "${a.start}" on channel "${a.channel}"`);
        if (a.stop !== undefined && !OUTPUT_TS.test(a.stop)) fail(`bad stop "${a.stop}" on channel "${a.channel}"`);
      }
    });
    parser.on('closetag', (name) => {
      stack.pop();
      if (name === 'programme' && stack.length === 1 && programme) {
        if (!programme.hasTitle) fail(`<programme> without <title> on channel "${programme.channel}"`);
        programme = null;
      }
    });
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (!sawRoot && !fatal) fail('document has no <tv> root');
      resolve({ ok: errors.length === 0 && !fatal, errors, channels: channelIds.size, programmes });
    };
    parser.on('end', finish);
    readable.on('error', (err) => {
      fail(`cannot read output: ${err.message}`);
      fatal = true;
      finish();
    });
    readable.pipe(parser);
  });
}

export function validateXmltvFile(gzFile) {
  const gunzip = createGunzip();
  const raw = createReadStream(gzFile);
  raw.on('error', (err) => gunzip.destroy(err));
  return validateXmltv(raw.pipe(gunzip));
}
