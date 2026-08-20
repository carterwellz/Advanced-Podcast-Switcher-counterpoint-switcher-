/*
 * Turns detected + Carter-approved removal candidates into the ripple-delete
 * directive file cpswApplyTrimPlan (host.jsx) reads.
 *
 * Deliberately separate from, and much faster than, detect-trim.ts: this never
 * re-transcribes anything, so toggling a checkbox in the filler-word review and
 * rebuilding the plan is instant. All padding/merge/ordering logic lives in
 * src/core/trim.ts; this file is just wiring.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  deadAirRemovalIntervals,
  exceedsRemovalCeiling,
  fillerRemovalIntervals,
  mergeRemovalIntervals,
  snapIntervalsToFrames,
  sortDescendingForRipple,
} from '../core/trim.js';
import type { Interval } from '../core/types.js';
import { bool, num } from './config-bridge.js';

interface ApprovedInput {
  /** Dead-air spans to remove verbatim -- Carter never reviews these individually. */
  deadAirIntervals: Interval[];
  /** Filler-word spans still checked in the review card, plain intervals. */
  approvedFillerSpans: Interval[];
  range: { start: number; end: number };
  /** Sequence frame rate. 0/absent means "unknown", and snapping is skipped. */
  fps?: number;
  settings: Record<string, number | boolean | string>;
}

function main() {
  const approvedPath = process.argv[2];
  const outBase = process.argv[3];
  if (!approvedPath || !outBase) {
    console.error('usage: build-trim-plan <approved.json> <outputBasePath>');
    process.exit(2);
  }

  const input: ApprovedInput = JSON.parse(readFileSync(approvedPath, 'utf8'));
  const deadAirPadSec = num(input.settings.deadAirPadMs, 150) / 1000;
  const fillerPadSec = num(input.settings.fillerPadMs, 40) / 1000;

  const deadAir = deadAirRemovalIntervals(input.deadAirIntervals, deadAirPadSec);
  const filler = fillerRemovalIntervals(input.approvedFillerSpans, fillerPadSec);
  // Snap AFTER merging, so union boundaries are snapped too, and BEFORE ordering,
  // since snapping can drop a span that collapses below the minimum.
  const fps = num(input.fps, 0);
  const merged = snapIntervalsToFrames(mergeRemovalIntervals(deadAir, filler), fps);
  if (!(fps > 0)) {
    console.error('warning: no frame rate supplied, spans not snapped; video may ripple with gaps');
  }
  const ordered = sortDescendingForRipple(merged);
  const totalRemovedSeconds = merged.reduce((s, iv) => s + (iv.end - iv.start), 0);

  // Last line of defence before anything is removed from a real timeline: see
  // exceedsRemovalCeiling() in trim.ts for why a trim pass can arrive here proposing
  // to delete the whole episode. Refuse and say why rather than write a plan nobody
  // has sanity-checked.
  const rangeLength = input.range.end - input.range.start;
  if (exceedsRemovalCeiling(merged, rangeLength)) {
    const pct = ((totalRemovedSeconds / rangeLength) * 100).toFixed(0);
    writeFileSync(
      `${outBase}.trimplan.json`,
      JSON.stringify(
        {
          ok: false,
          removedCount: 0,
          totalRemovedSeconds: 0,
          error:
            `Refusing to build this trim plan: it would remove ${totalRemovedSeconds.toFixed(0)}s of ` +
            `${rangeLength.toFixed(0)}s (${pct}% of the range). That is far ` +
            'past anything a dead-air or filler pass should ever produce, so detection almost certainly ' +
            'failed rather than the episode genuinely being that empty. Nothing was changed.',
        },
        null,
        2,
      ),
      'utf8',
    );
    console.error(`trim plan refused: ${pct}% of the range`);
    return;
  }

  const lines: string[] = [
    'MODE ripple',
    `DUPLICATE ${bool(input.settings.workOnDuplicate, true) ? 1 : 0}`,
    `RANGE ${input.range.start.toFixed(4)} ${input.range.end.toFixed(4)}`,
  ];
  // FULL float precision, not toFixed(). At 23.976fps a frame boundary is a repeating
  // decimal (1001/24000), so any fixed number of places rounds it slightly off the
  // frame, and Premiere is far more sensitive to that than it looks: measured on a
  // real sequence, passing exact frame values gave zero gaps on every track, while
  // the identical spans written through toFixed(6) left a one-frame hole on ~30% of
  // video cuts. String() round-trips the double exactly through Number() in host.jsx,
  // so the value Premiere receives is bit-identical to the one that was snapped.
  for (const iv of ordered) {
    lines.push(`REMOVE ${String(iv.start)} ${String(iv.end)}`);
  }
  writeFileSync(`${outBase}.trim.txt`, lines.join('\n'), 'utf8');

  writeFileSync(
    `${outBase}.trimplan.json`,
    JSON.stringify({ ok: true, removedCount: ordered.length, totalRemovedSeconds }, null, 2),
    'utf8',
  );

  console.error(`trim plan written: ${ordered.length} removals, ${totalRemovedSeconds.toFixed(1)}s total`);
}

main();
