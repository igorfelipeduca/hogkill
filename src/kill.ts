export interface KillOptions {
  /** Skip SIGTERM and go straight to SIGKILL. */
  force: boolean;
  /** Milliseconds to wait before escalating a survivor to SIGKILL. */
  escalateAfter: number;
  dryRun: boolean;
}

export interface KillOutcome {
  pid: number;
  name: string;
  status: 'terminated' | 'killed' | 'survived' | 'denied' | 'gone' | 'dry-run';
  error?: string;
}

export interface KillTarget {
  pid: number;
  name: string;
  /** `own` targets — hogkill and its terminal — are always signalled last. */
  own?: boolean;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function send(pid: number, signal: NodeJS.Signals): 'sent' | 'gone' | 'denied' {
  try {
    process.kill(pid, signal);
    return 'sent';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    return 'denied';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SIGTERM first so apps can save state, SIGKILL only for what refuses to go.
 */
export async function killTargets(
  targets: KillTarget[],
  options: KillOptions,
): Promise<KillOutcome[]> {
  const outcomes = new Map<number, KillOutcome>();
  const pending: KillTarget[] = [];

  // Killing our own shell first would abort the batch halfway through.
  const ordered = [...targets].sort(
    (a, b) => Number(a.own ?? false) - Number(b.own ?? false),
  );

  for (const target of ordered) {
    if (options.dryRun) {
      outcomes.set(target.pid, { ...target, status: 'dry-run' });
      continue;
    }

    const signal: NodeJS.Signals = options.force ? 'SIGKILL' : 'SIGTERM';
    const result = send(target.pid, signal);
    if (result === 'gone') {
      outcomes.set(target.pid, { ...target, status: 'gone' });
    } else if (result === 'denied') {
      outcomes.set(target.pid, {
        ...target,
        status: 'denied',
        error: 'permission denied — rerun with sudo',
      });
    } else {
      outcomes.set(target.pid, {
        ...target,
        status: options.force ? 'killed' : 'terminated',
      });
      if (!options.force) pending.push(target);
    }
  }

  if (pending.length > 0 && options.escalateAfter > 0) {
    await sleep(options.escalateAfter);
    for (const target of pending) {
      if (!isAlive(target.pid)) continue;
      const result = send(target.pid, 'SIGKILL');
      outcomes.set(target.pid, {
        ...target,
        status: result === 'sent' ? 'killed' : 'survived',
        error: result === 'denied' ? 'permission denied — rerun with sudo' : undefined,
      });
    }
  }

  return [...outcomes.values()];
}

export function summarize(outcomes: KillOutcome[]): string {
  let down = 0;
  let denied = 0;
  let survived = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'terminated' || outcome.status === 'killed' || outcome.status === 'gone') down++;
    else if (outcome.status === 'denied') denied++;
    else if (outcome.status === 'survived') survived++;
  }

  const parts: string[] = [];
  if (down) parts.push(`${down} killed`);
  if (denied) parts.push(`${denied} denied (needs sudo)`);
  if (survived) parts.push(`${survived} survived`);
  if (outcomes.some((o) => o.status === 'dry-run')) {
    return `dry run — ${outcomes.length} process${outcomes.length === 1 ? '' : 'es'} would be killed`;
  }
  return parts.join(' · ') || 'nothing to kill';
}
