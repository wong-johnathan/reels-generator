import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ROUTES } from './api.js';
import { OPENAPI_FILE, buildOpenApiDocument } from '../scripts/generate-openapi.js';

describe('OpenAPI document', () => {
  const generated = buildOpenApiDocument();
  const onDisk = parse(readFileSync(OPENAPI_FILE, 'utf8')) as Record<string, unknown>;

  it('is regenerated from the contract (npm run contract:openapi)', () => {
    expect(onDisk).toEqual(generated);
  });

  it('documents every route once with an operation id and a 2xx response', () => {
    const paths = generated.paths as Record<string, Record<string, Record<string, unknown>>>;
    const operations = Object.values(paths).flatMap((byMethod) => Object.values(byMethod));
    expect(operations).toHaveLength(ROUTES.length);

    const ids = operations.map((operation) => String(operation.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(ROUTES.map((route) => route.id)));

    for (const operation of operations) {
      const responses = operation.responses as Record<string, unknown>;
      const statuses = Object.keys(responses);
      expect(statuses.some((status) => status.startsWith('2'))).toBe(true);
    }
  });

  it('declares every path parameter it uses', () => {
    const paths = generated.paths as Record<string, Record<string, Record<string, unknown>>>;
    for (const [path, byMethod] of Object.entries(paths)) {
      const expected = Array.from(path.matchAll(/:([A-Za-z0-9_]+)/g), (match) => match[1]);
      for (const operation of Object.values(byMethod)) {
        const params =
          (operation.parameters as Array<{ name: string; in: string }> | undefined) ?? [];
        expect(params.filter((p) => p.in === 'path').map((p) => p.name)).toEqual(expected);
      }
    }
  });

  it('models the SSE endpoint as text/event-stream', () => {
    const paths = generated.paths as Record<string, Record<string, Record<string, unknown>>>;
    const events = paths['/api/events']?.get as Record<string, Record<string, unknown>>;
    const responses = events.responses as Record<string, Record<string, unknown>>;
    const ok = responses['200'] as { content: Record<string, unknown> };
    expect(Object.keys(ok.content)).toEqual(['text/event-stream']);
  });
});
