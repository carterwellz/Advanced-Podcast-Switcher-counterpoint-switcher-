import { extractFileEnvelope, SILENCE_DB } from './envelope.js';
import { DEFAULT_OVERLAP, detectOverlaps, type OverlapConfig } from './events.js';
import {
  complement,
  gateTrack,
  measureTrack,
  referenceSpeechLevel,
  unionIntervals,
  type TrackStats,
} from './gate.js';
import { checkMedia } from './media.js';
import {
  DEFAULT_GATE,
  type AnalysisResult,
  type Envelope,
  type GateConfig,
  type Interval,
  type ReactionEvent,
  type Seconds,
  type Speaker,
  type Turn,
} from './types.js';

export interface AnalyzeOptions {
  gate?: Partial<GateConfig>;
  overlap?: Partial<OverlapConfig>;
  hopSeconds?: number;
  cacheDir?: string;
  ffmpegPath?: string;
  /** Restrict analysis to this stretch of the timeline. */
  range?: Interval;
  onProgress?: (msg: string) => void;
}

export interface AnalyzeReport extends AnalysisResult {
  stats: TrackStats[];
  warnings: string[];
  timings: Record<string, number>;
}

/**
 * Turn a set of speakers with placed audio clips into turns, reactions, overlaps,
 * crosstalk and silence.
 *
 * Deliberately knows nothing about Premiere, cameras, or cutting. It takes file
 * paths plus timeline placements and returns facts about who spoke when, which is
 * the one thing the rest of the system is built on.
 */
export async function analyze(
  speakers: Speaker[],
  opts: AnalyzeOptions = {},
): Promise<AnalyzeReport> {
  const gate: GateConfig = { ...DEFAULT_GATE, ...opts.gate };
  const overlapCfg: OverlapConfig = { ...DEFAULT_OVERLAP, ...opts.overlap };
  const hopSeconds = opts.hopSeconds ?? 0.02;
  const warnings: string[] = [];
  const timings: Record<string, number> = {};
  const log = opts.onProgress ?? (() => {});

  const range = opts.range ?? inferRange(speakers);
  if (!(range.end > range.start)) {
    throw new Error(`Empty analysis range: ${range.start} to ${range.end}`);
  }

  // Verify media before spending minutes on ffmpeg.
  for (const sp of speakers) {
    for (const clip of sp.clips) {
      const check = checkMedia(clip.media);
      if (!check.ok) warnings.push(`${sp.name}: ${check.reason}`);
    }
  }

  const t0 = Date.now();

  // One ffmpeg run per distinct source file. Runs concurrently because each is
  // largely waiting on disk, and Counterpoint media lives on the NAS.
  const fileJobs = planFileJobs(speakers);
  log(`extracting ${fileJobs.length} source envelope(s) at ${hopSeconds * 1000}ms hop`);

  const envelopesByFile = new Map<string, SourceEnvelope>();
  await Promise.all(
    fileJobs.map(async (job) => {
      const started = Date.now();
      const env = await extractFileEnvelope(
        {
          file: job.file,
          channels: job.channels,
          poly: job.poly,
          startSeconds: job.sourceStart,
          durationSeconds: job.sourceEnd - job.sourceStart,
        },
        { hopSeconds, cacheDir: opts.cacheDir, ffmpegPath: opts.ffmpegPath, onProgress: log },
      );
      envelopesByFile.set(job.file, { byChannel: env.byChannel, sourceStart: job.sourceStart });
      log(`  done ${job.file} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }),
  );
  timings.extractSeconds = (Date.now() - t0) / 1000;

  // Remap each speaker's source-time envelope onto the sequence timeline.
  const t1 = Date.now();
  const envelopes: Envelope[] = speakers.map((sp) =>
    buildTimelineEnvelope(sp, envelopesByFile, range, hopSeconds, warnings),
  );
  timings.remapSeconds = (Date.now() - t1) / 1000;

  const t2 = Date.now();

  // Two passes on purpose. A mic cannot be judged in isolation: someone who barely
  // speaks in this stretch has no speech in their own statistics, so their room tone
  // would become "speech". Measure every track first, establish what speech sounds
  // like in this room, then gate against that.
  const measured = envelopes.map((env) => measureTrack(env.db));
  const referenceSpeechDb = referenceSpeechLevel(measured.map((m) => m.speechDb));
  log(`room speech reference: ${referenceSpeechDb.toFixed(1)} dBFS`);

  const stats: TrackStats[] = [];
  const turns: Turn[] = [];
  const reactions: ReactionEvent[] = [];
  for (const env of envelopes) {
    const res = gateTrack(env.speakerId, env.db, hopSeconds, range.start, gate, referenceSpeechDb);
    stats.push(res.stats);
    turns.push(...res.turns);
    reactions.push(...res.reactionCandidates);
    if (res.stats.inactive) {
      const name = speakers.find((s) => s.id === env.speakerId)?.name ?? env.speakerId;
      const below = (referenceSpeechDb - res.stats.speechDb).toFixed(0);
      warnings.push(
        `${name}: no speech in this range (peaks ${below} dB below the room), skipped`,
      );
    }
  }
  turns.sort((a, b) => a.start - b.start);
  reactions.sort((a, b) => a.start - b.start);
  timings.gateSeconds = (Date.now() - t2) / 1000;

  const { overlaps, crosstalk } = detectOverlaps(turns, overlapCfg);

  // A reaction only counts while somebody else holds the floor. A short burst during
  // the reactor's own turn is just their own speech breaking up.
  const speech = unionIntervals([turns.map((t) => ({ start: t.start, end: t.end }))]);
  const realReactions = reactions.filter((r) => !isInsideOwnTurn(r, turns));
  const silences = complement(speech, range, gate.minSilenceSeconds);

  return {
    speakers,
    envelopes,
    turns,
    reactions: realReactions,
    overlaps,
    crosstalk,
    silences,
    range,
    stats,
    warnings,
    timings,
  };
}

function isInsideOwnTurn(r: ReactionEvent, turns: Turn[]): boolean {
  for (const t of turns) {
    if (t.speakerId !== r.speakerId) continue;
    if (t.start > r.end) break;
    if (r.start >= t.start && r.end <= t.end) return true;
  }
  return false;
}

interface SourceEnvelope {
  byChannel: Map<number, Float32Array>;
  /** Source time that index 0 of each channel array corresponds to. */
  sourceStart: Seconds;
}

interface FileJob {
  file: string;
  channels: number[];
  poly: boolean;
  /** Earliest source time any clip needs, so a mid-episode range does not decode from zero. */
  sourceStart: Seconds;
  sourceEnd: Seconds;
}

function planFileJobs(speakers: Speaker[]): FileJob[] {
  const byFile = new Map<string, FileJob>();
  for (const sp of speakers) {
    for (const clip of sp.clips) {
      const { file, channel, fromPolyWav } = clip.media;
      const needStart = clip.sourceIn;
      const needEnd = clip.sourceIn + (clip.timelineEnd - clip.timelineStart);
      const existing = byFile.get(file);
      if (existing) {
        if (!existing.channels.includes(channel)) existing.channels.push(channel);
        existing.sourceStart = Math.min(existing.sourceStart, needStart);
        existing.sourceEnd = Math.max(existing.sourceEnd, needEnd);
      } else {
        byFile.set(file, {
          file,
          channels: [channel],
          poly: fromPolyWav,
          sourceStart: needStart,
          sourceEnd: needEnd,
        });
      }
    }
  }
  // Decode a little early so the first hop is not clipped by a seek landing late.
  for (const job of byFile.values()) job.sourceStart = Math.max(0, job.sourceStart - 0.5);
  return [...byFile.values()];
}

/**
 * Copy each clip's slice of source-time envelope into its place on the timeline.
 *
 * Hops with no clip covering them stay at digital silence, which is correct: no
 * media means nobody is talking, not "unknown".
 */
function buildTimelineEnvelope(
  sp: Speaker,
  envelopesByFile: Map<string, SourceEnvelope>,
  range: Interval,
  hopSeconds: number,
  warnings: string[],
): Envelope {
  const hops = Math.ceil((range.end - range.start) / hopSeconds);
  const db = new Float32Array(hops).fill(SILENCE_DB);

  for (const clip of sp.clips) {
    const source = envelopesByFile.get(clip.media.file);
    if (!source) continue;
    const key = clip.media.fromPolyWav ? clip.media.channel : 0;
    const src = source.byChannel.get(key) ?? source.byChannel.values().next().value;
    if (!src) {
      warnings.push(`${sp.name}: no envelope for channel ${key} of ${clip.media.file}`);
      continue;
    }

    const from = Math.max(clip.timelineStart, range.start);
    const to = Math.min(clip.timelineEnd, range.end);
    if (to <= from) continue;

    const startIdx = Math.floor((from - range.start) / hopSeconds);
    const endIdx = Math.min(hops, Math.ceil((to - range.start) / hopSeconds));
    for (let destIdx = startIdx; destIdx < endIdx; destIdx++) {
      const t = range.start + destIdx * hopSeconds;
      const sourceTime = clip.sourceIn + (t - clip.timelineStart);
      const srcIdx = Math.round((sourceTime - source.sourceStart) / hopSeconds);
      if (srcIdx < 0 || srcIdx >= src.length) continue;
      db[destIdx] = src[srcIdx];
    }
  }

  return { speakerId: sp.id, hopSeconds, startTime: range.start, db, floorDb: SILENCE_DB };
}

function inferRange(speakers: Speaker[]): Interval {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const sp of speakers) {
    for (const c of sp.clips) {
      start = Math.min(start, c.timelineStart);
      end = Math.max(end, c.timelineEnd);
    }
  }
  return { start: Number.isFinite(start) ? start : 0, end };
}

/** Sum of interval lengths. */
export function totalDuration(intervals: Interval[]): Seconds {
  return intervals.reduce((a, iv) => a + (iv.end - iv.start), 0);
}
