import { basename } from 'node:path';
import { statSync } from 'node:fs';

const APP_BUNDLE = /\/([^/]+)\.app\//;
const INTERPRETERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'php',
  'java',
  'dotnet',
  'sh',
  'bash',
  'zsh',
  'fish',
]);

const exeCache = new Map<string, string>();

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * `ps` joins argv with spaces, and macOS paths are full of spaces, so the
 * executable cannot be recovered by splitting. Walk the space boundaries and
 * keep the longest prefix that is a real file.
 */
function resolveExecutable(command: string): string {
  const chunks = command.split(' ');
  const first = chunks[0] ?? command;

  if (command.startsWith('/')) {
    let candidate = '';
    let longest = '';
    for (const chunk of chunks) {
      if (chunk.startsWith('-') && candidate) break;
      candidate = candidate ? `${candidate} ${chunk}` : chunk;
      if (isFile(candidate)) longest = candidate;
    }
    if (longest) return longest;

    // Deleted, renamed or unreadable: fall back to the first path-ish chunk.
    const bundle = APP_BUNDLE.exec(command);
    if (bundle) return command.slice(0, bundle.index + bundle[0].length - 1);
  }

  return first;
}

/** The executable path, i.e. the command line minus its arguments. */
export function executablePath(command: string): string {
  const cached = exeCache.get(command);
  if (cached !== undefined) return cached;

  const resolved = resolveExecutable(command);
  if (exeCache.size > 8192) exeCache.clear();
  exeCache.set(command, resolved);
  return resolved;
}

/** Outermost `.app` bundle in a path — `Google Chrome` for a Chrome Helper. */
export function appBundle(command: string): string | null {
  const match = APP_BUNDLE.exec(executablePath(command));
  return match ? match[1]! : null;
}

/** First non-flag argument — the script an interpreter was pointed at. */
function scriptArgument(command: string): string | null {
  const exe = executablePath(command);
  const rest = command.startsWith(exe) ? command.slice(exe.length) : command;

  for (const part of rest.trim().split(/\s+/)) {
    if (!part || part.startsWith('-')) continue;
    if (part.includes('=') && !part.includes('/')) continue;
    return basename(part);
  }
  return null;
}

/** Short label for a single process. */
export function displayName(command: string): string {
  const exe = basename(executablePath(command)) || command;
  const bundle = appBundle(command);

  if (bundle && bundle !== exe) return `${exe} — ${bundle}`;
  if (INTERPRETERS.has(exe)) {
    const script = scriptArgument(command);
    if (script) return `${exe} ${script}`;
  }
  return exe;
}

/** Label shared by every process that belongs to the same app. */
export function groupName(command: string): string {
  const bundle = appBundle(command);
  if (bundle) return bundle;

  const exe = basename(executablePath(command)) || command;
  if (INTERPRETERS.has(exe)) {
    const script = scriptArgument(command);
    if (script) return `${exe} ${script}`;
  }
  return exe;
}
