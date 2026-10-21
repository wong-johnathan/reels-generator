/**
 * S-16's data dependency — contract `export.get` and `export.build`.
 *
 * Same shape as the series, video, render and narration gateways: the web app
 * renders what the gateway returns and never invents a response. INT-01
 * composes the production adapter from the contract routes; this module ships
 * the in-memory one the preview and the tests drive.
 *
 * `build` is optional because the frozen contract exposes `export.build` but a
 * deployment may not mount it. When it is absent the page disables the control
 * with the reason instead of posting to a route that does not exist.
 */
import type { z } from 'zod';

import type { ExportViewSchema } from '../../../contract/api.js';

export type ExportView = z.infer<typeof ExportViewSchema>;

export class ExportNotFoundError extends Error {
  constructor(videoId: string) {
    super('No export for video ' + videoId);
    this.name = 'ExportNotFoundError';
  }
}

/** A named refusal: nothing to build yet, or the package already exists. */
export class ExportRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ExportRefusedError';
  }
}

export interface ExportGateway {
  get(videoId: string): Promise<ExportView | null>;
  /** `export.build` — 201 with the built view. */
  build?(videoId: string): Promise<ExportView>;
}

export interface MemoryExportSeed {
  readonly videoId: string;
  readonly view: ExportView | null;
  readonly now?: () => number;
}

export interface MemoryExportGateway extends ExportGateway {
  readonly current: () => ExportView | null;
  build(videoId: string): Promise<ExportView>;
}

/**
 * In-memory export. `build` only transitions a package that already carries
 * its file list (the fixture's package): it stamps `built_at`, sets the stage
 * done and keeps the content-addressed rows. A blocked or fileless export is
 * refused, because a build cannot conjure files it was never given.
 */
export function createMemoryExportGateway(seed: MemoryExportSeed): MemoryExportGateway {
  let current = seed.view;
  const now = seed.now ?? ((): number => Date.UTC(2026, 9, 20, 9, 41, 12));

  return {
    current: () => current,
    async get(videoId: string): Promise<ExportView | null> {
      if (videoId !== seed.videoId) return null;
      return current;
    },
    async build(videoId: string): Promise<ExportView> {
      if (videoId !== seed.videoId) throw new ExportNotFoundError(videoId);
      if (current === null) throw new ExportRefusedError('No export has run for this video.');
      if (current.status === 'blocked') {
        throw new ExportRefusedError(
          'Export is blocked: final approval is required first. Nothing was built.',
        );
      }
      if (current.files.length === 0) {
        throw new ExportRefusedError('The export has no files to package yet. Nothing was built.');
      }
      current = {
        ...current,
        status: 'done',
        package_built_at: new Date(now()).toISOString(),
      };
      return current;
    },
  };
}
