/**
 * S-01 progressive enhancement (UI_SPEC §6.1, §8.5).
 *
 * Server-rendered states do the work; this module adds only the two things
 * HTML cannot: revealing the typed password, and the "Signing in…" busy state
 * that blocks a double submit. The rules are pure so they run in Node; the
 * binding is a thin loop over an injected document, like the shell client.
 */

export interface RevealState {
  readonly type: 'password' | 'text';
  readonly label: string;
  readonly pressed: boolean;
}

/** The button names the action, not the current state. */
export function nextRevealState(pressed: boolean): RevealState {
  return pressed
    ? { type: 'text', label: 'Hide password', pressed: true }
    : { type: 'password', label: 'Show password', pressed: false };
}

export interface SubmitState {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly label: string;
}

export function submittingState(): SubmitState {
  return { busy: true, disabled: true, label: 'Signing in…' };
}

export function shouldBlockSubmit(busy: boolean): boolean {
  return busy;
}

export interface LoginEventLike {
  preventDefault(): void;
}

export interface LoginElementLike {
  textContent: string;
  value?: string;
  disabled?: boolean;
  hidden?: boolean;
  type?: string;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  addEventListener?(event: string, handler: (event?: LoginEventLike) => void): void;
}

export interface LoginDocumentLike {
  querySelector(selector: string): LoginElementLike | null;
}

export function initLogin(doc: LoginDocumentLike): boolean {
  const form = doc.querySelector('[data-login-form]');
  if (form === null) return false;

  let busy = false;

  const password = doc.querySelector('#password');
  const reveal = doc.querySelector('[data-reveal="password"]');
  if (password !== null && reveal !== null) {
    reveal.addEventListener?.('click', () => {
      const pressed = reveal.getAttribute?.('aria-pressed') === 'true';
      const state = nextRevealState(!pressed);
      password.type = state.type;
      reveal.setAttribute?.('aria-pressed', state.pressed ? 'true' : 'false');
      reveal.setAttribute?.('aria-label', state.label);
      reveal.textContent = state.pressed ? 'Hide' : 'Show';
    });
  }

  const submit = doc.querySelector('#login-submit');
  const label = doc.querySelector('[data-submit-label]');
  const spinner = doc.querySelector('[data-spinner]');

  form.addEventListener?.('submit', (event) => {
    if (shouldBlockSubmit(busy)) {
      event?.preventDefault();
      return;
    }
    busy = true;
    const state = submittingState();
    if (submit !== null) {
      submit.disabled = state.disabled;
      submit.setAttribute?.('aria-busy', 'true');
    }
    if (label !== null) label.textContent = state.label;
    if (spinner !== null) spinner.hidden = false;
    form.setAttribute?.('aria-busy', 'true');
  });

  // §8.5: the assertive region is written after load so the expiry message is
  // actually announced, then the source attribute is consumed.
  const alert = doc.querySelector('#live-alert');
  const message = alert?.getAttribute?.('data-message') ?? '';
  if (alert !== null && message.length > 0) {
    alert.textContent = '';
    alert.textContent = message;
    alert.setAttribute?.('data-message', '');
  }

  return true;
}

const runtimeDocument = (globalThis as { document?: LoginDocumentLike }).document;
if (runtimeDocument !== undefined) {
  initLogin(runtimeDocument);
}
