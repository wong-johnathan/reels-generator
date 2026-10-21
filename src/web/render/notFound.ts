/**
 * SY-3 Not found / no access — a system surface (UX §2.1), not in navigation.
 *
 * UX_SPEC names the surface but authors no copy or mockup for it, and UI_SPEC
 * has no SY-3 entry, so the wording and layout here are design judgement in the
 * product's voice: say what happened, claim nothing about data, offer one way
 * back in, no dead end (AX-01). It stays outside the app shell so it can be
 * served for an authenticated route that no longer resolves without implying a
 * current nav destination.
 */
import { escapeAttr } from './html.js';

export type NotFoundVariant = 'not_found' | 'no_access';

export const NOT_FOUND_COPY = {
  not_found: {
    code: '404',
    title: 'Page not found',
    body: 'That address does not exist in this app. Nothing was changed.',
    note: 'If you followed a link from inside the app, the item may since have been deleted.',
  },
  no_access: {
    code: '403',
    title: 'No access',
    body: 'You do not have access to that page.',
    note: 'Access is by the seeded operator account only.',
  },
} as const;

export interface NotFoundPageModel {
  readonly variant: NotFoundVariant;
  readonly assets?: { readonly stylesHref?: string };
}

const DEFAULT_STYLES = '/assets/app.css';

export function renderNotFoundPage(model: NotFoundPageModel): string {
  const copy = NOT_FOUND_COPY[model.variant];
  return (
    '<!doctype html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<title>' +
    copy.title +
    ' — reels-generator</title>' +
    '<link rel="stylesheet" href="' +
    escapeAttr(model.assets?.stylesHref ?? DEFAULT_STYLES) +
    '">' +
    '</head>' +
    '<body class="auth">' +
    '<a class="skip-link" href="#main">Skip to content</a>' +
    '<main id="main" class="auth-main" tabindex="-1">' +
    '<section class="system-card" aria-labelledby="system-title">' +
    '<p class="system-code mono">' +
    copy.code +
    '</p>' +
    '<h1 class="system-title" id="system-title">' +
    copy.title +
    '</h1>' +
    '<p class="system-body">' +
    copy.body +
    '</p>' +
    '<a class="system-action" href="/">Go to Overview</a>' +
    '<p class="system-note">' +
    copy.note +
    '</p>' +
    '</section>' +
    '</main>' +
    '</body>' +
    '</html>'
  );
}
