/**
 * How much of the machine goes down with the process.
 * `own` is hogkill itself or the terminal it runs in.
 */
export type RiskLevel = 'none' | 'system' | 'own' | 'critical';

export interface RiskInfo {
  level: RiskLevel;
  reason: string;
}

export interface Proc {
  pid: number;
  ppid: number;
  /** Percentage of a single core. Instantaneous once two samples exist. */
  cpu: number;
  /** Resident set size in bytes. */
  rss: number;
  /** Total CPU seconds burned since the process started. */
  cpuSeconds: number;
  /** Wall-clock seconds since the process started. */
  elapsed: number;
  user: string;
  /** Full command line. */
  command: string;
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
