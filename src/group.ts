import type { Group, Proc, RiskLevel, SortKey, Warning } from './types.js';
import { groupName } from './naming.js';
import { RISK_ORDER, worstRisk } from './risk.js';

export interface GroupOptions {
  minCpu: number;
  /** Bytes. */
  minMem: number;
  user: string | null;
  filter: string;
  /** Leave out anything the OS depends on, for people who only want their apps. */
  safeOnly: boolean;
}

/** Collapses the process table into one row per app, the way npkill folds paths. */
export function groupProcesses(procs: Proc[], options: GroupOptions): Group[] {
  const buckets = new Map<string, Proc[]>();

  for (const proc of procs) {
    if (options.user && proc.user !== options.user) continue;
    if (options.safeOnly && proc.risk !== 'none') continue;
    const key = `${proc.user} ${groupName(proc.command, proc.exe)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(proc);
    else buckets.set(key, [proc]);
  }

  const needle = options.filter.trim().toLowerCase();
  const groups: Group[] = [];

  for (const [key, members] of buckets) {
    const name = key.slice(key.indexOf(' ') + 1);
    if (needle && !matches(name, members, needle)) continue;

    let cpu = 0;
    let rss = 0;
    let risk: RiskLevel = 'none';
    let riskReason = '';
    for (const proc of members) {
      cpu += proc.cpu;
      rss += proc.rss;
      if (RISK_ORDER[proc.risk] > RISK_ORDER[risk]) {
        risk = proc.risk;
        riskReason = proc.riskReason;
      }
    }

    if (cpu < options.minCpu && rss < options.minMem) continue;

    members.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
    groups.push({
      key,
      name,
      procs: members,
      cpu: Math.round(cpu * 10) / 10,
      rss,
      user: members[0]!.user,
      risk,
      riskReason,
    });
  }

  return groups;
}

function matches(name: string, members: Proc[], needle: string): boolean {
  if (name.toLowerCase().includes(needle)) return true;
  return members.some(
    (proc) =>
      proc.command.toLowerCase().includes(needle) || String(proc.pid) === needle,
  );
}

export function sortGroups(groups: Group[], key: SortKey): Group[] {
  const sorted = [...groups];
  switch (key) {
    case 'cpu':
      sorted.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
      break;
    case 'mem':
      sorted.sort((a, b) => b.rss - a.rss || b.cpu - a.cpu);
      break;
    case 'count':
      sorted.sort((a, b) => b.procs.length - a.procs.length || b.rss - a.rss);
      break;
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }
  return sorted;
}

/** One warning per distinct consequence, worst first. */
export function collectWarnings(procs: Proc[]): Warning[] {
  const seen = new Map<string, Warning>();
  for (const proc of procs) {
    if (proc.risk === 'none') continue;
    const key = `${proc.risk}:${proc.riskReason}`;
    if (!seen.has(key)) {
      seen.set(key, { level: proc.risk, name: proc.name, reason: proc.riskReason });
    }
  }
  return [...seen.values()].sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level]);
}

export function highestRisk(procs: Proc[]): RiskLevel {
  return procs.reduce<RiskLevel>((worst, proc) => worstRisk(worst, proc.risk), 'none');
}
