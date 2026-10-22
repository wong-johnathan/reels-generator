/**
 * The canonical text-stage documents the deterministic fake serves.
 *
 * These are fixtures, not product content: they are the same bytes on every run,
 * they validate against `text-schemas.ts`, and `script` sits inside the measured
 * 75 s word band (216–239 words at 3.035 words/s — QUALIFICATION §2, R-009-2/3).
 * Downstream tasks (B-09 authoring, B-10 image prompts) can therefore exercise a
 * realistic document without a provider call.
 *
 * The narration is original prose written for this fixture; it is not quoted from
 * any source, so the 8-gram reference scan (R-003-2, B-09) has nothing to flag.
 */
import type { z } from 'zod';

import type {
  ScriptDocumentSchema,
  StoryboardDocumentSchema,
  TopicDocumentSchema,
} from './text-schemas.js';

export type TopicDocument = z.infer<typeof TopicDocumentSchema>;
export type ScriptDocument = z.infer<typeof ScriptDocumentSchema>;
export type StoryboardDocument = z.infer<typeof StoryboardDocumentSchema>;

const TOPIC: TopicDocument = {
  title: 'The cost of deciding everything at once',
  description:
    'Why founders who appear calm are usually not the ones with fewer problems, and how sorting decisions by the cost of undoing them buys back attention.',
  rationale:
    'Fits the series premise (psychology applied to the working life of a solo builder) and needs no factual claims, so it stays inside the creative channel.',
};

const SCRIPT: ScriptDocument = {
  script:
    'Every founder has heard the same advice. Move faster. ' +
    'The advice is not wrong, exactly. It is incomplete. Speed is a multiplier, and a multiplier takes its sign from the thing it multiplies. Point it at a decision that is cheap to reverse, and speed wins you information. Point it at a decision that is expensive to reverse, and speed simply gets you to the wrong place sooner. Psychologists describe the residue as cognitive load. Each open decision holds a small, silent reservation in your head. Ten of them cost more than one, not because the decisions are harder, but because the reservations never fully close. You carry the tab. The founders who look calm are rarely the ones with fewer problems. They are the ones who made the reversible decisions quickly and deliberately refused to hurry the irreversible ones. Hiring, pricing and the shape of the company are slow decisions. Most of the rest, including the ones that feel urgent at midnight, are not. There is a second trap: treating every decision as a decision at all. A surprising amount of a working week is maintenance, not choice. Naming that out loud is unglamorous, and it frees the attention that strategy actually needs. ' +
    'So before you speed up, ask one question. If this goes wrong, how much does it cost to undo? The answer tells you which gear to use.',
  title: 'Some decisions deserve the slow lane',
  description:
    'A short piece on cognitive load, reversible choices, and why speed is only useful once you know what it multiplies.',
  hashtags: ['#founders', '#psychology', '#decisionmaking', '#focus', '#creativeops'],
};

const FRAME_HOOK = 'Every founder has heard the same advice.';
const FRAME_ENDING = 'The answer tells you which gear to use.';

/** The frozen frame the deterministic fake serves: hook, ending and metadata. */
const FRAME = {
  hook: FRAME_HOOK,
  ending: FRAME_ENDING,
  title: SCRIPT.title,
  description: SCRIPT.description,
  hashtags: SCRIPT.hashtags,
};

/**
 * The middle narration. Derived from SCRIPT.script between the hook and the
 * ending, so `hook + ' ' + narration + ' ' + ending` reconstructs the canonical
 * script byte-for-byte (and therefore stays inside the measured word band).
 */
const NARRATION = {
  narration: SCRIPT.script.slice(
    FRAME_HOOK.length + 1,
    SCRIPT.script.length - FRAME_ENDING.length - 1,
  ),
};

const STORYBOARD: StoryboardDocument = {
  scenes: [
    {
      scene_no: 'S01',
      narration: 'Every founder has heard the same advice. Move faster.',
      image_prompt:
        'Duotone inked comic panel, recurring protagonist (short dark hair, round glasses, olive jacket) leaning over a desk stacked with clocks, one clock accelerating past the others, 9:16 vertical framing, no text or lettering',
      camera_move: 'zoom_in',
      caption_emphasis: 'same advice',
      fallback_text: 'Move faster.',
    },
    {
      scene_no: 'S02',
      narration: 'The advice is not wrong, exactly. It is incomplete.',
      image_prompt:
        'Same protagonist pausing mid-step on a wide staircase of half-finished decisions, warm side light, flat comic shading, empty speech space at the top of the frame, no text',
      camera_move: 'pan_r',
      caption_emphasis: 'incomplete',
      fallback_text: 'Not wrong. Incomplete.',
    },
    {
      scene_no: 'S03',
      narration:
        'Speed is a multiplier, and a multiplier takes its sign from the thing it multiplies.',
      image_prompt:
        'Repeated protagonist silhouette beside an oversized multiplication sign that leans over a small doorway, duotone palette with one accent colour, geometric shadows, no text',
      camera_move: 'static',
      caption_emphasis: 'multiplier',
      fallback_text: 'A multiplier takes its sign.',
    },
    {
      scene_no: 'S04',
      narration: 'Point it at a decision that is cheap to reverse, and speed wins you information.',
      image_prompt:
        'Protagonist writing on a glass board in a bright studio, arrows looping back on themselves, panels suggesting easy return paths, inked linework, no text',
      camera_move: 'pan_l',
      caption_emphasis: 'cheap to reverse',
      fallback_text: 'Speed wins information.',
    },
    {
      scene_no: 'S05',
      narration:
        'Point it at a decision that is expensive to reverse, and speed simply gets you to the wrong place sooner.',
      image_prompt:
        'Protagonist running down a corridor whose far door is drawn as a wall, motion lines behind them, cold blue shadows, single-point perspective, no text',
      camera_move: 'zoom_out',
      caption_emphasis: 'wrong place',
      fallback_text: 'Wrong place, sooner.',
    },
    {
      scene_no: 'S06',
      narration:
        'Psychologists describe the residue as cognitive load. Each open decision holds a small, silent reservation in your head.',
      image_prompt:
        'Cross-section of the protagonist head drawn in comic style, small paper tabs floating inside like unclosed files, low contrast background, no text',
      camera_move: 'zoom_in',
      caption_emphasis: 'open decision',
      fallback_text: 'A silent reservation.',
    },
    {
      scene_no: 'S07',
      narration:
        'Ten of them cost more than one, not because the decisions are harder, but because the reservations never fully close.',
      image_prompt:
        'Ten identical small doors floating around the protagonist, nine ajar and glowing faintly, one shut, duotone ink with a single warm highlight, no text',
      camera_move: 'static',
      caption_emphasis: 'never fully close',
      fallback_text: 'Reservations stay open.',
    },
    {
      scene_no: 'S08',
      narration: 'You carry the tab.',
      image_prompt:
        'Protagonist holding a long paper receipt that unrolls out of frame, deadpan expression, high contrast comic inking, empty space above for a caption, no text',
      camera_move: 'zoom_in',
      caption_emphasis: 'the tab',
      fallback_text: 'You carry the tab.',
    },
    {
      scene_no: 'S09',
      narration: 'The founders who look calm are rarely the ones with fewer problems.',
      image_prompt:
        'Protagonist sitting calmly at a cluttered table while a storm of papers swirls around them without touching, wide vertical composition, no text',
      camera_move: 'pan_r',
      caption_emphasis: 'look calm',
      fallback_text: 'Calm is not few problems.',
    },
    {
      scene_no: 'S10',
      narration:
        'They are the ones who made the reversible decisions quickly and deliberately refused to hurry the irreversible ones.',
      image_prompt:
        'Two sorting trays beside the protagonist, one labelled with a fast arrow and one with a slow hourglass drawn as symbols, clean comic linework, no words',
      camera_move: 'pan_l',
      caption_emphasis: 'reversible',
      fallback_text: 'Fast on one tray only.',
    },
    {
      scene_no: 'S11',
      narration: 'Hiring, pricing and the shape of the company are slow decisions.',
      image_prompt:
        'Protagonist standing before three tall stone doors shaped like a person, a price tag and a building, dim cathedral light, inked hatching, no text',
      camera_move: 'static',
      caption_emphasis: 'slow decisions',
      fallback_text: 'Three slow doors.',
    },
    {
      scene_no: 'S12',
      narration: 'Most of the rest, including the ones that feel urgent at midnight, are not.',
      image_prompt:
        'Protagonist at a kitchen table lit by a single phone screen, night outside the window, small pile of notes that look dramatic but thin, no text',
      camera_move: 'zoom_out',
      caption_emphasis: 'urgent at midnight',
      fallback_text: 'Urgent is not slow.',
    },
    {
      scene_no: 'S13',
      narration: 'There is a second trap: treating every decision as a decision at all.',
      image_prompt:
        'Protagonist standing at a crossroads made of identical signs, all pointing the same way, flat comic perspective, duotone shading, unreadable sign shapes, no text',
      camera_move: 'pan_r',
      caption_emphasis: 'second trap',
      fallback_text: 'Not everything is a choice.',
    },
    {
      scene_no: 'S14',
      narration: 'A surprising amount of a working week is maintenance, not choice.',
      image_prompt:
        'Protagonist oiling a small machine made of labelled gears and drawers, workshop bench, warm light, detailed ink textures, no text',
      camera_move: 'zoom_in',
      caption_emphasis: 'maintenance',
      fallback_text: 'Maintenance, not choice.',
    },
    {
      scene_no: 'S15',
      narration:
        'Naming that out loud is unglamorous, and it frees the attention that strategy actually needs.',
      image_prompt:
        'Protagonist clearing a desk in a single decisive sweep, a clean surface appearing under the clutter, high contrast comic panel, no text',
      camera_move: 'pan_l',
      caption_emphasis: 'frees the attention',
      fallback_text: 'Attention comes back.',
    },
    {
      scene_no: 'S16',
      narration: 'So before you speed up, ask one question.',
      image_prompt:
        'Protagonist with one hand raised as if pausing a crowd of arrows, centred, strong silhouette, dark background with a rim light, no text',
      camera_move: 'static',
      caption_emphasis: 'before you speed up',
      fallback_text: 'Ask one question.',
    },
    {
      scene_no: 'S17',
      narration:
        'If this goes wrong, how much does it cost to undo? The answer tells you which gear to use.',
      image_prompt:
        'Protagonist beside a two-speed gear lever drawn as a simple machine, calm expression, final panel framing with space at the bottom, no text',
      camera_move: 'zoom_out',
      caption_emphasis: 'cost to undo',
      fallback_text: 'Pick the gear.',
    },
  ],
};

export const QUIET_MACHINES_FIXTURES = {
  topic: TOPIC,
  script: SCRIPT,
  storyboard: STORYBOARD,
  frame: FRAME,
  narration: NARRATION,
} as const;

/** The fixture for a schema name, cloned so a caller cannot mutate the canonical copy. */
export function fixtureFor(name: string): unknown {
  const fixtures = QUIET_MACHINES_FIXTURES as unknown as Record<string, unknown>;
  return structuredClone(fixtures[name]);
}
