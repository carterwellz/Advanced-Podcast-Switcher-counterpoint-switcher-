import type {
  AnalysisResult,
  Interval,
  ReactionEvent,
  Seconds,
  ShotType,
  Speaker,
  Turn,
  VideoAngle,
} from './types.js';

export interface PlannerConfig {
  minShotSec: number;
  maxShotSec: number;
  cutDelayMs: number;
  returnCooldownSec: number;

  wideBudgetPct: number;
  wideMinSec: number;
  wideMaxSec: number;
  wideOnCrosstalk: boolean;
  wideOnPrompt: boolean;
  /**
   * How strongly the wide is favoured for the moment the floor changes hands, 0..100.
   * A handoff is a natural place to see the room. Deliberately a nudge and not a
   * rule: it competes with the tight shot of whoever just started talking, and the
   * wide ceiling still caps the total either way.
   */
  wideOnHandoffPct: number;
  /** How long the handoff window lasts. The minimum shot length still applies. */
  wideHandoffSec: number;
  /**
   * How often a monologue cutaway becomes a longer, deliberate look at the room
   * instead of the usual quick tight cutaway, 0..100. Meant to be rare: the room
   * shot the plugin was already spending on prompts and the walk-in was crowding
   * out every other reason to go wide, and nothing was left to spend the rest of
   * the budget on. Still counts against `wideBudgetPct` like everything else.
   */
  wideBreatherPct: number;
  /**
   * How long that occasional breather runs, instead of `monologueCutawaySec`. A
   * two-second glance does not read on a wide covering the whole room the way it
   * does on a two-shot; it needs enough time to actually register as a beat.
   */
  wideBreatherSec: number;

  reactEnabled: boolean;
  reactSensitivity: number;
  reactMinSec: number;
  reactMaxSec: number;
  reactCooldownSec: number;
  /**
   * How long one person must have held the floor before a reaction may interrupt.
   * During a fast exchange the cut should follow the argument; reactions earn their
   * place once somebody is holding forth.
   */
  reactAfterFloorSec: number;
  /**
   * How strongly reactions and cutaways favour the other side of the debate, 0..100.
   * A reaction or forced cutaway from the speaker's own bench is a nod, not a
   * counterpoint, so this is a ceiling on the same-side share of both: reactions
   * kept by `pickReactions()` and forced monologue-break/max-shot cutaways chosen by
   * `diversifyCutaways()` may each spend up to `1 - opposingBiasPct/100` of their
   * kind on the speaker's own side, tracked as a running ratio across the episode
   * rather than gated candidate by candidate, so a middle setting reads as "mostly
   * opposing, sometimes not" rather than "on" or "off".
   */
  opposingBiasPct: number;
  interruptEnabled: boolean;
  monologueSec: number;
  monologueCutawaySec: number;

  snapToPause: boolean;
  sameCameraPenalty: boolean;
}

export const DEFAULT_PLANNER: PlannerConfig = {
  minShotSec: 1.8,
  // 12 was far too tight for a debate. Every run that reached it was broken with a
  // forced cutaway, which on real material meant one every fourteen seconds, read as
  // a metronome, and got mistaken for the reaction feature misfiring.
  maxShotSec: 30,
  cutDelayMs: 150,
  // Was 4. Fully unwired until diversifyCutaways() gave it a job: how long to avoid
  // reusing the same camera for a monologue-break/max-shot cutaway. 60s is long
  // enough to actually rotate between siblings across a slow monologue cadence
  // (roughly one cutaway every 32s at the defaults below) without starving a
  // two-camera rig, which the diversify pass falls back to repeating anyway once no
  // fresh option scores close enough.
  returnCooldownSec: 60,
  wideBudgetPct: 15,
  wideMinSec: 1.5,
  wideMaxSec: 8,
  wideOnCrosstalk: true,
  wideOnPrompt: true,
  wideOnHandoffPct: 60,
  wideHandoffSec: 2.0,
  wideBreatherPct: 12,
  wideBreatherSec: 5.0,
  reactEnabled: true,
  reactSensitivity: 6,
  reactMinSec: 1.0,
  reactMaxSec: 2.5,
  reactCooldownSec: 25,
  reactAfterFloorSec: 15,
  // Was 70. At 75, the same-side ceiling this now also governs on forced cutaways
  // and reactions (1 - opposingBiasPct/100) lands at 25%, matching the conservative
  // edge of "75-80% opposing" rather than the loose edge.
  opposingBiasPct: 75,
  interruptEnabled: true,
  monologueSec: 30,
  monologueCutawaySec: 2.0,
  snapToPause: true,
  sameCameraPenalty: true,
};

export type CutReason =
  | 'speaker'
  | 'reaction'
  | 'interruption'
  /** Someone held the floor past the monologue threshold, so the edit looked away. */
  | 'monologue-break'
  /**
   * A shot hit the maximum length and had to go somewhere. Distinct from a
   * monologue break on purpose: both look away from the speaker, but this one is the
   * timer talking, not the conversation. Sharing a label with monologue breaks hid
   * the fact that a 12 second maximum was producing a forced cutaway every 14
   * seconds, and reporting them as reaction cuts made the panel say the opposite of
   * what the edit was doing.
   */
  | 'max-shot'
  | 'crosstalk'
  | 'prompt'
  | 'filler';

export interface Cut extends Interval {
  angleId: string;
  videoTrackIndex: number;
  reason: CutReason;
  /** Who this shot is about, when there is such a person. */
  subjectId?: string;
  /**
   * A deliberately-chosen wide breather, not an ordinary monologue-break cutaway.
   * Has to survive every merge (`pathToCuts()`'s run collapse, `joinAdjacent()`) or
   * `diversifyCutaways()` will rotate it back to a tight shot the moment it's stale,
   * silently defeating the reason it was chosen in the first place.
   */
  wideBreather?: boolean;
}

export interface PlanStats {
  cuts: number;
  cutsPerMinute: number;
  /** Share of the range each angle occupies, 0..1, keyed by angle id. */
  angleShare: Record<string, number>;
  /**
   * Share of the range each person is visible, 0..1, keyed by speaker id.
   *
   * These do NOT sum to 1 and are not meant to. A group shot has four people on
   * screen at once, so four people accrue that time, and a rig of group shots puts
   * the total near three. Comparing this directly against talkShare is comparing
   * two different denominators, which is what `seenWhenTalking` exists to avoid.
   */
  screenShare: Record<string, number>;
  /** Share of the range each person is talking, 0..1, keyed by speaker id. */
  talkShare: Record<string, number>;
  /**
   * Of the time this person holds the floor, the fraction where a camera is actually
   * showing them, 0..1.
   *
   * The one number in here that answers "is this person being missed", because it is
   * measured against their own speaking time rather than against the whole episode.
   * Screen share cannot answer it: on a rig of wide and group shots everybody scores
   * high whether or not the edit ever cuts to them deliberately.
   */
  seenWhenTalking: Record<string, number>;
  wideShare: number;
  reactionCuts: number;
  reactionsBySpeaker: Record<string, number>;
  /** Fraction of speaking time where the person talking is actually visible. */
  onSpeakerAccuracy: number;
  solverPasses: number;
}

export interface CutPlan {
  cuts: Cut[];
  stats: PlanStats;
  warnings: string[];
  range: Interval;
}

/** What a segment of timeline is fundamentally about. */
interface Segment extends Interval {
  kind: CutReason;
  /** Person the segment is about: the speaker, or the reactor on a reaction. */
  subjectId?: string;
  /** Person holding the floor, even on a reaction segment. */
  floorId?: string;
  /** The floor has just changed hands, so the room is worth a look. */
  handoff?: boolean;
  /**
   * How good a handoff this is to spend the room on, 0..1. Crossing sides is the
   * counterpoint moment and scores highest; a handoff after a real pause is a
   * natural breath; one mid-flow is barely a handoff at all.
   *
   * Without this the preference would be a single fixed bonus, which makes the
   * slider an on/off switch: either every handoff clears the bar or none does.
   * Varying the bonus per handoff is what makes a middle setting mean "the good
   * ones" rather than "half of them at random".
   */
  handoffQuality?: number;
  /**
   * This monologue-break segment was selected as a wide breather: it runs
   * `wideBreatherSec` instead of `monologueCutawaySec`, and `emission()` gives the
   * wide angle a decisive bonus for this occurrence only. Set by
   * `applyMonologueBreaks()`'s own running quota, independent of anything else.
   */
  wideBreather?: boolean;
}

/**
 * How far the wide is handicapped when the subject is one person.
 *
 * The wide shows everybody, so it technically "shows the subject" on every segment
 * and used to collect the same bonus a tight shot did, losing only on the tightness
 * multiplier. That put it permanently within a point or two of winning everywhere,
 * so which shots it took was decided by rounding rather than by intent, and the
 * result moved unpredictably whenever anything else changed.
 *
 * Nine faces in a 16:9 frame is not a way of showing one person, it is a way of
 * showing the room. So the wide now loses clearly whenever an individual is the
 * subject, and earns its screen time from crosstalk, prompts and handoffs instead.
 */
const WIDE_SUBJECT_HANDICAP = 6;

/**
 * How decisively a wide-breather occurrence wins the wide angle over its usual
 * competition on a monologue-break segment.
 *
 * Sized against the actual gap: a non-breather wide scores roughly 10 on a
 * monologue-break (tightness 0.35 plus a diluted opposing fraction, since the
 * wide's `.shows` includes everyone), and the best opposing two-shot scores
 * roughly 15.2. +12 puts wide at roughly 22, clear of even a `single`'s ceiling
 * (roughly 16), so no penalty to the competition is needed, and it applies to wide
 * alone rather than fighting every other angle down.
 */
const WIDE_BREATHER_BONUS = 12;

/**
 * How long an overlapping turn must have been running, as of the query instant,
 * before it can take the floor away from whoever already held it.
 *
 * Comparing total turn duration used information not yet known at that instant,
 * and let an established monologue keep "winning" against a genuine same-side
 * takeover for however long its own turn happened to run, not however long the
 * takeover had actually been real. Switching to elapsed-since-start alone does not
 * fix it either: the earlier turn's elapsed time is bigger than the later one's for
 * almost the whole overlap purely because it started first, so a magnitude
 * comparison never flips while both are active. The floor changes hands once the
 * later-started turn has itself been running this long, which is what tells a
 * genuine takeover apart from a brief interjection, not how it compares to the
 * turn it is taking over from. 1 second bounds "it takes a while to recognize and
 * switch" to about a second, and stays comfortably above `minTurnSeconds` (0.6s,
 * `gate.ts`) so a turn that only just cleared the "this is a Turn, not a reaction"
 * bar cannot flip the floor on its own.
 */
const FLOOR_TAKEOVER_GRACE_SEC = 1.0;

/**
 * Whether two angles come off the same physical body.
 *
 * Compared case and whitespace insensitively because the camera id is a field the
 * editor types. Exact equality meant "RIGHT CAM" and "Right Cam" were two different
 * cameras, and the only symptom would have been jump cuts quietly reappearing in one
 * project and not another.
 */
function sameCamera(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const SHOT_TIGHTNESS: Record<ShotType, number> = {
  single: 1.0,
  two: 0.8,
  group: 0.55,
  wide: 0.35,
};

/**
 * Turn analysis facts into a concrete list of shots.
 *
 * The whole thing is a shortest-path problem, not a sequence of local choices.
 * Picking the best angle segment by segment is what makes existing tools violate
 * their own minimum-shot and frequency settings: each decision looks fine alone and
 * the sequence is incoherent. Scoring every angle against every segment and solving
 * the chain once means the constraints hold by construction.
 */
export function planCuts(
  analysis: AnalysisResult,
  angles: VideoAngle[],
  cfg: PlannerConfig = DEFAULT_PLANNER,
): CutPlan {
  const warnings: string[] = [];
  const range = analysis.range;

  const usable = angles.filter((a) => a.shows.length > 0 || a.shotType === 'wide');
  if (usable.length === 0) {
    return {
      cuts: [],
      stats: emptyStats(),
      warnings: ['No camera has anyone tagged. Tag who each camera can see, then try again.'],
      range,
    };
  }
  if (usable.length < angles.length) {
    warnings.push(
      `${angles.length - usable.length} camera(s) have nobody tagged and were skipped.`,
    );
  }

  const segments = buildSegments(analysis, cfg);
  if (segments.length === 0) {
    return { cuts: [], stats: emptyStats(), warnings: ['No speech found in range.'], range };
  }

  // Places a forced cut can land without looking arbitrary: where somebody starts
  // or stops talking, and the middle of any real pause.
  const boundaries = [
    ...analysis.turns.flatMap((t) => [t.start, t.end]),
    ...analysis.silences.map((s) => (s.start + s.end) / 2),
  ].sort((a, b) => a - b);

  const speakerById = new Map(analysis.speakers.map((s) => [s.id, s]));

  // Solve, measure, nudge, solve again. Per-camera Target % is a target the planner
  // moves toward from either direction; the wide ceiling only ever pushes down.
  const bias = new Map<string, number>(usable.map((a) => [a.id, 0]));
  let best: Cut[] = [];
  let passes = 0;
  const MAX_PASSES = 12;

  for (passes = 1; passes <= MAX_PASSES; passes++) {
    const path = solve(segments, usable, speakerById, cfg, bias);
    best = pathToCuts(path, segments, usable, cfg, boundaries, speakerById);

    const shares = shareByAngle(best, range);
    let adjusted = false;

    for (const a of usable) {
      const got = shares[a.id] ?? 0;

      if (a.shotType === 'wide') {
        const cap = cfg.wideBudgetPct / 100;
        if (got > cap + 0.005) {
          bias.set(a.id, (bias.get(a.id) ?? 0) - Math.max(0.4, (got - cap) * 14));
          adjusted = true;
        }
        continue;
      }

      if (a.targetShare === null || a.targetShare === undefined) continue;
      const want = a.targetShare;
      const err = want - got;
      if (Math.abs(err) > 0.02) {
        bias.set(a.id, (bias.get(a.id) ?? 0) + err * 10);
        adjusted = true;
      }
    }

    if (!adjusted) break;
  }

  const wideCap = cfg.wideBudgetPct / 100;
  const finalShares = shareByAngle(best, range);
  const wideShare = usable
    .filter((a) => a.shotType === 'wide')
    .reduce((sum, a) => sum + (finalShares[a.id] ?? 0), 0);
  if (wideShare > wideCap + 0.01) {
    warnings.push(
      `Wide came out at ${(wideShare * 100).toFixed(1)}%, above the ${cfg.wideBudgetPct}% ceiling. ` +
        'Usually means the tighter cameras do not cover everyone who speaks.',
    );
  }

  for (const a of usable) {
    if (a.targetShare === null || a.targetShare === undefined || a.shotType === 'wide') continue;
    const got = finalShares[a.id] ?? 0;
    if (Math.abs(got - a.targetShare) > 0.06) {
      warnings.push(
        `${a.name} targeted ${(a.targetShare * 100).toFixed(0)}% and got ${(got * 100).toFixed(1)}%. ` +
          'Following the active speaker outranks hitting a target.',
      );
    }
  }

  return {
    cuts: best,
    stats: computeStats(best, analysis, usable, range, passes),
    warnings,
    range,
  };
}

/* -------------------------------------------------------------- segmentation */

/**
 * Chop the range at every point where the right answer could change: someone takes
 * or yields the floor, a reaction lands, a monologue overruns, the room erupts.
 */
function buildSegments(analysis: AnalysisResult, cfg: PlannerConfig): Segment[] {
  const { range, turns } = analysis;
  const delay = cfg.cutDelayMs / 1000;

  const marks = new Set<number>([range.start, range.end]);
  const add = (t: number) => {
    if (t > range.start && t < range.end) marks.add(round3(t));
  };

  const runs = floorRuns(turns);

  // The window is part of the lattice, not part of the preference. Adding these
  // boundaries only when the slider is above zero meant moving the slider changed
  // the segmentation as well as the scoring, and the result was not monotonic: a 50%
  // preference for the wide produced less wide than 0% did, because it was really
  // comparing two different segmentations. Boundaries are free when nothing wants to
  // cut on them, so they are always present and only the bonus is dialled.
  //
  // Clamped to the minimum shot length because a window shorter than that produces a
  // shot the minimum-shot pass immediately absorbs, which is a control that silently
  // does nothing.
  const handoffWindow = Math.max(cfg.wideHandoffSec, cfg.minShotSec);

  for (const t of turns) {
    add(t.start + delay);
    add(t.end);
    // Close the handoff window explicitly, so the room shot is a beat rather than
    // whatever is left of the incoming speaker's turn.
    if (handoffWindow > 0 && runs.start.get(t) === t.start) {
      add(t.start + delay + handoffWindow);
    }
  }
  for (const c of analysis.crosstalk) {
    add(c.start);
    add(c.end);
  }

  const reactions = cfg.reactEnabled ? pickReactions(analysis, cfg) : [];
  for (const r of reactions) {
    add(r.start);
    add(r.end);
  }

  const interrupts = cfg.interruptEnabled
    ? analysis.overlaps.filter((o) => o.isTakeover && o.interrupterId)
    : [];
  for (const o of interrupts) add(o.start);

  // Break up anything that outstays the maximum shot length.
  for (let t = range.start + cfg.maxShotSec; t < range.end; t += cfg.maxShotSec) add(t);

  const sorted = [...marks].sort((a, b) => a - b);
  const segments: Segment[] = [];
  const sideById = new Map(analysis.speakers.map((s) => [s.id, s.side]));

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end - start < 0.04) continue;
    const mid = (start + end) / 2;

    const floor = floorHolderAt(turns, mid);
    const inCrosstalk = analysis.crosstalk.some((c) => mid >= c.start && mid < c.end);
    const reaction = reactions.find((r) => mid >= r.start && mid < r.end);
    const takeover = interrupts.find((o) => mid >= o.start && mid < o.start + cfg.reactMaxSec);

    let kind: CutReason = 'speaker';
    let subjectId: string | undefined = floor?.speakerId;

    if (inCrosstalk && cfg.wideOnCrosstalk) {
      kind = 'crosstalk';
      subjectId = undefined;
    } else if (takeover) {
      kind = 'interruption';
      subjectId = takeover.interrupterId;
    } else if (reaction) {
      kind = 'reaction';
      subjectId = reaction.speakerId;
    } else if (!floor) {
      kind = 'filler';
      subjectId = undefined;
    }

    const isHandoff =
      kind === 'speaker' &&
      !!floor &&
      runs.start.get(floor) === floor.start &&
      mid < floor.start + delay + handoffWindow;

    segments.push({
      start,
      end,
      kind,
      subjectId,
      floorId: floor?.speakerId,
      handoff: isHandoff,
      handoffQuality: isHandoff ? handoffQuality(floor!, runs, sideById) : undefined,
    });
  }

  return applyMonologueBreaks(segments, cfg);
}

/**
 * How worthwhile it is to spend the room shot on this particular handoff, 0..1.
 *
 * Crossing sides is the moment the show is named after, so it scores highest. A
 * handoff after a real pause is a natural breath and reads well. A handoff mid-flow,
 * same side, is barely a change of subject and should mostly stay tight.
 */
function handoffQuality(
  incoming: Turn,
  runs: FloorRuns,
  sideById: Map<string, Speaker['side']>,
): number {
  let q = 0.2;

  const outgoingId = runs.prevSpeaker.get(incoming);
  const from = outgoingId ? sideById.get(outgoingId) : undefined;
  const to = sideById.get(incoming.speakerId);
  if (from && to && from !== to) {
    // Side to side is the moment the show is named after. To or from the host is a
    // change of subject too, just a less charged one.
    q += from !== 'host' && to !== 'host' ? 0.5 : 0.25;
  }

  // A measured gap rather than a listed silence: a silence event needs every mic
  // quiet for over a second, which in a live argument almost never happens, so
  // keying off it meant this term effectively never fired.
  const prevEnd = runs.prevEnd.get(incoming);
  if (prevEnd !== undefined && incoming.start - prevEnd >= 0.4) q += 0.3;

  return Math.min(1, q);
}

function floorHolderAt(turns: Turn[], t: number): Turn | undefined {
  let best: Turn | undefined;
  for (const turn of turns) {
    if (turn.start > t) break;
    if (t < turn.end) {
      if (!best) {
        best = turn;
        continue;
      }
      // `turns` is sorted by start, so every candidate reached here started at or
      // after `best`. It only takes the floor once it has held on its own, as of
      // `t`, for the grace period: comparing total duration let an established
      // monologue outlast a genuine same-side takeover for as long as its own turn
      // happened to run, and elapsed-since-start alone does not fix that either,
      // since the earlier turn's elapsed time is bigger for almost the whole
      // overlap purely from its head start. See FLOOR_TAKEOVER_GRACE_SEC.
      if (t - turn.start >= FLOOR_TAKEOVER_GRACE_SEC) best = turn;
    }
  }
  return best;
}

/**
 * Keep only reactions worth cutting on: loud enough, and not so frequent that one
 * animated listener takes over the edit.
 */
function pickReactions(analysis: AnalysisResult, cfg: PlannerConfig): ReactionEvent[] {
  const sideById = new Map(analysis.speakers.map((s) => [s.id, s.side]));
  const runStart = floorRuns(analysis.turns);

  const ordered = analysis.reactions
    .filter((r) => r.peakDb >= cfg.reactSensitivity)
    .slice()
    .sort((a, b) => a.start - b.start);

  // A running ceiling on how much of the partisan reaction pool may go to the
  // speaker's own side, rather than a hard gate. The show is about hearing the
  // other side, so most reactions should still land there, but a reaction from a
  // listener's own bench is real too and cutting it out entirely read as robotic.
  // Tracked as a ratio across the whole episode so it self-corrects instead of
  // gating every same-side candidate outright; the first same-side candidate is
  // always admitted, since refusing it before any opposing one has landed would
  // make the ceiling unreachable rather than stricter.
  const maxSameFraction = 1 - cfg.opposingBiasPct / 100;
  let sameCount = 0;
  let oppCount = 0;

  const kept: ReactionEvent[] = [];
  let lastAt = -Infinity;
  for (const r of ordered) {
    if (r.start - lastAt < cfg.reactCooldownSec) continue;

    // Only meaningful while somebody else holds the floor.
    const floor = floorHolderAt(analysis.turns, r.start);
    if (!floor || floor.speakerId === r.speakerId) continue;

    // Reactions earn their place during a monologue. Firing one in the middle of a
    // fast exchange fights the conversation instead of covering it.
    const heldFor = r.start - (runStart.start.get(floor) ?? floor.start);
    if (heldFor < cfg.reactAfterFloorSec) continue;

    // The host is neutral and pairs with either side, so only a partisan-vs-partisan
    // reaction counts toward the same-side ceiling at all.
    const floorSide = sideById.get(floor.speakerId);
    const reactorSide = sideById.get(r.speakerId);
    const bothPartisan = floorSide !== 'host' && reactorSide !== 'host';

    if (bothPartisan && floorSide === reactorSide) {
      const admit =
        sameCount === 0 || (sameCount + 1) / (sameCount + oppCount + 1) <= maxSameFraction + 1e-9;
      if (!admit) continue;
      sameCount++;
    } else if (bothPartisan) {
      oppCount++;
    }

    const length = Math.min(cfg.reactMaxSec, Math.max(cfg.reactMinSec, (r.end - r.start) * 3));
    kept.push({ ...r, end: r.start + length });
    lastAt = r.start;
  }
  return kept;
}

interface FloorRuns {
  /** When the current speaker took the floor. */
  start: Map<Turn, number>;
  /** Who held it before them. */
  prevSpeaker: Map<Turn, string | undefined>;
  /** When that previous holder stopped, so the gap at the handoff is measurable. */
  prevEnd: Map<Turn, number | undefined>;
}

/**
 * Collapse consecutive turns by one person into runs, and record what preceded each.
 *
 * A monologue is not one Turn. Someone talking for a minute breathes, and any pause
 * longer than the bridging gap ends a turn. What matters editorially is how long it
 * has been since the floor changed hands, so consecutive turns by one person count
 * as a single run.
 *
 * The previous holder is recorded here rather than tracked while walking segments,
 * because a handoff window spans several segments and a per-segment "who was last"
 * reports the incoming speaker for all but the first of them. That understated
 * cross-side handoffs badly: 10 of 52 instead of most of them.
 */
function floorRuns(turns: Turn[]): FloorRuns {
  const start = new Map<Turn, number>();
  const prevSpeaker = new Map<Turn, string | undefined>();
  const prevEnd = new Map<Turn, number | undefined>();

  let runSpeaker: string | undefined;
  let runStart = 0;
  let previous: string | undefined;
  let previousEnd: number | undefined;
  let lastEnd = 0;

  for (const t of turns) {
    if (t.speakerId !== runSpeaker) {
      previous = runSpeaker;
      previousEnd = runSpeaker === undefined ? undefined : lastEnd;
      runSpeaker = t.speakerId;
      runStart = t.start;
    }
    start.set(t, runStart);
    prevSpeaker.set(t, previous);
    prevEnd.set(t, previousEnd);
    lastEnd = Math.max(lastEnd, t.end);
  }
  return { start, prevSpeaker, prevEnd };
}

/**
 * If one person holds the floor past the monologue threshold, force a cutaway.
 * Marked as its own segment kind so scoring can push it to the opposing side.
 */
function applyMonologueBreaks(segments: Segment[], cfg: PlannerConfig): Segment[] {
  const out: Segment[] = [];
  let runSpeaker: string | undefined;
  let runStart = 0;

  // A running ratio over occurrences, not elapsed time: time-based either starves a
  // sparse episode of any breather at all, or fires on literally the first
  // available monologue-break once enough minutes have passed, neither of which
  // reads as "every once in a while". Unlike the same-side ceilings above, this one
  // does NOT admit its first eligible candidate for free: it is selecting a sparse
  // minority up from zero, and bootstrapping it would front-load a breather onto
  // whatever monologue-break happens to occur first, which is exactly what "rare"
  // rules out.
  let eligibleCount = 0;
  let breatherCount = 0;

  for (const seg of segments) {
    if (seg.floorId !== runSpeaker) {
      runSpeaker = seg.floorId;
      runStart = seg.start;
    }

    const held = seg.end - runStart;
    if (
      runSpeaker &&
      seg.kind === 'speaker' &&
      held > cfg.monologueSec &&
      seg.end - seg.start > cfg.monologueCutawaySec
    ) {
      const breakAt = seg.start;
      const segLen = seg.end - seg.start;

      let isBreather = false;
      if (cfg.wideBreatherPct > 0 && segLen > cfg.wideBreatherSec) {
        eligibleCount++;
        const target = cfg.wideBreatherPct / 100;
        isBreather = (breatherCount + 1) / eligibleCount <= target + 1e-9;
        if (isBreather) breatherCount++;
      }

      const cutawayLen = isBreather ? cfg.wideBreatherSec : cfg.monologueCutawaySec;

      out.push({
        start: breakAt,
        end: Math.min(seg.end, breakAt + cutawayLen),
        kind: 'monologue-break',
        subjectId: undefined,
        floorId: seg.floorId,
        wideBreather: isBreather || undefined,
      });
      if (seg.end > breakAt + cutawayLen) {
        out.push({ ...seg, start: breakAt + cutawayLen });
      }
      runStart = breakAt;
      continue;
    }
    out.push(seg);
  }
  return out;
}

/* -------------------------------------------------------------------- solving */

/**
 * How much a segment's suitability counts, relative to the cost of cutting.
 *
 * Being on the right angle for eight seconds matters more than being on it for one,
 * so emission is weighted by how long the segment actually runs. Without this every
 * boundary sliver votes as loudly as a whole turn, and any preference that lives in
 * a short window (the wide on a handoff, most obviously) can never repay the cost of
 * cutting there and back, no matter how the slider is set.
 *
 * The square root rather than the duration itself: a thirty second turn is more
 * important than a two second one, but not fifteen times more, and linear weighting
 * let one long stretch decide the whole neighbourhood.
 */
function weightOf(seg: Segment): number {
  return Math.sqrt(Math.max(0.05, seg.end - seg.start));
}

/** Viterbi over segments. Returns the chosen angle index per segment. */
function solve(
  segments: Segment[],
  angles: VideoAngle[],
  speakers: Map<string, Speaker>,
  cfg: PlannerConfig,
  bias: Map<string, number>,
): number[] {
  const n = segments.length;
  const k = angles.length;

  const cost = new Float64Array(n * k).fill(Infinity);
  const back = new Int32Array(n * k).fill(-1);

  for (let s = 0; s < k; s++) {
    cost[s] = -emission(segments[0], angles[s], speakers, cfg, bias) * weightOf(segments[0]);
  }

  for (let i = 1; i < n; i++) {
    const seg = segments[i];
    const w = weightOf(seg);
    for (let s = 0; s < k; s++) {
      const em = -emission(seg, angles[s], speakers, cfg, bias) * w;
      let bestCost = Infinity;
      let bestPrev = -1;
      for (let p = 0; p < k; p++) {
        const prev = cost[(i - 1) * k + p];
        if (prev === Infinity) continue;
        const total = prev + em + transition(angles[p], angles[s], seg, cfg);
        if (total < bestCost) {
          bestCost = total;
          bestPrev = p;
        }
      }
      cost[i * k + s] = bestCost;
      back[i * k + s] = bestPrev;
    }
  }

  let endState = 0;
  let endCost = Infinity;
  for (let s = 0; s < k; s++) {
    if (cost[(n - 1) * k + s] < endCost) {
      endCost = cost[(n - 1) * k + s];
      endState = s;
    }
  }

  const path = new Array<number>(n);
  path[n - 1] = endState;
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i * k + path[i]];
  return path;
}

/** How good this angle is for this segment. Higher is better. */
function emission(
  seg: Segment,
  angle: VideoAngle,
  speakers: Map<string, Speaker>,
  cfg: PlannerConfig,
  bias: Map<string, number>,
): number {
  let score = bias.get(angle.id) ?? 0;
  const tight = SHOT_TIGHTNESS[angle.shotType];
  const showsSubject = seg.subjectId ? angle.shows.includes(seg.subjectId) : false;
  const showsFloor = seg.floorId ? angle.shows.includes(seg.floorId) : false;

  switch (seg.kind) {
    case 'crosstalk':
      score += angle.shotType === 'wide' ? 12 : 1;
      break;

    case 'prompt':
      score += angle.shotType === 'wide' && cfg.wideOnPrompt ? 8 : showsSubject ? 5 : 0;
      break;

    case 'reaction':
    case 'interruption':
      if (showsSubject) score += 14 + tight * 6;
      else score -= 6;
      if (angle.shotType === 'wide') score -= WIDE_SUBJECT_HANDICAP;
      score += opposingBonus(seg, angle, speakers, cfg);
      break;

    case 'monologue-break':
      // Anyone but the person talking, and preferably the other side.
      if (showsFloor && !showsAnyoneElse(angle, seg.floorId)) score -= 10;
      else score += 6 + tight * 4;
      score += opposingBonus(seg, angle, speakers, cfg);
      // A wide breather is a deliberate, occasional choice made when this segment
      // was built (applyMonologueBreaks()'s own quota), not a per-solve preference:
      // decisive rather than a nudge, so it actually wins this specific occurrence
      // instead of just narrowing the gap.
      if (seg.wideBreather && angle.shotType === 'wide') score += WIDE_BREATHER_BONUS;
      break;

    case 'filler':
      score += angle.shotType === 'wide' ? 3 : 1;
      break;

    case 'speaker':
    default:
      if (showsSubject) score += 10 + tight * 8;
      else score -= 8;
      if (angle.shotType === 'wide') {
        score -= WIDE_SUBJECT_HANDICAP;
        // A change of speaker is a natural moment to see the room, and the only
        // place the wide earns individual-subject time back. Scaled by how good a
        // handoff it is, so a middle setting takes the cross-side and post-pause
        // ones and leaves the mid-flow ones tight.
        if (seg.handoff) {
          score += (cfg.wideOnHandoffPct / 100) * 20 * (seg.handoffQuality ?? 0.5);
        }
      }
      break;
  }

  return score;
}

function showsAnyoneElse(angle: VideoAngle, exceptId?: string): boolean {
  return angle.shows.some((id) => id !== exceptId);
}

/**
 * The show is about hearing the other side, so a cutaway during one side's turn
 * is worth more when it lands on the opposition.
 */
function opposingBonus(
  seg: Segment,
  angle: VideoAngle,
  speakers: Map<string, Speaker>,
  cfg: PlannerConfig,
): number {
  const floorSide = seg.floorId ? speakers.get(seg.floorId)?.side : undefined;
  if (!floorSide || floorSide === 'host') return 0;
  const weight = (cfg.opposingBiasPct / 100) * 8;

  let opposing = 0;
  for (const id of angle.shows) {
    const side = speakers.get(id)?.side;
    if (side && side !== 'host' && side !== floorSide) opposing++;
  }
  if (angle.shows.length === 0) return 0;
  return weight * (opposing / angle.shows.length);
}

/** Cost of moving from one angle to another at this segment boundary. */
function transition(
  from: VideoAngle,
  to: VideoAngle,
  seg: Segment,
  cfg: PlannerConfig,
): number {
  if (from.id === to.id) return 0;

  let cost = 3;

  // Two crops of one sensor cut together read as a jump cut.
  //
  // Effectively prohibitive rather than merely expensive, and large finite rather
  // than Infinity so that a rig where every alternative is the same body still
  // produces a plan instead of no plan. It was 14, which worked only until emission
  // began scaling with segment length: on a long turn the gap between the right
  // angle and a wrong one runs past 100, and a 14 point penalty is small change
  // against that. The result was real jump cuts on a four-two-shot rig, which is the
  // one thing this setting exists to prevent, so it is not a number to trade.
  if (cfg.sameCameraPenalty && sameCamera(from.physicalCamera, to.physicalCamera)) {
    cost += 1e6;
  }

  // Discourage very short shots. The hard guarantee is enforced afterwards; this
  // just stops the solver from choosing them in the first place.
  const length = seg.end - seg.start;
  if (length < cfg.minShotSec) cost += (cfg.minShotSec - length) * 6;

  return cost;
}

/* ------------------------------------------------------------- postprocessing */

/**
 * Collapse the per-segment path into runs, then guarantee the minimum shot length.
 *
 * Enforcing it here rather than inside the solver keeps the state space small: a
 * Viterbi state that also tracked elapsed time would multiply states by every
 * possible duration for a constraint that a merge pass satisfies exactly.
 */
function pathToCuts(
  path: number[],
  segments: Segment[],
  angles: VideoAngle[],
  cfg: PlannerConfig,
  boundaries: number[],
  speakers: Map<string, Speaker>,
): Cut[] {
  const runs: Cut[] = [];
  for (let i = 0; i < segments.length; i++) {
    const angle = angles[path[i]];
    const seg = segments[i];
    const last = runs[runs.length - 1];
    if (last && last.angleId === angle.id) {
      last.end = seg.end;
      if (rank(seg.kind) > rank(last.reason)) {
        last.reason = seg.kind;
        last.subjectId = seg.subjectId;
      }
      if (seg.wideBreather) last.wideBreather = true;
    } else {
      runs.push({
        start: seg.start,
        end: seg.end,
        angleId: angle.id,
        videoTrackIndex: angle.videoTrackIndex,
        reason: seg.kind,
        subjectId: seg.subjectId,
        wideBreather: seg.wideBreather,
      });
    }
  }

  const shaped = enforceMaxShot(enforceMinShot(runs, cfg.minShotSec), angles, cfg, boundaries, speakers);
  return normalize(shaped, angles, cfg, boundaries, speakers);
}

/**
 * Single place responsible for the guarantees this planner makes about its output:
 * the shots tile the range exactly, none is shorter than the minimum, and none is
 * longer than the maximum.
 *
 * These were previously spread across three passes that each half-enforced them and
 * undid each other's work, which is how a 12-second maximum shipped 86-second shots
 * twice. Concentrating the invariants in one loop that runs to a fixed point is the
 * difference between intending them and having them.
 */
function normalize(
  runs: Cut[],
  angles: VideoAngle[],
  cfg: PlannerConfig,
  boundaries: number[],
  speakers: Map<string, Speaker>,
): Cut[] {
  let out = joinAdjacent(runs.filter((c) => c.end > c.start));
  if (out.length === 0) return out;

  for (let pass = 0; pass < 12; pass++) {
    // Tiling first: every shot starts exactly where the last one ended.
    for (let i = 1; i < out.length; i++) out[i].start = out[i - 1].end;
    out = joinAdjacent(out.filter((c) => c.end > c.start + 1e-9));

    // Same-camera adjacency has to be repaired here, not only priced in the solver.
    // The solver never chooses one, but dropping a short run to satisfy the minimum
    // makes its two neighbours adjacent, and nothing was checking whether that new
    // pairing was two crops of one body. That is how jump cuts survived a penalty
    // meant to be prohibitive.
    if (cfg.sameCameraPenalty) out = mergeSameCamera(out, angles);

    const tooShort = out.some((c) => c.end - c.start < cfg.minShotSec - 1e-3);
    const tooLong = out.some((c) => c.end - c.start > cfg.maxShotSec + 1e-3);
    if (!tooShort && !tooLong) break;

    if (tooShort) out = enforceMinShot(out, cfg.minShotSec);
    if (tooLong) out = enforceMaxShot(out, angles, cfg, boundaries, speakers);
  }

  if (cfg.sameCameraPenalty) out = mergeSameCamera(out, angles);

  // Reassigning which angle a monologue-break or max-shot cutaway uses cannot
  // create a length violation -- it only ever changes angleId, never start/end --
  // so it runs once, after shot lengths have already converged, rather than inside
  // the length loop above. It CAN create a same-camera adjacency the same way a
  // dropped short run does, hence the merge pass immediately after.
  out = diversifyCutaways(out, angles, cfg, speakers);
  if (cfg.sameCameraPenalty) out = mergeSameCamera(out, angles);

  // Minimum wins over maximum where they genuinely conflict, because a shot below
  // the minimum is a visible flash and a slightly long shot is merely slow.
  return joinAdjacent(out.filter((c) => c.end > c.start + 1e-9));
}

/**
 * Break up any shot that outstays the maximum.
 *
 * Boundaries inserted during segmentation are not enough on their own: when the
 * segments either side of a boundary choose the same camera they merge straight
 * back together, and the limit silently disappears. Splitting has to happen after
 * merging, and it has to actually move to a different camera, otherwise the split
 * is invisible.
 */
/** How far a forced cut may be nudged to land on a real pause. */
const SNAP_WINDOW_SEC = 3.0;

/**
 * Move `ideal` onto the nearest natural boundary within `window`, without pushing it
 * outside the range that keeps both resulting pieces legal.
 */
function snapToBoundary(
  ideal: number,
  earliest: number,
  latest: number,
  boundaries: number[],
  window: number,
): number {
  const clamped = Math.min(Math.max(ideal, earliest), Math.max(earliest, latest));
  if (window <= 0 || boundaries.length === 0) return clamped;

  let best = clamped;
  let bestDist = Infinity;
  for (const b of boundaries) {
    if (b < earliest || b > latest) continue;
    const d = Math.abs(b - ideal);
    if (d > window) continue;
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

function enforceMaxShot(
  runs: Cut[],
  angles: VideoAngle[],
  cfg: PlannerConfig,
  boundaries: number[],
  speakers: Map<string, Speaker>,
): Cut[] {
  const cutaway = Math.max(cfg.minShotSec, cfg.monologueCutawaySec);
  // No alternative can satisfy the minimum, so breaking up would only churn.
  if (angles.length < 2) return runs;

  const out: Cut[] = [];

  for (const run of runs) {
    let current = { ...run };

    let guard = 0;
    while (current.end - current.start > cfg.maxShotSec && guard++ < 200) {
      const remaining = current.end - current.start;
      // Leave enough after the cutaway to satisfy the minimum, else stop splitting.
      if (remaining - cfg.maxShotSec - cutaway < cfg.minShotSec) break;

      const alt = bestAlternative(current, angles, cfg, speakers);
      if (!alt) break;

      // Splitting on a fixed clock produces a visible 12-2-12-2 metronome. Land the
      // cut on a real pause near the deadline instead, so the rhythm comes from the
      // conversation rather than from the timer.
      const deadline = current.start + cfg.maxShotSec;
      const splitAt = snapToBoundary(
        deadline,
        current.start + cfg.minShotSec,
        // Never past the deadline. Snapping may only pull a cut earlier, onto a
        // pause that has already happened, or the maximum stops being a maximum.
        Math.min(deadline, current.end - cutaway - cfg.minShotSec),
        boundaries,
        cfg.snapToPause ? SNAP_WINDOW_SEC : 0,
      );
      out.push({ ...current, end: splitAt });
      out.push({
        start: splitAt,
        end: splitAt + cutaway,
        angleId: alt.id,
        videoTrackIndex: alt.videoTrackIndex,
        reason: 'max-shot',
        subjectId: undefined,
      });
      current = { ...current, start: splitAt + cutaway };
    }

    out.push(current);
  }

  return joinAdjacent(out);
}

/**
 * The framing-and-opposing-side merit of a candidate cutaway angle, everything
 * `bestAlternative()` scores except recency. Pulled out on its own so
 * `diversifyCutaways()` can score the angle already in use on the same terms as
 * every alternative it is weighing against it, rather than inventing a second
 * rubric that could quietly drift out of step with this one.
 */
function alternativeMerit(
  candidate: VideoAngle,
  currentAngle: VideoAngle | undefined,
  subject: string | undefined,
  subjectSide: Speaker['side'] | undefined,
  cfg: PlannerConfig,
  speakers: Map<string, Speaker>,
): number {
  let score = SHOT_TIGHTNESS[candidate.shotType] * 4;
  if (
    cfg.sameCameraPenalty &&
    currentAngle &&
    candidate.id !== currentAngle.id &&
    sameCamera(candidate.physicalCamera, currentAngle.physicalCamera)
  ) {
    score -= 20;
  }
  if (subject && candidate.shows.includes(subject)) score -= 6;
  if (candidate.shows.length > 0) score += 2;

  // Look at the other bench. This function used to score purely on framing, so a
  // forced cutaway during one side's turn could land on that same side, which is
  // the one thing a show built on hearing the opposition must not do.
  if (subjectSide && subjectSide !== 'host' && candidate.shows.length > 0) {
    let opposing = 0;
    for (const id of candidate.shows) {
      const side = speakers.get(id)?.side;
      if (side && side !== 'host' && side !== subjectSide) opposing++;
    }
    score += (cfg.opposingBiasPct / 100) * 10 * (opposing / candidate.shows.length);
  }

  return score;
}

/**
 * How hard a cutaway angle is discouraged for having been used inside the return
 * cooldown, ramped linearly from full strength at the instant of reuse to zero
 * right at the cooldown boundary.
 *
 * Sized against what `alternativeMerit` actually produces: two comparably framed,
 * fully-opposing angles differ by rounding only, and a single beats a two-shot on
 * tightness alone by about 0.8. 12 comfortably outweighs both at full strength, so
 * recency can flip a genuine tie or near-tie, and it decays away over the cooldown
 * window rather than sitting on the scale forever.
 */
const CUTAWAY_FRESHNESS_PENALTY = 12;

function freshnessPenalty(
  angleId: string,
  recentlyUsed: Map<string, number> | undefined,
  asOf: number | undefined,
  cooldownSec: number,
): number {
  if (!recentlyUsed || asOf === undefined) return 0;
  const lastUsed = recentlyUsed.get(angleId);
  if (lastUsed === undefined) return 0;
  const sinceUse = asOf - lastUsed;
  if (sinceUse >= cooldownSec) return 0;
  return CUTAWAY_FRESHNESS_PENALTY * (1 - sinceUse / cooldownSec);
}

/**
 * Pick something to cut away to: a different physical camera where possible, and
 * one that shows somebody other than whoever this shot is already about.
 *
 * `recentlyUsed`/`asOf` are optional: `enforceMaxShot()`'s own call site doesn't
 * pass them and gets exactly the framing-only scoring it always has.
 * `diversifyCutaways()` passes both to also discourage an angle used too recently
 * as a cutaway, which is what actually produces rotation instead of a single
 * tie always resolving to the same camera.
 */
function bestAlternative(
  run: Cut,
  angles: VideoAngle[],
  cfg: PlannerConfig,
  speakers: Map<string, Speaker>,
  floorId?: string,
  recentlyUsed?: Map<string, number>,
  asOf?: number,
): VideoAngle | null {
  const currentAngle = angles.find((a) => a.id === run.angleId);
  const subject = run.subjectId ?? floorId;
  const subjectSide = subject ? speakers.get(subject)?.side : undefined;

  let best: VideoAngle | null = null;
  let bestScore = -Infinity;

  for (const a of angles) {
    if (a.id === run.angleId) continue;
    let score = alternativeMerit(a, currentAngle, subject, subjectSide, cfg, speakers);
    score -= freshnessPenalty(a.id, recentlyUsed, asOf, cfg.returnCooldownSec);

    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }

  return best;
}

/**
 * Pick the best cutaway angle that favours the floor holder's OWN side, for the
 * occasional same-side cutaway `diversifyCutaways()`'s quota calls for. A separate
 * function rather than a mode flag on `bestAlternative()`, because "favour this
 * side" and "favour the opposite side" are different searches, not the same
 * search with a sign flipped: this one has to actively require coverage of the
 * floor's own side, not merely fail to prefer the other one.
 */
function bestSameSideAlternative(
  run: Cut,
  angles: VideoAngle[],
  cfg: PlannerConfig,
  speakers: Map<string, Speaker>,
  floorId: string | undefined,
  floorSide: Speaker['side'] | undefined,
  recentlyUsed: Map<string, number>,
  asOf: number,
): VideoAngle | null {
  const currentAngle = angles.find((a) => a.id === run.angleId);

  let best: VideoAngle | null = null;
  let bestScore = -Infinity;

  for (const a of angles) {
    if (a.id === run.angleId || a.shotType === 'wide') continue; // wide has its own breather path
    if (!floorId || a.shows.includes(floorId)) continue; // never the speaker's own camera
    if (cfg.sameCameraPenalty && currentAngle && sameCamera(a.physicalCamera, currentAngle.physicalCamera)) continue;

    let own = 0;
    for (const id of a.shows) {
      if (speakers.get(id)?.side === floorSide) own++;
    }
    if (a.shows.length === 0 || own === 0) continue; // must actually show the floor's own side

    let score = SHOT_TIGHTNESS[a.shotType] * 4 + (own / a.shows.length) * 10;
    score -= freshnessPenalty(a.id, recentlyUsed, asOf, cfg.returnCooldownSec);

    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }

  return best;
}

/**
 * How much worse a fresh alternative may score than the angle already in use and
 * still be worth taking, in the same points `alternativeMerit` returns.
 *
 * Set below the opposing-side bonus gap at the default 75% bias (roughly 7.5
 * points between a fully-opposing and a fully-same-side candidate), so rotation
 * alone never trades a shot that actually covers the opposing side for one that
 * does not; that trade is only made deliberately, via the same-side quota below.
 * Set above the tightness gap between adjacent shot types (roughly 0.8-1.4
 * points), so a comparably composed alternative one tightness class down still
 * gets taken instead of repeating the same camera.
 */
const CUTAWAY_DIVERSITY_TOLERANCE = 3;

/**
 * Spreads forced monologue-break/max-shot cutaways across the cameras that
 * qualify for them, instead of the same tie resolving to the same camera every
 * time it recurs across an episode, and occasionally lets one land on the floor
 * holder's own side rather than always the opposition.
 *
 * A sequential post-process over the final cut list, the same category as
 * `mergeSameCamera()`, not a per-angle bias in the solver: monologue-break
 * segments are all close to the same duration, so a bias delta big enough to flip
 * one tied instance flips essentially all of them at once, which only swaps which
 * single camera dominates rather than producing real rotation. Genuine `reaction`/
 * `interruption` cuts are untouched -- they have a real subjectId from actual
 * audio and must keep following whoever audibly reacted. A `wideBreather` cut is a
 * deliberate choice, not a placeholder waiting to be rotated, so it is untouched
 * too.
 */
function diversifyCutaways(
  cuts: Cut[],
  angles: VideoAngle[],
  cfg: PlannerConfig,
  speakers: Map<string, Speaker>,
): Cut[] {
  if (angles.length < 2) return cuts;
  const byId = new Map(angles.map((a) => [a.id, a]));
  const recentlyUsed = new Map<string, number>();
  const maxSameFraction = 1 - cfg.opposingBiasPct / 100;
  let sameCount = 0;
  let oppCount = 0;
  const out: Cut[] = [];

  for (const cut of cuts) {
    if (cut.wideBreather) {
      out.push({ ...cut });
      continue;
    }
    if (cut.reason !== 'monologue-break' && cut.reason !== 'max-shot') {
      out.push({ ...cut });
      continue;
    }

    // Cut has no floorId of its own; recover who this cutaway is leaving from the
    // immediately preceding cut, the tail of the run that triggered it.
    const prev = out[out.length - 1];
    const floorId = prev?.subjectId;
    const floorSide = floorId ? speakers.get(floorId)?.side : undefined;
    const currentAngle = byId.get(cut.angleId);

    // Same running-ratio ceiling as pickReactions(), tracked independently: these
    // are a different population of cuts at different moments, and sharing one
    // pair of counters with the reaction quota would make either ratio jumpy.
    let wantSameSide = false;
    if (floorSide && floorSide !== 'host') {
      wantSameSide =
        sameCount === 0 || (sameCount + 1) / (sameCount + oppCount + 1) <= maxSameFraction + 1e-9;
    }

    if (wantSameSide) {
      const sameSide = bestSameSideAlternative(cut, angles, cfg, speakers, floorId, floorSide, recentlyUsed, cut.start);
      if (sameSide) {
        sameCount++;
        out.push({ ...cut, angleId: sameSide.id, videoTrackIndex: sameSide.videoTrackIndex });
        recentlyUsed.set(sameSide.id, cut.start);
        continue;
      }
      // No camera covers the floor holder's own side at all -- fall through rather
      // than silently burning a quota slot on nothing.
    }
    if (floorSide && floorSide !== 'host') oppCount++;

    const lastUsed = recentlyUsed.get(cut.angleId);
    const stale = lastUsed !== undefined && cut.start - lastUsed < cfg.returnCooldownSec;
    if (!stale) {
      out.push({ ...cut });
      recentlyUsed.set(cut.angleId, cut.start);
      continue;
    }

    const currentMerit = currentAngle
      ? alternativeMerit(currentAngle, currentAngle, floorId, floorSide, cfg, speakers)
      : -Infinity;
    const fresh = bestAlternative(cut, angles, cfg, speakers, floorId, recentlyUsed, cut.start);
    const freshMerit = fresh
      ? alternativeMerit(fresh, currentAngle, floorId, floorSide, cfg, speakers)
      : -Infinity;

    if (fresh && freshMerit >= currentMerit - CUTAWAY_DIVERSITY_TOLERANCE) {
      out.push({ ...cut, angleId: fresh.id, videoTrackIndex: fresh.videoTrackIndex });
      recentlyUsed.set(fresh.id, cut.start);
    } else {
      out.push({ ...cut });
      recentlyUsed.set(cut.angleId, cut.start);
    }
  }

  return out;
}

/** Reaction beats speaker when labelling a merged run, since it is the rarer event. */
function rank(r: CutReason): number {
  switch (r) {
    case 'interruption': return 5;
    case 'reaction': return 4;
    case 'monologue-break': return 3;
    case 'max-shot': return 3;
    case 'crosstalk': return 2;
    case 'speaker': return 1;
    default: return 0;
  }
}

function enforceMinShot(runs: Cut[], minShotSec: number): Cut[] {
  if (runs.length <= 1) return runs;
  let out = runs.slice();

  for (let guard = 0; guard < 40; guard++) {
    let shortest = -1;
    let shortestLen = Infinity;
    for (let i = 0; i < out.length; i++) {
      const len = out[i].end - out[i].start;
      if (len < minShotSec && len < shortestLen) {
        shortestLen = len;
        shortest = i;
      }
    }
    if (shortest === -1) break;
    if (out.length === 1) break;

    // Hand the offending stretch to whichever neighbour is already longer, so
    // absorbing it cannot create a fresh violation.
    const prev = out[shortest - 1];
    const next = out[shortest + 1];
    const prevLen = prev ? prev.end - prev.start : -1;
    const nextLen = next ? next.end - next.start : -1;

    if (prev && (!next || prevLen >= nextLen)) prev.end = out[shortest].end;
    else if (next) next.start = out[shortest].start;
    out.splice(shortest, 1);

    // Absorbing may have made neighbours identical; join them.
    out = joinAdjacent(out);
  }

  return out;
}

/**
 * Collapse any two neighbouring shots that come off the same physical camera.
 *
 * Two crops of one sensor side by side are not a cut, they are a jump. Since the
 * picture cannot legitimately change there, the repair is to make it one shot rather
 * than to find a third angle: reaching for a different camera would mean inventing a
 * cut the conversation never asked for, and could itself land below the minimum.
 *
 * The longer of the two wins, because it is the one carrying the moment. Ties go to
 * the earlier shot so the result does not depend on iteration order.
 */
function mergeSameCamera(runs: Cut[], angles: VideoAngle[]): Cut[] {
  if (runs.length < 2) return runs;
  const byId = new Map(angles.map((a) => [a.id, a]));

  const out: Cut[] = [{ ...runs[0] }];
  for (let i = 1; i < runs.length; i++) {
    const prev = out[out.length - 1];
    const cur = runs[i];
    const a = byId.get(prev.angleId);
    const b = byId.get(cur.angleId);

    if (prev.angleId !== cur.angleId && sameCamera(a?.physicalCamera, b?.physicalCamera)) {
      const prevLonger = prev.end - prev.start >= cur.end - cur.start;
      if (prevLonger) {
        prev.end = cur.end;
      } else {
        prev.angleId = cur.angleId;
        prev.videoTrackIndex = cur.videoTrackIndex;
        prev.reason = cur.reason;
        prev.subjectId = cur.subjectId;
        prev.wideBreather = cur.wideBreather;
        prev.end = cur.end;
      }
      continue;
    }
    out.push({ ...cur });
  }
  return joinAdjacent(out);
}

function joinAdjacent(runs: Cut[]): Cut[] {
  const out: Cut[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.angleId === r.angleId) {
      last.end = r.end;
      if (rank(r.reason) > rank(last.reason)) {
        last.reason = r.reason;
        last.subjectId = r.subjectId;
      }
      if (r.wideBreather) last.wideBreather = true;
    } else out.push({ ...r });
  }
  return out;
}

/* ----------------------------------------------------------------- statistics */

function shareByAngle(cuts: Cut[], range: Interval): Record<string, number> {
  const total = range.end - range.start;
  const out: Record<string, number> = {};
  for (const c of cuts) out[c.angleId] = (out[c.angleId] ?? 0) + (c.end - c.start);
  for (const k of Object.keys(out)) out[k] /= total || 1;
  return out;
}

function computeStats(
  cuts: Cut[],
  analysis: AnalysisResult,
  angles: VideoAngle[],
  range: Interval,
  passes: number,
): PlanStats {
  const total = range.end - range.start || 1;
  const angleShare = shareByAngle(cuts, range);
  const byId = new Map(angles.map((a) => [a.id, a]));

  const screen: Record<string, number> = {};
  for (const c of cuts) {
    const a = byId.get(c.angleId);
    if (!a) continue;
    for (const id of a.shows) screen[id] = (screen[id] ?? 0) + (c.end - c.start);
  }
  for (const k of Object.keys(screen)) screen[k] /= total;

  const talk: Record<string, number> = {};
  for (const t of analysis.turns) talk[t.speakerId] = (talk[t.speakerId] ?? 0) + (t.end - t.start);
  for (const k of Object.keys(talk)) talk[k] /= total;

  const wideShare = angles
    .filter((a) => a.shotType === 'wide')
    .reduce((sum, a) => sum + (angleShare[a.id] ?? 0), 0);

  // Only count reactions the viewer can actually see. Cutting "to" a reactor on a
  // camera that was already on screen, or that was already showing them, changes
  // nothing on the picture. Counting those would flatter the rig rather than
  // measure it, and the whole point of the feature is that reactions read.
  const reactionCuts: Cut[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    // Reactions and interruptions only. A shot the maximum-length rule forced is not
    // a reaction to anything, and counting those made the panel report dozens of
    // "reaction cuts" on an edit whose reactions had all been filtered out.
    if (c.reason !== 'reaction' && c.reason !== 'interruption') continue;
    const prev = cuts[i - 1];
    if (!prev || prev.angleId === c.angleId) continue;
    const prevAngle = byId.get(prev.angleId);
    if (c.subjectId && prevAngle?.shows.includes(c.subjectId)) continue;
    reactionCuts.push(c);
  }

  const reactionsBySpeaker: Record<string, number> = {};
  for (const c of reactionCuts) {
    if (c.subjectId) reactionsBySpeaker[c.subjectId] = (reactionsBySpeaker[c.subjectId] ?? 0) + 1;
  }

  const accuracy = onSpeakerAccuracy(cuts, analysis, byId);

  return {
    cuts: cuts.length,
    cutsPerMinute: cuts.length / (total / 60),
    angleShare,
    screenShare: screen,
    talkShare: talk,
    wideShare,
    reactionCuts: reactionCuts.length,
    reactionsBySpeaker,
    seenWhenTalking: accuracy.bySpeaker,
    onSpeakerAccuracy: accuracy.overall,
    solverPasses: passes,
  };
}

/**
 * Of all the time somebody is talking, how much of it is spent on a camera that can
 * actually see them. The single number worth watching: everything else can look
 * healthy while the edit stares at the wrong person.
 */
function onSpeakerAccuracy(
  cuts: Cut[],
  analysis: AnalysisResult,
  byId: Map<string, VideoAngle>,
): { overall: number; bySpeaker: Record<string, number> } {
  let speaking = 0;
  let onTarget = 0;
  let ci = 0;

  const spoke: Record<string, number> = {};
  const seen: Record<string, number> = {};

  for (const turn of analysis.turns) {
    const length = turn.end - turn.start;
    speaking += length;
    spoke[turn.speakerId] = (spoke[turn.speakerId] ?? 0) + length;

    while (ci > 0 && cuts[ci].start > turn.start) ci--;
    for (let i = ci; i < cuts.length; i++) {
      const c = cuts[i];
      if (c.start >= turn.end) break;
      if (c.end <= turn.start) { ci = i; continue; }
      const a = byId.get(c.angleId);
      if (!a || !a.shows.includes(turn.speakerId)) continue;
      const overlap = Math.min(c.end, turn.end) - Math.max(c.start, turn.start);
      onTarget += overlap;
      seen[turn.speakerId] = (seen[turn.speakerId] ?? 0) + overlap;
    }
  }

  const bySpeaker: Record<string, number> = {};
  for (const id of Object.keys(spoke)) {
    bySpeaker[id] = spoke[id] > 0 ? Math.min(1, (seen[id] ?? 0) / spoke[id]) : 0;
  }

  return { overall: speaking > 0 ? onTarget / speaking : 0, bySpeaker };
}

function emptyStats(): PlanStats {
  return {
    cuts: 0,
    cutsPerMinute: 0,
    angleShare: {},
    screenShare: {},
    talkShare: {},
    wideShare: 0,
    reactionCuts: 0,
    reactionsBySpeaker: {},
    seenWhenTalking: {},
    onSpeakerAccuracy: 0,
    solverPasses: 0,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Segment lattice, exposed for diagnostics and tuning. Not used by the panel. */
export function debugSegments(analysis: AnalysisResult, cfg: PlannerConfig = DEFAULT_PLANNER) {
  return buildSegments(analysis, cfg);
}
