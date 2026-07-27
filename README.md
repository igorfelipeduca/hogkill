# hogkill

`npkill`, but for the processes eating your machine.

You know the feeling: the fan spins up, everything stutters, and you have no idea
which of the forty Electron helpers is to blame. `hogkill` gives you one line per
**app** — not per PID — sorted by what it is actually costing you right now, and
lets you kill it with one key.

```
hogkill  918 procs · cpu 34.1% ███▍       · ram 12.4 GB/18.0 GB ██████▉    · load 3.21    sort cpu
────────────────────────────────────────────────────────────────────────────────────────────────
    NAME                                  CPU          MEMORY        PROCS USER
 ›  ▾ Google Chrome                     132.4% ████▏    4.21 GB ██▏      14 duca
    ├   4821 Google Chrome Helper (Ren…  88.1% ███      1.02 GB ▌      2h14m duca
    ├   4790 Google Chrome               21.3% ▊         680 MB ▍      2h14m duca
    ▸ Slack                              18.2% ▋         912 MB ▌         6 duca
 ▲  ▸ WindowServer                        9.4% ▍          54 MB           1 _windowserver
────────────────────────────────────────────────────────────────────────────────────────────────
↑↓ move · → expand · space select · d kill · D force · / filter · s sort · ? help · q quit
```

## Install

```bash
git clone <this repo> hogkill
cd hogkill
npm install     # builds on install
npm link        # puts `hogkill` (and `hk`) on your PATH
```

Requires Node 18+. macOS and Linux — it reads the process table through `ps(1)`.

## Use it

```bash
hogkill                    # interactive, sorted by CPU
hogkill -m                 # sorted by memory
hogkill chrome             # start filtered
hogkill --list --top 15    # print the top 15 and exit
hogkill --kill "Slack" -y  # kill every Slack process, no prompt
hogkill --json | jq .      # feed it to something else
```

### Keys

| key | does |
| --- | --- |
| `↑` `↓` / `k` `j` | move |
| `→` `←` / `l` `h` | expand / collapse an app into its processes |
| `space` | select (kill several at once) |
| `a` / `x` | select every app / clear the selection |
| `d` | kill — SIGTERM, then SIGKILL for whatever hangs on |
| `D` | kill now — straight SIGKILL |
| `/` | filter by name, command line or PID |
| `s` `c` `m` | cycle sort / sort by CPU / sort by memory |
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

## Guardrails

`hogkill` never refuses a kill. It tells you what breaks, then does what you asked.

| mark | meaning |
| --- | --- |
| ▲ red | **critical** — the OS leans on it. Killing it can panic, freeze or log you out. |
| ▲ yellow | **system** — a daemon the OS uses. Something stops working until it restarts. |
| ◆ cyan | **your session** — hogkill itself, or the shell/terminal it runs in. |

Before any kill, the confirmation bar spells out the consequence in plain words:

```
  ▲ WindowServer — draws every window; logs you out instantly
[dry run] kill CRITICAL system process WindowServer · 1 process · 73.4 MB · SIGTERM?
y yes · K force · n cancel
```

The same warnings show up in `--kill` and in `--json` (`risk` / `riskReason`), so
scripts can decide for themselves.

Two things happen quietly on your behalf, because they only ever bite:

- `--kill <text>` never matches hogkill's own process or the shell that launched
  it — the pattern you typed is sitting in their command lines too.
- When a batch includes your own session, those processes are signalled **last**,
  so killing your terminal doesn't abort the rest of the batch halfway through.

Use `--safe-only` if you only ever want to see your own apps, and `--dry-run`
when you want the report without the funeral.

## How it works

- One `ps` call per refresh, parsed into a process table.
- CPU is a **delta**: `ps` reports an average over the whole lifetime of a
  process, which tells you nothing about what is hot right now, so hogkill
  diffs consumed CPU time between two samples instead.
- Processes are folded into apps by their `.app` bundle (macOS), interpreter
  script (`node server.js`), or executable name — so all 14 Chrome helpers land
  on one row with one total.
- Executable paths are recovered by walking space boundaries and keeping the
  longest prefix that is a real file, because macOS paths are full of spaces
  and `ps` joins argv with spaces.
- Kills go SIGTERM first so apps can save, then SIGKILL after 4s for survivors.
  `EPERM` is reported as "rerun with sudo" rather than swallowed.

## License

MIT
