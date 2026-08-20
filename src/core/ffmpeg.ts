import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * ffmpeg is the one external binary this engine cannot work without, and it is
 * installed in a different place on every machine. Resolution order, most
 * deliberate first:
 *
 *   1. an explicit --ffmpeg path
 *   2. the CPSW_FFMPEG environment variable
 *   3. PATH, checked for real rather than assumed
 *   4. the handful of locations Windows package managers actually use
 *
 * Step 3 matters more than it looks. The old code returned the bare string
 * "ffmpeg" whenever nothing else matched, so a machine without ffmpeg installed
 * failed later with a raw spawn ENOENT from inside an envelope extraction,
 * naming neither ffmpeg nor what to do about it.
 */

const EXE = process.platform === 'win32' ? '.exe' : '';

function fromPath(name: string): string | null {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = join(dir.replace(/^"|"$/g, ''), name + EXE);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * winget installs ffmpeg into a versioned folder whose name changes with every
 * build, so the directory has to be scanned rather than named.
 */
function fromWingetPackages(name: string): string | null {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const root = join(local, 'Microsoft', 'WinGet', 'Packages');
  let pkgs: string[];
  try {
    pkgs = readdirSync(root);
  } catch {
    return null;
  }
  for (const pkg of pkgs) {
    if (!/ffmpeg/i.test(pkg)) continue;
    let inner: string[];
    try {
      inner = readdirSync(join(root, pkg));
    } catch {
      continue;
    }
    for (const dir of inner) {
      const p = join(root, pkg, dir, 'bin', name + EXE);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function wellKnown(name: string): string[] {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\Program Files';
  const programData = process.env.ProgramData || 'C:\ProgramData';
  return [
    join(local, 'Microsoft', 'WinGet', 'Links', name + EXE),
    join(homedir(), 'scoop', 'shims', name + EXE),
    join(programData, 'chocolatey', 'bin', name + EXE),
    join(programFiles, 'ffmpeg', 'bin', name + EXE),
    join('C:' + String.fromCharCode(92), 'ffmpeg', 'bin', name + EXE),
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
    '/usr/bin/' + name,
  ];
}

const cache: Record<string, string> = {};

function resolve(name: 'ffmpeg' | 'ffprobe', explicit?: string): string {
  if (explicit) return explicit;
  if (cache[name]) return cache[name];

  const envVar = name === 'ffmpeg' ? 'CPSW_FFMPEG' : 'CPSW_FFPROBE';
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) {
    cache[name] = fromEnv;
    return fromEnv;
  }

  const found =
    fromPath(name) ||
    fromWingetPackages(name) ||
    wellKnown(name).find((p) => existsSync(p)) ||
    null;

  if (found) {
    cache[name] = found;
    return found;
  }

  throw new Error(
    `${name} not found. Install ffmpeg and make sure it is on PATH ` +
      `(winget install Gyan.FFmpeg), or set ${envVar} to the full path of ${name}${EXE}.`,
  );
}

/** Find a usable ffmpeg, or throw an error that says how to fix it. */
export function findFfmpeg(explicit?: string): string {
  return resolve('ffmpeg', explicit);
}

/**
 * Find ffprobe. Resolved independently rather than by string-substituting the
 * ffmpeg path, so a machine that has them in different places still works.
 */
export function findFfprobe(explicit?: string): string {
  return resolve('ffprobe', explicit);
}

export interface ProbeResult {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  codec: string;
}

export async function probeAudio(file: string, ffprobePath?: string): Promise<ProbeResult> {
  const bin = findFfprobe(ffprobePath);
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1',
    file,
  ];
  const out = await run(bin, args);
  const get = (k: string) => {
    const m = out.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };
  const channels = Number.parseInt(get('channels'), 10);
  const sampleRate = Number.parseInt(get('sample_rate'), 10);
  const durationSeconds = Number.parseFloat(get('duration'));
  if (!Number.isFinite(channels) || !Number.isFinite(sampleRate)) {
    throw new Error(`ffprobe could not read an audio stream from ${file}`);
  }
  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    sampleRate,
    channels,
    codec: get('codec_name'),
  };
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited ${code}: ${err.slice(-2000)}`));
    });
  });
}

export interface PcmStreamOptions {
  file: string;
  sampleRate: number;
  /** Start offset into the source, in seconds. */
  startSeconds?: number;
  /** How much to read, in seconds. Omit to read to the end. */
  durationSeconds?: number;
  ffmpegPath?: string;
}

/**
 * Stream a file as interleaved 16-bit signed PCM at the requested rate,
 * keeping every channel. Callers get raw chunks and de-interleave themselves.
 *
 * Decoding all channels in one pass matters: the eight Counterpoint mics live
 * inside a single polyphonic WAV, so per-channel passes would read the same
 * multi-gigabyte file eight times over.
 */
export function streamPcm(
  opts: PcmStreamOptions,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const bin = findFfmpeg(opts.ffmpegPath);
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  // Seeking before -i is the fast path: ffmpeg jumps rather than decoding and discarding.
  if (opts.startSeconds && opts.startSeconds > 0) {
    args.push('-ss', opts.startSeconds.toFixed(6));
  }
  args.push('-i', opts.file);
  if (opts.durationSeconds && opts.durationSeconds > 0) {
    args.push('-t', opts.durationSeconds.toFixed(6));
  }
  args.push('-vn', '-ar', String(opts.sampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1');

  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    p.stdout.on('data', onChunk);
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-2000)}`));
    });
  });
}
