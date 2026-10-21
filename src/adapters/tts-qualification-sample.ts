/**
 * The TTS qualification fixture — R-008-3 / TECH_DESIGN §5.6 / D5 residual unknown.
 *
 * R-008-3 requires the TTS adapter to demonstrate "character-level alignment on a
 * >=60 s sample with >=99% word coverage and monotonic word timestamps". The
 * Milestone A residual unknown (PRD §4 D5) names the harder version: a 75 s
 * script containing at least ten proper nouns / jargon terms, because that is
 * where alignment is expected to break.
 *
 * This sample is ~250 words of original prose at the measured narration pace
 * (3.035 words/s, QUALIFICATION §2), so it is ~80 s of speech — comfortably over
 * the 60 s floor — and it carries the proper nouns the D5 benchmark asks for
 * (Kowloon, Sargasso, Mira Okonkwo, Tobias, Kelvinator, Adeyemi, Reykjavik,
 * Hilti, XLR, EQ, plus jargon). It was written for this repository; no
 * third-party text is reproduced.
 *
 * The unit tests pin its word count and derived duration so the fixture cannot
 * silently shrink below the threshold.
 */

export interface TtsQualificationSample {
  readonly label: string;
  readonly text: string;
  /** Proper nouns / jargon terms the D5 benchmark counts (>=10). */
  readonly proper_nouns: readonly string[];
}

export const TTS_QUALIFICATION_SAMPLE: TtsQualificationSample = {
  label: 'd5-proper-nouns-75s',
  proper_nouns: [
    'Kowloon',
    'Sargasso',
    'Mira Okonkwo',
    'Tobias',
    'Kelvinator',
    'Adeyemi',
    'Reykjavik',
    'Hilti',
    'XLR',
    'EQ',
    'multimeter',
  ],
  text: [
    'At half past two in the morning, Mira Okonkwo finally admitted that the studio in Kowloon',
    'was haunted by its own wiring. The hum had begun two weeks earlier, on the night she',
    'recorded a narration about the Sargasso Sea, and it grew louder with every take. She',
    'unplugged the preamp, swapped the XLR cable, and grounded the rack to a copper rod outside',
    'the fire escape. Nothing changed. The hum simply moved, like a tenant who refuses to leave.',
    'Her colleague Tobias kept insisting it was the refrigerator in the alley below, an ancient',
    'Kelvinator that cycled on whenever the voltage sagged. Mira tested his theory at four in',
    'the morning with a borrowed multimeter and a notebook, writing down every dip and spike in',
    'the line, and by dawn she had three pages of numbers that proved him almost right. The',
    'refrigerator was not the cause, but its compressor was a symptom: the whole building shared',
    'a single overloaded circuit, and somewhere between the second floor and the basement a',
    'neutral wire had worked itself loose. The landlord, a patient man named Mr Adeyemi, called',
    'an electrician from Reykjavik who happened to be visiting his sister. He arrived with a',
    'thermal camera, a battered Hilti drill, and an opinion about everything. By noon the wire',
    'was fixed, the hum was gone, and Mira recorded the Sargasso narration in a single clean',
    'take, with no EQ, no noise gate, and no excuses. She kept the notebook anyway. On the last',
    'page she wrote a single line: check the neutral before you blame the ghost.',
  ].join(' '),
};
