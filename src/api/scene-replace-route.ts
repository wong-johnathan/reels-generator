/**
 * `POST /api/videos/:videoId/scenes/:sceneId/replace-image` — US-020, RULINGS L-2.
 *
 * The route is the *enqueue* half of a per-scene replace (the contract's
 * response is QueueResponseSchema): it validates the request against the frozen
 * contract, refuses a stale scene revision (R-024 → 409, never a lost update),
 * commits the operator's prompt override together with a `queued` IM job scoped
 * to that scene, and answers with the cost the matrix says the job will incur
 * (1 image call, 0 TTS calls).
 *
 * The execution half is src/domain/scene-replace.ts::runSceneReplace.
 *
 * Auth: every contract route is `auth: true`, but the session/R-015 layer is
 * S-01's card; this handler assumes it is mounted behind that guard.
 */
import type { Pool } from 'pg';

import { ROUTES, type RouteDef } from '../../contract/api.js';
import { withTransaction } from '../db/client.js';
import { insertQueuedJob } from '../db/repositories/jobs.js';
import {
  lockSceneForReplace,
  SceneNotFoundInProjectError,
  SceneRevisionConflictError,
} from '../db/repositories/scenes.js';
import type { RetryScope } from '../domain/retry-scope.js';
import { computeInvalidation, ruleFor } from '../domain/invalidation.js';
import { SCENE_REPLACE_EDIT_KIND } from '../domain/scene-replace.js';
import type { HandlerResponse } from './server.js';

function contractRoute(): RouteDef {
  const found = ROUTES.find((route) => route.id === 'scenes.replace_image');
  if (found === undefined) {
    throw new Error('contract route scenes.replace_image is missing (LEAD_PLAN §6)');
  }
  return found;
}

const ROUTE = contractRoute();

/** The contract's request schema for this route; a missing one is a contract bug. */
const REQUEST_SCHEMA: NonNullable<RouteDef['request']> = (() => {
  const schema = ROUTE.request;
  if (schema === undefined) {
    throw new Error('contract route scenes.replace_image declares no request schema');
  }
  return schema;
})();

/** `/api/videos/:videoId/scenes/:sceneId/replace-image` */
const MATCHER = /^\/api\/videos\/([^/]+)\/scenes\/([^/]+)\/replace-image$/;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export interface SceneReplaceRouteRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

export interface SceneReplaceRouteDeps {
  readonly pool: Pool;
  readonly now?: () => Date;
  /**
   * Queue port. BullMQ registration is B-14; without it the row is still the
   * durable job (X-3) and the reconciler re-enqueues a queued job.
   */
  readonly enqueue?: (job: {
    readonly jobId: string;
    readonly projectId: string;
    readonly sceneId: string;
  }) => Promise<void>;
}

export type SceneReplaceHandler = (request: SceneReplaceRouteRequest) => Promise<HandlerResponse>;

function errorResponse(code: string, message: string, status: number): HandlerResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify({ error: { code, message } }) };
}

function conflictResponse(sceneId: string, expected: number, actual: number): HandlerResponse {
  // ConflictEnvelopeSchema (R-024 / IP-09): the client reloads, it does not merge.
  return {
    status: 409,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      error: {
        code: 'conflict',
        message:
          'scene ' +
          sceneId +
          ' is at revision ' +
          actual +
          ', the request carried ' +
          expected +
          ': reload before replacing (R-024)',
      },
      document: 'scene',
      current_revision: actual,
      your_revision: expected,
    }),
  };
}

/**
 * The cost preview shown to the operator before the job runs. It is computed
 * from the `image_replace` matrix row, so the route and the domain cannot
 * disagree about "1 image call, 0 TTS calls".
 */
export function replaceScope(sceneNo: string): RetryScope {
  const preview = computeInvalidation(ruleFor(SCENE_REPLACE_EDIT_KIND), { sceneCount: 1 });
  return {
    stage: 'IM',
    will_run: [
      {
        stage: 'IM',
        calls: preview.calls,
        detail: 'replace the image for scene ' + sceneNo + ' (one provider call)',
      },
    ],
    will_not_run: [
      {
        stage: 'IM',
        label: 'every other scene image',
        detail:
          'image_replace keeps the other scenes; only ' + sceneNo + ' is regenerated (R-007-1)',
      },
      {
        stage: 'NA',
        label: 'narration',
        detail: 'image_replace does not invalidate NA (0 TTS calls)',
      },
    ],
    unknown_charge: false,
    idempotency_protected: false,
    blockers: [],
  };
}

/**
 * Build the handler. Pure apart from the injected pool, so the route tests run
 * the real validation/transaction path without binding a socket.
 */
export function createSceneReplaceHandler(deps: SceneReplaceRouteDeps): SceneReplaceHandler {
  return async (request) => {
    const method = request.method.toUpperCase();
    const path = request.url.split('?')[0] ?? '/';
    const match = MATCHER.exec(path);
    if (match === null) return errorResponse('not_found', 'No route for ' + path, 404);
    if (method !== ROUTE.method) return errorResponse('method_not_allowed', 'POST only', 405);

    const projectId = match[1]!;
    const sceneId = match[2]!;
    const parsed = REQUEST_SCHEMA.safeParse(request.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[issue.path.join('.') || '_'] = issue.message;
      return {
        status: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          error: { code: 'validation_failed', message: 'invalid replace request', fields },
        }),
      };
    }
    const body = parsed.data as { revision: number; image_prompt?: string };

    let queued: { jobId: string; sceneNo: string; scope: RetryScope };
    try {
      queued = await withTransaction(deps.pool, async (client) => {
        const scene = await lockSceneForReplace(client, {
          projectId,
          sceneId,
          expectedRevision: body.revision,
          imagePrompt: body.image_prompt ?? null,
        });
        const scope = replaceScope(scene.scene_no);
        const job = await insertQueuedJob(client, {
          projectId,
          stage: 'IM',
          sceneId,
          retryScope: scope,
        });
        return { jobId: job.id, sceneNo: scene.scene_no, scope };
      });
    } catch (error) {
      if (error instanceof SceneNotFoundInProjectError) {
        return errorResponse('not_found', error.message, 404);
      }
      if (error instanceof SceneRevisionConflictError) {
        return conflictResponse(error.sceneId, error.expectedRevision, error.actualRevision);
      }
      throw error;
    }

    // The job row is committed; a transport hiccup cannot lose the work (X-3).
    await deps.enqueue?.({ jobId: queued.jobId, projectId, sceneId }).catch(() => undefined);

    const response = ROUTE.response.parse({
      queued: true,
      stage: 'IM',
      scope: queued.scope,
      enqueued_at: (deps.now?.() ?? new Date()).toISOString(),
    });
    return { status: 202, headers: JSON_HEADERS, body: JSON.stringify(response) };
  };
}
