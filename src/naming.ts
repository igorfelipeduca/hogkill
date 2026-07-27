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
  'powershell',
  'pwsh',
  'cmd',
]);

const exeCache = new Map<string, string>();

/** Last path segment, for either separator, minus a Windows executable suffix. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const tail = cut === -1 ? path : path.slice(cut + 1);
  return tail.replace(/\.exe$/i, '');
}

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

/** The executable path, recovered from a command line. Used by the ps collector. */
export function executablePath(command: string): string {
  const cached = exeCache.get(command);
  if (cached !== undefined) return cached;

  const resolved = resolveExecutable(command);
  if (exeCache.size > 8192) exeCache.clear();
  exeCache.set(command, resolved);
  return resolved;
}

/** Outermost `.app` bundle in a path — `Google Chrome` for a Chrome Helper. */
export function appBundle(exe: string): string | null {
  const match = APP_BUNDLE.exec(exe);
  return match ? match[1]! : null;
}

/** First non-flag argument — the script an interpreter was pointed at. */
function scriptArgument(command: string, exe: string): string | null {
  const rest = command.startsWith(exe) ? command.slice(exe.length) : command;

  for (const part of rest.trim().split(/\s+/)) {
    // `-flag`, and the Windows `/c` style, but never an absolute POSIX path.
    if (!part || part.startsWith('-') || /^\/[a-zA-Z]$/.test(part)) continue;
    if (part.includes('=') && !part.includes('/') && !part.includes('\\')) continue;
    return baseName(part);
  }
  return null;
}

/** Short label for a single process. */
export function displayName(command: string, exe: string): string {
  const base = baseName(exe) || command;
  const bundle = appBundle(exe);

  if (bundle && bundle !== base) return `${base} — ${bundle}`;
  if (INTERPRETERS.has(base)) {
    const script = scriptArgument(command, exe);
    if (script) return `${base} ${script}`;
  }
  return base;
}

/** Label shared by every process that belongs to the same app. */
export function groupName(command: string, exe: string): string {
  const bundle = appBundle(exe);
  if (bundle) return bundle;

  const base = baseName(exe) || command;
  if (INTERPRETERS.has(base)) {
    const script = scriptArgument(command, exe);
    if (script) return `${base} ${script}`;
  }
  return base;
}
