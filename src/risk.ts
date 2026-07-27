import { platform } from 'node:os';
import { baseName } from './naming.js';
import { paint } from './format.js';
import type { Proc, RiskInfo, RiskLevel } from './types.js';

/** Short label shown in the risk column. */
export const RISK_TAG: Record<RiskLevel, string> = {
  none: '',
  system: 'system',
  own: 'you',
  critical: 'critical',
};

/** Resolved per call so `--no-color` still applies after argument parsing. */
export function riskTint(level: RiskLevel): (text: string) => string {
  switch (level) {
    case 'critical':
      return paint.red;
    case 'system':
      return paint.yellow;
    case 'own':
      return paint.cyan;
    default:
      return (text: string) => text;
  }
}

export const RISK_WORD: Record<RiskLevel, string> = {
  none: '',
  system: 'system process',
  own: 'your own session',
  critical: 'CRITICAL system process',
};

export const RISK_ORDER: Record<RiskLevel, number> = {
  none: 0,
  system: 1,
  own: 2,
  critical: 3,
};

export function worstRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

interface Known {
  level: RiskLevel;
  reason: string;
}

const DARWIN: Record<string, Known> = {
  kernel_task: { level: 'critical', reason: 'the kernel itself; the machine panics' },
  launchd: { level: 'critical', reason: 'PID 1, parent of everything; macOS panics' },
  WindowServer: { level: 'critical', reason: 'draws every window; logs you out instantly' },
  loginwindow: { level: 'critical', reason: 'owns your login session; ends it' },
  configd: { level: 'critical', reason: 'runs the network stack; networking dies' },
  powerd: { level: 'critical', reason: 'power management; sleep, wake and battery break' },
  opendirectoryd: { level: 'critical', reason: 'resolves users and groups; logins start failing' },
  securityd: { level: 'critical', reason: 'keychain and crypto; apps lose credentials' },
  amfid: { level: 'critical', reason: 'validates code signatures; apps stop launching' },
  runningboardd: { level: 'critical', reason: 'manages app lifecycles; apps get suspended or killed' },
  launchservicesd: { level: 'critical', reason: 'launches apps and opens files; double-click stops working' },
  kernelmanagerd: { level: 'critical', reason: 'loads kernel extensions; drivers break' },
  watchdogd: { level: 'critical', reason: 'the system watchdog; may force a reboot' },
  hidd: { level: 'critical', reason: 'keyboard, mouse and trackpad input' },
  diskarbitrationd: { level: 'critical', reason: 'mounts disks; volumes stop appearing' },
  notifyd: { level: 'system', reason: 'system-wide notifications between processes' },
  distnoted: { level: 'system', reason: 'distributed notifications; apps lose sync' },
  syslogd: { level: 'system', reason: 'system logging stops' },
  coreaudiod: { level: 'system', reason: 'all audio dies until it restarts' },
  bluetoothd: { level: 'system', reason: 'bluetooth drops; including keyboard and mouse' },
  mDNSResponder: { level: 'system', reason: 'DNS resolution; name lookups fail until it restarts' },
  Dock: { level: 'system', reason: 'the Dock and Mission Control (relaunches on its own)' },
  Finder: { level: 'system', reason: 'the desktop and file windows (relaunches on its own)' },
  SystemUIServer: { level: 'system', reason: 'menu bar extras (relaunches on its own)' },
  WindowManager: { level: 'system', reason: 'Stage Manager and window tiling' },
  trustd: { level: 'system', reason: 'certificate validation; TLS starts failing' },
  syspolicyd: { level: 'system', reason: 'Gatekeeper checks; apps may refuse to open' },
  fseventsd: { level: 'system', reason: 'filesystem change events; Spotlight and sync tools go blind' },
  cfprefsd: { level: 'system', reason: 'reads and writes app preferences' },
};

const LINUX: Record<string, Known> = {
  systemd: { level: 'critical', reason: 'PID 1 and service manager; the system goes down' },
  init: { level: 'critical', reason: 'PID 1; the system goes down' },
  kthreadd: { level: 'critical', reason: 'parent of every kernel thread' },
  'systemd-journald': { level: 'critical', reason: 'system logging; services may block on it' },
  'systemd-logind': { level: 'critical', reason: 'owns login sessions; you get logged out' },
  'systemd-udevd': { level: 'critical', reason: 'device management; hotplug and drivers break' },
  'dbus-daemon': { level: 'critical', reason: 'desktop IPC bus; the session falls apart' },
  udevd: { level: 'critical', reason: 'device management; hotplug and drivers break' },
  sshd: { level: 'critical', reason: 'the SSH server; remote sessions die, including yours' },
  Xorg: { level: 'critical', reason: 'the X server; the graphical session ends' },
  Xwayland: { level: 'critical', reason: 'X compatibility layer; X apps die' },
  'gnome-shell': { level: 'critical', reason: 'the desktop shell; the session ends' },
  plasmashell: { level: 'critical', reason: 'the desktop shell; the session ends' },
  gdm: { level: 'critical', reason: 'the display manager; you get logged out' },
  sddm: { level: 'critical', reason: 'the display manager; you get logged out' },
  lightdm: { level: 'critical', reason: 'the display manager; you get logged out' },
  NetworkManager: { level: 'critical', reason: 'networking; connections drop' },
  'wpa_supplicant': { level: 'system', reason: 'wi-fi authentication; wireless drops' },
  pipewire: { level: 'system', reason: 'audio and video routing; sound dies' },
  pulseaudio: { level: 'system', reason: 'audio server; sound dies' },
};

const WINDOWS: Record<string, Known> = {
  System: { level: 'critical', reason: 'the Windows kernel; the machine bugchecks' },
  Registry: { level: 'critical', reason: 'the registry process; Windows bugchecks' },
  smss: { level: 'critical', reason: 'the session manager; instant blue screen' },
  csrss: { level: 'critical', reason: 'the Win32 subsystem; instant blue screen' },
  wininit: { level: 'critical', reason: 'starts every system service; instant blue screen' },
  winlogon: { level: 'critical', reason: 'owns your logon session; you get signed out' },
  services: { level: 'critical', reason: 'the service control manager; Windows bugchecks' },
  lsass: { level: 'critical', reason: 'local security authority; instant blue screen' },
  LsaIso: { level: 'critical', reason: 'credential guard; instant blue screen' },
  dwm: { level: 'critical', reason: 'the desktop compositor; the screen goes black' },
  svchost: { level: 'system', reason: 'hosts Windows services; networking or audio may drop' },
  explorer: { level: 'system', reason: 'taskbar, desktop and file windows (restarts on its own)' },
  fontdrvhost: { level: 'system', reason: 'font rendering for the session' },
  audiodg: { level: 'system', reason: 'audio device graph; sound dies until it restarts' },
  spoolsv: { level: 'system', reason: 'the print spooler; printing stops' },
  WmiPrvSE: { level: 'system', reason: 'WMI provider host; hogkill itself reads through WMI' },
  SearchIndexer: { level: 'system', reason: 'Windows Search; results go stale until it restarts' },
  RuntimeBroker: { level: 'system', reason: 'brokers permissions for Store apps' },
  sihost: { level: 'system', reason: 'shell infrastructure; parts of the UI stop responding' },
  ctfmon: { level: 'system', reason: 'text input and IME' },
  taskhostw: { level: 'system', reason: 'host for scheduled background tasks' },
  conhost: { level: 'system', reason: 'console window host; a terminal window may close' },
  MsMpEng: { level: 'system', reason: 'Microsoft Defender antivirus engine' },
  SecurityHealthService: { level: 'system', reason: 'Windows Security monitoring' },
};

const SYSTEM_USERS = new Set(['root', 'daemon', 'nobody', 'systemd-network', 'systemd-resolve']);

function table(): Record<string, Known> {
  switch (platform()) {
    case 'darwin':
      return DARWIN;
    case 'win32':
      return WINDOWS;
    default:
      return LINUX;
  }
}

/** Explains what a process is worth before you kill it. */
export function assessRisk(proc: Proc, lineage: Set<number>): RiskInfo {
  if (proc.pid === process.pid) {
    return { level: 'own', reason: 'this is hogkill itself' };
  }
  if (proc.pid <= 1) {
    return { level: 'critical', reason: 'PID 1; the whole system hangs off it' };
  }

  const exe = baseName(proc.exe);
  const known = table()[exe] ?? table()[proc.name];
  if (known) return known;

  if (lineage.has(proc.pid)) {
    return {
      level: 'own',
      reason: 'the shell or terminal running hogkill; this session closes',
    };
  }

  if (SYSTEM_USERS.has(proc.user) || proc.user.startsWith('_')) {
    return {
      level: 'system',
      reason: `system daemon running as ${proc.user}; something in the OS depends on it`,
    };
  }

  return { level: 'none', reason: '' };
}
