#!/usr/bin/env node
/*
 * Probe parakeet-cli.exe's one-shot and --daemon behavior against a short,
 * synthetic, entirely local test WAV (Windows TTS, not real episode audio -- this
 * touches no Premiere project and no Auphonic media). Judges the daemon's actual
 * JSON-over-stdin protocol by trying plausible request shapes and reporting
 * exactly what came back for each, the same "discover, don't assume" discipline
 * spikes/probe-ripple.jsx uses for the ExtendScript side.
 *
 * Usage: node spikes/probe-parakeet.mjs [path/to/16k-mono.wav]
 * If no WAV is given, generates one via Windows TTS + ffmpeg first.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PARAKEET_CLI = 'C:\\Program Files\\Vowen\\resources\\bin\\parakeet-cli.exe';
const MODEL_DIR = 'C:\\Users\\carte\\AppData\\Roaming\\vowen\\models\\parakeet-tdt-0.6b-v2-int8';
const FFMPEG = 'C:\\Users\\carte\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-N-121271-g74115b017c-win64-gpl\\bin\\ffmpeg.exe';

function log(...args) {
  console.log(...args);
}

function makeTestWav(dir) {
  const rawPs1 = path.join(dir, 'tts.ps1');
  const rawWav = path.join(dir, 'tts-raw.wav');
  const outWav = path.join(dir, 'tts-16k-mono.wav');
  writeFileSync(
    rawPs1,
    [
      'Add-Type -AssemblyName System.Speech',
      '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$synth.SetOutputToWaveFile("${rawWav}")`,
      '$synth.Speak("Well, you know, I just think that the actual point here is pretty clear, if that makes sense.")',
      '$synth.Dispose()',
    ].join('\n'),
    'utf8',
  );
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-File', rawPs1], { stdio: 'inherit' });
  if (ps.status !== 0) throw new Error('TTS generation failed');
  const ff = spawnSync(FFMPEG, ['-y', '-i', rawWav, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outWav]);
  if (ff.status !== 0) throw new Error('ffmpeg resample failed: ' + ff.stderr.toString().slice(-1000));
  return outWav;
}

async function probeOneShot(wavPath) {
  log('\n=== one-shot mode ===');
  const r = spawnSync(PARAKEET_CLI, ['--timestamps', MODEL_DIR, wavPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
  log('exit code:', r.status);
  log('stderr (last 2000 chars):', (r.stderr || '').slice(-2000));
  log('stdout (last 4000 chars):', (r.stdout || '').slice(-4000));
  try {
    const parsed = JSON.parse(r.stdout);
    log('stdout parses as JSON. Top-level keys:', Object.keys(parsed));
  } catch (e) {
    log('stdout did NOT parse as pure JSON:', e.message);
  }
}

function sendDaemonRequest(child, obj, label) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      // Assume newline-delimited JSON responses; resolve on the first line.
      if (out.includes('\n') && !settled) {
        settled = true;
        child.stdout.off('data', onData);
        resolve({ label, raw: out });
      }
    };
    child.stdout.on('data', onData);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.stdout.off('data', onData);
        resolve({ label, raw: out, timedOut: true });
      }
    }, 15000);
    child.stdin.write(JSON.stringify(obj) + '\n');
  });
}

async function probeDaemon(wavPath) {
  log('\n=== --daemon mode ===');
  const child = spawn(PARAKEET_CLI, ['--daemon', MODEL_DIR], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  child.on('error', (e) => log('daemon spawn error:', e.message));

  // Give it a moment to finish loading the model before sending anything.
  await new Promise((r) => setTimeout(r, 3000));

  const candidates = [
    { label: 'audio_path', obj: { audio_path: wavPath, timestamps: true } },
    { label: 'audioPath', obj: { audioPath: wavPath, timestamps: true } },
    { label: 'path', obj: { path: wavPath } },
    { label: 'file', obj: { file: wavPath } },
    { label: 'command+path', obj: { command: 'transcribe', path: wavPath } },
    { label: 'type+audio_path', obj: { type: 'transcribe', audio_path: wavPath, timestamps: true } },
  ];

  for (const c of candidates) {
    const result = await sendDaemonRequest(child, c.obj, c.label);
    log(`--- request shape "${result.label}" ---`);
    log('sent:', JSON.stringify(c.obj));
    log('raw response:', result.timedOut ? '(timed out after 15s, no response)' : result.raw.slice(0, 2000));
    try {
      const parsed = JSON.parse(result.raw.split('\n')[0]);
      log('parsed keys:', Object.keys(parsed));
      log('FOUND A WORKING SHAPE. Stopping here.');
      child.kill();
      log('\nstderr collected during daemon run (last 2000 chars):', stderrBuf.slice(-2000));
      return c;
    } catch {
      // try the next candidate
    }
  }

  log('\nNo candidate request shape produced parseable JSON. stderr (last 3000 chars):');
  log(stderrBuf.slice(-3000));
  child.kill();
  return null;
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cpsw-parakeet-probe-'));
  const wavArg = process.argv[2];
  const wavPath = wavArg && existsSync(wavArg) ? wavArg : makeTestWav(dir);
  log('test WAV:', wavPath);
  log('parakeet-cli.exe exists:', existsSync(PARAKEET_CLI));
  log('model dir exists:', existsSync(MODEL_DIR));

  await probeOneShot(wavPath);
  await probeDaemon(wavPath);
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
