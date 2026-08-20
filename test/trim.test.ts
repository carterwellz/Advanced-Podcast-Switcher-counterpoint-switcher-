import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deadAirRemovalIntervals,
  exceedsRemovalCeiling,
  fillerRemovalIntervals,
  mergeRemovalIntervals,
  removedFraction,
  snapIntervalsToFrames,
  sortDescendingForRipple,
} from '../src/core/trim.js';

test('deadAirRemovalIntervals pads inward and drops what collapses', () => {
  const silences = [
    { start: 10, end: 15 }, // 5s, survives a 1s pad easily
    { start: 20, end: 20.03 }, // 30ms, collapses under a 1s pad
  ];
  const out = deadAirRemovalIntervals(silences, 1);
  assert.deepEqual(out, [{ start: 11, end: 14 }]);
});

test('fillerRemovalIntervals insets from the ASR word boundary', () => {
  const spans = [{ start: 100, end: 100.5 }];
  const out = fillerRemovalIntervals(spans, 0.04);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].start - 100.04) < 1e-9);
  assert.ok(Math.abs(out[0].end - 100.46) < 1e-9);
});

test('padding never produces a negative-length or inverted interval', () => {
  // A span shorter than 2x the pad amount must be dropped entirely, not flipped.
  const spans = [{ start: 5, end: 5.05 }];
  const out = fillerRemovalIntervals(spans, 0.04);
  assert.deepEqual(out, []);
});

test('mergeRemovalIntervals unions overlapping and disjoint spans from both sources', () => {
  const deadAir = [{ start: 0, end: 5 }, { start: 20, end: 25 }];
  const filler = [{ start: 4, end: 6 }, { start: 30, end: 31 }];
  const out = mergeRemovalIntervals(deadAir, filler);
  assert.deepEqual(out, [
    { start: 0, end: 6 }, // 0-5 and 4-6 overlap, merged
    { start: 20, end: 25 },
    { start: 30, end: 31 },
  ]);
});

test('sortDescendingForRipple orders latest-start-first, the ordering host.jsx trusts blindly', () => {
  const intervals = [
    { start: 10, end: 12 },
    { start: 50, end: 52 },
    { start: 5, end: 6 },
    { start: 50.5, end: 51 }, // same start-ish neighbourhood, order among these is not asserted
  ];
  const out = sortDescendingForRipple(intervals);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].start >= out[i].start, 'not in descending start order');
  }
  assert.equal(out[out.length - 1].start, 5, 'earliest interval must be last');
});

test('sortDescendingForRipple does not mutate its input', () => {
  const intervals = [{ start: 1, end: 2 }, { start: 5, end: 6 }];
  const copy = intervals.map((i) => ({ ...i }));
  sortDescendingForRipple(intervals);
  assert.deepEqual(intervals, copy);
});

/*
 * The guard that would have caught Episode 30 Part 2 before anything touched the
 * timeline. A stale in/out point put the analysis range entirely outside the
 * sequence, so no track gated as active, so there were no turns, so the complement
 * of speech was the whole 2327s range and dead air proposed removing all of it.
 * Every stage was individually behaving as written; only the combination was absurd.
 */
test('a removal plan covering the whole range is refused', () => {
  const wholeRange = [{ start: 0, end: 2327 }];
  assert.equal(removedFraction(wholeRange, 2327), 1);
  assert.equal(exceedsRemovalCeiling(wholeRange, 2327), true);
});

test('a realistic dead-air plan is not refused', () => {
  // ~12% of a 40 minute range, comfortably more dead air than a real episode has.
  const intervals = [];
  for (let i = 0; i < 60; i++) intervals.push({ start: i * 40, end: i * 40 + 5 });
  const fraction = removedFraction(intervals, 2400);
  assert.ok(fraction > 0.1 && fraction < 0.15, `unexpected fraction ${fraction}`);
  assert.equal(exceedsRemovalCeiling(intervals, 2400), false);
});

test('removedFraction is zero rather than Infinity on a degenerate range', () => {
  assert.equal(removedFraction([{ start: 0, end: 10 }], 0), 0);
  assert.equal(exceedsRemovalCeiling([{ start: 0, end: 10 }], 0), false);
});

/*
 * The frame-alignment guard. Episode 30 produced 98 removal spans, not one of them
 * frame-aligned at both ends, and the result was zero gaps on audio (which ripples
 * sample-accurately) against 49 two-frame gaps on every video track. Video can only
 * cut on whole frames, so spans have to arrive already snapped.
 */
const FPS_23_976 = 24000 / 1001;

test('snapping puts both boundaries on exact frame lines', () => {
  // A real span from the failing episode, aligned to nothing.
  const out = snapIntervalsToFrames([{ start: 2310.12, end: 2314.88 }], FPS_23_976);
  assert.equal(out.length, 1);
  const frame = 1 / FPS_23_976;
  const startFrames = out[0].start / frame;
  const endFrames = out[0].end / frame;
  assert.ok(Math.abs(startFrames - Math.round(startFrames)) < 1e-6, 'start not on a frame');
  assert.ok(Math.abs(endFrames - Math.round(endFrames)) < 1e-6, 'end not on a frame');
  const lengthInFrames = (out[0].end - out[0].start) / frame;
  assert.ok(Math.abs(lengthInFrames - Math.round(lengthInFrames)) < 1e-6, 'length not whole frames');
});

test('snapping only ever shrinks a span, never grows it into neighbouring speech', () => {
  const original = { start: 100.037, end: 102.091 };
  const [snapped] = snapIntervalsToFrames([original], FPS_23_976);
  assert.ok(snapped.start >= original.start, 'start moved earlier, would eat preceding audio');
  assert.ok(snapped.end <= original.end, 'end moved later, would eat following audio');
});

test('an already-aligned span is left alone', () => {
  const frame = 1 / FPS_23_976;
  const exact = { start: 240 * frame, end: 360 * frame };
  const [snapped] = snapIntervalsToFrames([exact], FPS_23_976);
  assert.ok(Math.abs(snapped.start - exact.start) < 1e-9);
  assert.ok(Math.abs(snapped.end - exact.end) < 1e-9);
});

test('a span too short to contain a whole frame is dropped, not inverted', () => {
  const frame = 1 / FPS_23_976;
  const sliver = { start: 10 * frame + 0.001, end: 10 * frame + 0.004 };
  assert.deepEqual(snapIntervalsToFrames([sliver], FPS_23_976), []);
});

test('an unknown frame rate passes spans through untouched rather than mangling them', () => {
  const spans = [{ start: 1.234, end: 5.678 }];
  assert.deepEqual(snapIntervalsToFrames(spans, 0), spans);
});
