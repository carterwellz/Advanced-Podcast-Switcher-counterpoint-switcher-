/** Seconds on the sequence timeline. */
export type Seconds = number;

/**
 * Where a speaker's audio actually lives.
 *
 * Premiere reports a channel of a polyphonic WAV as a path whose parent is itself
 * a .wav file, e.g. `R:\...\V2 9-5ERMIC.wav\Track 3.wav`. That is not a real file on
 * disk. `file` is the thing ffmpeg can open, `channel` is the 0-based channel inside it.
 */
export interface MediaRef {
  /** Real path on disk that ffmpeg can open. */
  file: string;
  /** 0-based channel index within `file`. */
  channel: number;
  /** True when this came from a poly WAV rather than a standalone mono file. */
  fromPolyWav: boolean;
  /** The raw path Premiere reported, kept for diagnostics. */
  reportedPath: string;
}

/** One clip of a speaker's audio placed on the timeline. */
export interface AudioClipPlacement {
  media: MediaRef;
  /** Where the clip starts on the sequence timeline. */
  timelineStart: Seconds;
  /** Where the clip ends on the sequence timeline. */
  timelineEnd: Seconds;
  /** Offset into the source media that `timelineStart` corresponds to. */
  sourceIn: Seconds;
}

/** A person, their mic, and which side of the debate they are on. */
export interface Speaker {
  id: string;
  name: string;
  /** Index of the Premiere audio track this person is on. */
  audioTrackIndex: number;
  side: 'A' | 'B' | 'host';
  clips: AudioClipPlacement[];
}

export type ShotType = 'single' | 'two' | 'group' | 'wide';

/** A logical camera angle, which is one Premiere video track. */
export interface VideoAngle {
  id: string;
  name: string;
  /** Index of the Premiere video track. */
  videoTrackIndex: number;
  /** Speaker ids visible in this angle. */
  shows: string[];
  shotType: ShotType;
  /**
   * Which physical camera this came from. Several angles can be crops of one
   * sensor, and cutting between two of those reads as a jump cut.
   */
  physicalCamera: string;
  /** Desired share of screen time, 0..1. Enforced as a ceiling, not a hint. */
  targetShare?: number;
}

/**
 * A per-track loudness envelope.
 * `db[i]` covers the window starting at `startTime + i * hopSeconds`.
 */
export interface Envelope {
  speakerId: string;
  hopSeconds: number;
  startTime: Seconds;
  /** RMS in dBFS. Silence is represented as -Infinity clamped to `floorDb`. */
  db: Float32Array;
  /** Lowest value used to represent silence, so consumers need not handle -Infinity. */
  floorDb: number;
}

export interface Interval {
  start: Seconds;
  end: Seconds;
}

/** A continuous stretch where one person holds the floor. */
export interface Turn extends Interval {
  speakerId: string;
  /** Mean dB above this speaker's own noise floor. */
  strengthDb: number;
}

/**
 * A short burst on a non-speaking mic: a laugh, scoff, "mmm", or "that's not true".
 * This is the signal the whole reaction-shot feature rests on.
 */
export interface ReactionEvent extends Interval {
  speakerId: string;
  /** Peak dB above this speaker's own noise floor. Higher means a stronger reaction. */
  peakDb: number;
  /** Whether a voice-activity check confirmed this is speech and not a thump. */
  voiced: boolean | null;
}

/** Two or more people talking at once. */
export interface OverlapEvent extends Interval {
  speakerIds: string[];
  /** True when the incumbent stopped shortly after, so this was a real takeover. */
  isTakeover: boolean;
  /** The speaker who broke in, when identifiable. */
  interrupterId?: string;
}

/**
 * One transcribed word, timed on the sequence timeline (already remapped from
 * source-clip-relative seconds the same way turns are, so it lines up with
 * everything else in an `AnalysisResult` without a caller needing to know that
 * transcription ever happened on a per-clip basis).
 */
export interface Word extends Interval {
  text: string;
}

export interface AnalysisResult {
  speakers: Speaker[];
  envelopes: Envelope[];
  turns: Turn[];
  reactions: ReactionEvent[];
  overlaps: OverlapEvent[];
  /** Three or more people at once. Cut wide. */
  crosstalk: Interval[];
  /** Stretches where nobody is talking, candidates for dead-air trimming. */
  silences: Interval[];
  range: Interval;
}

export interface GateConfig {
  /** Floor constraint: the gate never sits closer than this to the track's own noise floor. */
  openDb: number;
  /**
   * Peak constraint: the gate sits this far below the track's own speech peak.
   * Speech has a characteristic dynamic range, so anchoring to the peak is what
   * stops a mic that is merely quiet from gating on its own room tone.
   */
  speechRangeDb: number;
  /** How far below the open threshold speech has to fall before the gate closes. */
  hysteresisDb: number;
  /**
   * A track whose speech peak is this far below the loudest mics in the room is not
   * carrying speech at all in this stretch, just bleed. Treated as inactive.
   */
  inactiveBelowReferenceDb: number;
  /** Pauses shorter than this do not end a turn. */
  bridgeGapSeconds: number;
  /** Bursts shorter than this are not turns. They become reaction candidates. */
  minTurnSeconds: number;
  /** Reaction candidates shorter than this are noise, not reactions. */
  minReactionSeconds: number;
  /** A reaction must peak at least this far above the open threshold. */
  reactionThresholdDb: number;
  /** Silence longer than this is dead air. */
  minSilenceSeconds: number;
}

export const DEFAULT_GATE: GateConfig = {
  openDb: 12,
  speechRangeDb: 28,
  hysteresisDb: 4,
  inactiveBelowReferenceDb: 22,
  bridgeGapSeconds: 0.35,
  minTurnSeconds: 0.6,
  minReactionSeconds: 0.12,
  reactionThresholdDb: 4,
  minSilenceSeconds: 1.5,
};
