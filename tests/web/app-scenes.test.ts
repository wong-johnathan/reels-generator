import { describe, expect, it } from 'vitest';

import {
  HealthReportSchema,
  OverviewSchema,
  StoryboardViewSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies, type WebRequest } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import {
  createMemorySceneGateway,
  type MemorySceneSeed,
  type SceneGateway,
} from '../../src/web/scenes/gateway.js';
import type { StoryboardView } from '../../src/web/scenes/model.js';
import { createMemoryVideoGateway } from '../../src/web/workspace/gateway.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { parseHtml, textOf } from './helpers/html.js';

/**
 * F-06 routes — S-11 /storyboard, S-12 /scenes, S-13 /scenes/:sceneId and the
 * two commits (optional storyboard gate, per-scene replace).
 *
 * Everything runs against in-memory gateways and the injected session store:
 * no socket, no database, no provider, no network. The API mapping is INT-01's;
 * these tests prove the web behaviour and the request shapes the gateway gets.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']) as unknown as VideoDetail;
const storyboard = StoryboardViewSchema.parse(FIXTURES['storyboard.get']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');
const VIDEO_PATH = '/videos/' + detail.id;

const checkpointStoryboard: StoryboardView = {
  ...storyboard,
  first_three_reviewed: false,
  approved: false,
  approved_at: null,
  scenes: storyboard.scenes.map((scene, index) =>
    index < 3
      ? { ...scene, state: 'done' as const }
      : { ...scene, asset: null, state: 'not_run' as const },
  ),
};

function seed(overrides: Partial<MemorySceneSeed> = {}): MemorySceneSeed {
  return { storyboards: [checkpointStoryboard], releaseRemaining: 14, ...overrides };
}

function app(
  options: { overrides?: Partial<WebAppDependencies>; seed?: Partial<MemorySceneSeed> } = {},
) {
  const sessions = new MemorySessionStore();
  const gateway = createMemorySceneGateway(seed(options.seed));
  const authenticate = ({
    username,
    password,
  }: {
    username: string;
    password: string;
  }): { kind: 'authenticated'; username: string } | { kind: 'rejected' } =>
    username === 'operator' && password === 'preview-passphrase'
      ? { kind: 'authenticated', username }
      : { kind: 'rejected' };
  const handle = createWebApp({
    sessions,
    authenticate,
    overview,
    health,
    now: () => NOW,
    video: createMemoryVideoGateway([detail]),
    scenes: gateway,
    ...options.overrides,
  });
  return { handle, gateway };
}

async function signedIn(options: Parameters<typeof app>[0] = {}) {
  const { handle, gateway } = app(options);
  const response = await handle({
    method: 'POST',
    url: '/login',
    body: 'username=operator&password=preview-passphrase',
  });
  const cookie = (response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  return { handle, gateway, cookie };
}

const get = (path: string, cookie: string): WebRequest => ({
  method: 'GET',
  url: path,
  headers: { cookie },
});

const post = (path: string, body: Record<string, string>, cookie: string): WebRequest => ({
  method: 'POST',
  url: path,
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

describe('S-12 scene grid route', () => {
  it('renders the grid with the checkpoint banner and 17 tiles', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(get(VIDEO_PATH + '/scenes', cookie));
    expect(response.status).toBe(200);
    const text = textOf(parseHtml(response.body));
    expect(text).toContain('3 of 17 generated · 14 not started');
    expect(text).toContain('Release remaining 14');
    expect(response.body.match(/data-scene-no="/g) ?? []).toHaveLength(17);
  });

  it('wires the release control because the gateway exposes releaseRemaining', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(get(VIDEO_PATH + '/scenes', cookie));
    expect(response.body).toContain('/scenes/release-checkpoint');
    expect(response.body).not.toContain('Release is not wired');
  });

  it('renders the release control disabled when the gateway cannot release', async () => {
    const { handle, cookie } = await signedIn({ seed: { releaseRemaining: null } });
    const response = await handle(get(VIDEO_PATH + '/scenes', cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('Release is not wired');
  });
});

describe('S-11 storyboard route', () => {
  it('renders every scene with its span and prompt', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(get(VIDEO_PATH + '/storyboard', cookie));
    expect(response.status).toBe(200);
    const text = textOf(parseHtml(response.body));
    expect(text).toContain('17 scenes · target 17');
    expect(text).toContain('Scene 17: the protagonist meets the idea');
  });

  it('falls back to the F-04 stage summary when no scene store is mounted', async () => {
    const { handle, cookie } = await signedIn({ overrides: { scenes: undefined } });
    const response = await handle(get(VIDEO_PATH + '/storyboard', cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('data-stage-summary="SB"');
    expect(response.body).not.toContain('data-storyboard');
  });

  it('approves the optional gate and redirects with a notice', async () => {
    const { handle, gateway, cookie } = await signedIn();
    const response = await handle(
      post(VIDEO_PATH + '/storyboard/approve', { revision: '2' }, cookie),
    );
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(VIDEO_PATH + '/storyboard?notice=approved');
    expect(gateway.calls.approve).toEqual([{ videoId: detail.id, revision: 2 }]);
  });
});

describe('S-13 scene detail route', () => {
  const scene = checkpointStoryboard.scenes[6]!;

  it('renders the provenance panel and the replace form', async () => {
    const { handle, cookie } = await signedIn({ seed: { storyboards: [storyboard] } });
    const response = await handle(get(VIDEO_PATH + '/scenes/' + scene.id, cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('data-provenance');
    expect(response.body).toContain('gemini-nano-banana-2.1');
    expect(response.body).toContain('/replace-image');
  });

  it('holds scenes 4+ behind the checkpoint and names the reason in S-13', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(get(VIDEO_PATH + '/scenes/' + scene.id, cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('waits for the first-three checkpoint release');
    expect(response.body).toContain('data-scene-replace="empty"');
  });

  it('leaves scenes 1–3 replaceable while the checkpoint is open', async () => {
    const first = checkpointStoryboard.scenes[0]!;
    const { handle, cookie } = await signedIn();
    const response = await handle(get(VIDEO_PATH + '/scenes/' + first.id, cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('data-replace');
    expect(response.body).not.toContain('waits for the first-three checkpoint release');
  });

  it('404s for a scene id that does not belong to the video', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(
      get(VIDEO_PATH + '/scenes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cookie),
    );
    expect(response.status).toBe(404);
  });

  it('queues exactly one replace with the typed prompt, then redirects', async () => {
    const first = checkpointStoryboard.scenes[0]!;
    const { handle, gateway, cookie } = await signedIn();
    const response = await handle(
      post(
        VIDEO_PATH + '/scenes/' + first.id + '/replace-image',
        { revision: '1', image_prompt: 'Scene 1: rain-soaked window, low angle' },
        cookie,
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(VIDEO_PATH + '/scenes/' + first.id + '?notice=replaced');
    expect(gateway.calls.replace).toEqual([
      {
        videoId: detail.id,
        sceneId: first.id,
        revision: 1,
        image_prompt: 'Scene 1: rain-soaked window, low angle',
      },
    ]);
  });

  it('rejects a replace whose revision is not a number without calling the gateway', async () => {
    const first = checkpointStoryboard.scenes[0]!;
    const { handle, gateway, cookie } = await signedIn();
    const response = await handle(
      post(VIDEO_PATH + '/scenes/' + first.id + '/replace-image', { revision: 'x' }, cookie),
    );
    expect(response.status).toBe(400);
    expect(gateway.calls.replace).toEqual([]);
  });
});

describe('checkpoint release commit', () => {
  it('releases the remaining scenes and redirects with the call count', async () => {
    const { handle, gateway, cookie } = await signedIn();
    const response = await handle(
      post(VIDEO_PATH + '/scenes/release-checkpoint', { revision: '2' }, cookie),
    );
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(VIDEO_PATH + '/scenes?notice=released');
    expect(gateway.calls.release).toEqual([{ videoId: detail.id, revision: 2 }]);
  });

  it('answers an honest 503 when the backend cannot release', async () => {
    const { handle, cookie } = await signedIn({ seed: { releaseRemaining: null } });
    const response = await handle(
      post(VIDEO_PATH + '/scenes/release-checkpoint', { revision: '2' }, cookie),
    );
    expect(response.status).toBe(503);
    expect(response.body).toContain('Release is not wired');
  });
});

describe('guarding and isolation', () => {
  it('redirects an unauthenticated request to /login', async () => {
    const { handle } = await signedIn();
    const response = await handle({ method: 'GET', url: VIDEO_PATH + '/scenes' });
    expect(response.status).toBe(303);
    expect(response.headers.location).toContain('/login');
  });

  it('does not know a scene store it was not given', async () => {
    const { handle, cookie } = await signedIn({
      overrides: { scenes: undefined as unknown as SceneGateway },
    });
    const response = await handle(get(VIDEO_PATH + '/scenes', cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('data-stage-summary="IM"');
  });
});
