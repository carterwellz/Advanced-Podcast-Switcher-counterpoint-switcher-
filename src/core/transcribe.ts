/*
 * Word-level transcription for filler-word trim, via AssemblyAI.
 *
 * This was local whisper-cli.exe until a direct measurement retired it. Whisper is
 * trained to emit clean readable transcripts and silently drops disfluencies: across
 * five minutes of real Counterpoint speech it returned ZERO instances of "um" or
 * "uh", which are the entire point of the feature. AssemblyAI with
 * `disfluencies: true` returned 8 over the same audio, transcribed the rest more
 * accurately (17 lexicon phrase matches vs 6), and did it in 11s against Whisper's
 * 176s. The local path was not a viable fallback, it was a trap: 19 minutes of
 * model-loading to find almost nothing, so it is gone rather than left switchable.
 *
 * Nothing here runs unless `detect-trim.ts` calls it, which only happens when
 * `trimFillerWords` is on. That toggle is off by default, so with it off no audio
 * ever leaves the machine and no key is ever read. Dead-air trim never calls this.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findFfmpeg } from './ffmpeg.js';
import { checkMedia } from './media.js';
import type { MediaRef, Seconds, Word } from './types.js';

const execFileAsync = promisify(execFile);

const API = 'https://api.assemblyai.com/v2';
/**
 * Silence inserted between concatenated turns. Long enough that a word at the end of
 * one turn cannot bleed into the next turn's first word, short enough not to inflate
 * the billed duration meaningfully.
 */
const SEPARATOR_SEC = 0.5;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

/** One turn's audio: where to read it from, and where it lives on the timeline. */
export interface TurnAudioRef {
  media: MediaRef;
  sourceStart: Seconds;
  sourceEnd: Seconds;
  /** Where `sourceStart` lands on the sequence timeline, for remapping results back. */
  timelineStart: Seconds;
}

export interface TranscribeOptions {
  cacheDir?: string;
  ffmpegPath?: string;
  apiKey?: string;
}

/**
 * Read CPSW_ASSEMBLYAI_KEY from the environment, falling back to the repo's .env.
 * The panel spawns these CLIs as plain child processes with no dotenv preloading, so
 * the file has to be read explicitly rather than assumed to be in the environment.
 */
export function findApiKey(explicit?: string): string {
  const fromEnv = explicit ?? process.env.CPSW_ASSEMBLYAI_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // Resolve .env relative to THIS MODULE, not to process.cwd(). The panel spawns
  // these CLIs from whatever directory Premiere happens to be running in, which is
  // never the repo, so a cwd-relative lookup finds nothing and the key silently
  // reads as missing. Walking up from the compiled module (dist/core/ -> repo root)
  // is the only location that holds regardless of who spawned the process.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), '.env'),
    join(here, '.env'),
    join(here, '..', '.env'),
    join(here, '..', '..', '.env'),
    join(here, '..', '..', '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const m = readFileSync(candidate, 'utf8').match(/^\s*CPSW_ASSEMBLYAI_KEY\s*=\s*(.+)\s*$/m);
    if (m && m[1].trim()) return m[1].trim();
  }

  throw new Error(
    'No AssemblyAI API key found. Filler-word trim needs one: set CPSW_ASSEMBLYAI_KEY, ' +
      'or put it in .env at the project root. Dead-air trim does not need this and is unaffected.',
  );
}

/**
 * Transcribe every supplied turn and return words already remapped onto the sequence
 * timeline, the same coordinate space `analysis.turns` uses.
 *
 * All turns go up as ONE concatenated file with a silence separator between them,
 * not one request per turn. Per-turn requests were what made the local path take
 * over an hour; the cost is dominated by per-request overhead, not by audio length,
 * and the offset table below is what makes a single request safe to unpick again.
 */
export async function transcribeTurns(
  refs: TurnAudioRef[],
  opts: TranscribeOptions = {},
): Promise<Word[]> {
  if (refs.length === 0) return [];

  const cacheDir = opts.cacheDir ?? join(process.cwd(), '.cache', 'transcripts');
  const key = batchCacheKey(refs);
  const cached = readCache(cacheDir, key);
  if (cached) return cached;

  const apiKey = findApiKey(opts.apiKey);
  const scratch = mkdtempSync(join(tmpdir(), 'cpsw-aai-'));
  try {
    const { wavPath, offsets } = await buildConcatenatedWav(refs, scratch, opts.ffmpegPath);
    const uploadUrl = await uploadAudio(wavPath, apiKey);
    const words = await runTranscription(uploadUrl, apiKey);
    const mapped = remapToTimeline(words, offsets, refs);
    writeCache(cacheDir, key, mapped);
    return mapped;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface ConcatOffset {
  /** Where this turn begins inside the concatenated file. */
  concatStart: Seconds;
  concatEnd: Seconds;
}

/**
 * Pull each turn out to a 16kHz mono WAV and concatenate them with silence between.
 * `pan=mono|c0=c<channel>` both selects this speaker's channel and downmixes in one
 * filter, and works whether the source is a true polyphonic WAV or an already-mono
 * file (channel 0 either way).
 */
async function buildConcatenatedWav(
  refs: TurnAudioRef[],
  scratch: string,
  ffmpegPath?: string,
): Promise<{ wavPath: string; offsets: ConcatOffset[] }> {
  const bin = findFfmpeg(ffmpegPath);

  const sepPath = join(scratch, 'sep.wav');
  await execFileAsync(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
    '-t', String(SEPARATOR_SEC), '-ar', '16000', '-ac', '1', sepPath,
  ]);

  const listLines: string[] = [];
  const offsets: ConcatOffset[] = [];
  let cursor = 0;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const duration = ref.sourceEnd - ref.sourceStart;
    const partPath = join(scratch, `t${i}.wav`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    if (ref.sourceStart > 0) args.push('-ss', ref.sourceStart.toFixed(6));
    args.push('-i', ref.media.file, '-t', duration.toFixed(6));
    args.push('-af', `pan=mono|c0=c${ref.media.channel}`, '-ar', '16000', '-ac', '1', '-f', 'wav', partPath);
    await execFileAsync(bin, args);

    offsets.push({ concatStart: cursor, concatEnd: cursor + duration });
    cursor += duration + SEPARATOR_SEC;
    listLines.push(`file '${partPath.replace(/\\/g, '/')}'`);
    listLines.push(`file '${sepPath.replace(/\\/g, '/')}'`);
  }

  const listPath = join(scratch, 'list.txt');
  writeFileSync(listPath, listLines.join('\n'), 'utf8');
  const wavPath = join(scratch, 'batch.wav');
  await execFileAsync(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', wavPath,
  ]);

  return { wavPath, offsets };
}

async function uploadAudio(wavPath: string, apiKey: string): Promise<string> {
  const res = await fetch(`${API}/upload`, {
    method: 'POST',
    headers: { authorization: apiKey },
    body: readFileSync(wavPath),
  });
  if (!res.ok) throw new Error(`AssemblyAI upload failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { upload_url: string };
  return body.upload_url;
}

interface AaiWord {
  text: string;
  start: number;
  end: number;
}

/**
 * `disfluencies: true` is the entire reason this provider was chosen: without it,
 * "um" and "uh" are stripped exactly the way local Whisper strips them. `format_text`
 * is off for the same reason, since text formatting is another normalisation pass
 * that can quietly tidy filler away.
 */
async function runTranscription(uploadUrl: string, apiKey: string): Promise<AaiWord[]> {
  const submit = await fetch(`${API}/transcript`, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      audio_url: uploadUrl,
      disfluencies: true,
      punctuate: true,
      format_text: false,
    }),
  });
  if (!submit.ok) throw new Error(`AssemblyAI submit failed (${submit.status}): ${await submit.text()}`);
  const job = (await submit.json()) as { id: string };

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error('AssemblyAI transcription timed out.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await fetch(`${API}/transcript/${job.id}`, { headers: { authorization: apiKey } });
    if (!poll.ok) throw new Error(`AssemblyAI poll failed (${poll.status}): ${await poll.text()}`);
    const result = (await poll.json()) as { status: string; error?: string; words?: AaiWord[] };
    if (result.status === 'error') throw new Error(`AssemblyAI transcription failed: ${result.error}`);
    if (result.status === 'completed') return result.words ?? [];
  }
}

/**
 * Unpick the single concatenated response back into timeline coordinates, using the
 * offset table built while concatenating. A word is attributed to the turn whose
 * concat window contains its start, then shifted by that turn's own timeline offset.
 */
function remapToTimeline(words: AaiWord[], offsets: ConcatOffset[], refs: TurnAudioRef[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const start = w.start / 1000;
    const end = w.end / 1000;
    const idx = offsets.findIndex((o) => start >= o.concatStart - 0.05 && start < o.concatEnd + 0.05);
    if (idx === -1) continue; // landed in a separator: not real speech, drop it
    const shift = refs[idx].timelineStart - offsets[idx].concatStart;
    out.push({ text: w.text, start: start + shift, end: end + shift });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function batchCacheKey(refs: TurnAudioRef[]): string {
  const h = createHash('sha1');
  h.update('assemblyai-disfluencies-v1');
  // Media identity once per distinct file, then every range, so a changed source
  // file or a changed turn list both miss the cache.
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!seen.has(ref.media.file)) {
      seen.add(ref.media.file);
      const st = checkMedia(ref.media);
      h.update(ref.media.file);
      h.update(String(st.sizeBytes ?? 0));
      h.update(String(st.mtimeMs ?? 0));
    }
    h.update(`${ref.media.channel}:${ref.sourceStart.toFixed(3)}:${ref.sourceEnd.toFixed(3)}`);
  }
  return h.digest('hex').slice(0, 20);
}

function readCache(dir: string, key: string): Word[] | null {
  const p = join(dir, `${key}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Word[];
  } catch {
    return null;
  }
}

function writeCache(dir: string, key: string, words: Word[]): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(words));
  } catch {
    // Cache is an optimisation. Failing to write it must never fail the run.
  }
}
