const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

let colorEnabled = true;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

function wrap(code: string, text: string): string {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const paint = {
  dim: (t: string) => wrap('2', t),
  bold: (t: string) => wrap('1', t),
  red: (t: string) => wrap('31', t),
  green: (t: string) => wrap('32', t),
  yellow: (t: string) => wrap('33', t),
  blue: (t: string) => wrap('34', t),
  magenta: (t: string) => wrap('35', t),
  cyan: (t: string) => wrap('36', t),
  gray: (t: string) => wrap('90', t),
  inverse: (t: string) => wrap('7', t),
  onBlue: (t: string) => wrap('44;97', t),
};

export function bytes(value: number): string {
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  const digits = n >= 100 || unit === 0 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(digits)} ${UNITS[unit]}`;
}

export function percent(value: number): string {
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    return `${h}h${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
}

const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** Fractional bar so small values stay visible instead of rounding to nothing. */
export function bar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const exact = clamped * width;
  const full = Math.floor(exact);
  const remainder = Math.floor((exact - full) * 8);
  const filled = '█'.repeat(full) + (full < width ? BLOCKS[remainder]! : '');
  return filled.padEnd(width, ' ');
}

const SGR = /^\x1b\[[0-9;]*m/;

/** Length on screen: escape sequences take no columns. */
export function visibleLength(text: string): number {
  return text.includes('\x1b') ? text.replace(/\x1b\[[0-9;]*m/g, '').length : text.length;
}

export function pad(text: string, width: number): string {
  const length = visibleLength(text);
  return length >= width ? text : text + ' '.repeat(width - length);
}

export function padStart(text: string, width: number): string {
  const length = visibleLength(text);
  return length >= width ? text : ' '.repeat(width - length) + text;
}

/** Cuts to a column count, stepping over escape sequences instead of counting them. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleLength(text) <= width) return text;
  if (!text.includes('\x1b')) {
    return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  }

  const limit = width - 1;
  let out = '';
  let visible = 0;
  let index = 0;
  let styled = false;

  while (index < text.length && visible < limit) {
    if (text[index] === '\x1b') {
      const match = SGR.exec(text.slice(index));
      if (match) {
        out += match[0];
        styled = true;
        index += match[0].length;
        continue;
      }
    }
    out += text[index];
    visible++;
    index++;
  }

  return `${out}…${styled ? '\x1b[0m' : ''}`;
}

export function fit(text: string, width: number): string {
  return pad(truncate(text, width), width);
}

/** Green under load, yellow when warm, red when it is the problem. */
export function heat(value: number, warn: number, danger: number): (t: string) => string {
  if (value >= danger) return paint.red;
  if (value >= warn) return paint.yellow;
  return paint.green;
}
