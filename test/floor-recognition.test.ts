import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PLANNER, debugSegments } from '../src/core/planner.js';
import type { AnalysisResult } from '../src/core/types.js';

/**
 * Fast and synthetic on purpose: unlike constraints.test.ts, this does not need real
 * audio or the R: drive. It is testing floorHolderAt()'s tie-break rule directly, which
 * only needs a hand-built AnalysisResult with two overlapping turns, not a real episode.
 */

function analysisWithOverlap(): AnalysisResult {
  return {
    speakers: [
      { id: 'a', name: 'A', audioTrackIndex: 0, side: 'A', clips: [] },
      { id: 'b', name: 'B', audioTrackIndex: 1, side: 'A', clips: [] },
    ],
    envelopes: [],
    // A holds the floor from 0-40s. B, on the same side but a different camera,
    // starts talking at 20s and keeps going past where A eventually stops, until 35s.
    // A's turn is far longer in total (40s vs 15s), which is exactly the shape that
    // broke the old total-duration tie-break: A would keep "winning" for the entire
    // 15 seconds B is actually talking.
    turns: [
      { speakerId: 'a', start: 0, end: 40, strengthDb: 20 },
      { speakerId: 'b', start: 20, end: 35, strengthDb: 20 },
    ],
    reactions: [],
    overlaps: [],
    crosstalk: [],
    silences: [],
    range: { start: 0, end: 40 },
  };
}

test('a sustained same-side takeover is recognized within a couple seconds, not only once the outgoing turn ends', () => {
  const analysis = analysisWithOverlap();
  const segments = debugSegments(analysis, DEFAULT_PLANNER);

  const takeoverSegment = segments.find((s) => s.start >= 20 && s.start < 25);
  assert.ok(takeoverSegment, 'no segment found shortly after B takes over');
  assert.equal(
    takeoverSegment!.floorId,
    'b',
    `expected the floor to switch to B shortly after B started talking, got '${takeoverSegment!.floorId}'. ` +
      'Under the old total-duration tie-break this stays on A (40s turn) for the entire time B is active (15s turn).',
  );
});

test('the floor reverts to the outgoing speaker once the takeover ends', () => {
  const analysis = analysisWithOverlap();
  const segments = debugSegments(analysis, DEFAULT_PLANNER);

  const afterSegment = segments.find((s) => s.start >= 35 && s.start < 40);
  assert.ok(afterSegment, 'no segment found after B stops talking');
  assert.equal(afterSegment!.floorId, 'a', 'expected the floor back on A once B stopped');
});

test('a brief interjection does not steal the floor', () => {
  const analysis = analysisWithOverlap();
  // C interjects for under a second while A is mid-sentence, well clear of
  // minTurnSeconds (0.6s) so it is a real Turn, not a reaction candidate, but short
  // enough it should never itself prove out.
  analysis.speakers.push({ id: 'c', name: 'C', audioTrackIndex: 2, side: 'A', clips: [] });
  analysis.turns.push({ speakerId: 'c', start: 10, end: 10.7, strengthDb: 20 });
  analysis.turns.sort((x, y) => x.start - y.start);

  const segments = debugSegments(analysis, DEFAULT_PLANNER);
  const interjectionWindow = segments.filter((s) => s.start >= 10 && s.start < 10.7);
  for (const seg of interjectionWindow) {
    assert.notEqual(seg.floorId, 'c', 'a sub-grace-period interjection should never take the floor');
  }
});
