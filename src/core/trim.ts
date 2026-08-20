/*
 * Turns candidate removal spans (dead air, approved filler words) into an actual
 * ripple-delete plan. Pure interval math only: no ffmpeg, no Premiere, no I/O, and
 * nothing here is reachable unless a panel setting explicitly asks for it. This
 * file has no effect on `analyze()` or `planCuts()`, and importing it changes
 * nothing about how the existing plugin behaves.
 */
import { unionIntervals } from './gate.js';
import type { Interval } from './types.js';

/** Below this, a padded-down interval is not worth a ripple-delete at all. */
const MIN_REMOVAL_SEC = 0.02;

/**
 * Shrink every interval inward by `padSec` on each side, dropping anything that
 * collapses to (near) nothing once padded. Shared by dead-air and filler padding
 * because the arithmetic is identical; the two callers exist separately because
 * the reasoning for the pad amount is different for each (see below) and may
 * diverge later (a context-aware dead-air pad is a named, deliberately deferred
 * follow-up, not a hypothetical).
 */
function padInward(intervals: Interval[], padSec: number): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    const start = iv.start + padSec;
    const end = iv.end - padSec;
    if (end - start > MIN_REMOVAL_SEC) out.push({ start, end });
  }
  return out;
}

/**
 * Silence intervals (`analysis.silences`, already filtered to `deadAirSec` and
 * already merged across every speaker) padded down so a small amount of room tone
 * survives on each side of the cut. A silence trimmed flush to its own boundary
 * reads as a vacuum, not a pause; leaving a little of it in place is what keeps a
 * dead-air cut from sounding like the recording itself dropped out.
 */
export function deadAirRemovalIntervals(silences: Interval[], padSec: number): Interval[] {
  return padInward(silences, padSec);
}

/**
 * Approved filler-word spans (already turned into plain intervals by the caller,
 * after Carter's review) padded inward from each word's own ASR-reported boundary.
 *
 * Inward, not outward, and worth being explicit about why: ASR word timestamps are
 * accurate to tens of milliseconds, not frame-exact. The failure mode that matters
 * is the cut boundary clipping into the *neighbouring real word*, not leaving a
 * barely-audible fragment of the filler word's own onset or offset. Given the
 * requirement is "never delete real dialogue," a small leftover fragment of
 * disposable filler is the correct trade against any risk of nibbling a neighbour.
 */
export function fillerRemovalIntervals(spans: Interval[], padSec: number): Interval[] {
  return padInward(spans, padSec);
}

/** Dead-air and filler removals merged into one sorted, non-overlapping list. */
export function mergeRemovalIntervals(deadAir: Interval[], filler: Interval[]): Interval[] {
  return unionIntervals([deadAir, filler]);
}

/**
 * Snap every removal span onto exact frame boundaries.
 *
 * This is not a refinement, it is required for a gap-free ripple. Audio ripples
 * sample-accurately, but video can only cut on whole frames, so a span with
 * arbitrary sub-frame boundaries makes Premiere round the video edit while the audio
 * closes exactly. Measured on a real 98-span episode: audio came back with zero gaps
 * and every video track with 49 gaps of exactly two frames each (4.09s total), and
 * not one of those 98 spans was frame-aligned at both ends.
 *
 * Start rounds up and end rounds down, so the span only ever shrinks to the whole
 * frames strictly inside it. That keeps the pass conservative (it can never eat into
 * neighbouring speech to satisfy alignment) at a cost of up to one frame per side.
 */
export function snapIntervalsToFrames(intervals: Interval[], fps: number): Interval[] {
  if (!(fps > 0)) return intervals.slice();
  const frame = 1 / fps;
  const out: Interval[] = [];
  for (const iv of intervals) {
    const start = Math.ceil(iv.start / frame - 1e-6) * frame;
    const end = Math.floor(iv.end / frame + 1e-6) * frame;
    if (end - start > MIN_REMOVAL_SEC) out.push({ start, end });
  }
  return out;
}

/**
 * Order removal intervals latest-start-first for the ripple pass.
 *
 * This is what makes the whole ripple-apply operation coordinate-safe without any
 * remapping math in ExtendScript: removing interval N only ever shifts content
 * strictly after `N.end`. Process the rightmost remaining interval next and every
 * interval still queued is entirely to the left of everything already touched, so
 * its absolute start/end are still valid. Reversed, the second removal's own
 * coordinates go stale the instant the first one lands. `host.jsx` trusts this
 * ordering completely and never re-sorts; getting it right is TypeScript's job
 * specifically so ExtendScript can stay mechanical.
 */
export function sortDescendingForRipple(intervals: Interval[]): Interval[] {
  return intervals.slice().sort((a, b) => b.start - a.start);
}

/**
 * Hard ceiling on how much of the range one trim plan may remove. Deliberately
 * loose: this is a wrong-answer detector, not a taste control. Real dead air plus
 * filler lands in the low tens of percent at the very most, so anything past this
 * is a detection failure rather than an unusually quiet episode.
 *
 * It exists because every stage upstream can be individually correct and still
 * combine into "remove the whole episode": if no track gates as active, there are no
 * turns, so the complement of speech is the entire range and dead air swallows
 * everything. That is exactly the shape of a bad range or unmounted media, and a
 * ripple-delete is not something to discover after the fact.
 */
export const MAX_REMOVED_FRACTION = 0.5;

/** Fraction of `rangeLength` these removal intervals would take out, 0 when unknown. */
export function removedFraction(intervals: Interval[], rangeLength: number): number {
  if (!(rangeLength > 0)) return 0;
  const total = intervals.reduce((s, iv) => s + (iv.end - iv.start), 0);
  return total / rangeLength;
}

/** True when this plan removes so much of the range that it should be refused. */
export function exceedsRemovalCeiling(intervals: Interval[], rangeLength: number): boolean {
  return removedFraction(intervals, rangeLength) > MAX_REMOVED_FRACTION;
}
