import { freemem, loadavg, totalmem } from 'node:os';
import type { Group, Proc, RiskLevel, SortKey, Warning } from './types.js';
import { CORES, ProcessSampler } from './ps.js';
import { collectWarnings, groupProcesses, highestRisk, sortGroups } from './group.js';
import { killTargets, summarize, type KillTarget } from './kill.js';
import { RISK_WORD, riskMark } from './risk.js';
import {
  bar,
  bytes,
  duration,
  fit,
  heat,
  padStart,
  paint,
  percent,
  truncate,
  visibleLength,
} from './format.js';

export interface UiOptions {
  interval: number;
  sort: SortKey;
  minCpu: number;
  minMem: number;
  user: string | null;
  filter: string;
  safeOnly: boolean;
  dryRun: boolean;
  escalateAfter: number;
}

type Row =
  | { kind: 'group'; id: string; group: Group }
  | { kind: 'proc'; id: string; group: Group; proc: Proc };

type Mode = 'list' | 'filter' | 'confirm' | 'help';

interface Confirm {
  targets: KillTarget[];
  label: string;
  force: boolean;
  risk: RiskLevel;
  warnings: Warning[];
}

const SORT_CYCLE: SortKey[] = ['cpu', 'mem', 'count', 'name'];
const TOTAL_MEM = totalmem();

export class Ui {
  private readonly sampler = new ProcessSampler();
  private readonly expanded = new Set<string>();
  private readonly selected = new Set<string>();

  private groups: Group[] = [];
  private rows: Row[] = [];
  private procCount = 0;
  private mode: Mode = 'list';
  private sort: SortKey;
  private filter = '';
  private filterDraft = '';
  private cursor = 0;
  private offset = 0;
  private toast = '';
  private toastUntil = 0;
  private confirm: Confirm | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;
  private resolveExit: (() => void) | null = null;

  constructor(private readonly options: UiOptions) {
    this.sort = options.sort;
    this.filter = options.filter;
    this.filterDraft = options.filter;
  }

  async start(): Promise<void> {
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this.onKey);
    process.stdout.on('resize', this.onResize);
    process.on('SIGINT', this.onSigint);

    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.options.interval);

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private readonly onResize = () => this.render();

  private readonly onSigint = () => this.quit();

  private quit(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    process.stdin.off('data', this.onKey);
    process.stdout.off('resize', this.onResize);
    process.off('SIGINT', this.onSigint);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    this.resolveExit?.();
  }

  private async refresh(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const procs = await this.sampler.sample();
      this.procCount = procs.length;
      const grouped = groupProcesses(procs, {
        minCpu: this.options.minCpu,
        minMem: this.options.minMem,
        user: this.options.user,
        filter: this.filter,
        safeOnly: this.options.safeOnly,
      });
      this.groups = sortGroups(grouped, this.sort);
      this.rebuildRows();
      this.render();
    } catch (error) {
      this.flash(`sample failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Keeps the cursor on the same entry across refreshes and re-sorts. */
  private rebuildRows(): void {
    const anchor = this.rows[this.cursor]?.id;
    const rows: Row[] = [];
    for (const group of this.groups) {
      rows.push({ kind: 'group', id: `g:${group.key}`, group });
      if (this.expanded.has(group.key)) {
        for (const proc of group.procs) {
          rows.push({ kind: 'proc', id: `p:${proc.pid}`, group, proc });
        }
      }
    }
    this.rows = rows;

    if (anchor) {
      const found = rows.findIndex((row) => row.id === anchor);
      if (found !== -1) this.cursor = found;
    }
    this.cursor = Math.max(0, Math.min(this.cursor, rows.length - 1));
  }

  private flash(message: string): void {
    this.toast = message;
    this.toastUntil = Date.now() + 5000;
    this.render();
  }

  private readonly onKey = (input: string) => {
    for (const key of splitKeys(input)) this.handleKey(key);
  };

  private handleKey(key: string): void {
    if (key === '\x03') {
      this.quit();
      return;
    }

    if (this.mode === 'filter') {
      this.handleFilterKey(key);
      return;
    }

    if (this.mode === 'confirm') {
      this.handleConfirmKey(key);
      return;
    }

    if (this.mode === 'help') {
      this.mode = 'list';
      this.render();
      return;
    }

    switch (key) {
      case 'q':
      case '\x1b':
        this.quit();
        return;
      case 'j':
      case '\x1b[B':
        this.move(1);
        break;
      case 'k':
      case '\x1b[A':
        this.move(-1);
        break;
      case '\x1b[6~':
        this.move(this.viewportHeight());
        break;
      case '\x1b[5~':
        this.move(-this.viewportHeight());
        break;
      case 'g':
        this.cursor = 0;
        break;
      case 'G':
        this.cursor = Math.max(0, this.rows.length - 1);
        break;
      case 'l':
      case '\x1b[C':
      case '\r':
      case '\n':
        this.toggleExpand(true);
        break;
      case 'h':
      case '\x1b[D':
        this.toggleExpand(false);
        break;
      case ' ':
        this.toggleSelect();
        break;
      case 'a':
        this.selectAllVisible();
        break;
      case 'x':
        this.selected.clear();
        break;
      case 'd':
        this.requestKill(false);
        return;
      case 'D':
        this.requestKill(true);
        return;
      case 's':
        this.reorder(SORT_CYCLE[(SORT_CYCLE.indexOf(this.sort) + 1) % SORT_CYCLE.length]!);
        break;
      case 'c':
        this.reorder('cpu');
        break;
      case 'm':
        this.reorder('mem');
        break;
      case '/':
        this.mode = 'filter';
        this.filterDraft = this.filter;
        break;
      case 'r':
        void this.refresh();
        return;
      case '?':
        this.mode = 'help';
        break;
      default:
        return;
    }
    this.render();
  }

  private reorder(sort: SortKey): void {
    this.sort = sort;
    this.groups = sortGroups(this.groups, sort);
    this.rebuildRows();
  }

  private handleFilterKey(key: string): void {
    if (key === '\r' || key === '\n') {
      this.mode = 'list';
    } else if (key === '\x1b') {
      this.mode = 'list';
      this.filterDraft = this.filter;
    } else if (key === '\x7f' || key === '\b') {
      this.filterDraft = this.filterDraft.slice(0, -1);
    } else if (key >= ' ' && key.length === 1) {
      this.filterDraft += key;
    } else {
      return;
    }

    if (this.filterDraft !== this.filter) {
      this.filter = this.filterDraft;
      this.cursor = 0;
      void this.refresh();
    }
    this.render();
  }

  private handleConfirmKey(key: string): void {
    const pending = this.confirm;
    if (!pending) {
      this.mode = 'list';
      return;
    }

    if (key === 'y' || key === 'Y' || key === '\r' || key === '\n') {
      void this.executeKill(pending);
    } else if (key === 'k' || key === 'K') {
      void this.executeKill({ ...pending, force: true });
    } else {
      this.confirm = null;
      this.mode = 'list';
      this.render();
    }
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
  }

  private toggleExpand(open: boolean): void {
    const row = this.rows[this.cursor];
    if (!row) return;
    const key = row.group.key;
    if (open) {
      if (row.kind === 'proc') return;
      this.expanded.add(key);
    } else if (row.kind === 'proc') {
      this.expanded.delete(key);
      const parent = this.rows.findIndex((entry) => entry.id === `g:${key}`);
      if (parent !== -1) this.cursor = parent;
    } else {
      this.expanded.delete(key);
    }
    this.rebuildRows();
  }

  private toggleSelect(): void {
    const row = this.rows[this.cursor];
    if (!row) return;
    if (this.selected.has(row.id)) this.selected.delete(row.id);
    else this.selected.add(row.id);
    this.move(1);
  }

  private selectAllVisible(): void {
    for (const row of this.rows) {
      if (row.kind === 'group') this.selected.add(row.id);
    }
  }

  private procsFor(rows: Row[]): Proc[] {
    const procs = new Map<number, Proc>();
    for (const row of rows) {
      if (row.kind === 'group') {
        for (const proc of row.group.procs) procs.set(proc.pid, proc);
      } else {
        procs.set(row.proc.pid, row.proc);
      }
    }
    return [...procs.values()];
  }

  private requestKill(force: boolean): void {
    const chosen = this.rows.filter((row) => this.selected.has(row.id));
    const current = this.rows[this.cursor];
    const rows = chosen.length > 0 ? chosen : current ? [current] : [];
    if (rows.length === 0) return;

    const procs = this.procsFor(rows);
    if (procs.length === 0) return;

    const reclaimed = procs.reduce((sum, proc) => sum + proc.rss, 0);
    const count = `${procs.length} process${procs.length === 1 ? '' : 'es'}`;
    const label =
      rows.length === 1 && rows[0]!.kind === 'group'
        ? `${rows[0]!.group.name} · ${count} · ${bytes(reclaimed)}`
        : `${count} · ${bytes(reclaimed)}`;

    this.confirm = {
      targets: procs.map((proc) => ({
        pid: proc.pid,
        name: `${proc.name} (${proc.pid})`,
        own: proc.risk === 'own',
      })),
      label,
      force,
      risk: highestRisk(procs),
      warnings: collectWarnings(procs),
    };
    this.mode = 'confirm';
    this.render();
  }

  private async executeKill(pending: Confirm): Promise<void> {
    this.confirm = null;
    this.mode = 'list';
    this.toast = `killing ${pending.targets.length}…`;
    this.toastUntil = Date.now() + 10000;
    this.render();

    const outcomes = await killTargets(pending.targets, {
      force: pending.force,
      escalateAfter: pending.force ? 0 : this.options.escalateAfter,
      dryRun: this.options.dryRun,
    });

    this.selected.clear();
    this.flash(summarize(outcomes));
    await this.refresh();
  }

  /** Title, rule, column header, bottom rule and however many status lines. */
  private chromeHeight(width: number): number {
    return 4 + this.statusLines(width).length;
  }

  private viewportHeight(): number {
    const width = Math.max(40, process.stdout.columns || 80);
    return Math.max(1, (process.stdout.rows || 24) - this.chromeHeight(width));
  }

  private render(): void {
    if (this.stopped) return;
    const width = Math.max(40, process.stdout.columns || 80);
    const height = Math.max(10, process.stdout.rows || 24);
    const status = this.statusLines(width);
    const body = Math.max(1, height - 4 - status.length);

    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + body) this.offset = this.cursor - body + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - body)));

    const lines: string[] = [];
    lines.push(...this.header(width));
    lines.push(this.columns(width));

    if (this.mode === 'help') {
      lines.push(...this.helpBody(width, body));
    } else {
      const slice = this.rows.slice(this.offset, this.offset + body);
      slice.forEach((row, index) => {
        lines.push(this.renderRow(row, width, this.offset + index === this.cursor));
      });
      for (let i = slice.length; i < body; i++) {
        lines.push(this.rows.length === 0 && i === 0 ? paint.dim('  nothing matches') : '');
      }
    }

    lines.push(paint.gray('─'.repeat(width)));
    lines.push(...status);

    const frame = lines
      .slice(0, height)
      .map((line) => `${line}\x1b[K`)
      .join('\n');
    process.stdout.write(`\x1b[H${frame}\x1b[J`);
  }

  private header(width: number): string[] {
    const used = TOTAL_MEM - freemem();
    const busy = this.groups.reduce((sum, group) => sum + group.cpu, 0);
    const cpuRatio = busy / (CORES * 100);
    const memRatio = used / TOTAL_MEM;
    const load = loadavg()[0]!.toFixed(2);

    const title = paint.bold(paint.magenta('hogkill'));
    const right = paint.gray(`sort ${this.sort}${this.filter ? ` · /${this.filter}` : ''}`);

    // Least useful stat goes first: on a narrow terminal the tail gets dropped
    // rather than truncated, so sort and filter stay readable.
    const stats = [
      `${this.procCount} procs`,
      `${heat(cpuRatio * 100, 50, 80)(`cpu ${percent(cpuRatio * 100)}`)} ${paint.gray(bar(cpuRatio, 10))}`,
      `${heat(memRatio * 100, 70, 88)(`ram ${bytes(used)}/${bytes(TOTAL_MEM)}`)} ${paint.gray(bar(memRatio, 10))}`,
      paint.gray(`load ${load}`),
    ];

    let left = `${title}  ${stats.join(paint.gray(' · '))}`;
    while (stats.length > 1 && visibleLength(left) + visibleLength(right) + 2 > width) {
      stats.pop();
      left = `${title}  ${stats.join(paint.gray(' · '))}`;
    }

    const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
    return [truncate(`${left}${' '.repeat(gap)}${right}`, width), paint.gray('─'.repeat(width))];
  }

  private layout(width: number) {
    const withBars = width >= 96;
    // Rows stop one column short so a full-width line never wraps.
    const fixed = 4 + 8 + 11 + 8 + 1 + 12 + (withBars ? 14 : 0);
    return { withBars, name: Math.max(12, width - 1 - fixed) };
  }

  private columns(width: number): string {
    const { withBars, name } = this.layout(width);
    const spacer = ` ${' '.repeat(6)}`;
    const parts = [
      '    ',
      fit('NAME', name),
      padStart('CPU', 8),
      withBars ? spacer : '',
      padStart('MEMORY', 11),
      withBars ? spacer : '',
      padStart('PROCS', 8),
      ' ',
      fit('USER', 12),
    ];
    return paint.gray(parts.join(''));
  }

  private renderRow(row: Row, width: number, active: boolean): string {
    const { withBars, name } = this.layout(width);
    const isGroup = row.kind === 'group';
    const cpu = isGroup ? row.group.cpu : row.proc.cpu;
    const rss = isGroup ? row.group.rss : row.proc.rss;
    const risk = isGroup ? row.group.risk : row.proc.risk;
    const marked = this.selected.has(row.id);

    const marker = marked ? paint.red('◉') : active ? paint.cyan('›') : ' ';
    const caret = isGroup
      ? row.group.procs.length > 1
        ? this.expanded.has(row.group.key)
          ? '▾ '
          : '▸ '
        : '  '
      : '├ ';

    const label = isGroup
      ? row.group.name
      : `${padStart(String(row.proc.pid), 7)} ${row.proc.name}`;
    const nameCell = fit(`${caret}${label}`, name);

    const cpuRatio = cpu / (CORES * 100);
    const memRatio = rss / TOTAL_MEM;
    const extra = isGroup
      ? padStart(String(row.group.procs.length), 8)
      : padStart(duration(row.proc.elapsed), 8);
    const userCell = fit(isGroup ? row.group.user : row.proc.user, 12);

    const cells = [
      ` ${marker}${riskMark(risk)} `,
      isGroup ? nameCell : paint.gray(nameCell),
      heat(cpu, 60, 150)(padStart(percent(cpu), 8)),
      withBars ? ` ${paint.gray(bar(cpuRatio, 6))}` : '',
      heat(memRatio * 100, 8, 20)(padStart(bytes(rss), 11)),
      withBars ? ` ${paint.gray(bar(memRatio, 6))}` : '',
      paint.gray(extra),
      ' ',
      paint.gray(userCell),
    ].join('');

    return active ? highlight(cells) : cells;
  }

  private helpBody(width: number, height: number): string[] {
    const rows = [
      '',
      `  ${paint.bold('navigate')}  ↑↓ / kj move · →← / lh expand · g G top/bottom · PgUp PgDn page`,
      '',
      `  ${paint.bold('act')}       space select · a select all · x clear selection`,
      '            d kill (SIGTERM, then SIGKILL if it hangs on)',
      '            D kill now (SIGKILL)',
      '',
      `  ${paint.bold('view')}      / filter · s cycle sort · c cpu · m memory · r refresh · q quit`,
      '',
      `  ${paint.bold('risk')}      ${paint.red('▲')} critical — the OS leans on it; can freeze or log you out`,
      `            ${paint.yellow('▲')} system — part of the OS stops working until it restarts`,
      `            ${paint.cyan('◆')} hogkill itself, or the terminal it runs in`,
      '',
      `  ${paint.dim('hogkill never refuses a kill — it shows the cost, then obeys.')}`,
      '',
      `  ${paint.dim('press any key to go back')}`,
    ];
    return rows.slice(0, height).map((line) => truncate(line, width));
  }

  /** The bottom block: warnings first, then the prompt or hints. */
  private statusLines(width: number): string[] {
    if (this.mode === 'confirm' && this.confirm) {
      const lines: string[] = [];
      const { warnings, risk } = this.confirm;

      for (const warning of warnings.slice(0, 3)) {
        const mark = riskMark(warning.level);
        const tint = warning.level === 'critical' ? paint.red : warning.level === 'own' ? paint.cyan : paint.yellow;
        lines.push(truncate(`  ${mark} ${tint(warning.name)} ${paint.gray(`— ${warning.reason}`)}`, width));
      }
      if (warnings.length > 3) {
        lines.push(paint.gray(`  …and ${warnings.length - 3} more risky processes in this batch`));
      }

      const verb = this.confirm.force ? paint.red('SIGKILL') : 'SIGTERM';
      const prefix = this.options.dryRun ? paint.yellow('[dry run] ') : '';
      const headline =
        risk === 'none' ? paint.bold('kill') : paint.red(paint.bold(`kill ${RISK_WORD[risk]}`));
      const prompt = `${prefix}${headline} ${this.confirm.label} · ${verb}?`;
      const keys = `${paint.green('y')} yes · ${paint.red('K')} force · ${paint.gray('n')} cancel`;

      // The answer keys must never be the part that gets cut off.
      if (visibleLength(prompt) + visibleLength(keys) + 2 <= width) {
        lines.push(`${prompt}  ${keys}`);
      } else {
        lines.push(truncate(prompt, width), keys);
      }
      return lines;
    }

    if (this.mode === 'filter') {
      return [
        truncate(
          `${paint.cyan('/')}${this.filterDraft}${paint.inverse(' ')}  ${paint.gray('enter to keep · esc to clear')}`,
          width,
        ),
      ];
    }

    if (this.toast && Date.now() < this.toastUntil) {
      return [truncate(paint.yellow(this.toast), width)];
    }

    const selection = this.selected.size > 0 ? paint.red(`${this.selected.size} selected  `) : '';
    const hints = paint.gray(
      '↑↓ move · → expand · space select · d kill · D force · / filter · s sort · ? help · q quit',
    );
    return [truncate(`${selection}${hints}`, width)];
  }
}

function highlight(line: string): string {
  return `\x1b[48;5;236m${line.replace(/\x1b\[0m/g, '\x1b[0m\x1b[48;5;236m')}\x1b[0m`;
}

/** Splits a raw stdin chunk into individual keys, keeping escape sequences whole. */
function splitKeys(input: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < input.length) {
    if (input[index] === '\x1b') {
      const match = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])?/.exec(input.slice(index));
      const sequence = match?.[0] ?? '\x1b';
      keys.push(sequence);
      index += sequence.length;
    } else {
      keys.push(input[index]!);
      index += 1;
    }
  }
  return keys;
}
