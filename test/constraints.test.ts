import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze } from '../src/core/analyze.js';
import { resolveMediaRef } from '../src/core/media.js';
import { DEFAULT_PLANNER, planCuts } from '../src/core/planner.js';
import type { Speaker, VideoAngle } from '../src/core/types.js';

const DIR = 'R:/EPISODE 29 Entrepreneurs vs 9-5/New Audio2/V2 9-5ERMIC.wav';
const NAMES = ['Jamie', 'Brady', 'Bree', 'Brysen', 'Garrett', 'Alicia', 'Ryan', 'Nico'];

function buildSpeakers(durationSec: number, sourceIn: number): Speaker[] {
  return NAMES.map((n, i) => ({
    id: 's' + i,
    name: n,
    audioTrackIndex: i,
    side: (n === 'Ryan' ? 'host' : i < 4 ? 'A' : 'B') as Speaker['side'],
    clips: [
      {
        media: resolveMediaRef(`${DIR}/Track ${i + 1}.wav`),
        timelineStart: 0,
        timelineEnd: durationSec,
        sourceIn,
      },
    ],
  }));
}

function buildAngles(speakers: Speaker[]): VideoAngle[] {
  return [
    {
      id: 'V1', name: 'WIDE', videoTrackIndex: 0,
      shows: speakers.map((s) => s.id), shotType: 'wide', physicalCamera: 'W',
    },
    {
      id: 'V2', name: 'LEFT', videoTrackIndex: 1,
      shows: speakers.filter((s) => s.side !== 'B').map((s) => s.id),
      shotType: 'group', physicalCamera: 'L',
    },
    {
      id: 'V3', name: 'RIGHT', videoTrackIndex: 2,
      shows: speakers.filter((s) => s.side === 'B').map((s) => s.id),
      shotType: 'group', physicalCamera: 'R',
    },
  ];
}

test('planner honours its own shot-length constraints on real audio', async () => {
  const duration = 600;
  const speakers = buildSpeakers(duration, 1200);
  const analysis = await analyze(speakers, { range: { start: 0, end: duration } });
  const plan = planCuts(analysis, buildAngles(speakers), DEFAULT_PLANNER);

  assert.ok(plan.cuts.length > 0, 'produced no cuts');

  const lengths = plan.cuts.map((c) => c.end - c.start);
  const eps = 1e-3;

  // The minimum is absolute. A shot below it is a visible flash.
  const underMin = lengths.filter((l) => l < DEFAULT_PLANNER.minShotSec - eps);
  assert.equal(underMin.length, 0, `${underMin.length} shots below the minimum: ${underMin.map((l) => l.toFixed(2)).join(', ')}`);

  // The maximum is a soft ceiling, and this is deliberate rather than a bug.
  // Breaking up a long shot costs a cutaway plus a fresh minimum-length shot, so a
  // run with less than (max + cutaway + min) of material cannot be split without
  // creating a flash. When the two rules collide the minimum wins, which bounds the
  // overshoot at exactly that figure. Asserting zero overshoot would be asserting
  // something the design does not promise.
  const cutaway = Math.max(DEFAULT_PLANNER.minShotSec, DEFAULT_PLANNER.monologueCutawaySec);
  const bound = DEFAULT_PLANNER.maxShotSec + cutaway + DEFAULT_PLANNER.minShotSec;
  const beyondBound = lengths.filter((l) => l > bound + eps);
  assert.equal(
    beyondBound.length,
    0,
    `${beyondBound.length} shots exceed even the splitting bound of ${bound.toFixed(1)}s: ${beyondBound.map((l) => l.toFixed(1)).join(', ')}`,
  );

  // And the overshoot has to stay rare, otherwise the setting is decorative.
  const overMax = lengths.filter((l) => l > DEFAULT_PLANNER.maxShotSec + eps);
  assert.ok(
    overMax.length / lengths.length < 0.15,
    `${overMax.length} of ${lengths.length} shots exceed the maximum, which is too many to call it a ceiling`,
  );
});

test('cuts tile the range with no gaps or overlaps', async () => {
  const duration = 600;
  const speakers = buildSpeakers(duration, 1200);
  const analysis = await analyze(speakers, { range: { start: 0, end: duration } });
  const plan = planCuts(analysis, buildAngles(speakers), DEFAULT_PLANNER);

  for (let i = 1; i < plan.cuts.length; i++) {
    assert.ok(
      Math.abs(plan.cuts[i].start - plan.cuts[i - 1].end) < 1e-6,
      `gap or overlap between shot ${i - 1} and ${i}`,
    );
  }
  assert.ok(Math.abs(plan.cuts[0].start - analysis.range.start) < 1e-6, 'does not start at range start');
  assert.ok(
    Math.abs(plan.cuts[plan.cuts.length - 1].end - analysis.range.end) < 1e-6,
    'does not end at range end',
  );
});

test('never cuts between two crops of the same physical camera', async () => {
  const duration = 600;
  const speakers = buildSpeakers(duration, 1200);
  const analysis = await analyze(speakers, { range: { start: 0, end: duration } });

  // Two crops off one body, which is exactly the Counterpoint rig.
  const angles: VideoAngle[] = [
    {
      id: 'V1', name: 'WIDE', videoTrackIndex: 0,
      shows: speakers.map((s) => s.id), shotType: 'wide', physicalCamera: 'W',
    },
    {
      id: 'V2', name: 'RIGHT pair A', videoTrackIndex: 1,
      shows: speakers.slice(4, 6).map((s) => s.id), shotType: 'two', physicalCamera: 'RIGHTCAM',
    },
    {
      id: 'V3', name: 'RIGHT pair B', videoTrackIndex: 2,
      shows: speakers.slice(6, 8).map((s) => s.id), shotType: 'two', physicalCamera: 'RIGHTCAM',
    },
    {
      id: 'V4', name: 'LEFT group', videoTrackIndex: 3,
      shows: speakers.slice(0, 4).map((s) => s.id), shotType: 'group', physicalCamera: 'LEFTCAM',
    },
  ];

  const plan = planCuts(analysis, angles, DEFAULT_PLANNER);
  const byId = new Map(angles.map((a) => [a.id, a]));

  let jumpCuts = 0;
  for (let i = 1; i < plan.cuts.length; i++) {
    const a = byId.get(plan.cuts[i - 1].angleId)!;
    const b = byId.get(plan.cuts[i].angleId)!;
    if (a.id !== b.id && a.physicalCamera === b.physicalCamera) jumpCuts++;
  }
  assert.equal(jumpCuts, 0, `${jumpCuts} cuts between crops of the same camera`);
});

test('no same-camera cuts survive the minimum-shot pass on a four-two-shot rig', async () => {
  const duration = 600;
  const speakers = buildSpeakers(duration, 1200);
  const analysis = await analyze(speakers, { range: { start: 0, end: duration } });

  // The real Counterpoint rig: one wide plus four tight two-shots, three of which are
  // crops of a single body. The earlier same-camera test uses long group shots, where
  // the solver simply never wants the forbidden transition. This one is the case that
  // actually broke: short two-shots mean the minimum-shot pass drops runs, and the
  // shots either side of a dropped run become adjacent without anything re-checking
  // that they came off different cameras.
  const angles: VideoAngle[] = [
    { id: 'V1', name: 'WIDE', videoTrackIndex: 0, shows: speakers.map((s) => s.id), shotType: 'wide', physicalCamera: 'WIDE' },
    { id: 'V2', name: 'pair A', videoTrackIndex: 1, shows: [speakers[2].id, speakers[4].id], shotType: 'two', physicalCamera: 'LEFT CAM' },
    { id: 'V3', name: 'pair B', videoTrackIndex: 2, shows: [speakers[3].id, speakers[4].id], shotType: 'two', physicalCamera: 'LEFT CAM' },
    // Deliberately the same body as the two above, spelled differently, because the
    // id is a field a human types.
    { id: 'V4', name: 'pair C', videoTrackIndex: 3, shows: [speakers[0].id, speakers[5].id], shotType: 'two', physicalCamera: 'left cam ' },
    { id: 'V5', name: 'pair D', videoTrackIndex: 4, shows: [speakers[1].id, speakers[7].id], shotType: 'two', physicalCamera: 'RIGHT CAM' },
  ];

  const plan = planCuts(analysis, angles, { ...DEFAULT_PLANNER, wideBudgetPct: 15 });
  const byId = new Map(angles.map((a) => [a.id, a]));
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();

  const offenders: string[] = [];
  for (let i = 1; i < plan.cuts.length; i++) {
    const a = byId.get(plan.cuts[i - 1].angleId)!;
    const b = byId.get(plan.cuts[i].angleId)!;
    if (a.id !== b.id && norm(a.physicalCamera) === norm(b.physicalCamera)) {
      offenders.push(`${a.name} -> ${b.name} at ${plan.cuts[i].start.toFixed(1)}s`);
    }
  }
  assert.equal(offenders.length, 0, `jump cuts: ${offenders.join(', ')}`);

  // Repairing them must not reintroduce a flash or tear the timeline.
  for (const c of plan.cuts) {
    assert.ok(c.end - c.start >= DEFAULT_PLANNER.minShotSec - 1e-3, 'merge produced a short shot');
  }
  for (let i = 1; i < plan.cuts.length; i++) {
    assert.ok(Math.abs(plan.cuts[i].start - plan.cuts[i - 1].end) < 1e-6, 'merge left a gap');
  }
});

test('wide shot stays under its ceiling', async () => {
  const duration = 600;
  const speakers = buildSpeakers(duration, 1200);
  const analysis = await analyze(speakers, { range: { start: 0, end: duration } });

  // Only the wide can see the host, so the planner has a real reason to use it.
  const angles = buildAngles(speakers);
  const cfg = { ...DEFAULT_PLANNER, wideBudgetPct: 10 };
  const plan = planCuts(analysis, angles, cfg);

  assert.ok(
    plan.stats.wideShare <= cfg.wideBudgetPct / 100 + 0.01,
    `wide came out at ${(plan.stats.wideShare * 100).toFixed(1)}%, ceiling was ${cfg.wideBudgetPct}%`,
  );
});

test('forced cutaways rotate between comparably-framed siblings instead of always the same camera', async () => {
  const duration = 600;
  const speakers = buildSpeakers(duration, 1200);
  const analysis = await analyze(speakers, { range: { start: 0, end: duration } });

  // Two singles, same shot type, each fully covering one side-B person, on distinct
  // physical cameras -- deliberately tied under both emission()'s monologue-break
  // scoring and bestAlternative()'s framing score, so a real Counterpoint complaint
  // ("the cutaway always lands on the one camera over there, the other person never
  // gets shown") reproduces here, not just on a real rig's messier composition.
  const angles: VideoAngle[] = [
    { id: 'WIDE', name: 'WIDE', videoTrackIndex: 0, shows: speakers.map((s) => s.id), shotType: 'wide', physicalCamera: 'WIDE' },
    { id: 'C', name: 'Garrett single', videoTrackIndex: 1, shows: [speakers[4].id], shotType: 'single', physicalCamera: 'RIGHT C' },
    { id: 'D', name: 'Alicia single', videoTrackIndex: 2, shows: [speakers[5].id], shotType: 'single', physicalCamera: 'RIGHT D' },
    { id: 'LEFT', name: 'left group', videoTrackIndex: 3, shows: speakers.slice(0, 4).map((s) => s.id), shotType: 'group', physicalCamera: 'LEFT' },
  ];

  // A short monologue threshold guarantees plenty of forced cutaways to test
  // rotation against, regardless of how this specific real clip's turn-taking
  // happens to fall.
  const cfg = { ...DEFAULT_PLANNER, monologueSec: 8 };
  const plan = planCuts(analysis, angles, cfg);

  const rightSideCutaways = plan.cuts.filter(
    (c) => (c.reason === 'monologue-break' || c.reason === 'max-shot') && (c.angleId === 'C' || c.angleId === 'D'),
  );

  if (rightSideCutaways.length >= 4) {
    const distinct = new Set(rightSideCutaways.map((c) => c.angleId));
    assert.ok(
      distinct.size > 1,
      `all ${rightSideCutaways.length} right-side cutaways landed on the same camera (${[...distinct].join(', ')})`,
    );
  }
});

test('reactions and forced cutaways sometimes land on the speaker\'s own side, within the opposing-bias quota', async () => {
  const duration = 600;
  const speakers = buildSpeakers(duration, 1200);
  const analysis = await analyze(speakers, { range: { start: 0, end: duration } });
  const angles = buildAngles(speakers);
  const sideById = new Map(speakers.map((s) => [s.id, s.side]));
  const angleById = new Map(angles.map((a) => [a.id, a]));

  const cfg = { ...DEFAULT_PLANNER, monologueSec: 8 };
  const plan = planCuts(analysis, angles, cfg);

  // Reconstructs the same classification diversifyCutaways() itself uses: the floor
  // holder for a cutaway is the subject of the cut immediately before it, and an
  // angle counts as "opposing" when at least half of who it shows is on the other
  // side from that floor holder.
  function classify(cuts: typeof plan.cuts) {
    let same = 0;
    let opposing = 0;
    for (let i = 1; i < cuts.length; i++) {
      const cut = cuts[i];
      const floorId = cuts[i - 1].subjectId;
      const floorSide = floorId ? sideById.get(floorId) : undefined;
      if (!floorSide || floorSide === 'host') continue;
      const angle = angleById.get(cut.angleId);
      if (!angle || angle.shows.length === 0) continue;
      const opposingCount = angle.shows.filter((id) => {
        const s = sideById.get(id);
        return s && s !== 'host' && s !== floorSide;
      }).length;
      if (opposingCount / angle.shows.length >= 0.5) opposing++;
      else same++;
    }
    return { same, opposing };
  }

  const reactionCuts = plan.cuts.filter((c) => c.reason === 'reaction');
  const cutawayCuts = plan.cuts.filter((c) => c.reason === 'monologue-break' || c.reason === 'max-shot');
  const reactionSplit = classify(reactionCuts);
  const cutawaySplit = classify(cutawayCuts);
  const maxSameFraction = 1 - cfg.opposingBiasPct / 100 + 0.05; // small tolerance over a finite sample

  // Proves the old hard reactOpposingOnly gate is really gone: at least one
  // same-side reaction or forced cutaway should surface somewhere in a 10 minute
  // real episode with the quota open at 25%.
  assert.ok(
    reactionSplit.same + cutawaySplit.same >= 1,
    'no same-side reaction or forced cutaway occurred anywhere; the same-side quota may be gated shut again',
  );

  if (reactionSplit.same + reactionSplit.opposing >= 4) {
    const frac = reactionSplit.same / (reactionSplit.same + reactionSplit.opposing);
    assert.ok(frac <= maxSameFraction, `same-side reaction fraction ${frac.toFixed(2)} exceeds the quota`);
  }
  if (cutawaySplit.same + cutawaySplit.opposing >= 4) {
    const frac = cutawaySplit.same / (cutawaySplit.same + cutawaySplit.opposing);
    assert.ok(frac <= maxSameFraction, `same-side cutaway fraction ${frac.toFixed(2)} exceeds the quota`);
  }
});

test('a monologue occasionally gets a longer wide breather instead of the usual tight cutaway', async () => {
  const duration = 600;
  const speakers = buildSpeakers(duration, 1200);
  const analysis = await analyze(speakers, { range: { start: 0, end: duration } });
  const angles = buildAngles(speakers);
  const byId = new Map(angles.map((a) => [a.id, a]));

  // Low enough that plenty of monologue-breaks fire regardless of how this
  // specific real clip's turn-taking happens to fall, so the breather quota has
  // real opportunities to be exercised.
  const cfg = { ...DEFAULT_PLANNER, monologueSec: 8 };
  const plan = planCuts(analysis, angles, cfg);

  const monologueBreaks = plan.cuts.filter((c) => c.reason === 'monologue-break');
  const breathers = monologueBreaks.filter((c) => c.wideBreather);

  // Whatever got flagged as a breather has to actually be on the wide and actually
  // run the breather length, not just carry the flag.
  for (const b of breathers) {
    const angle = byId.get(b.angleId);
    assert.equal(angle?.shotType, 'wide', 'a wideBreather cut landed on a non-wide angle');
    assert.ok(
      Math.abs(b.end - b.start - cfg.wideBreatherSec) < 0.5,
      `wideBreather cut ran ${(b.end - b.start).toFixed(1)}s, expected close to ${cfg.wideBreatherSec}s`,
    );
  }

  // Only require one to have actually happened once there was enough opportunity:
  // at a 12% rate, fewer than 15 monologue-breaks makes an all-zero draw too
  // plausible to treat as a meaningful failure.
  if (monologueBreaks.length >= 15) {
    assert.ok(breathers.length >= 1, `no wide breather among ${monologueBreaks.length} monologue-break cuts`);
  }
});
