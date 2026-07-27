import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import type { RawProc } from '../types.js';
import { executablePath } from '../naming.js';

const run = promisify(execFile);

const FIELDS = 'pid=,ppid=,pcpu=,rss=,time=,etime=,user=,args=';
const LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;

/** `[[dd-]hh:]mm:ss[.ff]` and bare seconds both land here. */
function parseClock(raw: string): number {
  let text = raw;
  let days = 0;
  const dash = text.indexOf('-');
  if (dash !== -1) {
    days = Number(text.slice(0, dash)) || 0;
    text = text.slice(dash + 1);
  }
  let seconds = 0;
  for (const part of text.split(':')) {
    seconds = seconds * 60 + (Number(part) || 0);
  }
  return days * 86400 + seconds;
}

function psArgs(): string[] {
  return platform() === 'darwin' ? ['-axwwo', FIELDS] : ['-eo', FIELDS, '-ww'];
}

export async function collect(): Promise<RawProc[]> {
  const { stdout } = await run('ps', psArgs(), { maxBuffer: 32 * 1024 * 1024 });
  const procs: RawProc[] = [];

  for (const line of stdout.split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, pid, ppid, pcpu, rss, cpuTime, etime, user, command] =
      match as unknown as string[];

    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rss: Number(rss) * 1024,
      cpuSeconds: parseClock(cpuTime!),
      elapsed: parseClock(etime!),
      user: user!,
      command: command!,
      exe: executablePath(command!),
      fallbackCpu: Number(pcpu),
    });
  }

  return procs;
}
