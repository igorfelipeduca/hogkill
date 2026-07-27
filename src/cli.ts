#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { userInfo } from 'node:os';
import type { Group, Proc, SortKey } from './types.js';
import { ProcessSampler, SUPPORTS_USERS } from './collect/index.js';
import { collectWarnings, groupProcesses, highestRisk, sortGroups } from './group.js';
import { RISK_TAG, riskTint } from './risk.js';
import { killTargets, summarize, type KillTarget } from './kill.js';
import { bytes, fit, padStart, paint, percent, setColor } from './format.js';
import { Ui } from './ui.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const SORTS: SortKey[] = ['cpu', 'mem', 'count', 'name'];

interface Options {
  sort: SortKey;
  interval: number;
  top: number;
  minCpu: number;
  minMem: number;
  user: string | null;
  filter: string;
  list: boolean;
  json: boolean;
  flat: boolean;
  kill: string | null;
  yes: boolean;
  force: boolean;
  dryRun: boolean;
  safeOnly: boolean;
  escalateAfter: number;
}

function usage(): string {
  const b = paint.bold;
  return `${b(paint.magenta('hogkill'))} ${paint.gray(`v${version}`)} — find and kill whatever is eating your machine

${b('USAGE')}
  hogkill                       interactive view, apps sorted by CPU
  hogkill -m                    same, sorted by memory
  hogkill --list --top 15       print the top 15 and exit
  hogkill --kill "Chrome" -y    kill every process of a matching app

${b('OPTIONS')}
  -s, --sort <key>       cpu | mem | count | name            (default: cpu)
  -m, --mem              shortcut for --sort mem
  -i, --interval <ms>    refresh rate                        (default: 1500)
  -n, --top <n>          rows to print in --list             (default: 20)
      --min-cpu <pct>    hide apps below this CPU%           (default: 0)
      --min-mem <mb>     hide apps below this memory         (default: 0)
  -u, --user <name>      only this user's processes
      --me               only your own processes
  -f, --filter <text>    only apps matching text
      --safe-only        hide everything the system depends on
  -l, --list             print once and exit, no TUI
      --flat             list individual processes, not apps
      --json             machine readable output (implies --list)
  -k, --kill <text>      non-interactive kill by name match
  -y, --yes              skip the confirmation prompt
  -9, --force            SIGKILL immediately, no SIGTERM first (no-op on Windows)
      --dry-run          show what would die, kill nothing
      --no-color         plain output
  -h, --help             this
  -v, --version          version

${b('RISK COLUMN')}
  ${paint.red('critical')}  the OS leans on it; killing it can freeze or log you out
  ${paint.yellow('system')}    a daemon the OS uses; part of it stops working until it restarts
  ${paint.cyan('you')}       hogkill itself, or the terminal it runs in
  ${paint.dim('hogkill never blocks a kill. It spells out the damage first, then obeys.')}

${b('KEYS')}
  ↑↓ / kj move    → expand app    space select    d kill    D force kill
  / filter        s cycle sort    c cpu   m mem   p pin order   ? help   q quit

  ${paint.dim('The list only re-ranks while the cursor sits at the top with nothing')}
  ${paint.dim('selected. Move, and rows hold still while the numbers keep updating.')}
`;
}

function fail(message: string): never {
  process.stderr.write(`${paint.red('hogkill:')} ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sort: 'cpu',
    interval: 1500,
    top: 20,
    minCpu: 0,
    minMem: 0,
    user: null,
    filter: '',
    list: false,
    json: false,
    flat: false,
    kill: null,
    yes: false,
    force: false,
    dryRun: false,
    safeOnly: false,
    escalateAfter: 4000,
  };

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) fail(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(usage());
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case '-v':
      case '--version':
        process.stdout.write(`${version}\n`);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case '-s':
      case '--sort': {
        const value = next(i++, arg) as SortKey;
        if (!SORTS.includes(value)) fail(`unknown sort "${value}" — use ${SORTS.join(', ')}`);
        options.sort = value;
        break;
      }
      case '-m':
      case '--mem':
        options.sort = 'mem';
        break;
      case '-i':
      case '--interval':
        options.interval = Math.max(250, Number(next(i++, arg)) || 1500);
        break;
      case '-n':
      case '--top':
        options.top = Math.max(1, Number(next(i++, arg)) || 20);
        break;
      case '--min-cpu':
        options.minCpu = Number(next(i++, arg)) || 0;
        break;
      case '--min-mem':
        options.minMem = (Number(next(i++, arg)) || 0) * 1024 * 1024;
        break;
      case '-u':
      case '--user':
        options.user = next(i++, arg);
        break;
      case '--me':
        options.user = userInfo().username;
        break;
      case '-f':
      case '--filter':
        options.filter = next(i++, arg);
        break;
      case '--safe-only':
        options.safeOnly = true;
        break;
      case '-l':
      case '--list':
        options.list = true;
        break;
      case '--flat':
        options.flat = true;
        break;
      case '--json':
        options.json = true;
        options.list = true;
        break;
      case '-k':
      case '--kill':
        options.kill = next(i++, arg);
        break;
      case '-y':
      case '--yes':
        options.yes = true;
        break;
      case '-9':
      case '--force':
        options.force = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-color':
        setColor(false);
        break;
      default:
        if (arg.startsWith('-')) fail(`unknown option "${arg}" — try --help`);
        options.filter = options.filter ? `${options.filter} ${arg}` : arg;
    }
  }

  return options;
}

async function collect(options: Options): Promise<Group[]> {
  const sampler = new ProcessSampler();
  await sampler.sample();
  // A second sample one beat later turns lifetime-average CPU into live CPU.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const procs = await sampler.sample();

  const groups = groupProcesses(procs, {
    minCpu: options.minCpu,
    minMem: options.minMem,
    user: options.user,
    filter: options.filter,
    safeOnly: options.safeOnly,
  });
  return sortGroups(groups, options.sort);
}

function printWarnings(procs: Proc[]): void {
  const warnings = collectWarnings(procs);
  if (warnings.length === 0) return;

  const risk = highestRisk(procs);
  const headline =
    risk === 'critical'
      ? paint.red(paint.bold('this batch includes critical system processes:'))
      : paint.yellow(paint.bold('this batch includes processes the system uses:'));
  process.stdout.write(`\n${headline}\n`);

  for (const warning of warnings) {
    const tag = riskTint(warning.level)(fit(RISK_TAG[warning.level], 9));
    process.stdout.write(`  ${tag} ${warning.name} ${paint.gray(`— ${warning.reason}`)}\n`);
  }
  process.stdout.write('\n');
}

function printList(groups: Group[], options: Options): void {
  if (options.json) {
    const payload = groups.slice(0, options.top).map((group) => ({
      name: group.name,
      user: group.user,
      cpu: group.cpu,
      rss: group.rss,
      risk: group.risk,
      riskReason: group.riskReason,
      processes: group.procs.map((proc) => ({
        pid: proc.pid,
        cpu: proc.cpu,
        rss: proc.rss,
        elapsed: proc.elapsed,
        risk: proc.risk,
        riskReason: proc.riskReason,
        command: proc.command,
      })),
    }));
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const width = Math.max(60, process.stdout.columns || 100);
  const nameWidth = Math.max(16, width - (SUPPORTS_USERS ? 47 : 37));
  process.stdout.write(
    `${paint.gray(`${fit('NAME', nameWidth)}${padStart('CPU', 7)}${padStart('MEMORY', 11)}${padStart('PROCS', 6)}  ${fit('RISK', 9)}${SUPPORTS_USERS ? 'USER' : ''}`)}\n`,
  );

  const shown = groups.slice(0, options.top);
  for (const group of shown) {
    const tag = riskTint(group.risk)(fit(RISK_TAG[group.risk], 9));
    process.stdout.write(
      `${fit(group.name, nameWidth)}${padStart(percent(group.cpu), 7)}${padStart(bytes(group.rss), 11)}${padStart(String(group.procs.length), 6)}  ${tag}${group.user}\n`,
    );

    if (!options.flat) continue;
    for (const proc of group.procs) {
      const procTag = riskTint(proc.risk)(fit(RISK_TAG[proc.risk], 9));
      process.stdout.write(
        `${paint.gray(`  ${fit(`${proc.pid} ${proc.name}`, nameWidth - 2)}${padStart(percent(proc.cpu), 7)}${padStart(bytes(proc.rss), 11)}${' '.repeat(8)}`)}${procTag}\n`,
      );
    }
  }

  if (shown.some((group) => group.risk !== 'none')) {
    process.stdout.write(
      paint.gray(`\nrisk: what breaks if you kill it — run with --json to read the reason\n`),
    );
  }
}

async function runKill(groups: Group[], options: Options): Promise<number> {
  const needle = options.kill!.toLowerCase();
  const matched = groups.filter(
    (group) =>
      group.name.toLowerCase().includes(needle) ||
      group.procs.some((proc) => proc.command.toLowerCase().includes(needle)),
  );

  // The pattern also lives in hogkill's own argv, so never match ourselves.
  const batches = matched
    .map((group) => ({ group, procs: group.procs.filter((proc) => proc.risk !== 'own') }))
    .filter((batch) => batch.procs.length > 0);

  const procs = batches.flatMap((batch) => batch.procs);
  if (procs.length === 0) {
    process.stderr.write(`${paint.yellow('no match for')} "${options.kill}"\n`);
    return 1;
  }

  const reclaimed = procs.reduce((sum, proc) => sum + proc.rss, 0);
  process.stdout.write(
    `${paint.bold('about to kill')} ${procs.length} process${procs.length === 1 ? '' : 'es'} · ${bytes(reclaimed)}\n`,
  );
  for (const batch of batches) {
    const count = batch.procs.length;
    const size = batch.procs.reduce((sum, proc) => sum + proc.rss, 0);
    const tag = riskTint(batch.group.risk)(fit(RISK_TAG[batch.group.risk], 9));
    process.stdout.write(
      `  ${tag} ${batch.group.name} ${paint.gray(`— ${count} proc${count === 1 ? '' : 's'}, ${bytes(size)}`)}\n`,
    );
  }

  printWarnings(procs);

  if (!options.yes && !options.dryRun) {
    if (!process.stdin.isTTY) fail('refusing to kill without --yes when stdin is not a terminal');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`${paint.red('proceed?')} [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      process.stdout.write('cancelled\n');
      return 130;
    }
  }

  const targets: KillTarget[] = procs.map((proc) => ({
    pid: proc.pid,
    name: `${proc.name} (${proc.pid})`,
  }));
  const outcomes = await killTargets(targets, {
    force: options.force,
    escalateAfter: options.force ? 0 : options.escalateAfter,
    dryRun: options.dryRun,
  });
  const subject =
    batches.length === 1 ? batches[0]!.group.name : `${batches.length} apps`;
  process.stdout.write(`${summarize(outcomes, subject)}\n`);
  return outcomes.some((outcome) => outcome.status === 'denied' || outcome.status === 'survived') ? 1 : 0;
}

async function main(): Promise<void> {
  if (!process.stdout.isTTY) setColor(false);

  const options = parseArgs(process.argv.slice(2));
  if (options.user !== null && !SUPPORTS_USERS) {
    fail('--user and --me need process ownership, which Windows does not report cheaply');
  }

  if (options.kill !== null) {
    process.exit(await runKill(await collect(options), options));
  }

  if (options.list || !process.stdout.isTTY || !process.stdin.isTTY) {
    printList(await collect(options), options);
    return;
  }

  const ui = new Ui({
    interval: options.interval,
    sort: options.sort,
    minCpu: options.minCpu,
    minMem: options.minMem,
    user: options.user,
    filter: options.filter,
    safeOnly: options.safeOnly,
    dryRun: options.dryRun,
    escalateAfter: options.escalateAfter,
  });
  await ui.start();
}

main().catch((error: unknown) => {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  fail((error as Error).message);
});
