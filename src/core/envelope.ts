import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findFfmpeg, probeAudio } from './ffmpeg.js';
import { checkMedia } from './media.js';
import type { MediaRef, Seconds } from './types.js';

/** Value used to represent digital silence, so consumers never see -Infinity. */
export const SILENCE_DB = -120;

export interface FileEnvelopeRequest {
  file: string;
  /**
   * Channels to extract. For a folder-per-track layout every speaker is their own
   * mono-ish file, so this is `[0]` and the file is downmixed. For a true poly WAV
   * these are the real channel indices to keep separate.
   */
  channels: number[];
  /** True when `channels` index into a polyphonic file rather than meaning "downmix". */
  poly: boolean;
  startSeconds: Seconds;
  durationSeconds: Seconds;
}

export interface FileEnvelope {
  file: string;
  hopSeconds: number;
  startSeconds: Seconds;
  /** Keyed by channel index. dBFS per hop. */
  byChannel: Map<number, Float32Array>;
}

export interface EnvelopeOptions {
  hopSeconds?: number;
  cacheDir?: string;
  ffmpegPath?: string;
  onProgress?: (msg: string) => void;
}

/**
 * Extract a per-hop RMS envelope in dBFS.
 *
 * ffmpeg does the arithmetic, not JavaScript. Computing RMS in JS would mean
 * touching every sample: 48 kHz times 2 channels times 2.7 hours is nearly a
 * billion operations per track. `asetnsamples` fixes the window to an exact hop
 * and `astats` reports the level per window, so all JS has to do is parse numbers.
 */
export async function extractFileEnvelope(
  req: FileEnvelopeRequest,
  opts: EnvelopeOptions = {},
): Promise<FileEnvelope> {
  const hopSeconds = opts.hopSeconds ?? 0.02;
  const cacheDir = opts.cacheDir ?? join(process.cwd(), '.cache', 'envelopes');

  const cacheKey = envelopeCacheKey(req, hopSeconds);
  const cached = readCache(cacheDir, cacheKey, req, hopSeconds);
  if (cached) {
    opts.onProgress?.(`cache hit ${req.file}`);
    return cached;
  }

  const probe = await probeAudio(req.file, undefined);
  const hopSamples = Math.max(1, Math.round(probe.sampleRate * hopSeconds));

  // Downmix unless the caller genuinely needs separate channels of a poly file.
  const channelFilter = req.poly ? '' : 'aformat=channel_layouts=mono,';
  const filter =
    `${channelFilter}asetnsamples=n=${hopSamples}:p=0,` +
    'astats=metadata=1:reset=1:measure_perchannel=RMS_level:measure_overall=none,' +
    'ametadata=mode=print:file=-';

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (req.startSeconds > 0) args.push('-ss', req.startSeconds.toFixed(6));
  args.push('-i', req.file);
  if (req.durationSeconds > 0) args.push('-t', req.durationSeconds.toFixed(6));
  args.push('-vn', '-af', filter, '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null');

  const expectedFrames = Math.ceil(req.durationSeconds / hopSeconds) + 2;
  const wanted = req.poly ? req.channels : [0];
  const acc = new Map<number, number[]>();
  for (const ch of wanted) acc.set(ch, []);

  await runAndParse(findFfmpeg(opts.ffmpegPath), args, acc, wanted, expectedFrames, opts.onProgress);

  const byChannel = new Map<number, Float32Array>();
  for (const [ch, values] of acc) byChannel.set(ch, Float32Array.from(values));

  const env: FileEnvelope = {
    file: req.file,
    hopSeconds,
    startSeconds: req.startSeconds,
    byChannel,
  };
  writeCache(cacheDir, cacheKey, env);
  return env;
}

/**
 * Parse ffmpeg's ametadata stream.
 *
 * Output alternates a frame header with one RMS line per channel:
 *   frame:12   pts:11520   pts_time:0.24
 *   lavfi.astats.1.RMS_level=-38.123456
 *
 * astats numbers channels from 1. `-inf` appears on digital silence.
 */
function runAndParse(
  bin: string,
  args: string[],
  acc: Map<number, number[]>,
  wanted: number[],
  expectedFrames: number,
  onProgress?: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let carry = '';
    let stderr = '';
    let frames = 0;
    let lastReport = 0;

    // Per-frame slots, so a channel that goes silent still lands in the right hop.
    const pending = new Map<number, number>();

    const flushFrame = () => {
      if (pending.size === 0) return;
      for (const ch of wanted) {
        const v = pending.has(ch) ? pending.get(ch)! : SILENCE_DB;
        acc.get(ch)!.push(v);
      }
      pending.clear();
      frames++;
      if (onProgress && frames - lastReport >= 50000) {
        lastReport = frames;
        onProgress(`  ${frames}/${expectedFrames} hops`);
      }
    };

    p.stdout.on('data', (d: Buffer) => {
      carry += d.toString('latin1');
      let nl: number;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.startsWith('frame:')) {
          flushFrame();
          continue;
        }
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq);
        if (!key.endsWith('.RMS_level')) continue;
        const chMatch = key.match(/astats\.(\d+)\.RMS_level$/);
        if (!chMatch) continue;
        const ch = Number.parseInt(chMatch[1], 10) - 1;
        const raw = line.slice(eq + 1).trim();
        const val = raw === '-inf' || raw === '-nan' ? SILENCE_DB : Number.parseFloat(raw);
        pending.set(ch, Number.isFinite(val) ? Math.max(val, SILENCE_DB) : SILENCE_DB);
      }
    });

    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      flushFrame();
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function envelopeCacheKey(req: FileEnvelopeRequest, hopSeconds: number): string {
  const ref: MediaRef = { file: req.file, channel: 0, fromPolyWav: req.poly, reportedPath: req.file };
  const st = checkMedia(ref);
  const h = createHash('sha1');
  h.update(req.file);
  h.update(String(st.sizeBytes ?? 0));
  h.update(String(st.mtimeMs ?? 0));
  h.update(req.channels.join(','));
  h.update(String(req.poly));
  h.update(req.startSeconds.toFixed(3));
  h.update(req.durationSeconds.toFixed(3));
  h.update(String(hopSeconds));
  return h.digest('hex').slice(0, 20);
}

interface CacheHeader {
  file: string;
  hopSeconds: number;
  startSeconds: number;
  channels: number[];
  lengths: number[];
}

function readCache(
  dir: string,
  key: string,
  req: FileEnvelopeRequest,
  hopSeconds: number,
): FileEnvelope | null {
  const headPath = join(dir, `${key}.json`);
  const binPath = join(dir, `${key}.f32`);
  if (!existsSync(headPath) || !existsSync(binPath)) return null;
  try {
    const head: CacheHeader = JSON.parse(readFileSync(headPath, 'utf8'));
    const buf = readFileSync(binPath);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const byChannel = new Map<number, Float32Array>();
    let off = 0;
    head.channels.forEach((ch, i) => {
      const len = head.lengths[i];
      byChannel.set(ch, all.slice(off, off + len));
      off += len;
    });
    return { file: req.file, hopSeconds, startSeconds: req.startSeconds, byChannel };
  } catch {
    return null;
  }
}

function writeCache(dir: string, key: string, env: FileEnvelope): void {
  try {
    mkdirSync(dir, { recursive: true });
    const channels = [...env.byChannel.keys()];
    const lengths = channels.map((c) => env.byChannel.get(c)!.length);
    const total = lengths.reduce((a, b) => a + b, 0);
    const flat = new Float32Array(total);
    let off = 0;
    for (const c of channels) {
      const arr = env.byChannel.get(c)!;
      flat.set(arr, off);
      off += arr.length;
    }
    const head: CacheHeader = {
      file: env.file,
      hopSeconds: env.hopSeconds,
      startSeconds: env.startSeconds,
      channels,
      lengths,
    };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(head));
    writeFileSync(join(dir, `${key}.f32`), Buffer.from(flat.buffer));
  } catch {
    // Cache is an optimisation. Failing to write it must never fail the run.
  }
}
