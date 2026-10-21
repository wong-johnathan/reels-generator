/**
 * A tiny mutable DOM for enhancer tests.
 *
 * There is no jsdom in this repo (no DOM package is installable here), so the
 * client tests drive `client/workspace.ts` through a small element model built
 * from the *real* server-rendered HTML (helpers/html.ts). That keeps the test
 * honest: the enhancer is exercised against the markup the renderer emits, not
 * against a hand-written stand-in that could drift from it.
 *
 * Supported selectors — exactly the ones the enhancer uses:
 *   `tag`, `#id`, `[attr]`, `[attr="value"]`, `tag[attr]`, `tag[attr="value"]`,
 *   and one descendant step (`[data-stage] a`).
 */
import { parseHtml, type HtmlNode } from './html.js';

function splitSelector(selector: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of selector) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ' ') {
      if (current.trim().length > 0) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

const SIMPLE = /^([a-zA-Z0-9-]+)?(?:#([a-zA-Z0-9_-]+))?((?:\.[a-zA-Z0-9_-]+|\[[^\]]+\])*)$/;

interface SimpleSelector {
  readonly tag: string | null;
  readonly id: string | null;
  readonly attrs: readonly (readonly [string, string | null])[];
  readonly classes: readonly string[];
}

function parseSimple(selector: string): SimpleSelector | null {
  const match = SIMPLE.exec(selector);
  if (match === null) return null;
  const attrs: Array<readonly [string, string | null]> = [];
  const classes: string[] = [];
  for (const token of match[3]?.matchAll(/\.[a-zA-Z0-9_-]+|\[[^\]]+\]/g) ?? []) {
    const value = token[0];
    if (value.startsWith('.')) {
      classes.push(value.slice(1));
      continue;
    }
    const attr = /^\[([^\]="]+)(?:="([^"]*)")?\]$/.exec(value);
    if (attr?.[1] !== undefined) attrs.push([attr[1], attr[2] ?? null]);
  }
  return { tag: match[1] ?? null, id: match[2] ?? null, attrs, classes };
}

export class FakeElement {
  readonly tag: string;
  readonly attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  hidden = false;
  focused = false;
  /** Form controls only: the enhancer reads and writes the property, as a browser does. */
  value = '';
  private text = '';

  constructor(tag: string, attrs: Readonly<Record<string, string>> = {}) {
    this.tag = tag.toLowerCase();
    for (const [name, value] of Object.entries(attrs)) this.attrs[name.toLowerCase()] = value;
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.text = value;
    for (const child of this.children) child.parent = null;
    this.children = [];
  }

  get innerHTML(): string {
    // Only used for assertions in these tests; the enhancer only ever sets it.
    return this.children.map((child) => child.outerHtml()).join('');
  }

  set innerHTML(value: string) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = '';
    const parsed = parseHtml(value);
    this.appendNodes(parsed.children, '');
  }

  outerHtml(): string {
    const attrs = Object.entries(this.attrs)
      .map(([name, value]) => ' ' + name + '="' + value + '"')
      .join('');
    return (
      '<' +
      this.tag +
      attrs +
      '>' +
      this.text +
      this.children.map((child) => child.outerHtml()).join('') +
      '</' +
      this.tag +
      '>'
    );
  }

  get tagName(): string {
    return this.tag.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.attrs[name.toLowerCase()] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name.toLowerCase()] = value;
  }

  removeAttribute(name: string): void {
    delete this.attrs[name.toLowerCase()];
  }

  matches(selector: string): boolean {
    const simple = parseSimple(selector);
    if (simple === null) return false;
    if (simple.tag !== null && this.tag !== simple.tag.toLowerCase()) return false;
    if (simple.id !== null && this.attrs['id'] !== simple.id) return false;
    for (const [name, value] of simple.attrs) {
      if (!(name.toLowerCase() in this.attrs)) return false;
      if (value !== null && this.attrs[name.toLowerCase()] !== value) return false;
    }
    const classList = (this.attrs['class'] ?? '').split(/\s+/);
    for (const name of simple.classes) {
      if (!classList.includes(name)) return false;
    }
    return true;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = splitSelector(selector);
    const last = parts[parts.length - 1];
    if (last === undefined) return [];
    let pool: FakeElement[] = [this];
    for (const part of parts.slice(0, -1)) {
      const next: FakeElement[] = [];
      for (const candidate of pool) next.push(...candidate.descendants(part));
      pool = next;
    }
    const found: FakeElement[] = [];
    for (const candidate of pool) {
      for (const descendant of candidate.descendants(last)) {
        if (!found.includes(descendant)) found.push(descendant);
      }
    }
    return found;
  }

  descendants(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  focus(): void {
    this.focused = true;
    if (this.owner !== null) this.owner.activeElement = this;
  }

  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  owner: FakeDocument | null = null;

  private appendNodes(nodes: readonly HtmlNode[], inheritedText: string): void {
    if (inheritedText.length > 0) this.text += inheritedText;
    for (const node of nodes) {
      if (node.type === 'text') {
        this.text += node.text;
        continue;
      }
      const element = new FakeElement(node.tag, node.attrs);
      element.owner = this.owner;
      this.append(element);
      element.appendNodes(node.children, '');
      // A browser exposes a control's current value as a property; the
      // enhancers read `value`, so the fake DOM must do the same.
      if (element.tag === 'textarea') element.value = element.textContent;
      else if (element.tag === 'input') element.value = node.attrs['value'] ?? '';
    }
  }
}

export class FakeDocument {
  readonly roots: FakeElement[] = [];
  activeElement: FakeElement | null = null;
  private keydown: Array<
    (event: { key: string; target?: FakeElement | null; preventDefault?: () => void }) => void
  > = [];

  addRoot(html: string): FakeElement {
    const parsed = parseHtml(html);
    const wrapper = new FakeElement('#document');
    wrapper.owner = this;
    wrapper.appendNodesFrom(parsed.children);
    for (const child of wrapper.children) {
      child.owner = this;
      this.roots.push(child);
    }
    return wrapper;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = splitSelector(selector);
    const last = parts[parts.length - 1];
    if (last === undefined) return [];
    const found: FakeElement[] = [];
    let pool: FakeElement[] = this.roots;
    for (const part of parts.slice(0, -1)) {
      const next: FakeElement[] = [];
      for (const candidate of pool) next.push(...candidate.descendants(part));
      pool = next;
    }
    for (const candidate of pool) {
      for (const descendant of candidate.descendants(last)) {
        if (!found.includes(descendant)) found.push(descendant);
      }
    }
    return found;
  }

  addEventListener(type: string, handler: (event: { key: string }) => void): void {
    if (type === 'keydown') this.keydown.push(handler);
  }

  press(key: string, target: FakeElement | null = null): void {
    for (const handler of this.keydown) handler({ key, target });
  }
}

declare module './fake-dom.js' {
  // Augment FakeElement for the parser helper below.
  interface FakeElement {
    appendNodesFrom(nodes: readonly HtmlNode[]): void;
  }
}

FakeElement.prototype.appendNodesFrom = function appendNodesFrom(
  this: FakeElement,
  nodes: readonly HtmlNode[],
): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      this.textContent += node.text;
      continue;
    }
    const element = new FakeElement(node.tag, node.attrs);
    element.owner = this.owner;
    this.append(element);
    element.appendNodesFrom(node.children);
    if (element.tag === 'textarea') element.value = element.textContent;
    else if (element.tag === 'input') element.value = node.attrs['value'] ?? '';
  }
};
