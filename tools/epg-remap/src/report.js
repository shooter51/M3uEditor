// Plaintext report. Contains channel names and ids only; never the playlist URL.

const pct = (n) => n.toFixed(3);

export function buildReport(r) {
  const lines = [];
  const h = (title, count) => {
    lines.push('', `== ${title} (${count}) ==`);
  };
  lines.push(`epg-remap report — ${r.generatedAt.toISOString()}${r.dryRun ? ' (dry run, nothing written)' : ''}`);
  const ps = r.playlistStats;
  const extras = [
    ps.categories !== undefined ? `${ps.categories} categories read` : null,
    ps.vodSkipped ? `${ps.vodSkipped} VOD skipped` : null,
    ps.adultSkipped ? `${ps.adultSkipped} adult skipped` : null,
    ps.groupFiltered ? `${ps.groupFiltered} outside group filter` : null,
  ].filter(Boolean);
  lines.push(`playlist: ${ps.total} entries${extras.length ? `, ${extras.join(', ')}` : ''}, ${r.playlistChannels} channel ids`);
  if (ps.cachedFrom) lines.push(`playlist: PROVIDER UNAVAILABLE (${ps.cacheReason}); using channel list saved ${ps.cachedFrom}`);
  for (const s of r.sources) {
    const progs = s.programmes ? `, ${s.programmes} programmes read` : '';
    lines.push(`source: ${s.url} — ${s.channels} channels${progs}${s.note ? ` [${s.note}]` : ''}`);
  }
  lines.push(`threshold: ${r.threshold}`);
  if (r.output) {
    lines.push(
      `output: ${r.output.channels} channels, ${r.output.programmes} programmes, ${r.output.droppedProgrammes} programmes dropped (bad timestamps), ${r.output.outsideWindow ?? 0} outside the guide window`,
    );
  }

  const sorted = [...r.match.matched].sort((a, b) => a.score - b.score || a.playlist.id.localeCompare(b.playlist.id));
  h('MATCHED', sorted.length);
  for (const m of sorted) {
    const flags = [m.method, m.tie ? 'tie' : null].filter(Boolean).join(', ');
    lines.push(`${pct(m.score)}  ${m.playlist.id}  "${m.playlist.name}"  ->  ${m.epg.id}  "${m.epg.displayNames[0] ?? ''}"  [${flags}]`);
  }

  h(`NEEDS REVIEW — best candidate below ${r.threshold}`, r.match.review.length);
  for (const m of [...r.match.review].sort((a, b) => b.score - a.score)) {
    lines.push(`${pct(m.score)}  ${m.playlist.id}  "${m.playlist.name}"  ?->  ${m.epg.id}  "${m.epg.displayNames[0] ?? ''}"`);
  }
  if (r.match.review.length) {
    lines.push('   (add accepted pairs to overrides.json: { "<playlist id>": "<epg id>" })');
  }

  h('PLACEHOLDER GUIDE (event channels)', r.placeholders.length);
  if (r.idleEventSlots) lines.push(`(${r.idleEventSlots} idle event slots with no event scheduled are left empty)`);
  for (const p of r.placeholders) lines.push(`${p.id}  "${p.name}"`);

  const unmatched = r.unmatchedNoPlaceholder;
  h('UNMATCHED PLAYLIST CHANNELS', unmatched.length);
  for (const p of unmatched) lines.push(`${p.id}  "${p.name}"${p.group ? `  [${p.group}]` : ''}`);

  h('UNUSED EPG CHANNELS', r.match.unusedEpg.length);
  for (const c of r.match.unusedEpg) lines.push(`${c.id}  "${c.displayNames[0] ?? ''}"`);

  const fallback = r.fallbackIds;
  h('NO tvg-id — FELL BACK TO NAME AS ID', fallback.length);
  for (const p of fallback) lines.push(`"${p.id}"`);

  h('BROKEN OVERRIDES — EPG id not found', r.match.brokenOverrides.length);
  for (const b of r.match.brokenOverrides) lines.push(`${b.playlistId}  ->  ${b.epgId}`);

  return `${lines.join('\n')}\n`;
}
