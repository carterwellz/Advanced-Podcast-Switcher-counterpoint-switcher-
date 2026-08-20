import type { Interval, OverlapEvent, Turn } from './types.js';

export interface OverlapConfig {
  /**
   * If the incumbent stops within this long after someone breaks in, the break-in
   * was a real takeover rather than a brief agreement noise.
   */
  takeoverWindowSeconds: number;
  /** Overlaps shorter than this are not worth cutting on. */
  minOverlapSeconds: number;
  /** This many people at once means nobody has the floor. Cut wide. */
  crosstalkSpeakers: number;
}

export const DEFAULT_OVERLAP: OverlapConfig = {
  takeoverWindowSeconds: 2.5,
  minOverlapSeconds: 0.25,
  crosstalkSpeakers: 3,
};

interface Boundary {
  t: number;
  delta: 1 | -1;
  turn: Turn;
}

/**
 * Sweep every turn boundary once and report where two or more people are talking.
 *
 * The distinction that matters editorially is not "did they overlap" but "did the
 * overlap change who has the floor". A listener agreeing over the top of a speaker
 * should not steal the shot; someone who breaks in and takes over should.
 */
export function detectOverlaps(
  turns: Turn[],
  cfg: OverlapConfig = DEFAULT_OVERLAP,
): { overlaps: OverlapEvent[]; crosstalk: Interval[] } {
  const bounds: Boundary[] = [];
  for (const t of turns) {
    bounds.push({ t: t.start, delta: 1, turn: t });
    bounds.push({ t: t.end, delta: -1, turn: t });
  }
  // Close before opening at the same instant, so abutting turns do not read as overlap.
  bounds.sort((a, b) => a.t - b.t || a.delta - b.delta);

  const overlaps: OverlapEvent[] = [];
  const crosstalk: Interval[] = [];
  const active = new Set<Turn>();

  let overlapStart: number | null = null;
  let crossStart: number | null = null;
  let participants = new Set<Turn>();

  for (const b of bounds) {
    const before = active.size;
    if (b.delta === 1) active.add(b.turn);
    else active.delete(b.turn);
    const after = active.size;

    if (before < 2 && after >= 2) {
      overlapStart = b.t;
      participants = new Set(active);
    } else if (after >= 2 && overlapStart !== null) {
      for (const a of active) participants.add(a);
    } else if (before >= 2 && after < 2 && overlapStart !== null) {
      const ev = buildOverlap(overlapStart, b.t, participants, cfg);
      if (ev) overlaps.push(ev);
      overlapStart = null;
      participants = new Set();
    }

    if (before < cfg.crosstalkSpeakers && after >= cfg.crosstalkSpeakers) {
      crossStart = b.t;
    } else if (before >= cfg.crosstalkSpeakers && after < cfg.crosstalkSpeakers && crossStart !== null) {
      if (b.t - crossStart >= cfg.minOverlapSeconds) crosstalk.push({ start: crossStart, end: b.t });
      crossStart = null;
    }
  }

  return { overlaps, crosstalk };
}

function buildOverlap(
  start: number,
  end: number,
  participants: Set<Turn>,
  cfg: OverlapConfig,
): OverlapEvent | null {
  if (end - start < cfg.minOverlapSeconds) return null;

  const list = [...participants].sort((a, b) => a.start - b.start);
  const incumbent = list[0];
  // Whoever started last is the one breaking in.
  const interrupter = list.reduce((latest, t) => (t.start > latest.start ? t : latest), list[0]);

  const incumbentStoppedSoon =
    interrupter !== incumbent && incumbent.end - start <= cfg.takeoverWindowSeconds;
  const interrupterContinued = interrupter.end > incumbent.end;

  return {
    start,
    end,
    speakerIds: [...new Set(list.map((t) => t.speakerId))],
    isTakeover: incumbentStoppedSoon && interrupterContinued,
    interrupterId: interrupter === incumbent ? undefined : interrupter.speakerId,
  };
}
