import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FILLER_LEXICON, findFillerCandidates, findThresholdGatedCandidates } from '../src/core/filler.js';
import type { Turn, Word } from '../src/core/types.js';

/** Lay out words back to back, 0.3s each with a 0.1s gap, starting at `t0`. */
function words(texts: string[], t0 = 0): Word[] {
  const out: Word[] = [];
  let t = t0;
  for (const text of texts) {
    out.push({ text, start: t, end: t + 0.3 });
    t += 0.4;
  }
  return out;
}

function turnFor(ws: Word[], speakerId = 'sp1'): Turn {
  return { speakerId, start: ws[0].start, end: ws[ws.length - 1].end, strengthDb: 20 };
}

test('matches a standalone auto-cut word', () => {
  const w = words(['so', 'um', 'the', 'point', 'is', 'clear']);
  const out = findFillerCandidates(w, [turnFor(w)]);
  const matched = out.filter((c) => c.tier === 1);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].text, 'um');
  assert.equal(matched[0].requiresReview, false);
});

test('matches a multi-word review phrase as one candidate, not two standalone words', () => {
  const w = words(['well', 'you', 'know', 'the', 'thing', 'is']);
  const out = findFillerCandidates(w, [turnFor(w)]);
  const phraseMatches = out.filter((c) => c.text.toLowerCase() === 'you know');
  assert.equal(phraseMatches.length, 1);
  assert.equal(phraseMatches[0].tier, 2);
  assert.equal(phraseMatches[0].requiresReview, true);
  // "well" is context-gated and off by default, so it must not appear at all.
  assert.ok(!out.some((c) => c.text.toLowerCase() === 'well'));
});

test('matches a single-word review entry ("basically") without auto-cutting it', () => {
  const w = words(['basically', 'that', 'is', 'the', 'plan']);
  const out = findFillerCandidates(w, [turnFor(w)]);
  const matched = out.filter((c) => c.text.toLowerCase() === 'basically');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].tier, 2);
  assert.equal(matched[0].requiresReview, true);
});

test('never substring-matches a lexicon entry inside an unrelated word', () => {
  // "uh" must not fire against "though"; matching runs over tokenized words, not raw text.
  const w = words(['even', 'though', 'that', 'happened']);
  const out = findFillerCandidates(w, [turnFor(w)]);
  assert.deepEqual(out, []);
});

test('context-gated words are inactive by default even when they appear turn-initial with a pause', () => {
  const w: Word[] = [
    { text: 'well', start: 0, end: 0.3 },
    { text: 'the', start: 1.0, end: 1.3 }, // 0.7s pause after "well"
    { text: 'point', start: 1.4, end: 1.7 },
  ];
  const out = findFillerCandidates(w, [turnFor(w)]);
  assert.deepEqual(out, []);
});

test('context-gated words fire only turn-initial with a pause, once explicitly enabled', () => {
  const lexicon = { ...DEFAULT_FILLER_LEXICON, enableContextGated: true };

  const turnInitial: Word[] = [
    { text: 'well', start: 0, end: 0.3 },
    { text: 'the', start: 1.0, end: 1.3 },
  ];
  const initialOut = findFillerCandidates(turnInitial, [turnFor(turnInitial)], lexicon);
  assert.equal(initialOut.length, 1);
  assert.equal(initialOut[0].text, 'well');
  assert.equal(initialOut[0].requiresReview, true);

  // Same word, mid-sentence: must not fire even with the gate enabled.
  const midSentence: Word[] = [
    { text: 'the', start: 0, end: 0.3 },
    { text: 'well', start: 0.4, end: 0.7 },
    { text: 'ran', start: 1.4, end: 1.7 },
  ];
  const midOut = findFillerCandidates(midSentence, [turnFor(midSentence)], lexicon);
  assert.deepEqual(midOut, []);

  // Turn-initial but no pause after it: must not fire either.
  const noPause: Word[] = [
    { text: 'well', start: 0, end: 0.3 },
    { text: 'the', start: 0.35, end: 0.65 },
  ];
  const noPauseOut = findFillerCandidates(noPause, [turnFor(noPause)], lexicon);
  assert.deepEqual(noPauseOut, []);
});

test('"so" is no longer context-gated: it never fires via findFillerCandidates, gate on or off', () => {
  const lexicon = { ...DEFAULT_FILLER_LEXICON, enableContextGated: true };
  const w: Word[] = [
    { text: 'so', start: 0, end: 0.3 },
    { text: 'the', start: 1.0, end: 1.3 },
  ];
  const out = findFillerCandidates(w, [turnFor(w)], lexicon);
  assert.deepEqual(out, []);
});

test('"like" never matches via findFillerCandidates, gated or not -- only via burst threshold', () => {
  const lexicon = { ...DEFAULT_FILLER_LEXICON, enableContextGated: true };
  const w = words(['it', 'was', 'like', 'really', 'important']);
  const out = findFillerCandidates(w, [turnFor(w)], lexicon);
  assert.ok(!out.some((c) => c.text.toLowerCase() === 'like'));
});

test('a turn made entirely of filler tokens is excluded outright', () => {
  const w = words(['um', 'you', 'know']); // auto-cut "um" + review "you know" covers 100% of the turn
  const out = findFillerCandidates(w, [turnFor(w)]);
  assert.deepEqual(out, []);
});

test('a turn that is mostly but not entirely filler still yields its candidates', () => {
  const w = words(['um', 'the', 'actual', 'point', 'matters']);
  const out = findFillerCandidates(w, [turnFor(w)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'um');
});

test('a longer phrase match wins over a standalone match on one of its own words', () => {
  const w = words(['so', 'yeah', 'that', 'happened']);
  const out = findFillerCandidates(w, [turnFor(w)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text.toLowerCase(), 'so yeah');
  assert.equal(out[0].tier, 2);
});

// --- threshold-gated ("like" / "so" burst detection) ---

/** Occurrences of `word` spaced `gapSec` apart, starting at `t0`, one per turn-worthy word. */
function burst(word: string, count: number, gapSec: number, t0 = 0): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < count; i++) out.push({ text: word, start: t0 + i * gapSec, end: t0 + i * gapSec + 0.2 });
  return out;
}

test('exactly at the threshold (3 uses in 30s) does not flag: the rule requires MORE than 3', () => {
  const w = burst('like', 3, 10); // t=0,10,20 -- all within a 30s window
  const out = findThresholdGatedCandidates(w, [turnFor(w)]);
  assert.deepEqual(out, []);
});

test('4 uses within the window flags every occurrence in the burst, not just the 4th', () => {
  // Real words around each "like", not bare bursts: a turn that is nothing but four
  // "like"s is legitimately 100% filler and the whole-turn guard is supposed to
  // strip it (covered separately below) -- that is not what this test is checking.
  const chunks = [0, 1, 2, 3].map((i) => words(['it', 'was', 'like', 'cool'], i * 8));
  const w = chunks.flat(); // "like" lands at t=0.8, 8.8, 16.8, 24.8 -- all within 30s of the first
  const turn: Turn = { speakerId: 'sp1', start: w[0].start, end: w[w.length - 1].end, strengthDb: 20 };
  const out = findThresholdGatedCandidates(w, [turn]);
  assert.equal(out.length, 4);
  assert.ok(out.every((c) => c.text === 'like'));
  assert.ok(out.every((c) => c.tier === 4 && c.requiresReview === true));
  assert.ok(out.every((c) => c.note && c.note.indexOf('4x') !== -1));
});

test('a single ordinary use of "like" is never flagged', () => {
  const w = words(['it', 'was', 'like', 'a', 'big', 'deal']);
  const out = findThresholdGatedCandidates(w, [turnFor(w)]);
  assert.deepEqual(out, []);
});

test('two well-separated uses of "like", each isolated, are never flagged', () => {
  // One near the start, one 5 minutes later -- nowhere near a 30s window together.
  const w = [...burst('like', 1, 0, 0), ...burst('like', 1, 0, 300)];
  const out = findThresholdGatedCandidates(w, [
    { speakerId: 'sp1', start: 0, end: 1, strengthDb: 20 },
    { speakerId: 'sp1', start: 300, end: 301, strengthDb: 20 },
  ]);
  assert.deepEqual(out, []);
});

test('bursting "like" does not also flag unrelated "so" usage, and vice versa', () => {
  const likeWords = burst('like', 4, 8, 0); // qualifies
  const soWords = burst('so', 1, 0, 100); // does not qualify alone
  const w = [...likeWords, ...soWords].sort((a, b) => a.start - b.start);
  const t = { speakerId: 'sp1', start: 0, end: 101, strengthDb: 20 };
  const out = findThresholdGatedCandidates(w, [t]);
  assert.equal(out.length, 4);
  assert.ok(out.every((c) => c.text === 'like'));
});

test('a burst spanning a window wider than windowSec only flags the qualifying sub-window', () => {
  // t=0,8,16 (3 within 30s of t=0) then a straggler at t=40 (outside that window).
  // The window anchored at t=0 covers [0,30] with 3 occurrences -- not > 3, so it
  // does not qualify on its own here.
  const w = burst('like', 3, 8, 0).concat(burst('like', 1, 0, 40));
  const out = findThresholdGatedCandidates(w, [{ speakerId: 'sp1', start: 0, end: 41, strengthDb: 20 }]);
  assert.deepEqual(out, []);
});

test('threshold candidates respect the whole-turn-filler exclusion too', () => {
  // A turn that is nothing but a "like" burst must still be excluded outright.
  const w = burst('like', 4, 8);
  const out = findThresholdGatedCandidates(w, [turnFor(w)]);
  assert.deepEqual(out, []);
});

test('threshold matching works across multiple short turns, not just within one', () => {
  // Four short turns, each with "like" plus real surrounding words (so the
  // whole-turn-filler guard doesn't strip them), turn starts 8s apart -- the
  // realistic shape of short conversational turns, and exactly why this needs the
  // whole speaker's word list rather than one turn at a time.
  const perTurn = [0, 1, 2, 3].map((i) => words(['it', 'was', 'like', 'cool'], i * 8));
  const w = perTurn.flat();
  const turns = perTurn.map((tw) => turnFor(tw));
  const out = findThresholdGatedCandidates(w, turns);
  assert.equal(out.length, 4);
  assert.ok(out.every((c) => c.text === 'like'));
});
