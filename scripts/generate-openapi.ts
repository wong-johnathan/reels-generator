/**
 * Generates `contract/openapi.yaml` from the zod schemas in `contract/api.ts`
 * (LEAD_PLAN §6: "openapi.yaml — generated from the schemas").
 *
 * Run `npm run contract:openapi` after changing the contract; the test in
 * `contract/openapi.test.ts` fails when the checked-in file drifts.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';
import { stringify } from 'yaml';

import { ROUTES, type RouteDef } from '../contract/api.js';

export type JsonSchema = Record<string, unknown>;

/** zod → JSON Schema (OpenAPI 3.1 dialect), with the dialect marker removed. */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as JsonSchema;
  // OpenAPI 3.1 does not carry zod's `$schema` dialect marker.
  const rest: JsonSchema = { ...json };
  delete rest['$schema'];
  return rest;
}

function pathParameters(path: string): JsonSchema[] {
  return path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => {
      const name = segment.slice(1);
      return {
        name,
        in: 'path',
        required: true,
        schema: name === 'stage' ? { type: 'string' } : { type: 'string', format: 'uuid' },
      };
    });
}

function responsesFor(route: RouteDef): JsonSchema {
  const status = String(route.status ?? 200);
  const mediaType = route.contentType ?? 'application/json';
  const ok = {
    description: route.summary,
    content: { [mediaType]: { schema: toJsonSchema(route.response) } },
  };
  const responses: JsonSchema = { [status]: ok };
  if (route.auth) {
    responses['401'] = { description: 'Session required (R-015-4)' };
    responses['409'] = { description: 'Revision conflict (R-024)' };
  }
  if (route.request) {
    responses['400'] = { description: 'Validation failed' };
  }
  return responses;
}

export function buildOpenApiDocument(): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};

  for (const route of ROUTES as readonly RouteDef[]) {
    const operation: JsonSchema = {
      operationId: route.id,
      summary: route.summary,
      tags: [route.path.startsWith('/api/videos') ? 'video' : (route.path.split('/')[1] ?? 'root')],
      'x-milestone': route.milestone,
      responses: responsesFor(route),
    };

    const parameters = pathParameters(route.path);
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.request) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: toJsonSchema(route.request) } },
      };
    }

    const key = route.method.toLowerCase();
    paths[route.path] = { ...(paths[route.path] ?? {}), [key]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'reels-generator API',
      version: '1.0.0',
      description:
        'Milestone A contract. Generated from contract/api.ts — do not edit by hand (npm run contract:openapi).',
    },
    servers: [{ url: 'http://localhost:8080' }],
    paths,
  };
}

export function renderOpenApiYaml(): string {
  return stringify(buildOpenApiDocument(), { lineWidth: 0, sortMapEntries: false });
}

export const OPENAPI_FILE = fileURLToPath(new URL('../contract/openapi.yaml', import.meta.url));

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  writeFileSync(OPENAPI_FILE, renderOpenApiYaml(), 'utf8');
  console.log(`wrote ${OPENAPI_FILE} — ${ROUTES.length} operations from contract/api.ts`);
}
