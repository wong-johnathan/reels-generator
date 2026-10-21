/**
 * S-04 progressive enhancement (UI_SPEC §6.1 S-04 states, IP-02, UC-18/UC-19,
 * §8.5).
 *
 * Adds exactly what HTML cannot: the changed-field marks and the commit panel
 * re-computed while the operator types, the busy label on submit, and the
 * post-redirect announcement. Every rule comes from `series/fields.ts` and
 * `series/commit.ts`, the same modules the server renderer uses.
 */
import { commitState } from '../series/commit.js';
import { changedFields, createReady, createSummary, type ChangedField } from '../series/fields.js';

export interface EditorEventLike {
  preventDefault(): void;
}

export interface EditorElementLike {
  value?: string;
  checked?: boolean;
  textContent: string;
  disabled?: boolean;
  hidden?: boolean;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  addEventListener?(name: string, handler: (event?: EditorEventLike) => void): void;
}

export interface EditorDocumentLike {
  querySelector(selector: string): EditorElementLike | null;
  querySelectorAll(selector: string): EditorElementLike[];
}

export interface SavingState {
  readonly label: string;
  readonly busy: boolean;
}

/** UC-18: the label becomes a present participle, never just a spinner. */
export function savingState(mode: 'create' | 'edit', nextVersion: number): SavingState {
  return {
    label: mode === 'create' ? 'Creating…' : 'Minting v' + nextVersion + '…',
    busy: true,
  };
}

export function readFieldValue(element: EditorElementLike): string {
  const kind = element.getAttribute?.('data-kind') ?? 'text';
  if (kind === 'checkbox') return element.checked === true ? 'true' : 'false';
  if (kind === 'radio') {
    if (element.checked === true) return element.value ?? '';
    if (element.checked === false) return '';
    return element.value ?? '';
  }
  return element.value ?? '';
}

export function valuesFromElements(elements: readonly EditorElementLike[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const element of elements) {
    const path = element.getAttribute?.('data-field');
    if (path === undefined || path === null || path.length === 0) continue;
    const kind = element.getAttribute?.('data-kind') ?? 'text';
    const value = readFieldValue(element);
    if (kind === 'radio' && value === '' && path in values) continue;
    values[path] = value;
  }
  return values;
}

function setText(node: EditorElementLike | null, text: string): void {
  if (node !== null) node.textContent = text;
}

function setHidden(node: EditorElementLike | null, hidden: boolean): void {
  if (node === null) return;
  node.hidden = hidden;
  if (hidden) node.setAttribute?.('hidden', '');
  else node.removeAttribute?.('hidden');
}

export function initSeriesEditor(doc: EditorDocumentLike): boolean {
  const form = doc.querySelector('[data-series-form]');
  if (form === null) return false;

  const mode = form.getAttribute?.('data-mode') === 'create' ? 'create' : 'edit';
  const currentVersion = Number(form.getAttribute?.('data-current-version') ?? '0') || 0;
  const inFlightBatches = Number(form.getAttribute?.('data-in-flight-batches') ?? '0') || 0;
  const videosRaw = form.getAttribute?.('data-in-flight-videos');
  const inFlightVideos =
    videosRaw === null || videosRaw === undefined || videosRaw === '' ? null : Number(videosRaw);

  const fields = doc.querySelectorAll('[data-field]');
  const initial: Record<string, string> = {};
  for (const field of fields) {
    const path = field.getAttribute?.('data-field');
    if (path === undefined || path === null || path === '') continue;
    if (!(path in initial)) initial[path] = field.getAttribute?.('data-initial') ?? '';
  }

  const button = doc.querySelector('[data-commit-button]');
  const label = doc.querySelector('[data-commit-label]') ?? button;
  const spinner = doc.querySelector('[data-spinner]');
  const reason = doc.querySelector('[data-commit-reason]');
  const empty = doc.querySelector('[data-change-empty]');
  const versionNode = doc.querySelector('[data-commit-version]');
  const bodyNode = doc.querySelector('[data-commit-body]');
  const marks = doc.querySelectorAll('[data-changed-for]');
  const summaries = doc.querySelectorAll('[data-summary-for]');
  const rows = doc.querySelectorAll('[data-field-row]');

  let busy = false;

  const update = (): void => {
    const values = valuesFromElements(fields);
    const changed: readonly ChangedField[] = mode === 'edit' ? changedFields(initial, values) : [];
    const createRows = mode === 'create' ? createSummary(values) : undefined;
    const ready = mode === 'create' ? createReady(values) : undefined;
    const state = commitState({
      mode,
      currentVersion,
      changed,
      inFlightBatches,
      ...(inFlightVideos === null ? {} : { inFlightVideos }),
      ...(ready === undefined ? {} : { createReady: ready }),
      saving: busy,
    });

    setText(versionNode, state.version);
    setText(bodyNode, state.body);
    setText(label, state.saveLabel);
    if (button !== null) {
      button.disabled = state.saveDisabled;
      if (state.reason.length > 0) button.setAttribute?.('aria-describedby', 'commit-reason');
      else button.removeAttribute?.('aria-describedby');
    }
    if (reason !== null) {
      setText(reason, state.reason);
      setHidden(reason, state.reason.length === 0);
    }

    const paths = new Set(changed.map((change) => change.path));
    for (const mark of marks) {
      const path = mark.getAttribute?.('data-changed-for') ?? '';
      setHidden(mark, !paths.has(path));
    }
    for (const row of rows) {
      const path = row.getAttribute?.('data-field-row') ?? '';
      row.setAttribute?.('data-changed', paths.has(path) ? 'true' : 'false');
    }
    for (const item of summaries) {
      const path = item.getAttribute?.('data-summary-for') ?? '';
      if (createRows !== undefined) {
        const row = createRows.find((candidate) => candidate.path === path);
        setText(
          item,
          row === undefined
            ? ''
            : row.label + ': ' + (row.value.trim().length === 0 ? '(empty)' : row.value),
        );
        setHidden(item, row === undefined);
      } else {
        const change = changed.find((candidate) => candidate.path === path);
        setText(
          item,
          change === undefined ? '' : change.label + ': ' + change.from + ' → ' + change.to,
        );
        setHidden(item, change === undefined);
      }
    }
    setHidden(empty, createRows !== undefined ? true : changed.length > 0);
  };

  form.addEventListener?.('input', () => {
    if (!busy) update();
  });
  form.addEventListener?.('change', () => {
    if (!busy) update();
  });

  form.addEventListener?.('submit', (event) => {
    if (busy) {
      event?.preventDefault();
      return;
    }
    busy = true;
    const state = commitState({
      mode,
      currentVersion,
      changed: [],
      saving: true,
    });
    if (button !== null) {
      button.disabled = true;
      button.setAttribute?.('aria-busy', 'true');
    }
    setText(label, state.saveLabel);
    if (spinner !== null) spinner.hidden = false;
    form.setAttribute?.('aria-busy', 'true');
  });

  // §8.5: write the server's post-redirect message into the polite region once.
  const live = doc.querySelector('#live-status');
  const message = live?.getAttribute?.('data-message') ?? '';
  if (live !== null && message.length > 0) {
    live.textContent = '';
    live.textContent = message;
    live.setAttribute?.('data-message', '');
  }

  update();
  return true;
}

const runtimeDocument = (globalThis as { document?: EditorDocumentLike }).document;
if (runtimeDocument !== undefined) {
  initSeriesEditor(runtimeDocument);
}
