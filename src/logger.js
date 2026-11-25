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
  constructor(logsDir, options = {}) {
    this.logsDir = logsDir;
    this.logFile = path.join(logsDir, 'run.log');
    this.prefix = options.prefix || '';
    this.workerId = options.workerId || null;
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  child(options = {}) {
    return new Logger(this.logsDir, {
      prefix: options.prefix ?? this.prefix,
      workerId: options.workerId ?? this.workerId,
      onLog: options.onLog ?? this.onLog,
    });
  }

  _write(level, color, message) {
    const ts = formatTimestamp();
    const taggedMessage = this.prefix ? `${this.prefix} ${message}` : message;
    const plainLine = `[${ts}] [${level}] ${taggedMessage}`;
    const coloredLine = `${COLORS.dim}[${ts}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${taggedMessage}`;

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

    if (this.onLog) {
      try {
        this.onLog({
          timestamp: ts,
          level,
          workerId: this.workerId,
          message: taggedMessage,
        });
      } catch {
        // Ignore UI listener errors
      }
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
