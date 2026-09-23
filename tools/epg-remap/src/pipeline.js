import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadOverrides } from './config.js';
import { parseM3u, toPlaylistChannels } from './m3u.js';
import { matchChannels } from './matcher.js';
import { isEventChannel, placeholderChannelElement, placeholderProgrammes } from './placeholders.js';
import { buildReport } from './report.js';
import { getM3uUrl, makeRedactor } from './secrets.js';
import { fetchPlaylist, fetchSource } from './sources.js';
import { fetchXtreamEntries, parseXtreamUrl } from './xtream.js';
import { formatXmltvTime, parseXmltvTime } from './time.js';
import { parseEventName } from './events.js';
import { childTexts, openXmlFile, streamXmltv, XmltvWriter } from './xmltv.js';
import { validateXmltvFile } from './validate.js';

// One full generation. Any error thrown out of here has already been redacted.
export async function generate({ config, env = process.env, fetchImpl = fetch, now = new Date(), dryRun = false, log = () => {} }) {
  const m3uUrl = getM3uUrl(env);
  const redact = makeRedactor(m3uUrl);
  const safeLog = (msg) => log(redact(msg));
  try {
    return await run({ config, m3uUrl, fetchImpl, now, dryRun, log: safeLog });
  } catch (err) {
    throw new Error(redact(err));
  }
}

async function run({ config, m3uUrl, fetchImpl, now, dryRun, log }) {
  const { entries, stats: playlistStats } = await loadPlaylistWithFallback({ config, m3uUrl, fetchImpl, now, log });
  // Section separators ("#### MIAMI ####") are list decoration, not channels.
  const separatorRe = config.placeholderExclude ? new RegExp(config.placeholderExclude, 'i') : null;
  const playlistChannels = toPlaylistChannels(separatorRe ? entries.filter((e) => !separatorRe.test(e.name)) : entries);
  log(`playlist: ${playlistChannels.length} live channel ids`);

  // Pass 1: download (or revalidate) each source and collect its channels.
  const sources = [];
  const epgChannels = [];
  for (const [i, url] of config.sources.entries()) {
    log(`fetching ${url}`);
    const { file, note } = await fetchSource(url, {
      cacheDir: config.cacheDir,
      fetchImpl,
      timeoutMs: config.fetchTimeoutMs,
    });
    const seen = new Set();
    const stats = await streamXmltv(await openXmlFile(file), {
      onChannel: (el) => {
        const id = el.attrs.id;
        if (!id || seen.has(id)) return;
        seen.add(id);
        epgChannels.push({
          key: `${i}\u0000${id}`,
          id,
          source: i,
          displayNames: childTexts(el, 'display-name'),
          el,
        });
      },
    });
    if (!stats.sawTv) throw new Error(`${url} is not an XMLTV document`);
    sources.push({ url, file, note, channels: seen.size, programmes: 0 });
  }

  const overrides = await loadOverrides(config.overrides, { fetchImpl });
  const match = matchChannels(playlistChannels, epgChannels, overrides, {
    threshold: config.threshold,
    regionPreference: config.regionPreference,
    reviewFloor: config.reviewFloor,
  });

  const eventRe = new RegExp(config.eventPattern, 'i');
  const withoutGuide = [...match.unmatched, ...match.review.map((r) => r.playlist)];
  const eventChannels = withoutGuide.filter((p) => isEventChannel(p, eventRe));
  // Idle event slots ("UFC 09:", "NO EVENT STREAMING") get no rows unless asked for: they
  // would only say "No event scheduled" and make the file much larger.
  const keepIdle = config.emptyEventPlaceholders || !config.parseEventNames;
  const placeholders = keepIdle ? eventChannels : eventChannels.filter((p) => !parseEventName(p.name).empty);
  const eventIds = new Set(eventChannels.map((p) => p.id));
  const reportInput = {
    generatedAt: now,
    dryRun,
    playlistStats,
    playlistChannels: playlistChannels.length,
    sources,
    threshold: config.threshold,
    match,
    placeholders,
    idleEventSlots: eventChannels.length - placeholders.length,
    unmatchedNoPlaceholder: match.unmatched.filter((p) => !eventIds.has(p.id)),
    fallbackIds: playlistChannels.filter((p) => p.idFallback),
  };

  if (dryRun) {
    return { report: buildReport(reportInput), match, placeholders, unmatched: reportInput.unmatchedNoPlaceholder, output: null };
  }

  await mkdir(config.outDir, { recursive: true });
  const outFile = path.join(config.outDir, config.outputFile);
  const tmp = `${outFile}.tmp-${process.pid}`;
  const writer = new XmltvWriter(tmp);
  let output;
  try {
    output = await writeOutput({ writer, match, placeholders, sources, config, now });
    await writer.end();
  } catch (err) {
    await writer.abort();
    await rm(tmp, { force: true });
    throw err;
  }

  const validation = await validateXmltvFile(tmp);
  if (!validation.ok) {
    await rm(tmp, { force: true });
    throw new Error(`generated XMLTV failed validation; previous output kept:\n  ${validation.errors.join('\n  ')}`);
  }
  await rename(tmp, outFile);

  reportInput.output = output;
  const report = buildReport(reportInput);
  const reportFile = path.join(config.outDir, config.reportFile);
  await writeFile(`${reportFile}.tmp`, report);
  await rename(`${reportFile}.tmp`, reportFile);
  log(`wrote ${outFile}: ${output.channels} channels, ${output.programmes} programmes`);
  return { report, match, placeholders, unmatched: reportInput.unmatchedNoPlaceholder, output: { ...output, file: outFile, reportFile } };
}

// Provider panels go down. The last good channel list (names, ids, logos, groups: never
// stream URLs or credentials) is kept in the cache dir and reused for up to
// playlistCacheHours, so an outage doesn't stop the guide from refreshing.
export async function loadPlaylistWithFallback({ config, m3uUrl, fetchImpl, now, log = () => {} }) {
  const cacheFile = path.join(config.cacheDir, 'playlist-channels.json');
  try {
    const result = await loadPlaylist({ config, m3uUrl, fetchImpl, log });
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(`${cacheFile}.tmp`, JSON.stringify({ savedAt: now.toISOString(), ...result }));
    await rename(`${cacheFile}.tmp`, cacheFile);
    return result;
  } catch (err) {
    let cached;
    try {
      cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    } catch {
      throw err;
    }
    const ageHours = (now.getTime() - Date.parse(cached.savedAt)) / 3_600_000;
    if (!(ageHours <= config.playlistCacheHours)) throw err;
    log(`playlist unavailable (${err.message}); using channel list from ${cached.savedAt}`);
    return { entries: cached.entries, stats: { ...cached.stats, cachedFrom: cached.savedAt, cacheReason: err.message } };
  }
}

export async function loadPlaylist({ config, m3uUrl, fetchImpl, log = () => {} }) {
  const groupFilter = config.groupFilter ? new RegExp(config.groupFilter, 'i') : null;
  const xtream = config.playlistSource === 'm3u' ? null : parseXtreamUrl(m3uUrl);
  if (config.playlistSource === 'xtream' && !xtream) {
    throw new Error('playlistSource is xtream but M3U_URL has no get.php/player_api.php username and password');
  }
  if (xtream) {
    log('fetching playlist (Xtream API)');
    return fetchXtreamEntries(xtream, { fetchImpl, timeoutMs: config.fetchTimeoutMs, groupFilter });
  }
  log('fetching playlist (M3U)');
  const body = await fetchPlaylist(m3uUrl, { fetchImpl, timeoutMs: config.fetchTimeoutMs });
  const parsed = await parseM3u(body, { skipVod: config.skipVod });
  if (!groupFilter) return parsed;
  const entries = parsed.entries.filter((e) => groupFilter.test(e.group));
  return { entries, stats: { ...parsed.stats, groupFiltered: parsed.entries.length - entries.length } };
}

async function writeOutput({ writer, match, placeholders, sources, config, now }) {
  // epg key -> playlist ids it feeds (HD and SD playlist entries can share one EPG channel).
  const targets = new Map();
  for (const m of match.matched) {
    const ids = targets.get(m.epg.key) ?? [];
    ids.push(m.playlist);
    targets.set(m.epg.key, ids);
  }
  const out = { channels: 0, programmes: 0, droppedProgrammes: 0, outsideWindow: 0 };
  // Only listings a viewer will scroll to: a few hours back, guideDays ahead.
  const windowStart = now.getTime() - config.guidePastHours * 3_600_000;
  const windowEnd = now.getTime() + config.guideDays * 86_400_000;

  await writer.start();
  // All <channel> elements precede all <programme> elements, per the XMLTV DTD.
  for (const m of match.matched) {
    await writer.element(remappedChannel(m.epg.el, m.playlist));
    out.channels++;
  }
  for (const p of placeholders) {
    await writer.element(placeholderChannelElement(p));
    out.channels++;
  }

  // Pass 2: stream programmes, rewriting channel ids and timestamps.
  for (const [i, source] of sources.entries()) {
    if (!match.matched.some((m) => m.epg.source === i)) continue;
    const stats = await streamXmltv(await openXmlFile(source.file), {
      onProgramme: (el) => {
        const playlists = targets.get(`${i}\u0000${el.attrs.channel}`);
        if (!playlists) return;
        const startDate = parseXmltvTime(el.attrs.start);
        const hasTitle = el.children.some((c) => typeof c !== 'string' && c.name === 'title');
        if (!startDate || !hasTitle) {
          out.droppedProgrammes += playlists.length;
          return;
        }
        const stopDate = el.attrs.stop === undefined ? null : parseXmltvTime(el.attrs.stop);
        const endsBy = (stopDate ?? startDate).getTime();
        if (startDate.getTime() >= windowEnd || endsBy <= windowStart) {
          out.outsideWindow += playlists.length;
          return;
        }
        const attrs = { ...el.attrs, start: formatXmltvTime(startDate) };
        if (stopDate) attrs.stop = formatXmltvTime(stopDate);
        else delete attrs.stop;
        const children = config.slimProgrammes ? slimChildren(el.children) : el.children;
        for (const p of playlists) {
          writer.writeElement({ ...el, attrs: { ...attrs, channel: p.id }, children });
          out.programmes++;
        }
      },
      afterChunk: () => writer.drain(),
    });
    source.programmes = stats.programmes;
  }

  for (const p of placeholders) {
    for (const el of placeholderProgrammes(p, now, config.placeholderHours, config.placeholderSlotHours, {
      parseEvents: config.parseEventNames,
    })) {
      await writer.element(el);
      out.programmes++;
    }
  }
  return out;
}

// What a TV guide app shows. Everything else (cast lists, content ratings, star ratings,
// "previously shown" dates, series ids...) makes up a large part of the file for no visible gain.
const KEEP_CHILDREN = new Set(['title', 'sub-title', 'desc', 'category', 'icon', 'episode-num', 'date', 'new', 'live', 'premiere']);
const MAX_CATEGORIES = 2;

export function slimChildren(children) {
  let categories = 0;
  return children.filter((c) => {
    if (typeof c === 'string' || !KEEP_CHILDREN.has(c.name)) return false;
    if (c.name === 'category') return ++categories <= MAX_CATEGORIES;
    return true;
  });
}

// The EPG channel's children (names, icons, urls) under the playlist's id. The playlist's
// display name goes first so the guide shows the name the user knows.
export function remappedChannel(epgEl, playlist) {
  const children = [{ name: 'display-name', attrs: {}, children: [playlist.name] }];
  for (const c of epgEl.children) {
    if (typeof c === 'string') continue;
    if (c.name === 'display-name' && c.children.join('').trim() === playlist.name) continue;
    children.push(c);
  }
  return { name: 'channel', attrs: { ...epgEl.attrs, id: playlist.id }, children };
}
