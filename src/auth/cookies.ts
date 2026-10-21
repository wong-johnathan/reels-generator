/**
 * Cookie parsing and serialisation (R-015-2).
 *
 * The session cookie is httpOnly + SameSite=Lax; `Secure` is added only when the
 * deployment terminates TLS (the LAN-only default is plain HTTP, documented in
 * TECH_DESIGN §10). Parsing is deliberately forgiving: a malformed cookie is
 * ignored, never an error, so a broken client cannot turn into a 500.
 */
export interface CookieAttributes {
  readonly maxAgeSeconds?: number;
  readonly expires?: Date;
  readonly path?: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: 'Lax' | 'Strict' | 'None';
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse a `Cookie` header. The first occurrence of a name wins. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name.length === 0 || name in jar) continue;
    let value = part.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    jar[name] = decode(value);
  }
  return jar;
}

/** Serialise one `Set-Cookie` value. Attribute order is stable for tests and logs. */
export function serializeCookie(
  name: string,
  value: string,
  attributes: CookieAttributes = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (attributes.maxAgeSeconds !== undefined) parts.push(`Max-Age=${attributes.maxAgeSeconds}`);
  if (attributes.expires !== undefined) parts.push(`Expires=${attributes.expires.toUTCString()}`);
  parts.push(`Path=${attributes.path ?? '/'}`);
  if (attributes.httpOnly) parts.push('HttpOnly');
  if (attributes.secure) parts.push('Secure');
  if (attributes.sameSite) parts.push(`SameSite=${attributes.sameSite}`);
  return parts.join('; ');
}

/** Expire a cookie on the client (logout). */
export function clearCookie(name: string, attributes: CookieAttributes = {}): string {
  return serializeCookie(name, '', {
    ...attributes,
    maxAgeSeconds: 0,
    expires: new Date(0),
  });
}
