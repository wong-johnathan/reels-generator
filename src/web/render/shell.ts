/**
 * F-01 app shell — server-rendered HTML, no SPA framework (TECH_DESIGN X-2).
 *
 * Implements UI_SPEC §4.1 (shell geometry and slots), §5 UC-01 (top strip and
 * left rail), UC-02 (breadcrumb), UC-23 (status strip, degraded banner and the
 * two live regions), §7 (responsive bands — the bands themselves live in
 * shell.css) and §8 (AX-01…AX-28 wiring: skip link first, one h1, labelled
 * landmarks, aria-current, described degradation, empty live regions).
 *
 * Everything the operator sees is derived from the frozen contract types; the
 * only trusted HTML is `content`, `aside.content` and `footer`, which later
 * cards render from their own components.
 */
import type { z } from 'zod';

import type {
  HealthReportSchema,
  OverviewSchema,
  SessionInfoSchema,
} from '../../../contract/api.js';
import { countPair, describeFreshness } from '../format.js';
import { escapeAttr, escapeHtml } from './html.js';

type Overview = z.infer<typeof OverviewSchema>;
type HealthReport = z.infer<typeof HealthReportSchema>;
type SessionInfo = z.infer<typeof SessionInfoSchema>;

export type NavKey = 'overview' | 'series' | 'batches' | 'posting' | 'health' | 'settings';

export interface NavItem {
  readonly key: NavKey;
  readonly label: string;
  readonly href: string;
  /** Three-letter form for the 64 px compact rail (UI_SPEC §7.1). */
  readonly short: string;
}

export const NAV_ITEMS = [
  { key: 'overview', label: 'Overview', href: '/', short: 'OVW' },
  { key: 'series', label: 'Series', href: '/series', short: 'SER' },
  { key: 'batches', label: 'Batches', href: '/batches', short: 'BAT' },
  { key: 'posting', label: 'Posting', href: '/posting', short: 'PST' },
  { key: 'health', label: 'Health', href: '/health', short: 'HLT' },
  { key: 'settings', label: 'Settings', href: '/settings', short: 'SET' },
] as const satisfies readonly NavItem[];

export interface BreadcrumbItem {
  readonly label: string;
  readonly href?: string;
}

/**
 * One degraded condition in the IP-07 taxonomy: cause, what is blocked, what
 * still works, what the system is doing. Only sourced sentences are rendered.
 */
export interface DegradedNotice {
  readonly cause: string;
  readonly blocked?: string;
  readonly stillWorks?: string;
  readonly system?: string;
}

export interface StatusStripModel {
  readonly ready: boolean;
  readonly degradedReasons: readonly string[];
  readonly inFlight: number;
  /** Null when the count is not shown in the strip (UC-01: Overview only). */
  readonly attention: number | null;
  readonly operator: string | null;
  readonly updatedAt: number | null;
  readonly now: number;
}

export interface ShellModel {
  readonly title: string;
  readonly documentTitle: string;
  readonly nav: NavKey | null;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly status: StatusStripModel;
  readonly attentionCount: number;
  readonly degraded: readonly DegradedNotice[];
  readonly content: string;
  readonly aside?: { readonly label: string; readonly content: string };
  readonly footer?: string;
  readonly assets: {
    readonly stylesHref: string;
    readonly scriptHref?: string;
    /** Surface modules that must load after the shell module. */
    readonly extraScripts: readonly string[];
  };
  /**
   * A message the surface earned before this render (a save, a state change).
   * §8.5: written into `#live-status` and announced once by the client module.
   */
  readonly liveStatus?: string;
}

export interface ShellInput {
  readonly title: string;
  readonly nav: NavKey | null;
  readonly overview: Overview;
  readonly health?: HealthReport;
  readonly session: SessionInfo;
  /** Trusted HTML rendered by the card that owns the surface. */
  readonly content: string;
  readonly breadcrumbs?: readonly BreadcrumbItem[];
  readonly aside?: { readonly label: string; readonly content: string };
  readonly footer?: string;
  readonly now?: number;
  readonly documentTitle?: string;
  readonly assets?: {
    readonly stylesHref?: string;
    readonly scriptHref?: string;
    readonly extraScripts?: readonly string[];
  };
  readonly liveStatus?: string;
}

const DEFAULT_STYLES = '/assets/app.css';
const DEFAULT_SCRIPT = '/assets/client/shell.js';

/** Map contract data onto the shell's view model — no invented fields. */
export function buildShellModel(input: ShellInput): ShellModel {
  const now = input.now ?? Date.now();
  const checkedAt = input.health === undefined ? Number.NaN : Date.parse(input.health.checked_at);
  const ready = input.health?.ready ?? input.overview.degraded.length === 0;
  const breadcrumbs =
    input.breadcrumbs === undefined || input.breadcrumbs.length === 0
      ? [{ label: input.title }]
      : input.breadcrumbs;

  return {
    title: input.title,
    documentTitle: input.documentTitle ?? input.title + ' — reels-generator',
    nav: input.nav,
    breadcrumbs,
    status: {
      ready,
      degradedReasons: input.overview.degraded,
      inFlight: input.overview.counts.running,
      attention: input.nav === 'overview' ? input.overview.counts.needs_attention : null,
      operator: input.session.authenticated ? input.session.username : null,
      updatedAt: Number.isNaN(checkedAt) ? null : checkedAt,
      now,
    },
    attentionCount: input.overview.counts.needs_attention,
    degraded: degradedNotices(input.overview, input.health),
    content: input.content,
    ...(input.aside === undefined ? {} : { aside: input.aside }),
    ...(input.footer === undefined ? {} : { footer: input.footer }),
    assets: {
      stylesHref: input.assets?.stylesHref ?? DEFAULT_STYLES,
      scriptHref: input.assets?.scriptHref ?? DEFAULT_SCRIPT,
      extraScripts: input.assets?.extraScripts ?? [],
    },
    ...(input.liveStatus === undefined ? {} : { liveStatus: input.liveStatus }),
  };
}

/**
 * IP-07: one banner per condition. The API's `overview.degraded` list is the
 * authority for *whether* the service is degraded; the health report supplies
 * the blocked / still-works / system detail for the known conditions.
 */
export function degradedNotices(
  overview: Overview,
  health: HealthReport | undefined,
): DegradedNotice[] {
  if (overview.degraded.length === 0) return [];

  const reasons = [...overview.degraded];
  const used = new Set<number>();
  const take = (pattern: RegExp): string | undefined => {
    const index = reasons.findIndex(
      (reason, candidate) => !used.has(candidate) && pattern.test(reason),
    );
    if (index === -1) return undefined;
    used.add(index);
    return reasons[index];
  };

  const components = health?.components ?? [];
  const isDown = (names: readonly string[]): boolean =>
    components.some((component) => names.includes(component.name) && component.status !== 'ok');

  const notices: DegradedNotice[] = [];

  if (isDown(['postgres', 'redis', 'migration', 'queue'])) {
    notices.push({
      cause:
        take(/postgres|redis|database|queue|migration/i) ??
        'Service not ready — the database or queue is unreachable.',
      blocked: 'New batches (HTTP 503)',
      stillWorks: 'Login, review and downloads of stored assets',
      system: 'Re-checking every 5 s; recovers within 30 s of the database reporting ready',
    });
  }

  if (isDown(['minio'])) {
    notices.push({
      cause: take(/minio|asset|storage/i) ?? 'Asset store unavailable.',
      blocked: 'Image, narration, render and export',
      stillWorks: 'Topic and script editing',
      system:
        'Stages that need the media store wait for it; nothing is written to an unready store',
    });
  }

  const disk = components.find(
    (component) => component.name === 'disk' && component.status !== 'ok',
  );
  if (disk !== undefined) {
    notices.push({
      cause: take(/disk/i) ?? 'Disk ' + disk.detail,
      blocked: 'New media writes below the safety margin',
      stillWorks: 'Review and export of already-stored assets',
      system: 'Re-checking every 5 s',
    });
  }

  for (const [index, reason] of reasons.entries()) {
    if (!used.has(index)) notices.push({ cause: reason });
  }

  return notices;
}

function renderStatusStrip(status: StatusStripModel): string {
  const state = !status.ready
    ? 'not-ready'
    : status.degradedReasons.length > 0
      ? 'degraded'
      : 'ready';
  const word =
    state === 'ready' ? 'Service ready' : state === 'degraded' ? 'DEGRADED' : 'Service not ready';
  const firstReason = status.degradedReasons[0];

  const cause =
    state === 'ready'
      ? ''
      : '<a class="status-cause" href="/health">' +
        escapeHtml(firstReason ?? 'Open Health') +
        '<span class="sr-only"> — open Health</span></a>';

  const attention =
    status.attention === null
      ? ''
      : '<span class="status-attention mono" data-attention-count="' +
        status.attention +
        '"><span class="num">' +
        status.attention +
        '</span> need attention</span>';

  let freshness = '';
  if (status.updatedAt !== null) {
    const described = describeFreshness(status.now - status.updatedAt);
    freshness =
      '<span class="status-freshness mono" data-updated-at="' +
      status.updatedAt +
      '" data-stale="' +
      (described.stale ? 'true' : 'false') +
      '">' +
      escapeHtml(described.text) +
      '</span>';
  }

  const operator =
    status.operator === null
      ? ''
      : '<span class="status-operator mono">' + escapeHtml(status.operator) + '</span>';

  return (
    '<header class="status-strip" data-state="' +
    state +
    '">' +
    '<span class="status-dot" aria-hidden="true"></span>' +
    '<span class="status-word">' +
    word +
    '</span>' +
    cause +
    '<span class="status-count mono"><span class="num">' +
    status.inFlight +
    '</span> in flight</span>' +
    attention +
    freshness +
    operator +
    '</header>'
  );
}

function renderRail(model: ShellModel): string {
  const items = NAV_ITEMS.map((item) => {
    const current = model.nav === item.key ? ' aria-current="page"' : '';
    const isOverview = item.key === 'overview';
    const badge =
      isOverview && model.attentionCount > 0
        ? '<span class="rail-badge mono" aria-hidden="true">' +
          model.attentionCount +
          '</span>' +
          '<span class="sr-only"> ' +
          escapeHtml(countPair(model.attentionCount, 'video', 'videos')) +
          ' need attention</span>'
        : '';
    return (
      '<li class="rail-item' +
      (item.key === 'settings' ? ' rail-settings' : '') +
      '"><a class="rail-link" href="' +
      escapeAttr(item.href) +
      '" data-short="' +
      item.short +
      '" title="' +
      escapeAttr(item.label) +
      '"' +
      current +
      '>' +
      '<span class="rail-glyph" aria-hidden="true">' +
      item.short +
      '</span>' +
      '<span class="rail-label">' +
      escapeHtml(item.label) +
      '</span>' +
      badge +
      '</a></li>'
    );
  });

  return (
    '<nav class="rail" aria-label="Primary"><ul class="rail-list">' + items.join('') + '</ul></nav>'
  );
}

function renderBreadcrumb(items: readonly BreadcrumbItem[]): string {
  const rendered = items.map((item, index) => {
    const last = index === items.length - 1;
    if (!last && item.href !== undefined) {
      return '<li><a href="' + escapeAttr(item.href) + '">' + escapeHtml(item.label) + '</a></li>';
    }
    if (last) {
      return '<li><span aria-current="page">' + escapeHtml(item.label) + '</span></li>';
    }
    return '<li><span>' + escapeHtml(item.label) + '</span></li>';
  });
  return '<nav class="breadcrumb" aria-label="Breadcrumb"><ol>' + rendered.join('') + '</ol></nav>';
}

function renderMobileBar(model: ShellModel): string {
  const previous = [...model.breadcrumbs]
    .slice(0, -1)
    .reverse()
    .find((item) => item.href !== undefined);
  const back =
    previous === undefined
      ? '<span class="mobile-home">reels-generator</span>'
      : '<a class="mobile-back" href="' +
        escapeAttr(previous.href ?? '/') +
        '"><span aria-hidden="true">&#8249;</span> ' +
        escapeHtml(previous.label) +
        '</a>';
  return (
    '<div class="mobile-bar">' +
    back +
    '<a class="mobile-attention" href="/">Attention (' +
    model.attentionCount +
    ')</a></div>'
  );
}

function renderDegradedBanner(notices: readonly DegradedNotice[]): string {
  const primary = notices[0];
  if (primary === undefined) return '';

  const terms: Array<[string, string | undefined]> = [
    ['Cause', primary.cause],
    ['Blocked', primary.blocked],
    ['Still works', primary.stillWorks],
    ['System', primary.system],
  ];
  const detail = terms
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([term, value]) => '<dt>' + term + '</dt><dd>' + escapeHtml(value) + '</dd>')
    .join('');

  const others = notices.slice(1);
  const more =
    others.length === 0
      ? ''
      : '<p class="degraded-more">+' +
        others.length +
        ' more — ' +
        escapeHtml(others.map((notice) => notice.cause).join('; ')) +
        '</p>';

  return (
    '<section class="degraded-banner" aria-labelledby="degraded-heading">' +
    '<h2 id="degraded-heading">Service degraded</h2>' +
    '<dl class="degraded-detail">' +
    detail +
    '</dl>' +
    more +
    '<a class="degraded-link" href="/health">Open Health</a>' +
    '</section>'
  );
}

export function renderShell(model: ShellModel): string {
  const hasAside = model.aside !== undefined;
  const grid =
    '<div class="content-grid' +
    (hasAside ? ' has-aside' : '') +
    '"><div class="content-main">' +
    model.content +
    '</div>' +
    (hasAside
      ? '<aside class="impact-column" aria-label="' +
        escapeAttr(model.aside?.label ?? 'Context') +
        '">' +
        (model.aside?.content ?? '') +
        '</aside>'
      : '') +
    '</div>';

  const footer =
    model.footer === undefined
      ? ''
      : '<footer class="workspace-footer">' + model.footer + '</footer>';

  const scripts = [
    ...(model.assets.scriptHref === undefined ? [] : [model.assets.scriptHref]),
    ...model.assets.extraScripts,
  ]
    .map((href) => '<script type="module" src="' + escapeAttr(href) + '"></script>')
    .join('');

  return (
    '<!doctype html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<title>' +
    escapeHtml(model.documentTitle) +
    '</title>' +
    '<link rel="stylesheet" href="' +
    escapeAttr(model.assets.stylesHref) +
    '">' +
    '</head>' +
    '<body class="shell">' +
    '<a class="skip-link" href="#main">Skip to content</a>' +
    renderStatusStrip(model.status) +
    renderRail(model) +
    '<main id="main" tabindex="-1" class="main">' +
    '<div class="content">' +
    renderMobileBar(model) +
    renderBreadcrumb(model.breadcrumbs) +
    '<h1 class="page-title">' +
    escapeHtml(model.title) +
    '</h1>' +
    renderDegradedBanner(model.degraded) +
    grid +
    footer +
    '</div>' +
    '</main>' +
    scripts +
    '<div id="live-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"' +
    (model.liveStatus === undefined ? '' : ' data-message="' + escapeAttr(model.liveStatus) + '"') +
    '></div>' +
    '<div id="live-alert" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>' +
    '</body>' +
    '</html>'
  );
}
