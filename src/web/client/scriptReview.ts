/**
 * S-10 progressive enhancement (UI_SPEC §6.6 W-05, §5 UC-06, UX_SPEC IP-01,
 * AX-04, AX-11; TECH_DESIGN X-2).
 *
 * Adds exactly what HTML cannot:
 *   - the unsaved marker and the live IP-01 preview, recomputed through the
 *     server's `video.invalidation_preview` endpoint (never locally, DI-02);
 *   - the two commits, with the no-spend one first and the spend one disabled
 *     until a complete preview has rendered (AX-04);
 *   - the approval commit, which swaps the control for its record line and
 *     repaints the rail from the authoritative `video.get` response, so the
 *     image and narration stages stop showing `blocked`;
 *   - the 409 conflict banner (IP-09) that keeps the typed text.
 *
 * It never computes an invalidation, a call count or a claim verdict: those are
 * the server's, and the browser only formats them with `script/impact.ts` and
 * `script/model.ts` — the same modules the server renderer uses.
 */
import { isoSeconds } from '../format.js';
import { readyImpact, computingImpact, failedImpact, idleImpact } from '../script/impact.js';
import type { ImpactView, InvalidationPreview } from '../script/impact.js';
import type { ScriptView } from '../script/model.js';
import type { StageSnapshot, StageState } from '../workspace/events.js';
import { paintStages } from '../workspace/railDom.js';
import type { RailDocument } from '../workspace/railDom.js';
import type { VideoDetail } from '../workspace/model.js';

export interface ScriptElement {
  value?: string;
  textContent: string;
  innerHTML?: string;
  hidden?: boolean;
  disabled?: boolean;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  remove?(): void;
  addEventListener?(type: string, handler: () => void): void;
}

export interface ScriptDocument extends RailDocument {
  querySelector(selector: string): ScriptElement | null;
  querySelectorAll(selector: string): ArrayLike<ScriptElement>;
}

export interface Conflict {
  readonly current_revision: number;
  readonly your_revision: number;
}

export interface ScriptContent {
  readonly script: string;
  readonly title: string;
  readonly description: string;
  readonly hashtags: readonly string[];
}

export interface PreviewRequest {
  readonly revision: number;
  readonly edits: readonly { readonly edit_kind: 'script_wording' }[];
  readonly script_content: ScriptContent;
}

export type PreviewResult =
  | { readonly kind: 'ok'; readonly preview: InvalidationPreview }
  | { readonly kind: 'conflict'; readonly conflict: Conflict }
  | { readonly kind: 'failed' };

export type SaveResult =
  | { readonly kind: 'ok'; readonly script: ScriptView }
  | { readonly kind: 'conflict'; readonly conflict: Conflict }
  | { readonly kind: 'failed' };

export type ApproveResult =
  | { readonly kind: 'ok'; readonly script: ScriptView }
  | { readonly kind: 'conflict'; readonly conflict: Conflict }
  | { readonly kind: 'failed' };

export type LoadResult =
  { readonly kind: 'ok'; readonly script: ScriptView } | { readonly kind: 'failed' };

export interface ScriptApi {
  preview(videoId: string, body: PreviewRequest): Promise<PreviewResult>;
  save(videoId: string, body: { revision: number; content: ScriptContent }): Promise<SaveResult>;
  approve(videoId: string, body: { revision: number }): Promise<ApproveResult>;
  load(videoId: string): Promise<LoadResult>;
  video(videoId: string): Promise<VideoDetail | null>;
  rerun(
    videoId: string,
    stage: string,
    body: { confirm_scope: true },
  ): Promise<{ readonly kind: 'ok' } | { readonly kind: 'failed' }>;
}

export interface ScriptEnvironment {
  readonly api: ScriptApi;
  /** Injected in tests so no timer runs; the default debounces by 120 ms. */
  readonly schedule?: (run: () => void) => unknown;
  /** Injected in tests; the runtime reassigns the page to the new revision. */
  readonly reload?: () => void;
}

export interface ScriptClientState {
  readonly revision: number;
  readonly dirty: boolean;
  readonly impact: ImpactView['kind'];
  readonly busy: boolean;
  readonly approved: boolean;
  readonly conflict: Conflict | null;
}

export interface ScriptReviewEnhancer {
  state(): ScriptClientState;
  /** The operator changed a field. */
  edit(): void;
  /** Run the pending preview now (the debounce calls this). */
  preview(): Promise<void>;
  apply(mode: 'edit' | 'regenerate'): Promise<void>;
  approve(): Promise<void>;
  conflictLoad(): Promise<void>;
  conflictKeep(): Promise<void>;
}

const FIELD_NAMES = ['script', 'title', 'description', 'hashtags'] as const;
type FieldName = (typeof FIELD_NAMES)[number];

const FIELDS: Readonly<Record<FieldName, string>> = {
  script: 'script-body',
  title: 'script-title',
  description: 'script-description',
  hashtags: 'script-hashtags',
};

const ELEMENT_IDS = {
  revNumber: '#script-rev-number',
  dirty: '[data-script-dirty]',
  chip: '[data-impact-chip]',
  message: '[data-impact-message]',
  detail: '[data-impact-detail]',
  changes: '[data-impact-changes]',
  stale: '[data-impact-stale]',
  survives: '[data-impact-survives]',
  calls: '[data-impact-calls]',
  conditional: '[data-impact-conditional]',
  blockers: '[data-impact-blockers]',
  skeleton: '[data-impact-skeleton]',
  retry: '[data-impact-retry]',
  apply: '[data-commit="edit"]',
  regenerate: '[data-commit="regenerate"]',
  impact: '[data-impact]',
  approve: '[data-script-approve]',
  record: '[data-approved-record]',
  unlock: '#script-unlock',
  conflict: '[data-conflict]',
  conflictText: '[data-conflict-text]',
  conflictLoad: '[data-conflict-load]',
  conflictKeep: '[data-conflict-keep]',
  form: '[data-script-form]',
  review: '[data-script-review]',
  status: '#live-status',
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setHidden(node: ScriptElement | null, hidden: boolean): void {
  if (node === null) return;
  node.hidden = hidden;
  if (hidden) node.setAttribute?.('hidden', '');
  else node.removeAttribute?.('hidden');
}

function setDisabled(node: ScriptElement | null, disabled: boolean): void {
  if (node === null) return;
  node.disabled = disabled;
  if (disabled) {
    node.setAttribute?.('disabled', '');
    node.setAttribute?.('aria-disabled', 'true');
  } else {
    node.removeAttribute?.('disabled');
    node.removeAttribute?.('aria-disabled');
  }
}

function readFields(doc: ScriptDocument): Record<FieldName, string> {
  const values = {} as Record<FieldName, string>;
  for (const name of FIELD_NAMES) {
    values[name] = doc.querySelector('#' + FIELDS[name])?.value ?? '';
  }
  return values;
}

function toContent(values: Record<FieldName, string>): ScriptContent {
  return {
    script: values.script,
    title: values.title,
    description: values.description,
    hashtags: values.hashtags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  };
}

function snapshotsOf(detail: VideoDetail): Record<string, StageSnapshot> {
  const stages: Record<string, StageSnapshot> = {};
  for (const row of detail.stages) {
    stages[row.stage] = { state: row.state as StageState, stale: row.stale };
  }
  return stages;
}

function conflictSentence(conflict: Conflict): string {
  return (
    'This script was saved by another tab (revision ' +
    conflict.current_revision +
    '). Your revision ' +
    conflict.your_revision +
    ' was not saved. Nothing was overwritten.'
  );
}

export function initScriptReview(
  doc: ScriptDocument,
  env: ScriptEnvironment,
): ScriptReviewEnhancer | null {
  const root = doc.querySelector(ELEMENT_IDS.review);
  if (root === null) return null;
  const form = doc.querySelector(ELEMENT_IDS.form);
  if (form === null) return null;

  const videoId =
    root.getAttribute?.('data-video-id') ?? form.getAttribute?.('data-video-id') ?? '';
  let revision = Number(form.getAttribute?.('data-revision') ?? '0') || 0;
  let initial = readFields(doc);
  let impact: ImpactView = idleImpact();
  let busy = false;
  let approved = form.getAttribute?.('data-script-approved') === 'true';
  let conflict: Conflict | null = null;
  let lastPreview: InvalidationPreview | null = null;
  let generation = 0;
  const schedule = env.schedule ?? ((run: () => void) => setTimeout(run, 120));

  const node = (selector: string): ScriptElement | null => doc.querySelector(selector);

  const status = node(ELEMENT_IDS.status);
  function announce(message: string): void {
    if (status === null) return;
    status.textContent = '';
    status.textContent = message;
  }

  function currentValues(): Record<FieldName, string> {
    return readFields(doc);
  }

  function content(): ScriptContent {
    return toContent(currentValues());
  }

  function isDirty(): boolean {
    const values = currentValues();
    return FIELD_NAMES.some((name) => values[name] !== initial[name]);
  }

  function renderDirty(): void {
    setHidden(node(ELEMENT_IDS.dirty), !isDirty());
  }

  function renderRevision(): void {
    const target = node(ELEMENT_IDS.revNumber);
    if (target !== null) target.textContent = 'Script rev ' + revision;
  }

  function renderImpact(view: ImpactView): void {
    impact = view;
    const impactNode = node(ELEMENT_IDS.impact);
    impactNode?.setAttribute?.('data-impact-state', view.kind);
    const chip = node(ELEMENT_IDS.chip);
    if (chip !== null) chip.textContent = view.chip;

    const message = node(ELEMENT_IDS.message);
    if (message !== null) {
      message.textContent = view.message ?? '';
      setHidden(message, view.message === null);
    }

    const showDetail = view.kind === 'ready' && view.message === null;
    setHidden(node(ELEMENT_IDS.detail), !showDetail);
    setHidden(node(ELEMENT_IDS.skeleton), view.kind !== 'computing');
    setHidden(node(ELEMENT_IDS.retry), view.kind !== 'failed');

    const changes = node(ELEMENT_IDS.changes);
    if (changes !== null) changes.textContent = view.changes ?? '';

    const stale = node(ELEMENT_IDS.stale);
    if (stale !== null) {
      stale.innerHTML = view.stale
        .map(
          (row) =>
            '<li data-impact-stale-stage="' +
            row.code +
            '"><span class="mono">' +
            row.code +
            ' ' +
            escapeHtml(row.label) +
            '</span> <span class="mono">(' +
            row.quantity +
            ')</span><span class="impact-note">' +
            escapeHtml(row.note) +
            '</span></li>',
        )
        .join('');
    }

    const survives = node(ELEMENT_IDS.survives);
    if (survives !== null) {
      survives.innerHTML = view.survives
        .map(
          (row) =>
            '<li><span>' +
            escapeHtml(row.label) +
            '</span><span class="impact-note">' +
            escapeHtml(row.detail) +
            '</span></li>',
        )
        .join('');
    }

    const calls = node(ELEMENT_IDS.calls);
    if (calls !== null) {
      calls.innerHTML = view.calls.map((line) => '<span>' + escapeHtml(line) + '</span>').join('');
    }

    const conditional = node(ELEMENT_IDS.conditional);
    if (conditional !== null) {
      conditional.textContent = view.conditional ?? '';
      setHidden(conditional, view.conditional === null);
    }

    const blockers = node(ELEMENT_IDS.blockers);
    if (blockers !== null) {
      blockers.innerHTML = view.blockers
        .map((blocker) => '<li>' + escapeHtml(blocker) + '</li>')
        .join('');
      setHidden(blockers, view.blockers.length === 0);
    }

    setDisabled(node(ELEMENT_IDS.apply), !view.canApply || busy);
    const regenerate = node(ELEMENT_IDS.regenerate);
    setDisabled(regenerate, !view.canRegenerate || busy);
    setHidden(regenerate, view.regenerateHidden);
  }

  function renderConflict(next: Conflict | null): void {
    conflict = next;
    const banner = node(ELEMENT_IDS.conflict);
    const text = node(ELEMENT_IDS.conflictText);
    if (banner === null) return;
    if (next === null) {
      setHidden(banner, true);
      if (text !== null) text.textContent = '';
      return;
    }
    if (text !== null) text.textContent = conflictSentence(next);
    setHidden(banner, false);
  }

  async function runPreview(): Promise<void> {
    if (busy) return;
    if (!isDirty()) {
      renderImpact(idleImpact());
      return;
    }
    const requestGeneration = (generation += 1);
    renderImpact(computingImpact());
    const result = await env.api.preview(videoId, {
      revision,
      edits: [{ edit_kind: 'script_wording' }],
      script_content: content(),
    });
    if (requestGeneration !== generation) return;
    switch (result.kind) {
      case 'ok':
        lastPreview = result.preview;
        renderImpact(readyImpact(result.preview));
        return;
      case 'conflict':
        renderImpact(failedImpact());
        renderConflict(result.conflict);
        return;
      case 'failed':
        renderImpact(failedImpact());
        return;
    }
  }

  async function refreshRail(): Promise<VideoDetail | null> {
    try {
      const detail = await env.api.video(videoId);
      if (detail !== null) paintStages(doc, snapshotsOf(detail));
      return detail;
    } catch {
      return null;
    }
  }

  async function save(mode: 'edit' | 'regenerate'): Promise<void> {
    if (busy) return;
    if (mode === 'edit' && !impact.canApply) return;
    if (mode === 'regenerate' && !impact.canRegenerate) return;

    busy = true;
    renderImpact(impact);
    const result = await env.api.save(videoId, { revision, content: content() });
    if (result.kind === 'conflict') {
      busy = false;
      renderImpact(impact);
      renderConflict(result.conflict);
      announce('This script was saved elsewhere. Your text is kept; nothing was overwritten.');
      return;
    }
    if (result.kind === 'failed') {
      busy = false;
      renderImpact(impact);
      announce('The script was not saved. Nothing was changed.');
      return;
    }

    revision = result.script.revision;
    initial = currentValues();
    renderRevision();
    renderDirty();
    renderConflict(null);
    const staleCodes = (lastPreview?.invalidated ?? []).map((row) => row.stage);
    const calls = lastPreview?.calls;
    const completed = impact;
    const firstStage = lastPreview?.invalidated[0]?.stage;

    renderImpact(idleImpact());

    let rerunNote = '';
    if (mode === 'regenerate' && firstStage !== undefined) {
      const rerun = await env.api.rerun(videoId, firstStage, { confirm_scope: true });
      rerunNote = rerun.kind === 'ok' ? ' Regeneration of ' + firstStage + ' is queued.' : '';
    }

    await refreshRail();
    busy = false;
    renderImpact(idleImpact());

    const staleText = staleCodes.length === 0 ? '' : ' ' + staleCodes.join(', ') + ' are stale.';
    const callText =
      calls === undefined
        ? ''
        : ' ' +
          calls.image +
          ' image calls, ' +
          calls.tts +
          ' TTS calls, ' +
          calls.render_passes +
          ' render passes.';
    announce('Script rev ' + revision + ' saved.' + staleText + callText + rerunNote);
    void completed;
    env.reload?.();
  }

  async function approve(): Promise<void> {
    if (busy || approved) return;
    const button = node(ELEMENT_IDS.approve);
    if (button === null) return;
    if (button.getAttribute?.('hidden') !== null && button.getAttribute?.('hidden') !== undefined)
      return;
    if (
      button.getAttribute?.('disabled') !== null &&
      button.getAttribute?.('disabled') !== undefined
    )
      return;

    busy = true;
    setDisabled(button, true);
    const result = await env.api.approve(videoId, { revision });
    busy = false;
    if (result.kind !== 'ok') {
      setDisabled(button, false);
      announce('The script was not approved. Nothing was unlocked.');
      return;
    }

    approved = true;
    setHidden(button, true);
    const record = node(ELEMENT_IDS.record);
    if (record !== null) {
      record.textContent =
        'Approved rev ' +
        result.script.revision +
        ' · operator · ' +
        (result.script.approved_at === null ? '' : isoSeconds(result.script.approved_at));
      setHidden(record, false);
    }
    for (const reason of Array.from(doc.querySelectorAll('.script-approve-reason'))) {
      setHidden(reason, true);
    }
    await refreshRail();
    announce(
      'Script rev ' +
        result.script.revision +
        ' approved. Image and narration are unlocked; approving unlocked the gated billable stages.',
    );
  }

  async function conflictLoad(): Promise<void> {
    const result = await env.api.load(videoId);
    if (result.kind !== 'ok') {
      announce('The saved revision could not be loaded. Your text is unchanged.');
      return;
    }
    const server = result.script;
    const contentValue = server.content;
    const assignments: Record<FieldName, string> = {
      script: contentValue.script,
      title: contentValue.title,
      description: contentValue.description,
      hashtags: contentValue.hashtags.join(', '),
    };
    for (const name of FIELD_NAMES) {
      const element = node('#' + FIELDS[name]);
      if (element !== null) element.value = assignments[name];
    }
    revision = server.revision;
    initial = readFields(doc);
    renderRevision();
    renderDirty();
    renderConflict(null);
    renderImpact(idleImpact());
    announce('Loaded revision ' + server.revision + '.');
  }

  async function conflictKeep(): Promise<void> {
    if (conflict === null) return;
    revision = conflict.current_revision;
    renderConflict(null);
    renderImpact(impact);
    await save('edit');
  }

  form.addEventListener?.('input', () => {
    if (busy) return;
    renderDirty();
    if (!isDirty()) {
      renderImpact(idleImpact());
      return;
    }
    renderImpact(computingImpact());
    schedule(() => {
      void runPreview();
    });
  });

  node(ELEMENT_IDS.retry)?.addEventListener?.('click', () => {
    void runPreview();
  });
  node(ELEMENT_IDS.apply)?.addEventListener?.('click', () => {
    void save('edit');
  });
  node(ELEMENT_IDS.regenerate)?.addEventListener?.('click', () => {
    void save('regenerate');
  });
  node(ELEMENT_IDS.approve)?.addEventListener?.('click', () => {
    void approve();
  });
  node(ELEMENT_IDS.conflictLoad)?.addEventListener?.('click', () => {
    void conflictLoad();
  });
  node(ELEMENT_IDS.conflictKeep)?.addEventListener?.('click', () => {
    void conflictKeep();
  });

  renderDirty();
  renderImpact(impact);

  return {
    state: () => ({ revision, dirty: isDirty(), impact: impact.kind, busy, approved, conflict }),
    edit: () => {
      renderDirty();
      if (!isDirty()) {
        renderImpact(idleImpact());
        return;
      }
      renderImpact(computingImpact());
      schedule(() => {
        void runPreview();
      });
    },
    preview: runPreview,
    apply: save,
    approve,
    conflictLoad,
    conflictKeep,
  };
}

/**
 * The runtime adapter. Returns discriminated results and never throws into the
 * enhancer; a non-2xx that is not a 409 is `failed`. INT-01 may replace this
 * with the contract-validating adapter — the enhancer only needs the
 * `ScriptApi` shape.
 */
export function createHttpScriptApi(fetchImpl?: typeof fetch): ScriptApi {
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> => {
    const doFetch = fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (doFetch === undefined) return { status: 0, json: null };
    const response = await doFetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };

  const conflictOf = (json: unknown): Conflict | null => {
    if (typeof json !== 'object' || json === null) return null;
    const candidate = json as Record<string, unknown>;
    const current = candidate['current_revision'];
    const yours = candidate['your_revision'];
    if (typeof current !== 'number' || typeof yours !== 'number') return null;
    return { current_revision: current, your_revision: yours };
  };

  const script = (json: unknown): ScriptView | null =>
    typeof json === 'object' && json !== null && typeof (json as ScriptView).revision === 'number'
      ? (json as ScriptView)
      : null;

  return {
    async preview(videoId, body) {
      const result = await call(
        'POST',
        '/api/videos/' + encodeURIComponent(videoId) + '/invalidation-preview',
        body,
      );
      if (result.status === 200) {
        const preview = result.json as InvalidationPreview | null;
        if (preview !== null && typeof preview.ok === 'boolean') return { kind: 'ok', preview };
      }
      if (result.status === 409) {
        const conflict = conflictOf(result.json);
        if (conflict !== null) return { kind: 'conflict', conflict };
      }
      return { kind: 'failed' };
    },
    async save(videoId, body) {
      const result = await call(
        'POST',
        '/api/videos/' + encodeURIComponent(videoId) + '/script',
        body,
      );
      if (result.status === 200) {
        const parsed = script(result.json);
        if (parsed !== null) return { kind: 'ok', script: parsed };
      }
      if (result.status === 409) {
        const conflict = conflictOf(result.json);
        if (conflict !== null) return { kind: 'conflict', conflict };
      }
      return { kind: 'failed' };
    },
    async approve(videoId, body) {
      const result = await call(
        'POST',
        '/api/videos/' + encodeURIComponent(videoId) + '/script/approve',
        body,
      );
      if (result.status === 200) {
        const parsed = script(result.json);
        if (parsed !== null) return { kind: 'ok', script: parsed };
      }
      if (result.status === 409) {
        const conflict = conflictOf(result.json);
        if (conflict !== null) return { kind: 'conflict', conflict };
      }
      return { kind: 'failed' };
    },
    async load(videoId) {
      const result = await call('GET', '/api/videos/' + encodeURIComponent(videoId) + '/script');
      if (result.status === 200) {
        const parsed = script(result.json);
        if (parsed !== null) return { kind: 'ok', script: parsed };
      }
      return { kind: 'failed' };
    },
    async video(videoId) {
      const result = await call('GET', '/api/videos/' + encodeURIComponent(videoId));
      if (result.status !== 200) return null;
      const detail = result.json as VideoDetail | null;
      return detail !== null && Array.isArray(detail.stages) ? detail : null;
    },
    async rerun(videoId, stage, body) {
      const result = await call(
        'POST',
        '/api/videos/' +
          encodeURIComponent(videoId) +
          '/stages/' +
          encodeURIComponent(stage) +
          '/retry',
        body,
      );
      return result.status === 200 ? { kind: 'ok' } : { kind: 'failed' };
    },
  };
}

const runtimeDocument = (globalThis as { document?: ScriptDocument }).document;
if (runtimeDocument !== undefined) {
  initScriptReview(runtimeDocument, {
    api: createHttpScriptApi(),
    // A committed revision changes the word count, the claims and the 8-gram
    // result; the server render is the only place those are decided. Reload
    // after the announcement so the operator sees rev 6 and not a mix of 5 and 6.
    reload: () => {
      setTimeout(() => {
        (globalThis as { location?: { reload?(): void } }).location?.reload?.();
      }, 800);
    },
  });
}
