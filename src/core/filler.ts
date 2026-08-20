/*
 * Lexicon-based filler-word detection.
 *
 * Deliberately not a judgment call: a curated word/phrase list matched against an
 * already-transcribed, already-tokenized word list, not an ML classifier scoring
 * "how disposable is this." A false positive here deletes real dialogue, which is
 * the one outcome this whole feature exists to avoid, so every candidate this
 * produces has to be explainable in one sentence ("it matched entry X in the
 * lexicon" or "it burst more than N times in M seconds"), auditable, and — outside
 * the auto-cut tier — reviewed by a human before it touches a timeline.
 *
 * Pure: no ffmpeg, no Premiere, no I/O. Has no effect on `analyze()` or
 * `planCuts()`, and nothing here runs unless a panel setting explicitly asks for
 * it and a transcript has already been produced elsewhere.
 */
import type { Interval, Turn, Word } from './types.js';

export interface ThresholdGateConfig {
  /** Words only proposed when they burst; each is counted independently of the others. */
  words: string[];
  /** A window must contain MORE than this many occurrences to qualify. */
  minCount: number;
  /** Width, in seconds, of the burst window. */
  windowSec: number;
}

export interface FillerLexicon {
  /**
   * Single tokens, matched standalone, unambiguous enough to remove without a human
   * looking at each one first. Real disfluencies with no plausible literal reading.
   */
  autoCut: string[];
  /**
   * Words or exact multi-word phrases, always surfaced for review rather than cut
   * automatically. A single word is a length-1 entry, matched by the same
   * longest-match-wins scan as a phrase; the multi-word entries are the safety
   * mechanism for phrases (never a word pulled out of the middle of one), while the
   * single-word entries here are ones judged safe to detect but not safe to cut
   * unattended.
   */
  review: string[][];
  /**
   * Words that are real, meaningful English far too often to gate on lexicon
   * membership alone ("like", "so"), so they are gated on FREQUENCY instead: only
   * proposed when a speaker bursts through the same word more than `minCount` times
   * within a `windowSec` window, which isolates a genuine crutch-word run from the
   * word's ordinary, meaningful use elsewhere in the episode. Still a deterministic,
   * explainable rule — "burst 5 times in 30s" — never a semantic judgment about
   * what any individual instance meant.
   */
  thresholdGated: ThresholdGateConfig;
  /**
   * Single words that need positional context to be safe (turn-initial, followed
   * by a pause) rather than being safe on their own. Defined but not matched
   * unless `enableContextGated` is true.
   */
  contextGated: string[];
  /** Off by default. `contextGated` entries need real-episode validation first. */
  enableContextGated: boolean;
  /** Minimum gap (seconds) after a contextGated word for it to count as "followed by a pause". */
  contextGatedPauseSec: number;
}

/**
 * Reviewed against real Episode 30/31 output: "you know" (review tier) was landing
 * correctly, which is what prompted moving from "like fully excluded" to "like
 * burst-gated" — a deterministic frequency rule the reviewer proposed rather than a
 * semantic one. `like` and `so` are absent from every other list; the ONLY path
 * either can be proposed through is `thresholdGated`. `basically` moved out of
 * `contextGated` into plain `review`: unlike `well`, its filler use doesn't need a
 * positional heuristic to be worth a reviewer's look. `well`, `right`, `actually`
 * stay context-gated and off by default, unchanged, since nothing new was learned
 * about them.
 */
export const DEFAULT_FILLER_LEXICON: FillerLexicon = {
  autoCut: ['um', 'uh', 'uhh', 'erm', 'ah', 'er'],
  review: [
    ['you', 'know'],
    ['i', 'mean'],
    ['sort', 'of'],
    ['kind', 'of'],
    ['so', 'yeah'],
    ['i', 'just', 'think'],
    ['if', 'that', 'makes', 'sense'],
    ['basically'],
  ],
  thresholdGated: { words: ['like', 'so'], minCount: 3, windowSec: 30 },
  contextGated: ['well', 'right', 'actually'],
  enableContextGated: false,
  contextGatedPauseSec: 0.3,
};

export interface FillerCandidate extends Interval {
  /** The matched words' original text, space-joined, for display in review. */
  text: string;
  tier: 1 | 2 | 3 | 4;
  /** True unless this is the auto-cut tier: the only tier a human never has to see. */
  requiresReview: boolean;
  /** Human-readable reason, populated for threshold-gated candidates ("used 5x in 30s"). */
  note?: string;
}

/** Strip punctuation ASR output may or may not include, lowercase for matching. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9']/g, '');
}

function turnContaining(word: Word, turns: Turn[]): Turn | undefined {
  return turns.find((t) => word.start >= t.start && word.start < t.end);
}

/**
 * Find every place in `words` an auto-cut, review, or context-gated entry matches.
 * Threshold-gated words ("like", "so") are handled separately by
 * `findThresholdGatedCandidates`, since a 30-second burst window routinely spans
 * more than one turn and this function is turn-scoped.
 *
 * `turns` is only needed for `contextGated` positional checks and the whole-turn
 * exclusion guard below; auto-cut/review matching does not consult it at all.
 */
export function findFillerCandidates(
  words: Word[],
  turns: Turn[],
  lexicon: FillerLexicon = DEFAULT_FILLER_LEXICON,
): FillerCandidate[] {
  const norm = words.map((w) => normalize(w.text));
  const candidates: FillerCandidate[] = [];
  const matchedWordIndices = new Set<number>();

  const autoCut = new Set(lexicon.autoCut.map((w) => normalize(w)));
  const review = lexicon.review
    .map((p) => p.map((w) => normalize(w)))
    .sort((a, b) => b.length - a.length); // longest phrases first, so a phrase wins over a shorter overlapping one

  for (let i = 0; i < words.length; i++) {
    if (matchedWordIndices.has(i)) continue;

    // Multi-word (or single-word) review entries first: a longer, more specific
    // match should win over a standalone match on one of its own words
    // (e.g. "so" inside "so yeah").
    let reviewMatch: string[] | null = null;
    let reviewLen = 0;
    for (const entry of review) {
      if (i + entry.length > words.length) continue;
      let ok = true;
      for (let k = 0; k < entry.length; k++) {
        if (norm[i + k] !== entry[k]) { ok = false; break; }
      }
      if (ok) { reviewMatch = entry; reviewLen = entry.length; break; }
    }

    if (reviewMatch) {
      const span = words.slice(i, i + reviewLen);
      candidates.push({
        start: span[0].start,
        end: span[span.length - 1].end,
        text: span.map((w) => w.text).join(' '),
        tier: 2,
        requiresReview: true,
      });
      for (let k = 0; k < reviewLen; k++) matchedWordIndices.add(i + k);
      i += reviewLen - 1;
      continue;
    }

    if (autoCut.has(norm[i])) {
      candidates.push({
        start: words[i].start, end: words[i].end, text: words[i].text,
        tier: 1, requiresReview: false,
      });
      matchedWordIndices.add(i);
      continue;
    }

    if (lexicon.enableContextGated && lexicon.contextGated.indexOf(norm[i]) !== -1) {
      const turn = turnContaining(words[i], turns);
      const isTurnInitial = !!turn && !words.slice(0, i).some((w) => w.start >= turn.start && w.start < turn.end);
      const next = words[i + 1];
      const followedByPause = !next || next.start - words[i].end >= lexicon.contextGatedPauseSec;
      if (isTurnInitial && followedByPause) {
        candidates.push({
          start: words[i].start, end: words[i].end, text: words[i].text,
          tier: 3, requiresReview: true,
        });
        matchedWordIndices.add(i);
      }
    }
  }

  return excludeWholeTurnFiller(candidates, words, turns);
}

/**
 * Find bursts of `lexicon.thresholdGated.words` ("like", "so") across a speaker's
 * FULL chronological word list, not one turn at a time — a 30-second window
 * routinely spans several short turns, so a per-turn scan would systematically
 * undercount and never trigger.
 *
 * Definition: for each occurrence of a threshold word, look at the forward window
 * `[occurrence, occurrence + windowSec]`. If that window contains MORE than
 * `minCount` occurrences of the SAME word, every occurrence inside that window is a
 * candidate — not just the one that tipped it over the line, since the point is to
 * isolate the whole crutch-word run, not only its tail. A word used once or twice
 * anywhere in the episode never produces a candidate; a genuine run does, in full.
 *
 * `words` must be sorted by `start` and should span every turn a burst could touch,
 * i.e. one speaker's entire word list for the range, not a single turn's.
 */
export function findThresholdGatedCandidates(
  words: Word[],
  turns: Turn[],
  lexicon: FillerLexicon = DEFAULT_FILLER_LEXICON,
): FillerCandidate[] {
  const cfg = lexicon.thresholdGated;
  if (!cfg || cfg.words.length === 0 || words.length === 0) return [];

  const norm = words.map((w) => normalize(w.text));
  const targets = new Set(cfg.words.map((w) => normalize(w)));
  const bestCountAt = new Map<number, number>(); // word index -> largest qualifying burst count seen

  for (const target of targets) {
    const occ: number[] = [];
    for (let i = 0; i < norm.length; i++) if (norm[i] === target) occ.push(i);

    for (let a = 0; a < occ.length; a++) {
      const windowEnd = words[occ[a]].start + cfg.windowSec;
      const inWindow: number[] = [];
      for (let b = a; b < occ.length; b++) {
        if (words[occ[b]].start > windowEnd) break;
        inWindow.push(occ[b]);
      }
      if (inWindow.length > cfg.minCount) {
        for (const idx of inWindow) {
          if ((bestCountAt.get(idx) ?? 0) < inWindow.length) bestCountAt.set(idx, inWindow.length);
        }
      }
    }
  }

  const candidates: FillerCandidate[] = [...bestCountAt.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, count]) => ({
      start: words[idx].start,
      end: words[idx].end,
      text: words[idx].text,
      tier: 4 as const,
      requiresReview: true,
      note: `used ${count}x within ${cfg.windowSec}s`,
    }));

  return excludeWholeTurnFiller(candidates, words, turns);
}

/**
 * Never propose removing an entire turn. If every word in a turn matched, that
 * turn's candidates are dropped outright rather than left for review to catch —
 * an unconditional guard, not a judgment call, since a turn that is nothing but
 * filler either deserves a human to actually look at it, or is borderline enough
 * that "delete the whole thing automatically" is not a call this feature should
 * make even with review, given a reviewer scanning a long candidate list could
 * easily not notice "this is 100% of what they said" from the row alone.
 */
function excludeWholeTurnFiller(
  candidates: FillerCandidate[],
  words: Word[],
  turns: Turn[],
): FillerCandidate[] {
  if (candidates.length === 0 || words.length === 0) return candidates;

  const out: FillerCandidate[] = [];
  for (const turn of turns) {
    const turnWords = words.filter((w) => w.start >= turn.start && w.start < turn.end);
    if (turnWords.length === 0) continue;
    const turnCandidates = candidates.filter((c) => c.start >= turn.start && c.start < turn.end);
    const coveredWordCount = turnCandidates.reduce((sum, c) => {
      return sum + turnWords.filter((w) => w.start >= c.start && w.start < c.end).length;
    }, 0);
    if (coveredWordCount < turnWords.length) out.push(...turnCandidates);
  }
  // Candidates whose start doesn't fall inside any turn (shouldn't normally
  // happen, since words come from transcribing turns) pass through unfiltered.
  const turnless = candidates.filter((c) => !turns.some((t) => c.start >= t.start && c.start < t.end));
  return [...out, ...turnless];
}
