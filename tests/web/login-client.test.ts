import { describe, expect, it } from 'vitest';

import {
  initLogin,
  nextRevealState,
  shouldBlockSubmit,
  submittingState,
  type LoginEventLike,
  type LoginDocumentLike,
  type LoginElementLike,
} from '../../src/web/client/login.js';

/**
 * S-01 client enhancement (UI_SPEC §6.1 keyboard order and submitting state;
 * §8.5 announcement rules). The rules are pure; the DOM binding runs against
 * fakes, exactly like the shell client tests.
 */

interface FakeElement extends LoginElementLike {
  readonly attrs: Map<string, string>;
  readonly events: Map<string, Array<(event?: LoginEventLike) => void>>;
  textContent: string;
  value?: string;
  disabled?: boolean;
  hidden?: boolean;
  type?: string;
}

function element(attrs: Record<string, string> = {}): FakeElement {
  const map = new Map(Object.entries(attrs));
  const events = new Map<string, Array<(event?: LoginEventLike) => void>>();
  return {
    attrs: map,
    events,
    textContent: '',
    getAttribute(name: string): string | null {
      return map.get(name) ?? null;
    },
    setAttribute(name: string, value: string): void {
      map.set(name, value);
    },
    addEventListener(name: string, handler: (event?: LoginEventLike) => void): void {
      const list = events.get(name) ?? [];
      list.push(handler);
      events.set(name, list);
    },
  };
}

function fakeDocument(): {
  doc: LoginDocumentLike;
  form: FakeElement;
  password: FakeElement;
  toggle: FakeElement;
  submit: FakeElement;
  label: FakeElement;
  spinner: FakeElement;
  alert: FakeElement;
} {
  const form = element({ 'data-login-form': '' });
  const password = element({ id: 'password', type: 'password' });
  const toggle = element({ 'data-reveal': 'password', 'aria-pressed': 'false' });
  const submit = element({ id: 'login-submit' });
  const label = element({ 'data-submit-label': '' });
  const spinner = element({ 'data-spinner': '', hidden: '' });
  const alert = element({ id: 'live-alert', 'data-message': 'Your session expired.' });
  const bySelector: Record<string, FakeElement> = {
    '[data-login-form]': form,
    '#password': password,
    '[data-reveal="password"]': toggle,
    '#login-submit': submit,
    '[data-submit-label]': label,
    '[data-spinner]': spinner,
    '#live-alert': alert,
  };
  return {
    doc: { querySelector: (selector: string) => bySelector[selector] ?? null },
    form,
    password,
    toggle,
    submit,
    label,
    spinner,
    alert,
  };
}

describe('reveal state (UI_SPEC §6.1 show/hide)', () => {
  it('starts hidden and exposes the action, not the current state, as its name', () => {
    expect(nextRevealState(false)).toEqual({
      type: 'password',
      label: 'Show password',
      pressed: false,
    });
  });

  it('reveals the value on press and offers the inverse action', () => {
    expect(nextRevealState(true)).toEqual({ type: 'text', label: 'Hide password', pressed: true });
  });
});

describe('submitting state (UI_SPEC §6.1)', () => {
  it('disables the control, marks it busy and says "Signing in…"', () => {
    expect(submittingState()).toEqual({ busy: true, disabled: true, label: 'Signing in…' });
  });

  it('blocks a second submit until the first response arrives', () => {
    expect(shouldBlockSubmit(false)).toBe(false);
    expect(shouldBlockSubmit(true)).toBe(true);
  });
});

describe('initLogin', () => {
  it('returns false when the login form is absent', () => {
    expect(initLogin({ querySelector: () => null })).toBe(false);
  });

  it('toggles the password field and the pressed state together', () => {
    const { doc, password, toggle } = fakeDocument();
    initLogin(doc);
    toggle.events.get('click')?.[0]?.();
    expect(password.type).toBe('text');
    expect(toggle.attrs.get('aria-pressed')).toBe('true');
    expect(toggle.attrs.get('aria-label')).toBe('Hide password');
    expect(toggle.textContent).toBe('Hide');
    toggle.events.get('click')?.[0]?.();
    expect(password.type).toBe('password');
    expect(toggle.attrs.get('aria-pressed')).toBe('false');
  });

  it('marks the form busy, disables the button and shows the spinner on submit', () => {
    const { doc, form, submit, label, spinner } = fakeDocument();
    initLogin(doc);
    const event = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    form.events.get('submit')?.[0]?.(event);
    expect(submit.disabled).toBe(true);
    expect(submit.attrs.get('aria-busy')).toBe('true');
    expect(label.textContent).toBe('Signing in…');
    expect(spinner.hidden).toBe(false);
    expect(form.attrs.get('aria-busy')).toBe('true');
    expect(event.defaultPrevented).toBe(false);
  });

  it('prevents a double submit', () => {
    const { doc, form } = fakeDocument();
    initLogin(doc);
    const first = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    form.events.get('submit')?.[0]?.(first);
    const second = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    form.events.get('submit')?.[0]?.(second);
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(true);
  });

  it('re-announces the session-expiry message from the generated markup', () => {
    const { doc, alert } = fakeDocument();
    initLogin(doc);
    expect(alert.textContent).toBe('Your session expired.');
    expect(alert.attrs.get('data-message')).toBe('');
  });
});
