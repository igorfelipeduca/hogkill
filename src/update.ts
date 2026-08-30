import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A published release newer than the one running. */
export interface UpdateInfo {
  name: string;
  current: string;
  latest: string;
}

interface Cache {
  name: string;
  checkedAt: number;
  /** null when the last lookup failed — remembered so we stop retrying. */
  latest: string | null;
}

/** A day between lookups: releases are not that exciting. */
const FRESH_MS = 24 * 60 * 60 * 1000;
/** After a failed lookup back off an hour, not a full day. */
const RETRY_MS = 60 * 60 * 1000;
/** The registry is never worth waiting on — the process table is the point. */
const TIMEOUT_MS = 2500;
const MAX_BODY = 1024 * 1024;

/**
 * Looks up the newest published version, honouring a cache on disk.
 * Never throws and never rejects: a broken network is not a reason to fail.
 */
export async function checkForUpdate(name: string, current: string): Promise<UpdateInfo | null> {
  if (optedOut()) return null;
  try {
    const latest = await latestVersion(name);
    return latest && isNewer(latest, current) ? { name, current, latest } : null;
  } catch {
    return null;
  }
}

/** `NO_UPDATE_NOTIFIER` is the convention; `CI` because robots never upgrade. */
function optedOut(): boolean {
  return Boolean(
    process.env.HOGKILL_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER || process.env.CI,
  );
}

function registry(): string {
  const configured =
    process.env.HOGKILL_REGISTRY || process.env.npm_config_registry || 'https://registry.npmjs.org';
  return configured.replace(/\/+$/, '');
}

function cacheFile(): string {
  const home = homedir() || tmpdir();
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      : process.env.XDG_CACHE_HOME || join(home, '.cache');
  return join(base, 'hogkill', 'update-check.json');
}

async function latestVersion(name: string): Promise<string | null> {
  const now = Date.now();
  const cached = await readCache(name);
  if (cached) {
    const age = now - cached.checkedAt;
    // A negative age means the clock moved; treat it as stale rather than fresh forever.
    if (age >= 0 && age < (cached.latest ? FRESH_MS : RETRY_MS)) return cached.latest;
  }

  let latest: string | null = null;
  try {
    const body = (await getJson(`${registry()}/${encodeURIComponent(name)}/latest`)) as {
      version?: unknown;
    };
    if (typeof body.version === 'string') latest = body.version;
  } catch {
    latest = null;
  }

  await writeCache({ name, checkedAt: now, latest });
  return latest;
}

async function readCache(name: string): Promise<Cache | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), 'utf8')) as Partial<Cache>;
    if (parsed.name !== name || typeof parsed.checkedAt !== 'number') return null;
    const latest = typeof parsed.latest === 'string' ? parsed.latest : null;
    return { name, checkedAt: parsed.checkedAt, latest };
  } catch {
    return null;
  }
}

async function writeCache(cache: Cache): Promise<void> {
  try {
    const file = cacheFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache), 'utf8');
  } catch {
    // A cache we cannot write only costs one request per run.
  }
}

/**
 * A tiny GET. `fetch` would do, but it prints an experimental warning on Node 18
 * and 20 — straight onto the terminal the TUI is drawing on.
 */
function getJson(url: string, redirects = 2): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = send(
      target,
      {
        headers: {
          accept: 'application/vnd.npm.install-v1+json, application/json',
          'user-agent': `hogkill (+https://github.com/igorfelipeduca/hogkill)`,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirects <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          resolve(getJson(new URL(location, target).toString(), redirects - 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`registry answered ${status}`));
          return;
        }

        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_BODY) req.destroy(new Error('registry answered with too much'));
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error as Error);
          }
        });
        res.on('error', reject);
      },
    );

    // Quitting must not wait on the registry: an in-flight check never holds
    // the process open.
    req.on('socket', (socket) => socket.unref());

    // The socket timeout only covers idle time, so cap the whole exchange too.
    const deadline = setTimeout(() => req.destroy(new Error('registry timed out')), TIMEOUT_MS * 2);
    deadline.unref?.();
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('registry timed out')));
    req.on('error', reject);
    req.end();
  });
}

interface Version {
  parts: [number, number, number];
  pre: boolean;
}

function parseVersion(version: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/.exec(version.trim());
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] !== undefined && match[4].length > 0,
  };
}

/** Plain semver comparison. A prerelease on the registry is never an upgrade. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b || a.pre) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i]! > b.parts[i]!;
  }
  // Same numbers, but 1.2.0 does beat the 1.2.0-rc.1 you are running.
  return b.pre;
}
