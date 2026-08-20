import { existsSync, statSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import type { MediaRef } from './types.js';

/**
 * Turn a path Premiere reported into something ffmpeg can actually open.
 *
 * Counterpoint's audio arrives as Auphonic multitrack output, which is a *folder*
 * named after the input file, holding one real mono WAV per person:
 *
 *   R:\EPISODE 29\New Audio2\V2 9-5ERMIC.wav\Track 3.wav
 *   \____ folder, despite the .wav name ___/ \_ real file _/
 *
 * Separately, Premiere addresses a channel of a genuine polyphonic WAV using the
 * identical shape, where the parent really is a file and the leaf is a channel that
 * does not exist on disk.
 *
 * The two cases are indistinguishable by name, so never guess from the extension.
 * Stat the parent: a directory means the leaf is a real file, a file means the leaf
 * is a channel index into it.
 */
export function resolveMediaRef(reportedPath: string): MediaRef {
  const normalized = reportedPath.replace(/\//g, '\\').trim();
  const parent = dirname(normalized);
  const leaf = basename(normalized);

  let parentIsFile = false;
  try {
    parentIsFile = existsSync(parent) && statSync(parent).isFile();
  } catch {
    parentIsFile = false;
  }

  if (parentIsFile) {
    return {
      file: parent,
      channel: parseChannelIndex(leaf),
      fromPolyWav: true,
      reportedPath,
    };
  }

  return { file: normalized, channel: 0, fromPolyWav: false, reportedPath };
}

/**
 * Pull a 0-based channel index out of a leaf name like `Track 3.wav`.
 * Premiere numbers these from 1. Anything unrecognised falls back to channel 0,
 * which is the safe answer for a mono file.
 */
export function parseChannelIndex(leaf: string): number {
  const stem = leaf.slice(0, leaf.length - extname(leaf).length);
  const match = stem.match(/(\d+)\s*$/);
  if (!match) return 0;
  const oneBased = Number.parseInt(match[1], 10);
  return Number.isFinite(oneBased) && oneBased > 0 ? oneBased - 1 : 0;
}

export interface MediaCheck {
  ok: boolean;
  reason?: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

/** Confirm the resolved file is really on disk before handing it to ffmpeg. */
export function checkMedia(ref: MediaRef): MediaCheck {
  if (!ref.file) return { ok: false, reason: 'empty path' };
  if (!existsSync(ref.file)) {
    return {
      ok: false,
      reason: ref.fromPolyWav
        ? `poly-WAV container not found: ${ref.file} (reported as ${ref.reportedPath})`
        : `file not found: ${ref.file}`,
    };
  }
  const st = statSync(ref.file);
  if (!st.isFile()) return { ok: false, reason: `not a file: ${ref.file}` };
  return { ok: true, sizeBytes: st.size, mtimeMs: st.mtimeMs };
}
