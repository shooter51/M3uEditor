# epg-remap

Rewrites public XMLTV guide data so its channel ids match your IPTV playlist's `tvg-id`s,
so TiviMate lines the guide up without hand-mapping. PPV and event channels that have no
guide data anywhere get placeholder programmes titled with the event name.

```
playlist (M3U_URL) ─┐
                    ├─ normalize names ─ match ─ rewrite ids ─ validate ─ epg.xml.gz + report.txt
epgshare01 feeds ───┘                      ▲
                               overrides.json (always wins)
```

## Setup

```bash
cd tools/epg-remap
npm ci
cp .env.example .env                 # put your real M3U_URL in here
cp config.example.json config.json   # optional; defaults are the same
```

**Xtream providers.** Many Xtream Codes panels block the `get.php` M3U download (it returns
odd statuses like 884) and only answer `player_api.php`, which is also what TiviMate uses
with an Xtream login. When `M3U_URL` is a `get.php` / `player_api.php` link with a username
and password, the tool reads live channels from the Xtream API instead. `epg_channel_id`
becomes the tvg-id, and adult streams are skipped. Set `playlistSource` to `m3u` to force
the plain download. With `groupFilter` (e.g. `^US[|]`) only matching categories are
requested, one at a time.

`M3U_URL` contains your provider credentials. It is only read from the environment or
`.env`. The tool never logs it, never writes it to disk, and strips it from error messages.
`.env`, `config.json` and `overrides.json` are git-ignored.

## Usage

```bash
node src/cli.js --dry-run     # print the match report, write nothing
node src/cli.js               # write out/epg.xml.gz and out/report.txt
node src/cli.js --serve       # serve over HTTP, regenerate every refreshHours
```

In serve mode:

| Path | What |
|---|---|
| `/epg.xml.gz` | the guide (point TiviMate here) |
| `/epg.xml` | same, uncompressed |
| `/report.txt` | the match report (basic auth if `reportAuth` is set) |
| `/healthz` | JSON status: last success, last error |

If `accessToken` is set, the guide and report paths move under it
(`/<token>/epg.xml.gz`, or just `/<token>` for the guide) and the bare paths return 404. A failed refresh keeps serving the
last good file.

## Matching

Names from both sides are normalized in the same way:

- casefold
- strip country prefixes (`US|`, `USA:`, `US-`)
- strip quality suffixes (HD/FHD/UHD/4K/SD)
- strip regional qualifiers (`(East)`, `(Pacific)`, a trailing `West`)
- strip the filler words `The` and `Channel`
- split on non-alphanumerics

Each playlist channel is scored against every EPG display name, and against the name
embedded in the EPG id (`ESPN.HD.us2` becomes "ESPN HD"). The score is a token-set
similarity.

- **Overrides** in `overrides.json` (`{ "playlist-tvg-id": "epg-channel-id" }`) always win.
  An override that points at a missing EPG id is listed in the report, and fuzzy matching
  runs instead.
- Matches **below `threshold`** (default 0.85) are never accepted. They go to the report's
  *NEEDS REVIEW* list with the best candidate, ready to copy into `overrides.json`.
- **Regional ties**: `HBO (East)` gets the East feed. A bare `HBO` gets `regionPreference`
  (default `west`), then an un-regioned feed.
- **HD/SD variants** that normalize the same all get the same guide data, one copy per
  playlist `tvg-id`.
- Channels with no `tvg-id` use their `tvg-name` (or display name) as the id. They are
  listed in the report.
- **Event channels** that don't match get 4-hour placeholder slots covering the next 24
  hours, titled with the display name. A channel counts as an event channel when its name
  or group matches `eventPattern` (default: PPV, EVENT, "vs", "@", "NN: ..."). Other
  unmatched channels stay empty and are listed in the report.
- VOD entries (`/movie/`, `/series/` URLs) are skipped.
- Provider decorations are ignored: platform tags (`AT&T:`, `TV:`, `RK:`), feed codes
  (`(A)`, `(D)`), and superscript tags like `ᴿᴬᵂ ⁶⁰ᶠᵖˢ` or `⁽ᴮᴷ⁾`.
- Guards on fuzzy matches. A candidate is never auto-accepted when:
  - a short brand token differs (`NBC` vs `CBS`);
  - the numbers differ (`Showtime` vs `Showtime 2`);
  - a playlist word has no close counterpart (`Bally Sports Arizona` vs
    `Arizona Family Sports`).

  Candidates scoring below `reviewFloor` (0.6) count as unmatched instead of cluttering
  the review list.
- Separator rows such as `##### PPV HD/4K #####` never get placeholders
  (`placeholderExclude`).

## Output guarantees

- Every `<channel id>` and `<programme channel>` is a playlist id. EPG channels that
  matched nothing are dropped.
- Timestamps are `YYYYMMDDHHMMSS +0000`. Offsets are converted to UTC. A programme with an
  unparseable `start` or no `<title>` is dropped and counted in the report.
- `<icon>`, `<desc>`, `<credits>` and other children are preserved.
- The file is written to a temp path, then re-parsed strictly and validated: channels
  before programmes, unique ids, no dangling references, UTC timestamps, titles present.
  Only then is it renamed into place. A failed validation keeps the previous file.

## Memory

The feeds run from 6 to 58 MB uncompressed. They are cached on disk in their compressed
form (with ETag / If-Modified-Since revalidation) and stream-parsed twice: once for
channels, once for programmes. Only the channel list stays in memory. Against the real
US2 and FANDUEL1 feeds (811 channels, about 84k programmes) a run takes about 3.5s with
peak RSS around 145 MB. The playlist is streamed and never cached.

## Configuration

See `config.example.json`. Paths in it are relative to the config file.

| Key | Default | |
|---|---|---|
| `sources` | US2 + FANDUEL1 | HTTPS only (plain http returns Cloudflare 520 on epgshare01) |
| `threshold` | `0.85` | minimum fuzzy score to auto-accept |
| `reviewFloor` | `0.6` | below this a candidate isn't listed for review |
| `playlistSource` | `auto` | `auto` / `m3u` / `xtream` |
| `groupFilter` | empty | regex on group-title / Xtream category name |
| `placeholderExclude` | separator rows | regex; event-looking names that get no placeholder |
| `regionPreference` | `west` | `west` / `east` / `none` for unqualified names |
| `overrides` | `overrides.json` | |
| `outDir` / `cacheDir` | `out` / `cache` | |
| `eventPattern` | see `src/config.js` | case-insensitive regex |
| `placeholderHours` / `placeholderSlotHours` | `24` / `4` | |
| `host` / `port` | `0.0.0.0` / `8080` | serve mode |
| `refreshHours` | `6` | the upstream feeds rebuild daily |
| `accessToken` | empty | secret path segment for the public URL |
| `reportAuth` | empty | `user:pass` basic auth on `/report.txt` |

## Deploying (KVM 8)

The VPS's Traefik (from the `permit` swarm stack) routes swarm services on the overlay network
`permit-net`, using the `websecure` entry point and the `letsencrypt` resolver. There's no
SSH, so the deploy goes through Hostinger's Docker Manager:

1. Create the Docker Manager project `epg-remap` from `deploy/hostinger-deployer.yml`, with
   these env values: `M3U_URL`, `EPG_ACCESS_TOKEN`, `EPG_GROUP_FILTER=^US[|]`,
   `EPG_REFRESH_HOURS=2`.
2. It runs once: it builds `epg-remap:<timestamp>` on the VPS from the `epg-remap` branch,
   then runs `docker stack deploy` for `deploy/stack.yml` as stack `epg`.
3. To ship a new version, push the branch and re-run the project.
4. Cloudflare DNS (outherehq.com zone): `A` record `epg` → `62.72.3.35` (DNS only until the certificate is
   issued).
5. TiviMate EPG source: `https://epg.outherehq.com/<EPG_ACCESS_TOKEN>`.

On a Dokploy host, use `docker-compose.dokploy.yml` instead. Without either, `docker compose up -d --build` with the plain `docker-compose.yml` runs
it on `127.0.0.1:8080` behind whatever proxy you have. It reads `M3U_URL` from `./.env`.

Env equivalents: `EPG_ACCESS_TOKEN`, `EPG_REPORT_AUTH`, `EPG_REFRESH_HOURS`, `EPG_THRESHOLD`,
`EPG_REGION_PREFERENCE`, `EPG_GROUP_FILTER`, `EPG_PLAYLIST_SOURCE`, `PORT`.
The same `EPG_*` variables work outside Docker too. They override `config.json` (see
`--help`).

## Tests

```bash
npm test
npm run coverage   # fails below 95% line coverage
```

Tests only use the committed fixtures in `test/fixtures` and make no network calls.
