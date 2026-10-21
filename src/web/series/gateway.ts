/**
 * The S-03/S-04 data dependency, shaped by the frozen contract.
 *
 * The web app never invents a shape: `list` returns `SeriesSummary[]`,
 * `get` returns `SeriesDetail | null`, and a save returns the new detail. The
 * production adapter (INT-01) composes the contract's `series.*` routes; this
 * module also ships the in-memory implementation used by the preview and the
 * tests, which deliberately keeps `projects` immutable across a mint so the
 * R-002-3 claim ("existing projects/assets untouched") is executable.
 *
 * No network, no database, no provider call.
 */
import type { z } from 'zod';

import { SeriesDetailSchema, SeriesSummarySchema } from '../../../contract/api.js';
import type { SeriesVersionDetailSchema } from '../../../contract/api.js';

export type SeriesDetail = z.infer<typeof SeriesDetailSchema>;
export type SeriesSummary = z.infer<typeof SeriesSummarySchema>;
export type SeriesVersionDetail = z.infer<typeof SeriesVersionDetailSchema>;

export interface SeriesCreateInput {
  readonly name: string;
  readonly slug: string;
  readonly profile: Record<string, unknown>;
}

/** R-024/IP-09: `revision` is the optimistic lock the caller last read. */
export interface SeriesUpdateInput {
  readonly revision: number;
  readonly name?: string;
  readonly profile?: Record<string, unknown>;
}

/** The result of an explicit create-batch request (R-019). */
export interface BatchCreated {
  readonly batchId: string;
  readonly projectCount: number;
}

export interface SeriesGateway {
  list(): Promise<readonly SeriesSummary[]>;
  get(seriesId: string): Promise<SeriesDetail | null>;
  create(input: SeriesCreateInput): Promise<SeriesDetail>;
  update(seriesId: string, input: SeriesUpdateInput): Promise<SeriesDetail>;
  /**
   * R-019-4: mint a batch from the operator's explicit request. The size comes
   * from the series snapshot (`videos_per_batch`), never from this call.
   */
  createBatch(seriesId: string): Promise<BatchCreated>;
  /** Optional: a sourced in-flight video count, when the adapter has one. */
  inFlightVideos?(seriesId: string): Promise<number | null>;
}

export class SeriesNotFoundError extends Error {
  constructor(seriesId: string) {
    super('No series ' + seriesId);
    this.name = 'SeriesNotFoundError';
  }
}

export class SeriesArchivedError extends Error {
  constructor() {
    super('Archived series cannot be edited or used for new batches.');
    this.name = 'SeriesArchivedError';
  }
}

export class SeriesSlugTakenError extends Error {
  constructor(slug: string) {
    super('Slug already used: ' + slug);
    this.name = 'SeriesSlugTakenError';
  }
}

/** R-024-2/IP-09: carries the revision the operator must re-apply onto. */
export class SeriesConflictError extends Error {
  readonly currentRevision: number;
  readonly currentVersion: number;
  readonly savedAt: string;

  constructor(currentRevision: number, currentVersion: number, savedAt: string) {
    super('Series was changed by another tab at revision ' + currentRevision);
    this.name = 'SeriesConflictError';
    this.currentRevision = currentRevision;
    this.currentVersion = currentVersion;
    this.savedAt = savedAt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementation (preview + tests)
// ─────────────────────────────────────────────────────────────────────────────

export interface MemorySeriesProject {
  readonly id: string;
  /** Per-stage pin: stage code → series version. Never touched by an edit. */
  readonly pins: Readonly<Record<string, number>>;
}

export interface MemorySeriesSeed {
  readonly detail: SeriesDetail;
  readonly versions: readonly SeriesVersionDetail[];
  readonly projects?: readonly MemorySeriesProject[];
  readonly inFlightBatches?: number;
  readonly inFlightVideos?: number;
}

export interface MemorySeriesGateway extends SeriesGateway {
  seriesCount(): number;
  projectsOf(seriesId: string): readonly MemorySeriesProject[];
  versionsOf(seriesId: string): readonly SeriesVersionDetail[];
}

interface Entry {
  detail: SeriesDetail;
  versions: SeriesVersionDetail[];
  projects: MemorySeriesProject[];
  inFlightVideos: number | null;
}

const clone = <T>(value: T): T => structuredClone(value);

const summaryOf = (detail: SeriesDetail): SeriesSummary =>
  SeriesSummarySchema.parse({
    id: detail.id,
    name: detail.name,
    slug: detail.slug,
    mode: detail.mode,
    status: detail.status,
    current_version: detail.current_version,
    current_version_id: detail.current_version_id,
    target_duration_s: detail.target_duration_s,
    default_aspect_ratio: detail.default_aspect_ratio,
    revision: detail.revision,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  });

/** Dotted leaf paths that differ, so `changed_fields` names real fields. */
function diffPaths(before: unknown, after: unknown, prefix = ''): string[] {
  const bothObjects =
    typeof before === 'object' &&
    before !== null &&
    typeof after === 'object' &&
    after !== null &&
    !Array.isArray(before) &&
    !Array.isArray(after);

  if (!bothObjects) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
  }

  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
  const paths: string[] = [];
  for (const key of keys) {
    const child = prefix.length === 0 ? key : prefix + '.' + key;
    paths.push(...diffPaths(beforeRecord[key], afterRecord[key], child));
  }
  return paths;
}

export function createMemorySeriesGateway(
  seed: MemorySeriesSeed,
  options: { readonly now?: () => number } = {},
): MemorySeriesGateway {
  const now = options.now ?? ((): number => Date.now());
  const stamp = (): string => new Date(now()).toISOString();
  const entries = new Map<string, Entry>();
  let counter = 0;

  entries.set(seed.detail.id, {
    detail: clone(seed.detail),
    versions: clone([...seed.versions]),
    projects: clone([...(seed.projects ?? [])]),
    inFlightVideos: seed.inFlightVideos ?? null,
  });
  if (seed.inFlightBatches !== undefined) {
    const entry = entries.get(seed.detail.id);
    if (entry !== undefined) {
      entry.detail = { ...entry.detail, in_flight_batches: seed.inFlightBatches };
    }
  }

  const uuid = (): string => {
    counter += 1;
    return 'aaaaaaaa-0000-4000-8000-' + String(counter).padStart(12, '0');
  };

  const requireEntry = (seriesId: string): Entry => {
    const entry = entries.get(seriesId);
    if (entry === undefined) throw new SeriesNotFoundError(seriesId);
    return entry;
  };

  return {
    async list(): Promise<readonly SeriesSummary[]> {
      return [...entries.values()].map((entry) => summaryOf(entry.detail));
    },

    async get(seriesId: string): Promise<SeriesDetail | null> {
      const entry = entries.get(seriesId);
      return entry === undefined ? null : SeriesDetailSchema.parse(clone(entry.detail));
    },

    async create(input: SeriesCreateInput): Promise<SeriesDetail> {
      for (const entry of entries.values()) {
        if (entry.detail.slug === input.slug) throw new SeriesSlugTakenError(input.slug);
      }
      const id = uuid();
      const versionId = uuid();
      const timestamp = stamp();
      const mode = input.profile['mode'];
      const duration = input.profile['target_duration_s'];
      const aspect = input.profile['default_aspect_ratio'];
      if (mode !== 'factual' && mode !== 'creative') {
        throw new Error('create() requires a validated profile (mode)');
      }
      const detail = SeriesDetailSchema.parse({
        id,
        name: input.name,
        slug: input.slug,
        mode,
        status: 'active',
        current_version: 1,
        current_version_id: versionId,
        target_duration_s: typeof duration === 'number' ? duration : 75,
        default_aspect_ratio: typeof aspect === 'string' ? aspect : '9:16',
        revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
        profile: input.profile,
        version_count: 1,
        in_flight_batches: 0,
      });
      const version: SeriesVersionDetail = {
        id: versionId,
        series_id: id,
        version: 1,
        mode,
        target_duration_s: detail.target_duration_s,
        changed_fields: Object.keys(input.profile).sort(),
        created_at: timestamp,
        created_by: 'operator',
        snapshot: clone(input.profile) as SeriesDetail['profile'],
        pinned_by: [],
      };
      entries.set(id, {
        detail,
        versions: [version],
        projects: [],
        inFlightVideos: null,
      });
      return clone(detail);
    },

    async update(seriesId: string, input: SeriesUpdateInput): Promise<SeriesDetail> {
      const entry = requireEntry(seriesId);
      if (entry.detail.status === 'archived') throw new SeriesArchivedError();
      if (entry.detail.revision !== input.revision) {
        throw new SeriesConflictError(
          entry.detail.revision,
          entry.detail.current_version,
          entry.detail.updated_at,
        );
      }

      const nextProfile = clone(input.profile ?? entry.detail.profile);
      const nextName = input.name ?? entry.detail.name;
      const changed = [
        ...(nextName === entry.detail.name ? [] : ['name']),
        ...diffPaths(entry.detail.profile, nextProfile),
      ];
      // An edit that changes nothing is not an edit (R-002-1).
      if (changed.length === 0) return SeriesDetailSchema.parse(clone(entry.detail));

      const mode = nextProfile['mode'];
      const duration = nextProfile['target_duration_s'];
      const aspect = nextProfile['default_aspect_ratio'];
      if (mode !== 'factual' && mode !== 'creative') {
        throw new Error('update() requires a validated profile (mode)');
      }

      const version = entry.detail.current_version + 1;
      const versionId = uuid();
      const timestamp = stamp();
      const versionRow: SeriesVersionDetail = {
        id: versionId,
        series_id: seriesId,
        version,
        mode,
        target_duration_s: typeof duration === 'number' ? duration : entry.detail.target_duration_s,
        changed_fields: changed,
        created_at: timestamp,
        created_by: 'operator',
        snapshot: clone(nextProfile) as SeriesDetail['profile'],
        pinned_by: [],
      };

      entry.detail = SeriesDetailSchema.parse({
        ...entry.detail,
        name: nextName,
        mode,
        current_version: version,
        current_version_id: versionId,
        target_duration_s: versionRow.target_duration_s,
        default_aspect_ratio:
          typeof aspect === 'string' ? aspect : entry.detail.default_aspect_ratio,
        revision: entry.detail.revision + 1,
        updated_at: timestamp,
        profile: nextProfile,
        version_count: entry.detail.version_count + 1,
      });
      entry.versions = [...entry.versions, versionRow];
      // entry.projects is deliberately untouched: R-002-3.
      return SeriesDetailSchema.parse(clone(entry.detail));
    },

    async inFlightVideos(seriesId: string): Promise<number | null> {
      return entries.get(seriesId)?.inFlightVideos ?? null;
    },

    async createBatch(seriesId: string): Promise<BatchCreated> {
      const entry = requireEntry(seriesId);
      if (entry.detail.status === 'archived') throw new SeriesArchivedError();
      const raw = entry.detail.profile['videos_per_batch'];
      const projectCount = typeof raw === 'number' ? Math.min(Math.max(Math.trunc(raw), 1), 30) : 1;
      const batchId = uuid();
      entry.detail = SeriesDetailSchema.parse({
        ...entry.detail,
        in_flight_batches: entry.detail.in_flight_batches + 1,
      });
      return { batchId, projectCount };
    },

    seriesCount(): number {
      return entries.size;
    },

    projectsOf(seriesId: string): readonly MemorySeriesProject[] {
      return clone(entries.get(seriesId)?.projects ?? []);
    },

    versionsOf(seriesId: string): readonly SeriesVersionDetail[] {
      return clone(entries.get(seriesId)?.versions ?? []);
    },
  };
}
