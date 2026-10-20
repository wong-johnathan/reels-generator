#!/usr/bin/env node
/**
 * Startup environment gate — R-016-5.
 *
 * Every container starts through this module (see Dockerfile.web / .worker /
 * .ops). It validates the environment for its role, prints every problem at
 * once without echoing values, and only then hands over to the real command.
 *
 *   node dist/src/boot/validate-env.js --role web --exec node dist/src/api/server.js
 *   node dist/src/boot/validate-env.js --role migrate -- node dist/src/db/migrate.js
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { ROLES, formatIssues, isRole, validateEnv, type Role } from '../config/env.js';

interface SpawnedLike {
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: 'inherit'; env: NodeJS.ProcessEnv },
) => SpawnedLike;

export interface RunIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly spawn: SpawnLike;
}

export interface ParsedArgs {
  readonly role: string;
  readonly command: readonly string[];
  readonly error?: string;
}

/** Parse `--role <role>` and an optional `--exec`/`--` command tail. */
export function parseArgs(argv: readonly string[], fallbackRole = 'web'): ParsedArgs {
  let role = fallbackRole;
  let command: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--role' || arg === '-r') {
      const next = argv[i + 1];
      if (!next) return { role, command, error: '--role requires a value' };
      role = next;
      i += 1;
      continue;
    }
    if (arg?.startsWith('--role=')) {
      role = arg.slice('--role='.length);
      continue;
    }
    if (arg === '--exec' || arg === '--') {
      command = argv.slice(i + 1);
      break;
    }
    return { role, command, error: `unexpected argument: ${arg}` };
  }

  return { role, command };
}

export async function run(argv: readonly string[], io: RunIo): Promise<number> {
  const envRole = io.env.ROLE ?? 'web';
  const parsed = parseArgs(argv, envRole);

  if (parsed.error) {
    io.err(
      `env-validator: ${parsed.error}\nusage: validate-env --role <${ROLES.join('|')}> [-- <command…>]`,
    );
    return 2;
  }
  if (!isRole(parsed.role)) {
    io.err(`env-validator: unknown role "${parsed.role}" (expected one of ${ROLES.join(', ')})`);
    return 2;
  }

  const role: Role = parsed.role;
  const result = validateEnv(io.env, role);
  if (!result.ok) {
    io.err(formatIssues(result.issues, role));
    return 1;
  }

  if (parsed.command.length === 0) {
    io.out(formatIssues([], role));
    return 0;
  }

  const [command, ...args] = parsed.command;
  if (!command) {
    io.err('env-validator: empty command after --');
    return 2;
  }

  const child = io.spawn(command, args, {
    stdio: 'inherit',
    env: { ...io.env } as NodeJS.ProcessEnv,
  });

  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const signal of signals) process.on(signal, forward);

  const code = await new Promise<number>((resolve) => {
    child.once('exit', (exitCode, exitSignal) => {
      for (const signal of signals) process.off(signal, forward);
      resolve(exitCode ?? (exitSignal ? 1 : 0));
    });
  });

  return code;
}

async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    spawn: nodeSpawn as unknown as SpawnLike,
  });
  process.exit(code);
}

const entrypoint = process.argv[1];
const isEntrypoint = entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
if (isEntrypoint) {
  await main();
}
