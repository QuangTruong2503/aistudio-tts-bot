const fs = require('fs');
const path = require('path');

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

class Logger {
  constructor(logsDir) {
    this.logsDir = logsDir;
    this.logFile = path.join(logsDir, 'run.log');
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  _write(level, color, message) {
    const ts = formatTimestamp();
    const plainLine = `[${ts}] [${level}] ${message}`;
    const coloredLine = `${COLORS.dim}[${ts}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${message}`;

    if (level === 'ERROR') {
      console.error(coloredLine);
    } else {
      console.log(coloredLine);
    }

    try {
      fs.appendFileSync(this.logFile, plainLine + '\n', 'utf8');
    } catch {
      // Avoid crashing the bot if log file is temporarily locked
    }
  }

  info(message) {
    this._write('INFO', COLORS.cyan, message);
  }

  success(message) {
    this._write('OK', COLORS.green, message);
  }

  warn(message) {
    this._write('WARN', COLORS.yellow, message);
  }

  error(message) {
    this._write('ERROR', COLORS.red, message);
  }

  skip(message) {
    this._write('SKIP', COLORS.magenta, message);
  }

  debug(message) {
    if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
      this._write('DEBUG', COLORS.dim, message);
    }
  }
}

module.exports = Logger;
