/**
 * Structured logger — TECH_DESIGN §8.4(a): the denylist runs *inside* the
 * serializer, so a secret cannot reach a log line even when a caller passes one
 * by accident (an upstream error message quoting a key, a settings dump, a
 * provider URL with embedded credentials).
 *
 * One JSON object per line, no console formatting: the line is what the backup
 * job's denylist scan reads (R-015-5). Serialisation never throws — a hostile or
 * circular field becomes `[Circular]` or a fallback line, because losing the
 * log line is worse than losing the field.
 */
import { redactText, redactValue, type RedactOptions } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  readonly ts: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface LogFields {
  readonly [field: string]: unknown;
}

export interface LoggerOptions {
  readonly sink: (line: string) => void;
  readonly level?: LogLevel;
  readonly now?: () => Date;
  readonly redact?: RedactOptions;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['ts', 'level', 'event']);

export function createLogger(options: LoggerOptions): Logger {
  const minimum = LEVEL_RANK[options.level ?? 'info'];
  const now = options.now ?? (() => new Date());
  const redact = options.redact ?? {};

  const build = (base: LogFields): Logger => {
    const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
      if (LEVEL_RANK[level] < minimum) return;

      const merged: Record<string, unknown> = {};
      for (const [key, value] of Object.entries({ ...base, ...fields })) {
        if (!RESERVED.has(key)) merged[key] = value;
      }

      const record: Record<string, unknown> = {
        ts: now().toISOString(),
        level,
        event: redactText(event, redact),
        ...(redactValue(merged, redact) as Record<string, unknown>),
      };

      try {
        options.sink(JSON.stringify(record));
      } catch {
        // A field that even the redactor cannot serialise must not lose the line.
        options.sink(
          JSON.stringify({
            ts: now().toISOString(),
            level: 'error',
            event: 'log.serialize_failed',
            original_event: redactText(event, redact),
          }),
        );
      }
    };

    return {
      log: emit,
      debug: (event, fields) => emit('debug', event, fields),
      info: (event, fields) => emit('info', event, fields),
      warn: (event, fields) => emit('warn', event, fields),
      error: (event, fields) => emit('error', event, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  };

  return build({});
}

/** A sink that appends newline-delimited JSON to a stream (stdout, a file). */
export function jsonLineSink(stream: { write(chunk: string): unknown }): (line: string) => void {
  return (line: string) => {
    stream.write(`${line}\n`);
  };
}
