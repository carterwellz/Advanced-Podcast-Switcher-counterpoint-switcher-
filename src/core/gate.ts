import { SILENCE_DB } from './envelope.js';
import type { GateConfig, Interval, ReactionEvent, Seconds, Turn } from './types.js';

export interface TrackStats {
  speakerId: string;
  /** Level below which this mic is just room tone, in dBFS. */
  floorDb: number;
  /** Typical speech level for this mic, in dBFS. */
  speechDb: number;
  /** floorDb + openDb, clamped so a quiet track cannot become a hair trigger. */
  openThresholdDb: number;
  closeThresholdDb: number;
  /** Fraction of hops that are exact digital silence. Auphonic gating pushes this high. */
  digitalSilenceRatio: number;
  /** True when there is not enough dynamic range to call anything speech. */
  inactive: boolean;
}

export interface GateResult {
  stats: TrackStats;
  turns: Turn[];
  reactionCandidates: ReactionEvent[];
}

/**
 * Percentile over a Float32Array without sorting a copy of the whole thing when it
 * is large. A stride sample is plenty for a noise floor, and an episode has
 * hundreds of thousands of hops.
 */
function percentile(values: Float32Array, p: number, predicate?: (v: number) => boolean): number {
  const maxSamples = 200_000;
  const stride = Math.max(1, Math.floor(values.length / maxSamples));
  const picked: number[] = [];
  for (let i = 0; i < values.length; i += stride) {
    const v = values[i];
    if (predicate && !predicate(v)) continue;
    picked.push(v);
  }
  if (picked.length === 0) return SILENCE_DB;
  picked.sort((a, b) => a - b);
  const idx = Math.min(picked.length - 1, Math.max(0, Math.round(p * (picked.length - 1))));
  return picked[idx];
}

/**
 * Measure a track's noise floor and its speech peak. No thresholds yet, because a
 * track cannot be judged on its own: see `computeTrackStats`.
 */
export function measureTrack(db: Float32Array): {
  floorDb: number;
  speechDb: number;
  digitalSilenceRatio: number;
} {
  const silenceCutoff = SILENCE_DB + 1;
  let digitalSilence = 0;
  for (let i = 0; i < db.length; i++) if (db[i] <= silenceCutoff) digitalSilence++;

  return {
    floorDb: percentile(db, 0.1, (v) => v > silenceCutoff),
    // A high quantile, not the 95th. Someone who speaks for 4% of a window has
    // their 95th percentile sitting in room tone, which is exactly the case that
    // broke the first version.
    speechDb: percentile(db, 0.995),
    digitalSilenceRatio: db.length ? digitalSilence / db.length : 1,
  };
}

/**
 * Decide where this mic's gate sits.
 *
 * Three facts make a naive threshold wrong:
 *
 *  - Mics differ, so an absolute dBFS threshold is meaningless.
 *  - Auphonic's gating pushes true silence to digital zero, so a plain percentile
 *    floor lands at -120 and any "floor + N" gate becomes a hair trigger.
 *  - A person who barely speaks in the analysed stretch has no speech in their own
 *    statistics at all, so anchoring only to their own levels turns room tone into
 *    a 95%-talking speaker. That is a real bug this code already shipped once.
 *
 * So the gate is the *stricter* of two constraints, and a track is only trusted at
 * all when its speech peak is within reach of the loudest mics in the same room.
 */
export function computeTrackStats(
  speakerId: string,
  db: Float32Array,
  cfg: GateConfig,
  referenceSpeechDb: number,
): TrackStats {
  const { floorDb, speechDb, digitalSilenceRatio } = measureTrack(db);

  // Carries no speech in this stretch, only bleed and room tone.
  const inactive =
    !Number.isFinite(speechDb) ||
    !Number.isFinite(floorDb) ||
    speechDb < referenceSpeechDb - cfg.inactiveBelowReferenceDb ||
    speechDb - floorDb < 10;

  // Whichever constraint is stricter wins. Anchoring to the speech peak is what
  // handles a clean mic with a very low floor; anchoring to the floor is what
  // handles a noisy mic whose peak is close to its own noise.
  const openThresholdDb = Math.max(floorDb + cfg.openDb, speechDb - cfg.speechRangeDb);
  const closeThresholdDb = openThresholdDb - cfg.hysteresisDb;

  return {
    speakerId,
    floorDb,
    speechDb,
    openThresholdDb,
    closeThresholdDb,
    digitalSilenceRatio,
    inactive,
  };
}

/**
 * The room's speech level, taken as the median speech peak across mics that are
 * plausibly carrying speech. Median rather than max, so one clipped mic or one
 * dead mic cannot drag the reference for everybody.
 */
export function referenceSpeechLevel(speechDbs: number[]): number {
  const usable = speechDbs.filter((v) => Number.isFinite(v) && v > SILENCE_DB + 1);
  if (usable.length === 0) return SILENCE_DB;
  const sorted = usable.slice().sort((a, b) => a - b);
  // Upper-middle: with several quiet mics in a nine-person room, the plain median
  // sits too low, and the max is hostage to a single hot mic.
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.7));
  return sorted[idx];
}

/** Scan one track's envelope into speech runs using a hysteresis gate. */
function hysteresisRuns(
  db: Float32Array,
  openDb: number,
  closeDb: number,
): Array<{ startIdx: number; endIdx: number }> {
  const runs: Array<{ startIdx: number; endIdx: number }> = [];
  let open = false;
  let start = 0;
  for (let i = 0; i < db.length; i++) {
    const v = db[i];
    if (!open && v >= openDb) {
      open = true;
      start = i;
    } else if (open && v < closeDb) {
      open = false;
      runs.push({ startIdx: start, endIdx: i });
    }
  }
  if (open) runs.push({ startIdx: start, endIdx: db.length });
  return runs;
}

/** Merge runs separated by less than `maxGapHops`. */
function bridge(
  runs: Array<{ startIdx: number; endIdx: number }>,
  maxGapHops: number,
): Array<{ startIdx: number; endIdx: number }> {
  if (runs.length === 0) return runs;
  const out = [{ ...runs[0] }];
  for (let i = 1; i < runs.length; i++) {
    const prev = out[out.length - 1];
    if (runs[i].startIdx - prev.endIdx <= maxGapHops) prev.endIdx = runs[i].endIdx;
    else out.push({ ...runs[i] });
  }
  return out;
}

/**
 * Split one track's envelope into turns and reaction candidates.
 *
 * The two come from the same scan. A run long enough to be holding the floor is a
 * turn. A run too short for that, but still clearly above the noise floor, is what
 * a laugh, a scoff, or "that's not true" looks like on a clean mic. That short-run
 * bucket is the entire basis of the reaction-shot feature, so it is kept rather
 * than discarded as the usual "ignore small" setting would.
 */
export function gateTrack(
  speakerId: string,
  db: Float32Array,
  hopSeconds: number,
  timeOffset: Seconds,
  cfg: GateConfig,
  referenceSpeechDb: number,
): GateResult {
  const stats = computeTrackStats(speakerId, db, cfg, referenceSpeechDb);
  if (stats.inactive) {
    return { stats, turns: [], reactionCandidates: [] };
  }

  const raw = hysteresisRuns(db, stats.openThresholdDb, stats.closeThresholdDb);
  const merged = bridge(raw, Math.round(cfg.bridgeGapSeconds / hopSeconds));

  const turns: Turn[] = [];
  const reactionCandidates: ReactionEvent[] = [];
  const minTurnHops = cfg.minTurnSeconds / hopSeconds;
  const minReactionHops = cfg.minReactionSeconds / hopSeconds;

  for (const run of merged) {
    const hops = run.endIdx - run.startIdx;
    const start = timeOffset + run.startIdx * hopSeconds;
    const end = timeOffset + run.endIdx * hopSeconds;

    let sum = 0;
    let peak = SILENCE_DB;
    for (let i = run.startIdx; i < run.endIdx; i++) {
      sum += db[i];
      if (db[i] > peak) peak = db[i];
    }
    const mean = hops > 0 ? sum / hops : SILENCE_DB;

    if (hops >= minTurnHops) {
      turns.push({ speakerId, start, end, strengthDb: mean - stats.floorDb });
    } else if (hops >= minReactionHops && peak - stats.openThresholdDb >= cfg.reactionThresholdDb) {
      reactionCandidates.push({
        speakerId,
        start,
        end,
        peakDb: peak - stats.openThresholdDb,
        voiced: null,
      });
    }
  }

  return { stats, turns, reactionCandidates };
}

/** Union of intervals, assuming each input list is already sorted and disjoint. */
export function unionIntervals(lists: Interval[][]): Interval[] {
  const all = lists.flat().slice().sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of all) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

/** Gaps in `range` not covered by `covered`. Used for dead-air detection. */
export function complement(covered: Interval[], range: Interval, minLength: number): Interval[] {
  const out: Interval[] = [];
  let cursor = range.start;
  for (const iv of covered) {
    if (iv.start > cursor && iv.start - cursor >= minLength) {
      out.push({ start: cursor, end: iv.start });
    }
    cursor = Math.max(cursor, iv.end);
  }
  if (range.end - cursor >= minLength) out.push({ start: cursor, end: range.end });
  return out;
}
