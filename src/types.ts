/**
 * How much of the machine goes down with the process.
 * `own` is hogkill itself or the terminal it runs in.
 */
export type RiskLevel = 'none' | 'system' | 'own' | 'critical';

export interface RiskInfo {
  level: RiskLevel;
  reason: string;
}

/** What a platform collector reports, before CPU is turned into a rate. */
export interface RawProc {
  pid: number;
  ppid: number;
  /** Resident set size in bytes. */
  rss: number;
  /** Total CPU seconds burned since the process started. */
  cpuSeconds: number;
  /** Wall-clock seconds since the process started. */
  elapsed: number;
  /** Empty on platforms that do not report ownership cheaply. */
  user: string;
  /** Full command line. */
  command: string;
  /** Path of the executable, resolved by the collector. */
  exe: string;
  /** Whatever CPU figure the platform offers before two samples exist. */
  fallbackCpu: number;
}

export interface Proc extends RawProc {
  /** Percentage of a single core. Instantaneous once two samples exist. */
  cpu: number;
  /** Short, human readable name. */
  name: string;
  risk: RiskLevel;
  /** Plain-language consequence of killing it. Empty when the risk is none. */
  riskReason: string;
}

export interface Warning {
  level: RiskLevel;
  name: string;
  reason: string;
}

export interface Group {
  key: string;
  name: string;
  procs: Proc[];
  cpu: number;
  rss: number;
  user: string;
  /** Worst risk level among the members. */
  risk: RiskLevel;
  /** Reason attached to the riskiest member. */
  riskReason: string;
}

export type SortKey = 'cpu' | 'mem' | 'count' | 'name';
