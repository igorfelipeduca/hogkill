import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RawProc } from '../types.js';

const run = promisify(execFile);

/**
 * Windows has no `ps`. Win32_Process carries the same numbers under different
 * names: WorkingSetSize for RSS, and kernel + user time in 100-nanosecond
 * ticks, which is exactly the cumulative CPU time the delta sampler wants.
 * Ownership is not on the class — reading it costs one CIM method call per
 * process — so the user column simply does not exist on this platform.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$now = Get-Date
$rows = Get-CimInstance Win32_Process | ForEach-Object {
  $start = $_.CreationDate
  [PSCustomObject]@{
    pid  = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    exe  = [string]$_.ExecutablePath
    name = [string]$_.Name
    cmd  = [string]$_.CommandLine
    rss  = [int64]$_.WorkingSetSize
    cpu  = [double]((([double]$_.KernelModeTime) + ([double]$_.UserModeTime)) / 1e7)
    age  = [int64]$(if ($start) { ($now - $start).TotalSeconds } else { 0 })
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 2
`;

interface Row {
  pid: number;
  ppid: number;
  exe: string | null;
  name: string | null;
  cmd: string | null;
  rss: number;
  cpu: number;
  age: number;
}

const ARGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand'];

/** UTF-16LE base64 sidesteps every layer of Windows command-line quoting. */
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

async function runPowerShell(): Promise<string> {
  try {
    const { stdout } = await run('powershell.exe', [...ARGS, ENCODED], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    const { stdout } = await run('pwsh', [...ARGS, ENCODED], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  }
}

export async function collect(): Promise<RawProc[]> {
  const stdout = await runPowerShell();
  const parsed = JSON.parse(stdout.trim() || '[]') as Row[] | Row;
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  // Pid 0 is the idle process — not a real, killable target.
  return rows.filter((row) => row.pid > 0).map((row) => {
    const exe = row.exe || row.name || String(row.pid);
    return {
      pid: row.pid,
      ppid: row.ppid,
      rss: row.rss,
      cpuSeconds: row.cpu,
      elapsed: row.age,
      user: '',
      command: row.cmd || exe,
      exe,
      fallbackCpu: 0,
    };
  });
}
