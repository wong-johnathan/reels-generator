/**
 * Small HTTP helpers shared by the API handlers.
 *
 * The response shape is the middleware's `HttpResponse`, so a handler can be
 * driven directly by `createRequestHandler` in tests and by a real socket in
 * production without an adapter in between.
 */
import type { z } from 'zod';

import type { HttpResponse } from '../web/middleware/auth.js';

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/** Authenticated payloads are per-operator and must not be cached. */
function noStore(
  headers: Record<string, string | readonly string[]>,
): Record<string, string | readonly string[]> {
  return { ...headers, 'cache-control': 'no-store' };
}

export function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string | readonly string[]> = {},
): HttpResponse {
  return {
    status,
    headers: noStore({ ...JSON_HEADERS, ...headers }),
    body: JSON.stringify(payload),
  };
}

/** The contract's `ErrorEnvelopeSchema` shape (ERROR_CODES covers every code used). */
export function errorEnvelope(
  code: string,
  message: string,
  status: number,
  fields?: Record<string, string>,
  headers: Record<string, string | readonly string[]> = {},
): HttpResponse {
  const error: Record<string, unknown> = { code, message };
  if (fields !== undefined && Object.keys(fields).length > 0) error.fields = fields;
  return jsonResponse(status, { error }, headers);
}

/** Dotted field paths for `validation_failed` (contract: keyed by dotted path). */
export function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map((part) => String(part)).join('.');
    fields[path.length > 0 ? path : 'body'] = issue.message;
  }
  return fields;
}

export type ParsedBody<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly fields: Record<string, string> };

/** Parse a JSON request body and validate it against a schema. */
export function parseJsonBody<T>(body: string | undefined, schema: z.ZodType<T>): ParsedBody<T> {
  if (body === undefined || body.trim().length === 0) {
    return { ok: false, fields: { body: 'a JSON body is required' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, fields: { body: 'must be valid JSON' } };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false, fields: zodFields(result.error) };
  return { ok: true, data: result.data };
}
