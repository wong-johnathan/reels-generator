/**
 * Minimal HTML structure reader for tests.
 *
 * There is no DOM package in this repo (no jsdom, no testing-library) and the
 * shell is server-rendered strings, so accessibility and structure assertions
 * run against a small, strict reader instead of a regex. It understands quoted
 * attributes, comments, doctypes, void elements and raw-text script/style
 * elements — everything the shell renderer emits, and nothing else.
 */

export interface HtmlNode {
  readonly type: 'element' | 'text';
  /** Lower-case tag name, or "#document" for the root. */
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: HtmlNode[];
  readonly text: string;
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

const ATTRIBUTE_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1];
    if (name === undefined) continue;
    attrs[name.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { type: 'element', tag: '#document', attrs: {}, children: [], text: '' };
  const stack: HtmlNode[] = [root];
  let index = 0;

  const append = (node: HtmlNode): void => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.children.push(node);
  };
  const appendText = (raw: string): void => {
    if (raw.length === 0) return;
    append({ type: 'text', tag: '#text', attrs: {}, children: [], text: decodeEntities(raw) });
  };

  while (index < html.length) {
    const nextTag = html.indexOf('<', index);
    if (nextTag === -1) {
      appendText(html.slice(index));
      break;
    }
    if (nextTag > index) appendText(html.slice(index, nextTag));

    if (html.startsWith('<!--', nextTag)) {
      const end = html.indexOf('-->', nextTag);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', nextTag)) {
      const end = html.indexOf('>', nextTag);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = findTagEnd(html, nextTag);
    if (end === -1) {
      appendText(html.slice(nextTag));
      break;
    }
    const raw = html.slice(nextTag + 1, end);
    index = end + 1;

    if (raw.startsWith('/')) {
      const closing = raw.slice(1).trim().toLowerCase();
      const last = stack[stack.length - 1];
      if (last !== undefined && last.tag === closing) stack.pop();
      continue;
    }

    const trimmed = raw.trimEnd();
    const selfClosing = trimmed.endsWith('/');
    const body = selfClosing ? trimmed.slice(0, -1) : raw;
    const nameMatch = /^([a-zA-Z0-9-]+)/.exec(body);
    if (nameMatch === null || nameMatch[1] === undefined) continue;
    const tag = nameMatch[1].toLowerCase();
    const node: HtmlNode = {
      type: 'element',
      tag,
      attrs: parseAttributes(body.slice(nameMatch[1].length)),
      children: [],
      text: '',
    };
    append(node);

    if (VOID_ELEMENTS.has(tag) || selfClosing) continue;

    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closeToken = '</' + tag + '>';
      const closeIndex = html.toLowerCase().indexOf(closeToken, index);
      const rawText = closeIndex === -1 ? html.slice(index) : html.slice(index, closeIndex);
      if (rawText.length > 0) {
        node.children.push({
          type: 'text',
          tag: '#text',
          attrs: {},
          children: [],
          text: decodeEntities(rawText),
        });
      }
      index = closeIndex === -1 ? html.length : closeIndex + closeToken.length;
      continue;
    }

    stack.push(node);
  }

  return root;
}

export function findAll(node: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode[] {
  const found: HtmlNode[] = [];
  const walk = (current: HtmlNode): void => {
    for (const child of current.children) {
      if (child.type === 'element' && predicate(child)) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

export function byTag(node: HtmlNode, tag: string): HtmlNode[] {
  return findAll(node, (candidate) => candidate.tag === tag);
}

export function byId(node: HtmlNode, id: string): HtmlNode | undefined {
  return findAll(node, (candidate) => candidate.attrs['id'] === id)[0];
}

function rawText(node: HtmlNode): string {
  let text = node.text;
  for (const child of node.children) text += rawText(child);
  return text;
}

export function textOf(node: HtmlNode): string {
  return rawText(node).replace(/\s+/g, ' ').trim();
}

/** Text a screen reader would compute: aria-hidden subtrees are excluded. */
export function accessibleTextOf(node: HtmlNode): string {
  const walk = (current: HtmlNode): string => {
    if (current.attrs['aria-hidden'] === 'true') return '';
    let text = current.text;
    for (const child of current.children) text += walk(child);
    return text;
  };
  return walk(node).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
}

export function classesOf(node: HtmlNode): string[] {
  return (node.attrs['class'] ?? '').split(/\s+/).filter((entry) => entry.length > 0);
}

export function hasClass(node: HtmlNode, name: string): boolean {
  return classesOf(node).includes(name);
}
