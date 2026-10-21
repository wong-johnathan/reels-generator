/** CSS reading helpers for the design-token and responsive-band tests. */

export function blockStartingAt(css: string, openBrace: number): string {
  let depth = 0;
  for (let index = openBrace; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(openBrace + 1, index);
    }
  }
  throw new Error('unbalanced CSS block');
}

/** Body of the first block whose prelude is exactly `selector` (whitespace-insensitive). */
export function extractBlock(css: string, selector: string): string {
  // Compare preludes with whitespace and comments removed, so a formatter that
  // wraps `html, body` across lines still matches.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  const wanted = selector.replace(/\s+/g, '');
  let prelude = '';

  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (char === '{') {
      if (prelude.replace(/\s+/g, '') === wanted) return blockStartingAt(css, index);
      prelude = '';
      continue;
    }
    if (char === '}' || char === ';') {
      prelude = '';
      continue;
    }
    prelude += char;
  }

  throw new Error('no block for selector: ' + selector);
}

export interface MediaBlock {
  readonly query: string;
  readonly body: string;
}

export function mediaBlocks(css: string): MediaBlock[] {
  const blocks: MediaBlock[] = [];
  const pattern = /@media([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const body = blockStartingAt(css, match.index + match[0].length - 1);
    blocks.push({ query: (match[1] ?? '').trim(), body });
  }
  return blocks;
}

export function customProperties(block: string): Record<string, string> {
  const props: Record<string, string> = {};
  const pattern = /--([A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) props[name] = value.trim();
  }
  return props;
}

/** WCAG 2.2 relative luminance for a #rrggbb colour. */
export function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
