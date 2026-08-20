import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { analyze, totalDuration } from '../core/analyze.js';
import { probeAudio } from '../core/ffmpeg.js';
import { resolveMediaRef } from '../core/media.js';
import { DEFAULT_PLANNER, planCuts } from '../core/planner.js';
import type { Speaker, VideoAngle } from '../core/types.js';

interface Args {
  dir?: string;
  start: number;
  duration: number;
  hop: number;
  names?: string[];
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { start: 0, duration: 0, hop: 0.02 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--dir') { a.dir = v; i++; }
    else if (k === '--start') { a.start = Number(v); i++; }
    else if (k === '--duration') { a.duration = Number(v); i++; }
    else if (k === '--hop') { a.hop = Number(v); i++; }
    else if (k === '--names') { a.names = v.split(',').map((s) => s.trim()); i++; }
    else if (k === '--json') { a.json = v; i++; }
  }
  return a;
}

function fmt(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`
    : `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('usage: npm run analyze -- --dir <folder of per-speaker wavs> [--start S] [--duration S] [--hop 0.02] [--names a,b,c]');
    process.exit(1);
  }

  const files = readdirSync(args.dir)
    .filter((f) => /\.(wav|aif|aiff|flac)$/i.test(f))
    .filter((f) => statSync(join(args.dir!, f)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    console.error(`no audio files in ${args.dir}`);
    process.exit(1);
  }

  const probe = await probeAudio(join(args.dir, files[0]));
  const fullDuration = probe.durationSeconds;
  const start = args.start;
  const duration = args.duration > 0 ? args.duration : Math.max(0, fullDuration - start);

  console.log(`source: ${args.dir}`);
  console.log(`files:  ${files.length}  |  ${probe.sampleRate} Hz, ${probe.channels} ch, ${probe.codec}, ${fmt(fullDuration)}`);
  console.log(`range:  ${fmt(start)} to ${fmt(start + duration)}  (${fmt(duration)})`);
  console.log('');

  const speakers: Speaker[] = files.map((f, i) => {
    const path = join(args.dir!, f);
    const name = args.names?.[i] ?? basename(f, extname(f));
    return {
      id: `s${i}`,
      name,
      audioTrackIndex: i,
      side: i % 2 === 0 ? 'A' : 'B',
      clips: [
        {
          media: resolveMediaRef(path),
          timelineStart: 0,
          timelineEnd: duration,
          sourceIn: start,
        },
      ],
    };
  });

  const report = await analyze(speakers, {
    hopSeconds: args.hop,
    range: { start: 0, end: duration },
    onProgress: (m) => console.log(m),
  });

  console.log('');
  console.log('PER TRACK');
  console.log(
    pad('speaker', 16) + padL('floor', 8) + padL('speech', 8) + padL('open', 8) +
    padL('digSil', 8) + padL('turns', 7) + padL('talk', 8) + padL('talk%', 7) + padL('react', 7),
  );
  console.log('-'.repeat(16 + 8 * 4 + 7 + 8 + 7 + 7));

  for (const sp of speakers) {
    const st = report.stats.find((s) => s.speakerId === sp.id)!;
    const myTurns = report.turns.filter((t) => t.speakerId === sp.id);
    const talk = totalDuration(myTurns);
    const react = report.reactions.filter((r) => r.speakerId === sp.id).length;
    console.log(
      pad(sp.name, 16) +
        padL(st.floorDb.toFixed(1), 8) +
        padL(st.speechDb.toFixed(1), 8) +
        padL(st.openThresholdDb.toFixed(1), 8) +
        padL((st.digitalSilenceRatio * 100).toFixed(0) + '%', 8) +
        padL(String(myTurns.length), 7) +
        padL(fmt(talk), 8) +
        padL(((talk / duration) * 100).toFixed(1) + '%', 7) +
        padL(String(react), 7) +
        (st.inactive ? '  INACTIVE' : ''),
    );
  }

  const speechTotal = totalDuration(report.turns);
  const silence = totalDuration(report.silences);
  const takeovers = report.overlaps.filter((o) => o.isTakeover).length;

  console.log('');
  console.log('TOTALS');
  console.log(`  turns          ${report.turns.length}  (${fmt(speechTotal)} of mic-on time, overlaps counted once per speaker)`);
  console.log(`  reactions      ${report.reactions.length}  (${(report.reactions.length / (duration / 60)).toFixed(1)} per minute)`);
  console.log(`  overlaps       ${report.overlaps.length}  of which takeovers ${takeovers}`);
  console.log(`  crosstalk      ${report.crosstalk.length}  (${fmt(totalDuration(report.crosstalk))})`);
  console.log(`  dead air       ${report.silences.length}  (${fmt(silence)}, ${((silence / duration) * 100).toFixed(1)}%)`);
  console.log('');
  console.log('TIMING');
  for (const [k, v] of Object.entries(report.timings)) {
    console.log(`  ${pad(k, 18)} ${v.toFixed(2)}s`);
  }

  if (report.warnings.length) {
    console.log('');
    console.log('WARNINGS');
    for (const w of report.warnings) console.log(`  ${w}`);
  }

  // ---- plan a cut on a Counterpoint-shaped rig -------------------------------
  const sideA = speakers.filter((s) => s.side === 'A').map((s) => s.id);
  const sideB = speakers.filter((s) => s.side === 'B').map((s) => s.id);
  const angles: VideoAngle[] = [
    {
      id: 'V1', name: 'WIDE CAM', videoTrackIndex: 0,
      shows: speakers.map((s) => s.id), shotType: 'wide', physicalCamera: 'WIDE',
    },
    {
      id: 'V2', name: 'LEFT CAM', videoTrackIndex: 1,
      shows: sideA, shotType: 'group', physicalCamera: 'LEFT',
    },
    {
      id: 'V3', name: 'RIGHT CAM', videoTrackIndex: 2,
      shows: sideB, shotType: 'group', physicalCamera: 'RIGHT',
    },
  ];

  const plan = planCuts(report, angles, DEFAULT_PLANNER);
  const nameOf = (id?: string) =>
    id ? speakers.find((s) => s.id === id)?.name ?? id : '-';

  console.log('');
  console.log('CUT PLAN');
  console.log(`  shots            ${plan.stats.cuts}  (${plan.stats.cutsPerMinute.toFixed(1)}/min)`);
  console.log(`  on-speaker       ${(plan.stats.onSpeakerAccuracy * 100).toFixed(1)}%  of speaking time spent on a camera that can see the talker`);
  console.log(`  wide             ${(plan.stats.wideShare * 100).toFixed(1)}%  (ceiling ${DEFAULT_PLANNER.wideBudgetPct}%)`);
  console.log(`  reaction cuts    ${plan.stats.reactionCuts}`);
  console.log(`  solver passes    ${plan.stats.solverPasses}`);
  console.log('');
  console.log('  camera shares');
  for (const a of angles) {
    const share = (plan.stats.angleShare[a.id] ?? 0) * 100;
    console.log(`    ${pad(a.name, 12)} ${padL(share.toFixed(1) + '%', 7)}  ${'#'.repeat(Math.round(share / 2))}`);
  }
  console.log('');
  console.log('  talk vs screen');
  for (const sp of speakers) {
    const t = (plan.stats.talkShare[sp.id] ?? 0) * 100;
    const s = (plan.stats.screenShare[sp.id] ?? 0) * 100;
    console.log(`    ${pad(sp.name, 14)} talk ${padL(t.toFixed(1) + '%', 6)}   screen ${padL(s.toFixed(1) + '%', 6)}`);
  }

  const shortest = plan.cuts.reduce((m, c) => Math.min(m, c.end - c.start), Infinity);
  console.log('');
  console.log(`  shortest shot    ${shortest.toFixed(2)}s  (minimum is ${DEFAULT_PLANNER.minShotSec}s)`);
  if (plan.warnings.length) {
    console.log('  plan warnings');
    for (const w of plan.warnings) console.log(`    ${w}`);
  }

  console.log('');
  console.log('FIRST 20 SHOTS');
  for (const c of plan.cuts.slice(0, 20)) {
    const a = angles.find((x) => x.id === c.angleId)!;
    console.log(
      `  ${padL(fmt(start + c.start), 9)} ${padL((c.end - c.start).toFixed(1) + 's', 6)}  ${pad(a.name, 11)} ${pad(c.reason, 16)} ${nameOf(c.subjectId)}`,
    );
  }

  console.log('');
  console.log('FIRST 25 REACTIONS (the reaction-shot signal)');
  for (const r of report.reactions.slice(0, 25)) {
    const name = speakers.find((s) => s.id === r.speakerId)?.name ?? r.speakerId;
    const holder = report.turns.find((t) => t.start <= r.start && t.end >= r.start);
    const holderName = holder
      ? speakers.find((s) => s.id === holder.speakerId)?.name ?? holder.speakerId
      : '(nobody)';
    console.log(
      `  ${padL(fmt(start + r.start), 9)}  ${pad(name, 14)} +${r.peakDb.toFixed(0)}dB  ${(r.end - r.start).toFixed(2)}s   while ${holderName} held the floor`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
