/*
 * Detects dead-air and filler-word removal candidates for Carter to review,
 * without touching the timeline at all. Only spawned when trimDeadAir or
 * trimFillerWords is on; most runs never invoke this. Writes <outBase>.trim.json.
 *
 * Reuses analyze() exactly as run-plan.ts does -- zero changes to analyze.ts or
 * planner.ts were needed to build this.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../core/analyze.js';
import { DEFAULT_FILLER_LEXICON, findFillerCandidates, findThresholdGatedCandidates, type FillerCandidate } from '../core/filler.js';
import { findApiKey, transcribeTurns, type TurnAudioRef } from '../core/transcribe.js';
import type { AudioClipPlacement, Speaker, Turn, Word } from '../core/types.js';
import { bool, resolveSpeakers, toGateConfig, type PanelConfig } from './config-bridge.js';

interface ReviewCandidate {
  id: string;
  speakerId: string;
  speakerName: string;
  start: number;
  end: number;
  text: string;
  tier: 1 | 2 | 3 | 4;
  /** False only for the auto-cut tier: the one kind of filler nobody has to look at. */
  requiresReview: boolean;
  note?: string;
  contextBefore: string;
  contextAfter: string;
}

function clipForTimelineTime(sp: Speaker, t: number): AudioClipPlacement | undefined {
  return sp.clips.find((c) => t >= c.timelineStart && t < c.timelineEnd);
}

/** Where one turn's audio lives in its source file, or null if it cannot be located. */
function audioRefForTurn(sp: Speaker, turn: Turn): TurnAudioRef | null {
  const clip = clipForTimelineTime(sp, turn.start);
  if (!clip) return null;
  const sourceStart = clip.sourceIn + (turn.start - clip.timelineStart);
  const clipSourceEnd = clip.sourceIn + (clip.timelineEnd - clip.timelineStart);
  const sourceEnd = Math.min(clip.sourceIn + (turn.end - clip.timelineStart), clipSourceEnd);
  if (sourceEnd <= sourceStart) return null;
  return { media: clip.media, sourceStart, sourceEnd, timelineStart: turn.start };
}

function buildContext(words: Word[], candidateStart: number, wordCount: number, radius = 6) {
  const idx = words.findIndex((w) => w.start === candidateStart);
  const i = idx === -1 ? 0 : idx;
  return {
    before: words.slice(Math.max(0, i - radius), i).map((w) => w.text).join(' '),
    after: words.slice(i + wordCount, i + wordCount + radius).map((w) => w.text).join(' '),
  };
}

async function main() {
  const configPath = process.argv[2];
  const outBase = process.argv[3];
  if (!configPath || !outBase) {
    console.error('usage: detect-trim <config.json> <outputBasePath>');
    process.exit(2);
  }

  const cfg: PanelConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  const wantDeadAir = bool(cfg.settings.trimDeadAir, false);
  const wantFiller = bool(cfg.settings.trimFillerWords, false);

  if (!wantDeadAir && !wantFiller) {
    // Neither toggle is on. Nothing downstream should ever spawn this CLI in that
    // case, but writing a harmless empty result if it happens anyway costs nothing
    // and keeps the contract simple.
    writeFileSync(
      `${outBase}.trim.json`,
      JSON.stringify(
        {
          ok: true,
          deadAir: { intervals: [], totalSeconds: 0, count: 0 },
          filler: { candidates: [], totalCandidates: 0 },
          warnings: [],
          range: cfg.range,
        },
        null,
        2,
      ),
      'utf8',
    );
    return;
  }

  const speakers = resolveSpeakers(cfg);
  const warnings: string[] = [];

  const analysis = await analyze(speakers, {
    gate: toGateConfig(cfg.settings),
    range: cfg.range,
    onProgress: (m) => console.error(m),
  });

  // A dead-air pass can only mean anything if speech was actually found. When every
  // track gates as inactive -- a bad range, unmounted media, the wrong roster -- the
  // complement of "no speech at all" is the entire range, and removing that is
  // removing the episode. Silence is only meaningful relative to speech, so with no
  // turns there is nothing to measure against and the honest answer is zero
  // candidates plus a loud warning, not a proposal to delete everything.
  let deadAirIntervals = wantDeadAir ? analysis.silences : [];
  if (wantDeadAir && analysis.turns.length === 0) {
    warnings.push(
      'No speech was detected on any track in this range, so dead-air trim was skipped entirely. ' +
        'Nothing was removed. Check that the in/out points cover real audio and that the speaker ' +
        'tracks point at media that is currently mounted.',
    );
    deadAirIntervals = [];
  }
  const deadAirTotal = deadAirIntervals.reduce((s, iv) => s + (iv.end - iv.start), 0);

  const candidates: ReviewCandidate[] = [];

  if (wantFiller) {
    let keyReady = true;
    try {
      findApiKey();
    } catch (e) {
      warnings.push(String((e as Error).message) + ' Filler-word trim skipped for this run.');
      keyReady = false;
    }

    if (keyReady) {
      const nameById = new Map(speakers.map((s) => [s.id, s.name]));

      // Every turn goes up in ONE request. Per-turn requests were what made the old
      // local path take over an hour, and the same shape would mean 696 round trips
      // here. `turnFor` keeps each returned word attributable to the turn (and so the
      // speaker) it came from, since the batch itself is speaker-agnostic.
      const refs: TurnAudioRef[] = [];
      const turnFor: Turn[] = [];
      for (const sp of speakers) {
        for (const turn of analysis.turns.filter((t) => t.speakerId === sp.id)) {
          const ref = audioRefForTurn(sp, turn);
          if (!ref) continue;
          refs.push(ref);
          turnFor.push(turn);
        }
      }

      console.error(
        `Transcribing ${refs.length} turns in one batch (${(refs.reduce((s, r) => s + (r.sourceEnd - r.sourceStart), 0) / 60).toFixed(1)} min of speech)...`,
      );

      let words: Word[] = [];
      try {
        words = await transcribeTurns(refs);
      } catch (e) {
        warnings.push(
          `Transcription failed, so no filler words were found: ${(e as Error).message} ` +
            'Dead-air trim is unaffected.',
        );
      }

      if (words.length > 0) {
        console.error(`Transcribed ${words.length} words. Matching against the filler lexicon...`);
        let counter = 0;

        function pushCandidate(f: FillerCandidate, turn: Turn, turnWords: Word[]): void {
          const wordCount = turnWords.filter((w) => w.start >= f.start && w.start < f.end).length || 1;
          const ctx = buildContext(turnWords, f.start, wordCount);
          counter++;
          candidates.push({
            id: `f${counter}`,
            speakerId: turn.speakerId,
            speakerName: nameById.get(turn.speakerId) ?? turn.speakerId,
            start: f.start,
            end: f.end,
            text: f.text,
            tier: f.tier,
            requiresReview: f.requiresReview,
            note: f.note,
            contextBefore: ctx.before,
            contextAfter: ctx.after,
          });
        }

        // Group turns by speaker so threshold-gated words ("like", "so") can be
        // scanned across a speaker's FULL chronological word list. A 30-second
        // burst window routinely spans several of these short turns, so matching
        // turn by turn would systematically undercount and never trigger.
        const turnsBySpeaker = new Map<string, Turn[]>();
        for (const turn of turnFor) {
          const arr = turnsBySpeaker.get(turn.speakerId) ?? [];
          arr.push(turn);
          turnsBySpeaker.set(turn.speakerId, arr);
        }

        for (const [, spTurns] of turnsBySpeaker) {
          spTurns.sort((a, b) => a.start - b.start);

          // Auto-cut / review / context-gated: matched one turn at a time, so a
          // phrase can never be assembled across a turn boundary.
          for (const turn of spTurns) {
            const inTurn = words.filter((w) => w.start >= turn.start - 0.05 && w.start < turn.end + 0.05);
            if (inTurn.length === 0) continue;
            for (const f of findFillerCandidates(inTurn, [turn], DEFAULT_FILLER_LEXICON)) {
              pushCandidate(f, turn, inTurn);
            }
          }

          // Threshold-gated: matched once across every turn this speaker has,
          // chronologically, so a burst spanning turn boundaries is still caught.
          const speakerWords = words
            .filter((w) => spTurns.some((t) => w.start >= t.start - 0.05 && w.start < t.end + 0.05))
            .sort((a, b) => a.start - b.start);
          for (const f of findThresholdGatedCandidates(speakerWords, spTurns, DEFAULT_FILLER_LEXICON)) {
            const turn = spTurns.find((t) => f.start >= t.start - 0.05 && f.start < t.end + 0.05) ?? spTurns[0];
            const inTurn = words.filter((w) => w.start >= turn.start - 0.05 && w.start < turn.end + 0.05);
            pushCandidate(f, turn, inTurn);
          }
        }
      }
    }
  }

  candidates.sort((a, b) => a.start - b.start);

  writeFileSync(
    `${outBase}.trim.json`,
    JSON.stringify(
      {
        ok: true,
        deadAir: { intervals: deadAirIntervals, totalSeconds: deadAirTotal, count: deadAirIntervals.length },
        filler: { candidates, totalCandidates: candidates.length },
        warnings: [...analysis.warnings, ...warnings],
        range: analysis.range,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.error(
    `trim detection written: ${deadAirIntervals.length} dead-air spans, ${candidates.length} filler candidates`,
  );
}

main().catch((e) => {
  const outBase = process.argv[3];
  if (outBase) {
    try {
      writeFileSync(
        `${outBase}.trim.json`,
        JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2),
        'utf8',
      );
    } catch {
      /* fall through to the exit code */
    }
  }
  console.error(e);
  process.exit(1);
});
