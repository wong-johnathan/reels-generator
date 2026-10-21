/** HTML escaping for server-rendered strings. Every interpolation goes through it. */

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

/** Attribute values are quoted with double quotes, so the same escaping applies. */
export function escapeAttr(value: string): string {
  return escapeHtml(value);
}
