/**
 * `npm run security:scan -- <path…>` — the R-015-5 release gate.
 *
 * Scans log directories and unpacked export trees with the denylist in
 * src/security/redact.ts, using the running environment's secret values as the
 * literal layer. Prints file, kind, offset and fingerprint — never a value.
 * Exit 0 = 0 matches; exit 1 = a leak (the gate fails closed); exit 2 = usage.
 */
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { scanDirectory, scanForSecrets } from './redact.js';

const LABEL = 'security:scan';

function scanFile(path: string): number {
  const findings = scanForSecrets(readFileSync(path, 'utf8'), { env: process.env });
  for (const finding of findings) {
    console.error(
      `${LABEL}: LEAK ${path}:${finding.index} kind=${finding.kind} ` +
        `length=${finding.length} fingerprint=${finding.fingerprint}`,
    );
  }
  return findings.length;
}

export function scanPaths(paths: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  let filesScanned = 0;
  let matches = 0;

  for (const path of paths) {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      const result = scanDirectory(path, { env });
      filesScanned += result.filesScanned;
      for (const finding of result.findings) {
        console.error(
          `${LABEL}: LEAK ${finding.file}:${finding.index} kind=${finding.kind} ` +
            `length=${finding.length} fingerprint=${finding.fingerprint}`,
        );
      }
      matches += result.findings.length;
    } else if (stats.isFile()) {
      filesScanned += 1;
      matches += scanFile(path);
    }
  }

  if (matches === 0) {
    console.log(`${LABEL}: scanned ${filesScanned} file(s) — 0 matches (R-015-5 gate holds)`);
  } else {
    console.error(`${LABEL}: scanned ${filesScanned} file(s) — ${matches} match(es); gate FAILS`);
  }
  return matches;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error(`${LABEL}: usage: security:scan -- <log-dir-or-file> [...]`);
    process.exitCode = 2;
  } else {
    process.exitCode = scanPaths(paths) === 0 ? 0 : 1;
  }
}
