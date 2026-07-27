<div align="center">

# hogkill

**`npkill`, but for the processes eating your machine.**

[![npm](https://img.shields.io/npm/v/hogkill?color=cb3837&logo=npm)](https://www.npmjs.com/package/hogkill)
[![license](https://img.shields.io/npm/l/hogkill?color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/hogkill)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#requirements)

</div>

The fan spins up, everything stutters, and you have no idea which of the forty
Electron helpers is to blame. `hogkill` gives you one line per **app** — not per
PID — ranked by what it is actually costing you right now, and kills it with one
key.

```
hogkill  918 procs · cpu 34.1% ███▍  · ram 12.4 GB/18.0 GB ██████▉             ⏸ held · sort cpu
────────────────────────────────────────────────────────────────────────────────────────────────
     NAME                                  CPU       MEMORY      PROCS·AGE  RISK      USER
 [ ] ▾ Google Chrome                     132.4% ███  4.21 GB ███        14            duca
 [ ]   └   4821 Chrome Helper (Renderer)  88.1% ██   1.02 GB ▊       2h14m            duca
 [ ]   └   4790 Google Chrome              1.3% ▏     680 MB ▌       2h14m            duca
❯[x] ▸ Slack                              18.2% ▍     912 MB ▋           6            duca
 [ ]   WindowServer                        9.4% ▎      54 MB             1  critical  _windowserver
────────────────────────────────────────────────────────────────────────────────────────────────
rows held still · g top to re-rank · space select · d kill · / filter · ? help · q quit
```

## Why

`top` and `htop` show you processes. Your machine has 900 of them, and the app
you actually want to kill is smeared across 40 rows named `Helper (Renderer)`.
Activity Monitor groups them, but you cannot reach it from a terminal, over SSH,
or without lifting your hands off the keyboard.

`hogkill` folds the process table into apps the way `npkill` folds `node_modules`
into projects, tells you what each one really costs, and gets out of the way.

- **One row per app.** All 14 Chrome helpers, one total, one keystroke.
- **CPU that means something.** `ps` reports an average over a process's entire
  lifetime — useless for "what is hot right now". hogkill diffs consumed CPU
  time between samples and smooths the result.
- **A list that holds still.** A live ranking that re-sorts under your cursor is
  unusable. This one freezes the moment you start navigating.
- **Guardrails that explain instead of forbid.** It never refuses a kill; it
  tells you exactly what breaks first.
- **Zero runtime dependencies.** One `ps` call per refresh, nothing else.

## Install

```bash
npm install -g hogkill
```

Or run it without installing:

```bash
npx hogkill
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/igorfelipeduca/hogkill.git
cd hogkill
npm install     # builds on install
npm link        # puts `hogkill` and `hk` on your PATH
```

</details>

### Requirements

Node 18+, macOS or Linux. It reads the process table through `ps(1)` — no native
modules, no root, no daemon.

## Usage

```bash
hogkill                    # interactive, ranked by CPU
hogkill -m                 # ranked by memory
hogkill chrome             # start filtered
hogkill --list --top 15    # print the top 15 and exit
hogkill --kill "Slack" -y  # kill every Slack process, no prompt
hogkill --json | jq .      # feed it to something else
```

Also available as `hk`.

### Keys

| key | does |
| --- | --- |
| `↑` `↓` / `k` `j` | move |
| `→` `←` / `l` `h` | expand / collapse an app into its processes |
| `space` | select — kill several at once |
| `a` / `x` | select every app / clear the selection |
| `d` | kill — SIGTERM, then SIGKILL for whatever hangs on |
| `D` | kill now — straight SIGKILL |
| `/` | filter by name, command line or PID |
| `s` `c` `m` | cycle sort / sort by CPU / sort by memory |
| `p` | pin the order so it never re-ranks |
| `g` `G` | jump to top / bottom |
| `r` `?` `q` | refresh · help · quit |

### Options

```
-s, --sort <key>       cpu | mem | count | name            (default: cpu)
-m, --mem              shortcut for --sort mem
-i, --interval <ms>    refresh rate                        (default: 1500)
-n, --top <n>          rows to print in --list             (default: 20)
    --min-cpu <pct>    hide apps below this CPU%
    --min-mem <mb>     hide apps below this memory
-u, --user <name>      only this user's processes
    --me               only your own processes
-f, --filter <text>    only apps matching text
    --safe-only        hide everything the system depends on
-l, --list             print once and exit, no TUI
    --flat             list individual processes, not apps
    --json             machine readable output (implies --list)
-k, --kill <text>      non-interactive kill by name match
-y, --yes              skip the confirmation prompt
-9, --force            SIGKILL immediately, no SIGTERM first
    --dry-run          show what would die, kill nothing
    --no-color         plain output
```

## The list doesn't move under your cursor

A live CPU ranking re-sorts every second, which makes picking a row impossible —
you aim at Chrome, the refresh lands, and you kill Spotify.

So hogkill only re-ranks while you are **parked at the top with nothing
selected** (`● live` in the corner). The moment you move down, select something,
or open a dialog, positions **hold still** (`⏸ held`) and only the numbers keep
updating. Press `g` to return to the top and let it re-rank, or `p` to pin the
order for good. Changing the sort always re-ranks — you asked for it.

## Guardrails

**hogkill never refuses a kill.** It tells you what breaks, then does what you
asked. Every row carries a `RISK` column:

| tag | meaning |
| --- | --- |
| `critical` | the OS leans on it. Killing it can panic, freeze or log you out. |
| `system` | a daemon the OS uses. Something stops working until it restarts. |
| `you` | hogkill itself, or the shell/terminal it runs in. |

Before any kill, the confirmation spells out the consequence in plain words:

```
  critical WindowServer — draws every window; logs you out instantly
kill CRITICAL system process WindowServer · 1 process · 73.4 MB · SIGTERM?
y yes · K force · n cancel
```

The same reasons ride along in `--kill` output and in `--json` (`risk` /
`riskReason`), so scripts can decide for themselves.

Two things happen quietly on your behalf, because they only ever bite:

- `--kill <text>` never matches hogkill's own process or the shell that launched
  it — the pattern you typed is sitting in their command lines too.
- When a batch includes your own session, those processes are signalled **last**,
  so killing your terminal doesn't abort the rest of the batch halfway through.

Use `--safe-only` to hide anything the OS depends on, and `--dry-run` when you
want the report without the funeral.

## How it works

- One `ps` call per refresh, parsed into a process table.
- CPU is a **delta** of consumed CPU time between two samples, then smoothed —
  never the lifetime average `ps` hands you.
- Processes fold into apps by their `.app` bundle (macOS), interpreter script
  (`node server.js`), or executable name.
- Executable paths are recovered by walking space boundaries and keeping the
  longest prefix that is a real file, because macOS paths are full of spaces and
  `ps` joins argv with spaces.
- Bars scale to the biggest row on screen, not to total cores or total RAM —
  scaled against the machine, every bar reads as empty.
- Kills go SIGTERM first so apps can save, then SIGKILL after 4s for survivors.
  `EPERM` is reported as "rerun with sudo" rather than swallowed.

## Development

```bash
npm install       # installs deps and builds
npm run build     # tsc + chmod
npm run dev       # tsc --watch
node dist/cli.js  # run the local build
```

The source is small and split by concern: `ps.ts` samples, `naming.ts` names
things, `group.ts` folds, `risk.ts` judges, `kill.ts` signals, `ui.ts` draws,
`cli.ts` parses arguments.

Issues and pull requests are welcome — especially Linux fixes and additions to
the risk table in `src/risk.ts`.

## License

[MIT](./LICENSE) © Igor Duca
