/**
 * Series API handlers — `series.list/create/get/update` and
 * `series.versions.list/get/mint` (contract/api.ts ROUTES).
 *
 * Auth is already decided by `src/web/middleware/auth.ts` before this module
 * runs: every series route is `auth: true` and every mutating method has passed
 * the CSRF check. This module therefore only does routing, validation, the
 * domain call and error → contract-envelope mapping.
 *
 * Response bodies are validated against the contract's response schemas before
 * they are serialised, so a domain change that drifts from the frozen shapes
 * fails a test instead of shipping a shape the SPA cannot read.
 *
 * C-B14-1: the frozen contract bounds `target_duration_s` at 15–300 in
 * `SeriesProfileSchema`/`SeriesCreateRequestSchema`; PRD R-009-1 (and this
 * task) say 10–180 with 75 as the default. The PRD bound is enforced here and
 * only that one field is re-declared; every other constraint is the contract's.
 */
import type { Pool } from 'pg';

import {
  SeriesCreateRequestSchema,
  SeriesUpdateRequestSchema,
  UuidSchema,
} from '../../contract/api.js';
import type { AuthenticatedSession } from '../auth/types.js';
import {
  createSeries,
  DuplicateSlugError,
  getSeries,
  getSeriesVersion,
  listSeries,
  listSeriesVersions,
  MAX_TARGET_DURATION_S,
  MIN_TARGET_DURATION_S,
  mintSeriesVersion,
  RevisionConflictError,
  SeriesDetailResponseSchema,
  SeriesNoChangeError,
  SeriesNotFoundError,
  SeriesProfileResponseSchema,
  SeriesSummaryResponseSchema,
  SeriesVersionDetailResponseSchema,
  SeriesVersionNotFoundError,
  SeriesVersionSummaryResponseSchema,
  TargetDurationError,
  updateSeries,
  type SeriesProfilePatch,
} from '../domain/series.js';
import { redactText } from '../security/redact.js';
import { requestPath, type HttpRequestLike, type HttpResponse } from '../web/middleware/auth.js';
import { errorEnvelope, jsonResponse, parseJsonBody } from './http.js';

export interface SeriesRoutesDeps {
  readonly pool: Pool;
}

/**
 * The contract's request schemas with the PRD's duration bound. Everything else
 * (slug pattern, required name, revision floor, optional profile) is untouched.
 */
export const SeriesCreateRequestWithPrdBoundsSchema = SeriesCreateRequestSchema.extend({
  profile: SeriesProfileResponseSchema.partial().optional(),
});

export const SeriesUpdateRequestWithPrdBoundsSchema = SeriesUpdateRequestSchema.extend({
  profile: SeriesProfileResponseSchema.partial().optional(),
});

function methodHeaders(allow: string): Record<string, string> {
  return { allow };
}

function notFound(message: string): HttpResponse {
  return errorEnvelope('not_found', message, 404);
}

function validationFailed(message: string, fields: Record<string, string>): HttpResponse {
  return errorEnvelope('validation_failed', message, 400, fields);
}

function methodNotAllowed(allow: string): HttpResponse {
  return errorEnvelope(
    'method_not_allowed',
    `Allowed methods: ${allow}`,
    405,
    undefined,
    methodHeaders(allow),
  );
}

/** R-024: 409 with the current revision, never a lost update. */
function revisionConflict(error: RevisionConflictError): HttpResponse {
  return jsonResponse(409, {
    error: { code: 'conflict', message: error.message },
    document: 'series',
    current_revision: error.currentRevision,
    your_revision: error.yourRevision,
  });
}

function mapError(error: unknown): HttpResponse {
  if (error instanceof SeriesNotFoundError || error instanceof SeriesVersionNotFoundError) {
    return notFound(error.message);
  }
  if (error instanceof RevisionConflictError) return revisionConflict(error);
  if (error instanceof DuplicateSlugError) {
    return errorEnvelope('conflict', error.message, 409);
  }
  if (error instanceof SeriesNoChangeError) {
    return validationFailed(error.message, { profile: error.message });
  }
  if (error instanceof TargetDurationError) {
    return validationFailed(error.message, {
      target_duration_s: `must be between ${MIN_TARGET_DURATION_S} and ${MAX_TARGET_DURATION_S}`,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return errorEnvelope('internal', redactText(message), 500);
}

function isUuid(value: string): boolean {
  return UuidSchema.safeParse(value).success;
}

function profileOf(body: { profile?: SeriesProfilePatch }): SeriesProfilePatch | undefined {
  return body.profile;
}

async function handleList(deps: SeriesRoutesDeps): Promise<HttpResponse> {
  const series = await listSeries(deps.pool);
  return jsonResponse(200, {
    series: series.map((summary) => SeriesSummaryResponseSchema.parse(summary)),
  });
}

async function handleCreate(
  request: HttpRequestLike,
  session: AuthenticatedSession,
  deps: SeriesRoutesDeps,
): Promise<HttpResponse> {
  const body = parseJsonBody(request.body, SeriesCreateRequestWithPrdBoundsSchema);
  if (!body.ok) return validationFailed('The series request is invalid', body.fields);

  const detail = await createSeries(deps.pool, {
    name: body.data.name,
    slug: body.data.slug,
    ...(body.data.profile === undefined ? {} : { profile: profileOf(body.data) }),
    operatorId: session.operatorId,
  });
  return jsonResponse(201, SeriesDetailResponseSchema.parse(detail));
}

async function handleGet(seriesId: string, deps: SeriesRoutesDeps): Promise<HttpResponse> {
  const detail = await getSeries(deps.pool, seriesId);
  return jsonResponse(200, SeriesDetailResponseSchema.parse(detail));
}

async function handleUpdate(
  seriesId: string,
  request: HttpRequestLike,
  session: AuthenticatedSession,
  deps: SeriesRoutesDeps,
): Promise<HttpResponse> {
  const body = parseJsonBody(request.body, SeriesUpdateRequestWithPrdBoundsSchema);
  if (!body.ok) return validationFailed('The series edit is invalid', body.fields);

  const detail = await updateSeries(deps.pool, {
    seriesId,
    revision: body.data.revision,
    ...(body.data.name === undefined ? {} : { name: body.data.name }),
    ...(body.data.profile === undefined ? {} : { profile: profileOf(body.data) }),
    operatorId: session.operatorId,
  });
  return jsonResponse(200, SeriesDetailResponseSchema.parse(detail));
}

async function handleListVersions(seriesId: string, deps: SeriesRoutesDeps): Promise<HttpResponse> {
  const versions = await listSeriesVersions(deps.pool, seriesId);
  return jsonResponse(200, {
    versions: versions.map((version) => SeriesVersionSummaryResponseSchema.parse(version)),
  });
}

async function handleGetVersion(
  seriesId: string,
  versionId: string,
  deps: SeriesRoutesDeps,
): Promise<HttpResponse> {
  const version = await getSeriesVersion(deps.pool, seriesId, versionId);
  return jsonResponse(200, SeriesVersionDetailResponseSchema.parse(version));
}

async function handleMint(
  seriesId: string,
  request: HttpRequestLike,
  session: AuthenticatedSession,
  deps: SeriesRoutesDeps,
): Promise<HttpResponse> {
  const body = parseJsonBody(request.body, SeriesUpdateRequestWithPrdBoundsSchema);
  if (!body.ok) return validationFailed('The version request is invalid', body.fields);

  const version = await mintSeriesVersion(deps.pool, {
    seriesId,
    revision: body.data.revision,
    ...(body.data.name === undefined ? {} : { name: body.data.name }),
    ...(body.data.profile === undefined ? {} : { profile: profileOf(body.data) }),
    operatorId: session.operatorId,
  });
  return jsonResponse(201, SeriesVersionDetailResponseSchema.parse(version));
}

/**
 * Route one request. Returns `null` when the path is not a series route, so the
 * caller can fall through to the next handler (and eventually 404).
 */
export async function handleSeriesRequest(
  request: HttpRequestLike,
  session: AuthenticatedSession,
  deps: SeriesRoutesDeps,
): Promise<HttpResponse | null> {
  const path = requestPath(request.url);
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments[0] !== 'api' || segments[1] !== 'series') return null;

  const method = request.method.toUpperCase();

  try {
    if (segments.length === 2) {
      if (method === 'GET') return await handleList(deps);
      if (method === 'POST') return await handleCreate(request, session, deps);
      return methodNotAllowed('GET, POST');
    }

    const seriesId = segments[2];
    if (seriesId === undefined) return null;

    if (segments.length === 3) {
      if (!isUuid(seriesId)) return notFound(`series ${seriesId} does not exist`);
      if (method === 'GET') return await handleGet(seriesId, deps);
      if (method === 'PATCH') return await handleUpdate(seriesId, request, session, deps);
      return methodNotAllowed('GET, PATCH');
    }

    if (segments[3] !== 'versions') return null;

    if (segments.length === 4) {
      if (!isUuid(seriesId)) return notFound(`series ${seriesId} does not exist`);
      if (method === 'GET') return await handleListVersions(seriesId, deps);
      if (method === 'POST') return await handleMint(seriesId, request, session, deps);
      return methodNotAllowed('GET, POST');
    }

    if (segments.length === 5) {
      const versionId = segments[4];
      if (versionId === undefined) return null;
      if (!isUuid(seriesId) || !isUuid(versionId)) {
        return notFound(`series ${seriesId} has no version ${versionId}`);
      }
      if (method === 'GET') return await handleGetVersion(seriesId, versionId, deps);
      return methodNotAllowed('GET');
    }

    return null;
  } catch (error) {
    return mapError(error);
  }
}
