import { execFile } from 'node:child_process';
import { cpus, platform } from 'node:os';
import { promisify } from 'node:util';
import type { Proc } from './types.js';
import { assessRisk } from './risk.js';
import { displayName } from './naming.js';

const run = promisify(execFile);

const FIELDS = 'pid=,ppid=,pcpu=,rss=,time=,etime=,user=,args=';
const LINE =
  /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;

const CORES = Math.max(1, cpus().length);
const MAX_CPU = CORES * 100;

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
  return platform() === 'darwin'
    ? ['-axwwo', FIELDS]
    : ['-eo', FIELDS, '-ww'];
}

interface Prev {
  at: number;
  cpuSeconds: Map<number, number>;
}

/**
 * Reads the process table. `ps` reports %CPU averaged over the whole lifetime
 * of a process, which is useless for spotting what is hot *right now*, so from
 * the second sample onward CPU is derived from the delta in consumed CPU time.
 */
export class ProcessSampler {
  private prev: Prev | null = null;

  async sample(): Promise<Proc[]> {
    const { stdout } = await run('ps', psArgs(), {
      maxBuffer: 32 * 1024 * 1024,
    });
    const at = Date.now();
    const elapsedSinceLast = this.prev ? (at - this.prev.at) / 1000 : 0;
    const cpuSeconds = new Map<number, number>();
    const procs: Proc[] = [];

    for (const line of stdout.split('\n')) {
      const match = LINE.exec(line);
      if (!match) continue;
      const [, pidRaw, ppidRaw, pcpuRaw, rssRaw, timeRaw, etimeRaw, user, command] =
        match as unknown as string[];

      const pid = Number(pidRaw);
      const cpuTime = parseClock(timeRaw!);
      cpuSeconds.set(pid, cpuTime);

      let cpu = Number(pcpuRaw);
      const before = this.prev?.cpuSeconds.get(pid);
      if (before !== undefined && elapsedSinceLast > 0.2 && cpuTime >= before) {
        cpu = ((cpuTime - before) / elapsedSinceLast) * 100;
      }
      cpu = Math.min(MAX_CPU, Math.max(0, Math.round(cpu * 10) / 10));

      procs.push({
        pid,
        ppid: Number(ppidRaw),
        cpu,
        rss: Number(rssRaw) * 1024,
        cpuSeconds: cpuTime,
        elapsed: parseClock(etimeRaw!),
        user: user!,
        command: command!,
        name: displayName(command!),
        risk: 'none',
        riskReason: '',
      });
    }

    this.prev = { at, cpuSeconds };
    markRisk(procs);
    return procs;
  }
}

/** Rates every process, including our own ancestry (the shell, the terminal). */
function markRisk(procs: Proc[]): void {
  const byPid = new Map<number, Proc>();
  for (const proc of procs) byPid.set(proc.pid, proc);

  const lineage = new Set<number>();
  let cursor: number | undefined = process.pid;
  while (cursor !== undefined && cursor > 0 && !lineage.has(cursor)) {
    lineage.add(cursor);
    cursor = byPid.get(cursor)?.ppid;
  }

  for (const proc of procs) {
    const risk = assessRisk(proc, lineage);
    proc.risk = risk.level;
    proc.riskReason = risk.reason;
  }
}

export { CORES };
