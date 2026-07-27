import { freemem, loadavg, totalmem } from 'node:os';
import type { Group, Proc, RiskLevel, SortKey, Warning } from './types.js';
import { CORES, ProcessSampler } from './ps.js';
import { collectWarnings, groupProcesses, highestRisk, sortGroups } from './group.js';
import { killTargets, summarize, type KillTarget } from './kill.js';
import { RISK_TAG, RISK_WORD, riskTint } from './risk.js';
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

  /** Row order carried across refreshes so nothing moves under the cursor. */
  private order: string[] = [];
  private readonly procOrder = new Map<string, number[]>();

  private groups: Group[] = [];
  private rows: Row[] = [];
  private procCount = 0;
  private mode: Mode = 'list';
  private sort: SortKey;
  private filter = '';
  private filterDraft = '';
  private cursor = 0;
  private offset = 0;
  private pinned = false;
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

  /**
   * The list only re-ranks while you are parked at the top with nothing picked.
   * The moment you start moving, positions hold still and only the numbers move.
   */
  private held(): boolean {
    return this.pinned || this.cursor > 0 || this.selected.size > 0 || this.mode !== 'list';
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

      const hold = this.held();
      const ordered = hold ? this.applyOrder(grouped) : sortGroups(grouped, this.sort);
      if (hold) for (const group of ordered) this.applyProcOrder(group);
      this.rememberOrder(ordered);

      this.groups = ordered;
      this.rebuildRows();
      this.render();
    } catch (error) {
      this.flash(`sample failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Keeps every known row where it was; anything new lands at the bottom. */
  private applyOrder(groups: Group[]): Group[] {
    const byKey = new Map(groups.map((group) => [group.key, group]));
    const kept: Group[] = [];
    for (const key of this.order) {
      const group = byKey.get(key);
      if (group) {
        kept.push(group);
        byKey.delete(key);
      }
    }
    return [...kept, ...sortGroups([...byKey.values()], this.sort)];
  }

  private applyProcOrder(group: Group): void {
    const remembered = this.procOrder.get(group.key);
    if (!remembered) return;

    const byPid = new Map(group.procs.map((proc) => [proc.pid, proc]));
    const kept: Proc[] = [];
    for (const pid of remembered) {
      const proc = byPid.get(pid);
      if (proc) {
        kept.push(proc);
        byPid.delete(pid);
      }
    }
    group.procs = [...kept, ...byPid.values()];
  }

  private rememberOrder(groups: Group[]): void {
    this.order = groups.map((group) => group.key);
    this.procOrder.clear();
    for (const group of groups) {
      this.procOrder.set(group.key, group.procs.map((proc) => proc.pid));
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
      case 'p':
        this.pinned = !this.pinned;
        this.flash(this.pinned ? 'order pinned' : 'order live again');
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
        this.reorder(this.sort);
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

  /** Changing the sort is an explicit request to re-rank, hold or not. */
  private reorder(sort: SortKey): void {
    this.sort = sort;
    this.groups = sortGroups(this.groups, sort);
    for (const group of this.groups) {
      group.procs.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
    }
    this.rememberOrder(this.groups);
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
      this.order = [];
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
      // Bars are relative to the worst offender in view: scaling them against
      // total cores or total RAM leaves every row visually empty.
      const scale = this.groups.reduce(
        (peak, group) => ({
          cpu: Math.max(peak.cpu, group.cpu),
          rss: Math.max(peak.rss, group.rss),
        }),
        { cpu: 1, rss: 1 },
      );

      const slice = this.rows.slice(this.offset, this.offset + body);
      slice.forEach((row, index) => {
        lines.push(this.renderRow(row, width, this.offset + index === this.cursor, scale));
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

    const title = paint.bold(paint.magenta('hogkill'));
    const state = this.held()
      ? paint.yellow(`⏸ ${this.pinned ? 'pinned' : 'held'}`)
      : paint.green('● live');
    const right = paint.gray(
      `${state}${paint.gray(` · sort ${this.sort}`)}${this.filter ? paint.gray(` · /${this.filter}`) : ''}`,
    );

    // Least useful stat goes first: on a narrow terminal the tail gets dropped
    // rather than truncated, so state, sort and filter stay readable.
    const stats = [
      `${this.procCount} procs`,
      `${heat(cpuRatio * 100, 50, 80)(`cpu ${percent(cpuRatio * 100)}`)} ${paint.gray(bar(cpuRatio, 10))}`,
      `${heat(memRatio * 100, 70, 88)(`ram ${bytes(used)}/${bytes(TOTAL_MEM)}`)} ${paint.gray(bar(memRatio, 10))}`,
      paint.gray(`load ${loadavg()[0]!.toFixed(2)}`),
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
    const withUser = width >= 100;
    const withBars = width >= 116;
    // Cursor, checkbox, cpu, memory, count, risk, and optionally user and bars.
    const fixed = 5 + 8 + 11 + 9 + 9 + (withUser ? 11 : 0) + (withBars ? 14 : 0);
    return { withUser, withBars, name: Math.max(14, width - 1 - fixed) };
  }

  private columns(width: number): string {
    const { withUser, withBars, name } = this.layout(width);
    const spacer = ' '.repeat(7);
    return paint.gray(
      [
        '     ',
        fit('NAME', name),
        padStart('CPU', 7),
        withBars ? spacer : '',
        padStart('MEMORY', 11),
        withBars ? spacer : '',
        padStart('PROCS·AGE', 9),
        '  ',
        fit('RISK', 8),
        withUser ? ` ${fit('USER', 10)}` : '',
      ].join(''),
    );
  }

  private renderRow(
    row: Row,
    width: number,
    active: boolean,
    scale: { cpu: number; rss: number },
  ): string {
    const { withUser, withBars, name } = this.layout(width);
    const isGroup = row.kind === 'group';
    const cpu = isGroup ? row.group.cpu : row.proc.cpu;
    const rss = isGroup ? row.group.rss : row.proc.rss;
    const risk = isGroup ? row.group.risk : row.proc.risk;

    const cursor = active ? paint.cyan('❯') : ' ';
    const box = this.selected.has(row.id) ? paint.red('[x]') : paint.gray('[ ]');
    const caret = isGroup
      ? row.group.procs.length > 1
        ? this.expanded.has(row.group.key)
          ? '▾ '
          : '▸ '
        : '  '
      : '  ';
    const label = isGroup
      ? `${caret}${row.group.name}`
      : `${caret}${paint.gray('└')} ${padStart(String(row.proc.pid), 6)} ${row.proc.name}`;

    const cells = [
      `${cursor}${box} `,
      isGroup ? fit(label, name) : paint.gray(fit(label, name)),
      heat(cpu, 60, 150)(padStart(percent(cpu), 7)),
      withBars ? ` ${paint.gray(bar(cpu / scale.cpu, 6))}` : '',
      heat((rss / TOTAL_MEM) * 100, 8, 20)(padStart(bytes(rss), 11)),
      withBars ? ` ${paint.gray(bar(rss / scale.rss, 6))}` : '',
      paint.gray(padStart(isGroup ? String(row.group.procs.length) : duration(row.proc.elapsed), 9)),
      '  ',
      riskTint(risk)(fit(RISK_TAG[risk], 8)),
      withUser ? ` ${paint.gray(fit(isGroup ? row.group.user : row.proc.user, 10))}` : '',
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
      `  ${paint.bold('view')}      / filter · s cycle sort · c cpu · m memory · p pin · q quit`,
      '',
      `  ${paint.bold('order')}     ${paint.green('● live')} only while you sit at the top with nothing selected.`,
      `            ${paint.yellow('⏸ held')} the moment you move — numbers keep updating, rows stay put.`,
      '            g returns to the top and lets it re-rank · p pins it for good',
      '',
      `  ${paint.bold('risk')}      ${paint.red('critical')} the OS leans on it; can freeze or log you out`,
      `            ${paint.yellow('system')}   part of the OS stops working until it restarts`,
      `            ${paint.cyan('you')}      hogkill itself, or the terminal it runs in`,
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
        const tint = riskTint(warning.level);
        lines.push(
          truncate(
            `  ${tint(RISK_TAG[warning.level])} ${warning.name} ${paint.gray(`— ${warning.reason}`)}`,
            width,
          ),
        );
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

    const selected = this.selected.size > 0 ? paint.red(`${this.selected.size} selected · `) : '';
    const hints = this.held()
      ? `${paint.yellow('rows held still')} ${paint.gray('· g top to re-rank · space select · d kill · / filter · ? help · q quit')}`
      : paint.gray('↑↓ move · → expand · space select · d kill · / filter · s sort · ? help · q quit');
    return [truncate(`${selected}${hints}`, width)];
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
