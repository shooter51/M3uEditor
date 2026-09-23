#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { generate } from './pipeline.js';
import { makeRedactor } from './secrets.js';
import { createEpgServer } from './server.js';

const USAGE = `Usage: epg-remap [options]

Rewrites public XMLTV EPG channel ids to your playlist's tvg-ids.
Reads the playlist URL from M3U_URL (environment or .env).
Optional env: PORT, EPG_ACCESS_TOKEN, EPG_REPORT_AUTH, EPG_REFRESH_HOURS,
EPG_THRESHOLD, EPG_REGION_PREFERENCE, EPG_GROUP_FILTER, EPG_PLAYLIST_SOURCE
(override config.json).

  -c, --config <file>   config file (default: ./config.json if present)
      --dry-run         print the match report, write nothing
      --serve           serve the guide over HTTP and regenerate on an interval
      --port <n>        HTTP port for --serve
      --host <addr>     bind address for --serve
      --out <dir>       output directory
      --env <file>      env file to load (default: ./.env if present)
  -h, --help            show this help
`;

export async function main(argv, deps = {}) {
  const {
    env = process.env,
    stdout = (s) => process.stdout.write(s),
    stderr = (s) => process.stderr.write(s),
    fetchImpl = fetch,
    loadEnvFile = process.loadEnvFile,
    onServerStarted = () => {},
  } = deps;

  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        config: { type: 'string', short: 'c' },
        'dry-run': { type: 'boolean' },
        serve: { type: 'boolean' },
        port: { type: 'string' },
        host: { type: 'string' },
        out: { type: 'string' },
        env: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }).values;
  } catch (err) {
    stderr(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    stdout(USAGE);
    return 0;
  }
  if (args['dry-run'] && args.serve) {
    stderr('--dry-run and --serve cannot be combined\n');
    return 2;
  }

  try {
    loadEnvFile(args.env ?? '.env');
  } catch (err) {
    if (args.env || err.code !== 'ENOENT') {
      stderr(`cannot load env file: ${err.code ?? err.message}\n`);
      return 2;
    }
  }

  const redact = makeRedactor(env.M3U_URL);
  const log = (msg) => stderr(`[${new Date().toISOString()}] ${redact(msg)}\n`);

  let config;
  try {
    config = await loadConfig(
      args.config ?? 'config.json',
      { ...envOverrides(env), port: args.port ?? env.PORT, host: args.host, outDir: args.out },
      { required: Boolean(args.config) },
    );
  } catch (err) {
    stderr(`${redact(err)}\n`);
    return 2;
  }

  const run = (dryRun) => generate({ config, env, fetchImpl, now: new Date(), dryRun, log });

  if (args.serve) {
    const epg = createEpgServer({ config, generate: () => run(false), log });
    try {
      await epg.start();
    } catch (err) {
      stderr(`cannot start server: ${redact(err)}\n`);
      return 1;
    }
    onServerStarted(epg);
    return new Promise((resolve) => {
      const shutdown = async () => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        log('shutting down');
        await epg.stop();
        resolve(0);
      };
      epg.shutdown = shutdown;
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  }

  try {
    const result = await run(Boolean(args['dry-run']));
    if (result.output) {
      const { matched, review } = result.match;
      const { unmatched } = result;
      stdout(
        `wrote ${result.output.file}\n` +
          `  ${result.output.channels} channels, ${result.output.programmes} programmes\n` +
          `  ${matched.length} matched, ${review.length} need review, ${unmatched.length} unmatched, ${result.placeholders.length} placeholders\n` +
          `  report: ${result.output.reportFile}\n`,
      );
    } else {
      stdout(result.report);
    }
    return 0;
  } catch (err) {
    stderr(`${redact(err)}\n`);
    return 1;
  }
}

// Settings that are handy to set from a PaaS environment panel instead of a mounted file.
export function envOverrides(env) {
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  return {
    accessToken: env.EPG_ACCESS_TOKEN || undefined,
    reportAuth: env.EPG_REPORT_AUTH || undefined,
    refreshHours: num(env.EPG_REFRESH_HOURS),
    threshold: num(env.EPG_THRESHOLD),
    regionPreference: env.EPG_REGION_PREFERENCE || undefined,
    groupFilter: env.EPG_GROUP_FILTER || undefined,
    playlistSource: env.EPG_PLAYLIST_SOURCE || undefined,
  };
}

/* v8 ignore start -- process entry point */
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
/* v8 ignore stop */
