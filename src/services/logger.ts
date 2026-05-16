type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

class Logger {
  private level: LogLevel;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.level];
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...meta,
    };
    const output = JSON.stringify(entry);
    // Always write to stderr to avoid corrupting stdio MCP protocol on stdout
    process.stderr.write(output + "\n");
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.log("debug", message, meta);
  }
  info(message: string, meta?: Record<string, unknown>) {
    this.log("info", message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>) {
    this.log("warn", message, meta);
  }
  error(message: string, meta?: Record<string, unknown>) {
    this.log("error", message, meta);
  }
}

const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

function resolveLogLevel(): LogLevel {
  const envLevel = process.env["LOG_LEVEL"];
  if (envLevel && VALID_LEVELS.has(envLevel)) return envLevel as LogLevel;
  if (envLevel) {
    process.stderr.write(`[local-memory-mcp] Unknown LOG_LEVEL "${envLevel}", falling back to "info"\n`);
    return "info";
  }
  return process.env["NODE_ENV"] === "production" ? "info" : "debug";
}

export const logger = new Logger(resolveLogLevel());
