import { cpus, platform } from 'node:os';
import type { Proc, RawProc } from '../types.js';
import { assessRisk } from '../risk.js';
import { displayName } from '../naming.js';
import { collect as collectPosix } from './posix.js';
import { collect as collectWindows } from './windows.js';

export const IS_WINDOWS = platform() === 'win32';

/** Windows exposes process ownership only at one CIM call per process. */
export const SUPPORTS_USERS = !IS_WINDOWS;

export const CORES = Math.max(1, cpus().length);

const MAX_CPU = CORES * 100;
const SMOOTHING = 0.6;

interface Prev {
  at: number;
  cpuSeconds: Map<number, number>;
  /** Smoothed CPU per pid, so the numbers stop flickering between refreshes. */
  smoothed: Map<number, number>;
}

const collect = IS_WINDOWS ? collectWindows : collectPosix;

/**
 * Turns whatever the platform reports into live CPU. Both `ps` and Win32_Process
 * only expose CPU time accumulated over a process's whole life, which says
 * nothing about what is hot right now, so this diffs it between two samples.
 */
export class ProcessSampler {
  private prev: Prev | null = null;

  async sample(): Promise<Proc[]> {
    const raw = await collect();
    const at = Date.now();
    const since = this.prev ? (at - this.prev.at) / 1000 : 0;

    const cpuSeconds = new Map<number, number>();
    const smoothed = new Map<number, number>();
    const procs: Proc[] = [];

    for (const row of raw) {
      cpuSeconds.set(row.pid, row.cpuSeconds);

      let cpu = row.fallbackCpu;
      const before = this.prev?.cpuSeconds.get(row.pid);
      if (before !== undefined && since > 0.2 && row.cpuSeconds >= before) {
        cpu = ((row.cpuSeconds - before) / since) * 100;
      }

      cpu = Math.min(MAX_CPU, Math.max(0, cpu));
      const previous = this.prev?.smoothed.get(row.pid);
      if (previous !== undefined) {
        cpu = previous * (1 - SMOOTHING) + cpu * SMOOTHING;
      }
      smoothed.set(row.pid, cpu);

      procs.push({
        ...row,
        cpu: Math.round(cpu * 10) / 10,
        name: displayName(row.command, row.exe),
        risk: 'none',
        riskReason: '',
      });
    }

    this.prev = { at, cpuSeconds, smoothed };
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

export type { RawProc };
