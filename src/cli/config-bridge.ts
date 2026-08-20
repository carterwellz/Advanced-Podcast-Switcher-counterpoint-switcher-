/*
 * The vocabulary shared by every CLI the panel spawns.
 *
 * `run-plan.ts` and `detect-trim.ts` both start from the exact same panel config
 * JSON (the panel builds it once per run and hands the same file to whichever
 * CLIs are needed for that run). Splitting this out is what keeps them from
 * silently drifting apart on what a setting means: dead-air detection here and the
 * camera-cut plan in `run-plan.ts` must agree on what counts as a pause, or the two
 * passes disagree about the same audio.
 */
import { resolveMediaRef } from '../core/media.js';
import type { GateConfig, ShotType, Speaker } from '../core/types.js';

export interface PanelClip {
  mediaPath: string;
  timelineStart: number;
  timelineEnd: number;
  sourceIn: number;
}

export interface PanelSpeaker {
  id: string;
  name: string;
  audioTrackIndex: number;
  side: 'A' | 'B' | 'host';
  clips: PanelClip[];
}

export interface PanelAngle {
  id: string;
  name: string;
  videoTrackIndex: number;
  shows: string[];
  shotType: ShotType;
  physicalCamera: string;
  targetSharePct: number | null;
}

export interface PanelConfig {
  speakers: PanelSpeaker[];
  angles: PanelAngle[];
  settings: Record<string, number | boolean | string>;
  range: { start: number; end: number };
}

export function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

export function toGateConfig(s: PanelConfig['settings']): Partial<GateConfig> {
  return {
    minTurnSeconds: num(s.ignoreShorterSec, 0.6),
    bridgeGapSeconds: num(s.holdThroughPauseSec, 0.35),
    minSilenceSeconds: num(s.deadAirSec, 1.5),
  };
}

/** `PanelConfig.speakers` with media references resolved, ready for `analyze()`. */
export function resolveSpeakers(cfg: PanelConfig): Speaker[] {
  return cfg.speakers.map((s) => ({
    id: s.id,
    name: s.name,
    audioTrackIndex: s.audioTrackIndex,
    side: s.side,
    clips: s.clips.map((c) => ({
      media: resolveMediaRef(c.mediaPath),
      timelineStart: c.timelineStart,
      timelineEnd: c.timelineEnd,
      sourceIn: c.sourceIn,
    })),
  }));
}
