/**
 * Deterministic fixtures for the mock server (LEAD_PLAN §6).
 *
 * Every route in `contract/api.ts` has exactly one fixture here; the contract
 * test parses each fixture against its route's response schema, so a shape
 * change breaks the build instead of the frontend. No timestamps are "now" and
 * no ids are random: two runs produce byte-identical responses.
 */
import type { RouteId } from '../api.js';

const T0 = '2026-10-20T09:00:00.000Z';
const T1 = '2026-10-20T09:41:12.000Z';

export const IDS = {
  series: '11111111-1111-4111-8111-111111111111',
  seriesVersion2: '11111111-1111-4111-8111-222222222222',
  seriesVersion3: '11111111-1111-4111-8111-333333333333',
  batch: '33333333-3333-4333-8333-111111111111',
  video: '22222222-2222-4222-8222-111111111111',
  video2: '22222222-2222-4222-8222-222222222222',
  topic: '44444444-4444-4444-8444-111111111111',
  script: '55555555-5555-4555-8555-111111111111',
  claimSourced: '66666666-6666-4666-8666-111111111111',
  claimUnsourced: '66666666-6666-4666-8666-222222222222',
  source: '77777777-7777-4777-8777-111111111111',
  prompt: '88888888-8888-4888-8888-111111111111',
  image: '99999999-9999-4999-8999-111111111111',
  audio: 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
  videoAsset: 'bbbbbbbb-bbbb-4bbb-8bbb-111111111111',
  poster: 'bbbbbbbb-bbbb-4bbb-8bbb-222222222222',
  srt: 'bbbbbbbb-bbbb-4bbb-8bbb-333333333333',
  vtt: 'bbbbbbbb-bbbb-4bbb-8bbb-444444444444',
  sidecar: 'bbbbbbbb-bbbb-4bbb-8bbb-555555555555',
  manifest: 'bbbbbbbb-bbbb-4bbb-8bbb-666666666666',
  attempt: 'cccccccc-cccc-4ccc-8ccc-111111111111',
} as const;

const sha = (n: number): string => n.toString(16).padStart(64, '0').slice(0, 64);

const profile = {
  niche: {
    subject: 'psychology for founders',
    audience: 'solo builders',
    boundaries: ['no medical advice'],
    language: 'en',
    location: 'global',
    prohibited_topics: ['politics'],
    preferred_sources: ['peer-reviewed journals'],
  },
  script_style: { tone: 'dry, concrete', structure: ['hook', 'tension', 'turn', 'landing'] },
  voice_config: { voice_id: 'voice-fixture', speed: 1, style: 'documentary' },
  art_style: { preset: 'inking-comic', palette: 'duotone', recurring_protagonist: true },
  default_aspect_ratio: '9:16',
  target_duration_s: 75,
  narration_language: 'en',
  captions_preset: { words_per_caption: 3, emphasis: true },
  music_config: null,
  image_resolution: '1K',
  mode: 'creative',
};

const seriesSummary = {
  id: IDS.series,
  name: 'Founders, Quietly',
  slug: 'founders-quietly',
  mode: 'creative',
  status: 'active',
  current_version: 3,
  current_version_id: IDS.seriesVersion3,
  target_duration_s: 75,
  default_aspect_ratio: '9:16',
  revision: 4,
  created_at: T0,
  updated_at: T1,
};

const seriesDetail = {
  ...seriesSummary,
  profile,
  version_count: 3,
  in_flight_batches: 1,
};

const pins = {
  text: 'v3 ×4 · v2 ×3',
  uniform: false,
  versions: [
    { version: 2, count: 3, stages: ['T', 'RS', 'SC'] },
    { version: 3, count: 4, stages: ['SB', 'IM', 'NA', 'TC'] },
  ],
};

/** A stage row; defaults describe a clean, completed pipeline. */
function stage(code: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: code,
    label: code,
    state: 'done',
    series_version_id: IDS.seriesVersion3,
    series_version: 3,
    stale: false,
    stale_cause: null,
    stale_at: null,
    last_event: null,
    last_event_at: null,
    progress: { current: 0, total: 0 },
    attempts: { count: 0, max_attempts: 3, last_error_class: null },
    blocked_reason: null,
    ...overrides,
  };
}

const stages = [
  stage('T', {
    series_version_id: IDS.seriesVersion2,
    series_version: 2,
    progress: { current: 1, total: 1 },
  }),
  stage('RS', { state: 'done', series_version_id: IDS.seriesVersion2, series_version: 2 }),
  stage('SC', {
    series_version_id: IDS.seriesVersion2,
    series_version: 2,
    last_event: 'approved by operator',
    last_event_at: T1,
  }),
  stage('SB', { progress: { current: 17, total: 17 } }),
  stage('IM', { progress: { current: 17, total: 17 } }),
  stage('NA', { progress: { current: 1, total: 1 } }),
  stage('TC', { progress: { current: 228, total: 228 } }),
  stage('RE', {
    state: 'awaiting_approval',
    progress: { current: 1, total: 1 },
    last_event: 'QC pass',
    last_event_at: T1,
  }),
  stage('QC', { state: 'done' }),
  stage('FA', { state: 'awaiting_approval' }),
  stage('EX', { state: 'blocked', blocked_reason: 'final approval required (R-005-3)' }),
];

const videoSummary = {
  id: IDS.video,
  batch_id: null,
  series_id: IDS.series,
  series_name: seriesSummary.name,
  position_in_batch: 0,
  status: 'NEEDS_ATTENTION',
  current_stage: 'FA',
  stage_state: 'awaiting_approval',
  attention_kind: 'approval',
  attention_reason: 'final approval',
  pins,
  updated_at: T1,
};

const videoDetail = {
  ...videoSummary,
  topic_id: IDS.topic,
  script_revision: 4,
  scene_count: 17,
  target_duration_s: 75,
  created_at: T0,
  stages,
  links: {
    topic: `/videos/${IDS.video}`,
    script: `/videos/${IDS.video}/script`,
    storyboard: `/videos/${IDS.video}/storyboard`,
    scenes: `/videos/${IDS.video}/scenes`,
    audio: `/videos/${IDS.video}/audio`,
    render: `/videos/${IDS.video}/render`,
    export: `/videos/${IDS.video}/export`,
  },
};

const topic = {
  id: IDS.topic,
  project_id: IDS.video,
  title: 'The cost of narrating your own work',
  description: 'Why founders who explain themselves too early lose the thread — and the fix.',
  rationale: 'Evergreen, low-controversy, cites two studies.',
  source_links: [{ url: 'https://example.org/study', title: 'Self-explanation and focus' }],
  dedupe_status: 'none',
  dedupe_match: null,
  status: 'approved',
  revision: 2,
  created_at: T0,
};

const claimSourced = {
  id: IDS.claimSourced,
  script_revision_id: IDS.script,
  text: 'Participants who explained their reasoning spent 23% longer on the task.',
  is_factual: true,
  status: 'sourced',
  source: {
    id: IDS.source,
    url: 'https://example.org/study',
    title: 'Self-explanation and focus',
    domain: 'example.org',
    rerank_score: 2.31,
  },
  url_status: 200,
  url_reachable_at: T1,
};

const claimUnsourced = {
  id: IDS.claimUnsourced,
  script_revision_id: IDS.script,
  text: 'Most founders quit in month nine.',
  is_factual: true,
  status: 'unsourced',
  source: null,
  url_status: null,
  url_reachable_at: null,
};

const script = {
  id: IDS.script,
  project_id: IDS.video,
  revision: 4,
  schema_version: '1.0.0',
  status: 'approved',
  content: {
    hook: 'You are not stuck. You are narrating.',
    narration:
      'You are not stuck. You are narrating. Every time you explain the plan out loud, the plan gets heavier. ' +
      'Here is the mechanism, and here is the smaller version that actually ships.',
    ending: 'Say less. Ship the sentence.',
    title: 'The cost of narrating your own work',
    description: 'A 75-second note on why explaining early costs focus.',
    hashtags: ['#psychology', '#founders', '#focus'],
  },
  word_count: 228,
  estimated_runtime_s: 75.1,
  budget: { target_words: 228, min_words: 216, max_words: 239, within_band: true },
  eight_gram: { pass: true, violations: [] },
  claims: [claimSourced, claimUnsourced],
  approved_at: T1,
};

function sceneAsset(sceneIndex: number) {
  return {
    id:
      sceneIndex === 1
        ? IDS.image
        : `99999999-9999-4999-8999-${String(sceneIndex).padStart(12, '0')}`,
    stage: 'IM',
    kind: 'image',
    width: 768,
    height: 1376,
    size_bytes: 184_320,
    content_sha256: sha(sceneIndex),
    urls: {
      thumb: `/asset/${IDS.image}/thumb`,
      detail: `/asset/${IDS.image}/detail`,
      full: `/asset/${IDS.image}/full`,
    },
    provenance: {
      provider: 'gemini',
      model: 'gemini-nano-banana-2.1',
      prompt_hash: `prompt-${String(sceneIndex).padStart(2, '0')}`,
      prompt_text: 'ink illustration, duotone, recurring protagonist',
      seed: '1729411200',
      series_version_id: IDS.seriesVersion3,
      series_version: 3,
      created_at: T0,
    },
  };
}

const cameraMoves = ['zoom_in', 'zoom_out', 'pan_l', 'pan_r', 'static'];

const scenes = Array.from({ length: 17 }, (_, i) => {
  const index = i + 1;
  const startMs = i * 4400;
  return {
    id: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`,
    scene_no: `S${String(index).padStart(2, '0')}`,
    position: index,
    image_prompt: `Scene ${index}: the protagonist meets the idea`,
    camera_move: cameraMoves[i % cameraMoves.length],
    caption_emphasis: index === 1 ? 'narration' : null,
    fallback_text: `Scene ${index}`,
    uses_protagonist: true,
    narration: { start_ms: startMs, end_ms: startMs + 4400 },
    asset: sceneAsset(index),
    state: 'done',
    revision: 1,
  };
});

const storyboard = {
  project_id: IDS.video,
  revision: 2,
  scene_count: 17,
  target_scene_count: 17,
  approved: true,
  approved_at: T1,
  first_three_reviewed: true,
  scenes,
};

const audioAsset = {
  id: IDS.audio,
  stage: 'NA',
  kind: 'audio',
  width: null,
  height: null,
  size_bytes: 1_204_224,
  content_sha256: sha(200),
  urls: {
    thumb: `/asset/${IDS.audio}/thumb`,
    detail: `/asset/${IDS.audio}/detail`,
    full: `/asset/${IDS.audio}/full`,
  },
  provenance: {
    provider: 'elevenlabs',
    model: 'eleven_multilingual_v2',
    prompt_hash: null,
    prompt_text: null,
    seed: null,
    series_version_id: IDS.seriesVersion3,
    series_version: 3,
    created_at: T0,
  },
};

const words = [
  { word: 'You', start_ms: 0, end_ms: 220 },
  { word: 'are', start_ms: 220, end_ms: 380 },
  { word: 'not', start_ms: 380, end_ms: 520 },
  { word: 'stuck.', start_ms: 520, end_ms: 940 },
];

const narration = {
  status: 'done',
  asset: audioAsset,
  duration_s: 75.1,
  target_duration_s: 75,
  band: { min_s: 71.3, max_s: 78.8, within_band: true },
  word_count: 228,
  words,
  alignment: {
    provider: 'elevenlabs',
    model: 'convert-with-timestamps',
    request_id: 'req_000000000001',
  },
  accepted_at: T1,
};

const renderAsset = {
  id: IDS.videoAsset,
  stage: 'RE',
  kind: 'video',
  width: 1080,
  height: 1920,
  size_bytes: 48_234_112,
  content_sha256: sha(300),
  urls: {
    thumb: `/asset/${IDS.videoAsset}/thumb`,
    detail: `/asset/${IDS.videoAsset}/detail`,
    full: `/asset/${IDS.videoAsset}/full`,
  },
  provenance: {
    provider: null,
    model: 'ffmpeg',
    prompt_hash: null,
    prompt_text: null,
    seed: null,
    series_version_id: IDS.seriesVersion3,
    series_version: 3,
    created_at: T1,
  },
};

function ownUrls(id: string) {
  return {
    thumb: `/asset/${id}/thumb`,
    detail: `/asset/${id}/detail`,
    full: `/asset/${id}/full`,
  };
}

// Each asset points at its own id. The spread above inherited the video's urls,
// which would have made the poster and both caption files resolve to the MP4.
const posterAsset = {
  ...renderAsset,
  id: IDS.poster,
  stage: 'POSTER',
  kind: 'poster',
  urls: ownUrls(IDS.poster),
};
const srtAsset = {
  ...renderAsset,
  id: IDS.srt,
  stage: 'EX',
  kind: 'caption',
  urls: ownUrls(IDS.srt),
};
const vttAsset = {
  ...renderAsset,
  id: IDS.vtt,
  stage: 'EX',
  kind: 'caption',
  urls: ownUrls(IDS.vtt),
};

const render = {
  status: 'awaiting_approval',
  video: renderAsset,
  poster: posterAsset,
  captions: { srt: srtAsset, vtt: vttAsset },
  render_passes: 1,
  wall_time_s: 214.6,
  peak_ram_mb: 1_412,
  qc: {
    status: 'pass',
    checks: [
      {
        id: 'QC-2',
        label: 'Resolution and frame rate',
        pass: true,
        measured: '1080×1920 @ 30 fps',
        expected: '1080×1920 @ 30 fps (±0 px, ±1 fps)',
        requirement: 'R-010-2',
      },
      {
        id: 'QC-3',
        label: 'Audio stream present and within ±0.5 s of the video',
        pass: true,
        measured: '75.1 s audio · 75.1 s video · +0.0 s',
        expected: 'present · within ±0.5 s',
        requirement: 'R-010-3',
      },
      {
        id: 'QC-4',
        label: 'Flagged frames (mean luminance <16 or >240)',
        pass: true,
        measured: '0 flagged',
        expected: '0',
        requirement: 'R-010-4',
      },
      {
        id: 'QC-5',
        label: 'Every scene present, visible duration ≥ narration span − 0.2 s',
        pass: true,
        measured: '17 of 17 scenes · min margin +0.0 s',
        expected: '17 of 17 · ≥ span − 0.2 s',
        requirement: 'R-010-5',
      },
      {
        id: 'QC-6',
        label: 'Captions inside the 5 % safe area',
        pass: true,
        measured: '100.0 %',
        expected: '100.0 %',
        requirement: 'R-010-6',
      },
      {
        id: 'QC-7',
        label: 'Rendered duration inside the ±5 % band',
        pass: true,
        measured: '75.1 s',
        expected: '71.3–78.8 s',
        requirement: 'R-010-7',
      },
    ],
    checked_at: T1,
  },
  approved: false,
  approved_at: null,
};

const exportFiles = [
  {
    name: 'founders-quietly-2026-10-20.mp4',
    kind: 'video',
    size_bytes: 48_234_112,
    sha256: sha(300),
    url: `/asset/${IDS.videoAsset}/full`,
  },
  {
    name: 'founders-quietly-2026-10-20.srt',
    kind: 'srt',
    size_bytes: 6_112,
    sha256: sha(301),
    url: `/asset/${IDS.srt}/full`,
  },
  {
    name: 'founders-quietly-2026-10-20.vtt',
    kind: 'vtt',
    size_bytes: 6_320,
    sha256: sha(302),
    url: `/asset/${IDS.vtt}/full`,
  },
  {
    name: 'founders-quietly-2026-10-20.json',
    kind: 'sidecar',
    size_bytes: 2_048,
    sha256: sha(303),
    url: `/asset/${IDS.sidecar}/full`,
  },
  {
    name: 'source-manifest.json',
    kind: 'manifest',
    size_bytes: 1_536,
    sha256: sha(304),
    url: `/asset/${IDS.manifest}/full`,
  },
];

const exportView = {
  status: 'blocked',
  package_built_at: null,
  files: exportFiles,
  total_bytes: 48_256_128,
  pins: [
    { stage: 'T', series_version: 2, series_version_id: IDS.seriesVersion2 },
    { stage: 'SC', series_version: 2, series_version_id: IDS.seriesVersion2 },
    { stage: 'IM', series_version: 3, series_version_id: IDS.seriesVersion3 },
    { stage: 'NA', series_version: 3, series_version_id: IDS.seriesVersion3 },
    { stage: 'RE', series_version: 3, series_version_id: IDS.seriesVersion3 },
  ],
  manifest: {
    video_id: IDS.video,
    series_version: 3,
    sources: [{ url: 'https://example.org/study', retrieved_at: T1 }],
    posted_flag: false,
  },
};

const attempt = {
  id: IDS.attempt,
  stage: 'NA',
  provider: 'elevenlabs',
  model: 'eleven_multilingual_v2',
  provider_request_id: 'req_000000000001',
  prompt_hash: 'sha256:9f2c',
  idempotency_protected: false,
  charge_status: 'billed',
  status: 'succeeded',
  error_class: null,
  http_status: 200,
  attempt_no: 1,
  max_attempts: 3,
  backoff_s: null,
  created_at: T0,
  started_at: T0,
  ended_at: T1,
};

const retryScope = {
  stage: 'NA',
  will_run: [
    {
      stage: 'NA',
      calls: { image: 0, tts: 1, text: 0, render_passes: 0 },
      detail: 'narration — 1 TTS call',
    },
    {
      stage: 'TC',
      calls: { image: 0, tts: 0, text: 0, render_passes: 0 },
      detail: 'timing — derived from the new alignment',
    },
    {
      stage: 'RE',
      calls: { image: 0, tts: 0, text: 0, render_passes: 1 },
      detail: 'render — 1 pass',
    },
  ],
  will_not_run: [
    { label: 'images', detail: '17 images (v3) stored and reused' },
    { label: 'script', detail: 'rev 4 approved' },
    { label: 'sources', detail: '5 accepted sources' },
  ],
  unknown_charge: false,
  idempotency_protected: false,
  blockers: [],
};

const healthReport = {
  ready: true,
  service: 'web',
  checked_at: T1,
  migration: { status: 'up_to_date', version: 'M-005' },
  components: [
    { name: 'postgres', status: 'ok', detail: 'pg_isready 12 ms' },
    { name: 'redis', status: 'ok', detail: 'PONG 3 ms' },
    { name: 'minio', status: 'ok', detail: 'health/live 200' },
    { name: 'migration', status: 'ok', detail: 'M-005 applied' },
    { name: 'queue', status: 'ok', detail: 'content 1 active, render 0 active' },
    { name: 'disk', status: 'degraded', detail: '38 GB free of 220 GB' },
  ],
  providers: [
    {
      provider: 'deepseek',
      key_present: true,
      qualified: true,
      qualified_at: T0,
      idempotency_protected: false,
      note: null,
    },
    {
      provider: 'gemini',
      key_present: true,
      qualified: true,
      qualified_at: T0,
      idempotency_protected: false,
      note: 'no honoured idempotency key (R-012-2)',
    },
    {
      provider: 'elevenlabs',
      key_present: true,
      qualified: false,
      qualified_at: null,
      idempotency_protected: false,
      note: 'qualification pending',
    },
  ],
  queue: { waiting: 2, active: 1, failed: 0 },
  disk: { free_bytes: 40_802_304_000, total_bytes: 236_223_283_200, headroom_ok: false },
  degraded_reasons: ['disk headroom below 20 %'],
};

const sseEvents = [
  {
    type: 'stage.updated',
    video_id: IDS.video,
    stage: 'RE',
    state: 'done',
    stale: false,
    occurred_at: T0,
  },
  {
    type: 'video.updated',
    video_id: IDS.video,
    status: 'NEEDS_ATTENTION',
    current_stage: 'FA',
    attention_kind: 'approval',
    attention_reason: 'final approval',
    occurred_at: T1,
  },
  {
    type: 'batch.progress',
    batch_id: IDS.batch,
    completed_count: 4,
    target_count: 8,
    status: 'ACTIVE',
    occurred_at: T1,
  },
  { type: 'health.changed', ready: true, degraded_reasons: [], occurred_at: T1 },
  { type: 'ping', occurred_at: T1 },
];

/** Non-JSON route fixture: an ordered replay for the SSE stream. */
export const SSE_FIXTURE = sseEvents;

export const FIXTURES: Record<RouteId, unknown> = {
  'health.live': { status: 'ok' },
  'health.ready': { ready: true, degraded_reasons: [] },
  'auth.session': {
    authenticated: true,
    username: 'operator',
    csrf_token: 'csrf-fixture-token',
    expires_at: '2026-11-19T09:41:12.000Z',
  },
  'auth.login': {
    authenticated: true,
    username: 'operator',
    csrf_token: 'csrf-fixture-token',
    expires_at: '2026-11-19T09:41:12.000Z',
  },
  'auth.logout': { ok: true },
  'overview.get': {
    attention: [
      {
        video_id: IDS.video,
        series_name: seriesSummary.name,
        video_label: 'Video 18',
        batch_id: null,
        batch_position: null,
        status: 'NEEDS_ATTENTION',
        current_stage: 'FA',
        stage_state: 'awaiting_approval',
        attention_kind: 'approval',
        attention_reason: 'final approval',
        updated_at: T1,
      },
      {
        video_id: IDS.video2,
        series_name: seriesSummary.name,
        video_label: 'Video 19',
        batch_id: IDS.batch,
        batch_position: 2,
        status: 'NEEDS_ATTENTION',
        current_stage: 'NA',
        stage_state: 'failed',
        attention_kind: 'failed',
        attention_reason: 'failed: NA',
        updated_at: T1,
      },
    ],
    batches: [
      {
        id: IDS.batch,
        series_id: IDS.series,
        series_name: seriesSummary.name,
        status: 'ACTIVE',
        target_count: 8,
        completed_count: 4,
        needs_attention_count: 1,
        failed_count: 1,
        created_at: T0,
      },
    ],
    counts: { needs_attention: 2, running: 3, complete: 4 },
    degraded: ['disk headroom below 20 %'],
  },
  'series.list': { series: [seriesSummary] },
  'series.create': seriesDetail,
  'series.get': seriesDetail,
  'series.update': seriesDetail,
  'series.versions.list': {
    versions: [
      {
        id: IDS.seriesVersion3,
        series_id: IDS.series,
        version: 3,
        mode: 'creative',
        target_duration_s: 75,
        changed_fields: ['voice_config.speed'],
        created_at: T1,
        created_by: 'operator',
      },
      {
        id: IDS.seriesVersion2,
        series_id: IDS.series,
        version: 2,
        mode: 'creative',
        target_duration_s: 75,
        changed_fields: ['art_style.preset'],
        created_at: T0,
        created_by: 'operator',
      },
    ],
  },
  'series.versions.get': {
    id: IDS.seriesVersion3,
    series_id: IDS.series,
    version: 3,
    mode: 'creative',
    target_duration_s: 75,
    changed_fields: ['voice_config.speed'],
    created_at: T1,
    created_by: 'operator',
    snapshot: profile,
    pinned_by: [{ project_id: IDS.video, stages: ['SB', 'IM', 'NA', 'TC'] }],
  },
  'series.versions.mint': {
    id: IDS.seriesVersion3,
    series_id: IDS.series,
    version: 3,
    mode: 'creative',
    target_duration_s: 75,
    changed_fields: ['voice_config.speed'],
    created_at: T1,
    created_by: 'operator',
    snapshot: profile,
    pinned_by: [],
  },
  'video.create': videoDetail,
  'video.get': videoDetail,
  'video.invalidation_preview': {
    revision: 4,
    ok: true,
    edits: ['script_wording'],
    invalidated: [
      { stage: 'SB', state_after: 'stale', quantity: 17, note: 'storyboard prompts re-derived' },
      { stage: 'NA', state_after: 'stale', quantity: 1, note: 'narration re-recorded' },
      { stage: 'TC', state_after: 'stale', quantity: 1, note: 'timing re-derived' },
      { stage: 'RE', state_after: 'stale', quantity: 1, note: 'one render pass' },
    ],
    survives: [
      { label: 'images', detail: '17 images (v3) stored and reused' },
      { label: 'sources', detail: '5 accepted sources' },
    ],
    calls: { image: 0, tts: 1, text: 1, render_passes: 1 },
    conditional: null,
    blockers: [],
  },
  'topic.get': topic,
  'topic.save': topic,
  'topic.approve': { ...topic, status: 'approved' },
  'script.get': script,
  'script.save': { ...script, status: 'draft', revision: 5 },
  'script.approve': { ...script, approved_at: T1 },
  'script.reject': { ...script, status: 'rejected', approved_at: null },
  'storyboard.get': storyboard,
  'storyboard.approve': storyboard,
  'scenes.list': { scenes },
  'scenes.get': scenes[0],
  'scenes.replace_image': {
    queued: true,
    stage: 'IM',
    scope: {
      stage: 'IM',
      will_run: [
        {
          stage: 'IM',
          calls: { image: 1, tts: 0, text: 0, render_passes: 0 },
          detail: 'scene S01 — 1 image call',
        },
      ],
      will_not_run: [{ label: 'other images', detail: '16 images stored and reused' }],
      unknown_charge: false,
      idempotency_protected: false,
      blockers: [],
    },
    enqueued_at: T1,
  },
  'audio.get': narration,
  'audio.rerun': { queued: true, stage: 'NA', scope: retryScope, enqueued_at: T1 },
  'audio.accept': narration,
  'render.get': render,
  'render.approve': { ...render, status: 'done', approved: true, approved_at: T1 },
  'export.get': exportView,
  'export.build': { ...exportView, status: 'done', package_built_at: T1 },
  'attempts.list': { attempts: [attempt] },
  'retry.scope': retryScope,
  'retry.run': { queued: true, stage: 'NA', scope: retryScope, enqueued_at: T1 },
  'health.report': healthReport,
  'settings.providers': {
    read_only: true,
    key_values_exposed: false,
    providers: healthReport.providers,
  },
  'events.stream': sseEvents,
};
