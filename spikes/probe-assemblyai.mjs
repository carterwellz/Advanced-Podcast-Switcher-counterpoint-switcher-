/*
 * Does AssemblyAI actually return the "um"/"uh" that local Whisper silently drops,
 * and is the payoff worth a cloud dependency?
 *
 * Deliberately apples-to-apples with the local measurement: same episode, same
 * ~5 minutes of real speech taken in timeline order, same lexicon. Local Whisper
 * scored 6 matches / 3.3s and ZERO um/uh. This reports the same numbers so the two
 * can be compared directly rather than by impression.
 *
 * Also validates the batching shape the real module will use: one concatenated WAV
 * per batch with an offset table, not one request per turn.
 *
 * Uploads real episode audio to AssemblyAI. Costs a few cents. Run deliberately.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'C:/Users/carte/Desktop/AntiGravity/Multicam Editor';
const SCRATCH = 'C:/Users/carte/AppData/Local/Temp/cpsw-aai';
const SEP_SEC = 0.5;
const TARGET_SPEECH_SEC = 300;

const key = (readFileSync(join(REPO, '.env'), 'utf8').match(/CPSW_ASSEMBLYAI_KEY=(.+)/) || [])[1].trim();
if (!key) throw new Error('CPSW_ASSEMBLYAI_KEY missing from .env');

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

const { analyze } = await import(`file:///${REPO}/dist/core/analyze.js`);
const { toGateConfig, resolveSpeakers } = await import(`file:///${REPO}/dist/cli/config-bridge.js`);
const { findFillerCandidates, DEFAULT_FILLER_LEXICON } = await import(`file:///${REPO}/dist/core/filler.js`);

const cfg = JSON.parse(readFileSync('C:/Users/carte/AppData/Local/Temp/counterpoint-switcher/trim-config.json', 'utf8'));
const speakers = resolveSpeakers(cfg);
const analysis = await analyze(speakers, { gate: toGateConfig(cfg.settings), range: cfg.range, onProgress: () => {} });
const nameById = new Map(speakers.map((s) => [s.id, s.name]));

const picked = [];
let acc = 0;
for (const t of analysis.turns) {
  if (acc >= TARGET_SPEECH_SEC) break;
  picked.push(t);
  acc += t.end - t.start;
}
console.log(`${picked.length} turns, ${acc.toFixed(0)}s of real speech`);

// Concatenate with a silence separator, recording where each turn lands.
const sep = join(SCRATCH, 'sep.wav');
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t',String(SEP_SEC),'-ar','16000','-ac','1',sep]);
const lines = [];
const offsets = [];
let cursor = 0;
picked.forEach((t, i) => {
  const sp = speakers.find((s) => s.id === t.speakerId);
  const clip = sp.clips.find((c) => t.start >= c.timelineStart && t.start < c.timelineEnd);
  const srcStart = clip.sourceIn + (t.start - clip.timelineStart);
  const dur = t.end - t.start;
  const out = join(SCRATCH, `t${i}.wav`);
  execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-nostdin','-y','-ss', srcStart.toFixed(6),
    '-i', clip.media.file, '-t', dur.toFixed(6), '-af', `pan=mono|c0=c${clip.media.channel}`,
    '-ar','16000','-ac','1','-f','wav', out]);
  offsets.push({ concatStart: cursor, turn: t });
  cursor += dur + SEP_SEC;
  lines.push(`file '${out.replace(/\\/g,'/')}'`);
  lines.push(`file '${sep.replace(/\\/g,'/')}'`);
});
const listPath = join(SCRATCH, 'list.txt');
writeFileSync(listPath, lines.join('\n'), 'utf8');
const concatPath = join(SCRATCH, 'all.wav');
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',listPath,'-c','copy',concatPath]);
console.log(`one ${cursor.toFixed(0)}s WAV to upload`);

const t0 = Date.now();
const upload = await fetch('https://api.assemblyai.com/v2/upload', {
  method: 'POST', headers: { authorization: key }, body: readFileSync(concatPath),
});
if (!upload.ok) throw new Error(`upload failed ${upload.status}: ${await upload.text()}`);
const { upload_url } = await upload.json();
console.log(`uploaded in ${((Date.now()-t0)/1000).toFixed(1)}s`);

const submit = await fetch('https://api.assemblyai.com/v2/transcript', {
  method: 'POST',
  headers: { authorization: key, 'content-type': 'application/json' },
  body: JSON.stringify({ audio_url: upload_url, disfluencies: true, punctuate: true, format_text: false }),
});
if (!submit.ok) throw new Error(`submit failed ${submit.status}: ${await submit.text()}`);
const job = await submit.json();

let result;
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${job.id}`, { headers: { authorization: key } });
  result = await poll.json();
  if (result.status === 'completed' || result.status === 'error') break;
  process.stdout.write('.');
}
console.log('');
if (result.status === 'error') throw new Error(`transcription error: ${result.error}`);
const elapsed = (Date.now() - t0) / 1000;
console.log(`*** AssemblyAI total: ${elapsed.toFixed(1)}s for ${acc.toFixed(0)}s of speech ***`);
console.log(`*** local Whisper, same audio: 176s ***\n`);

const words = (result.words || []).map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }));
console.log(`words returned: ${words.length}`);

// The whole question: does it emit disfluencies at all?
const DIS = /^(um|uh|uhh|umm|er|erm|mm|hmm)[.,!?]?$/i;
const dis = words.filter((w) => DIS.test(w.text));
console.log(`\n=== DISFLUENCIES ("um"/"uh"/...) RETURNED: ${dis.length} ===`);
console.log(`local Whisper found: 0`);
if (dis.length) {
  const secs = dis.reduce((s, w) => s + (w.end - w.start), 0);
  console.log(`their total duration: ${secs.toFixed(1)}s in this ${acc.toFixed(0)}s sample`);
  console.log('first 15:', dis.slice(0, 15).map((w) => `"${w.text}"@${w.start.toFixed(1)}s`).join('  '));
}

// Lexicon matches, mapped back per turn onto timeline time.
let phraseCount = 0, phraseSec = 0;
for (const { concatStart, turn } of offsets) {
  const dur = turn.end - turn.start;
  const inTurn = words
    .filter((w) => w.start >= concatStart - 0.05 && w.start < concatStart + dur + 0.05)
    .map((w) => ({ text: w.text, start: w.start - concatStart + turn.start, end: w.end - concatStart + turn.start }));
  if (!inTurn.length) continue;
  for (const c of findFillerCandidates(inTurn, [turn], DEFAULT_FILLER_LEXICON)) {
    phraseCount++; phraseSec += c.end - c.start;
  }
}
console.log(`\n=== LEXICON PHRASE MATCHES: ${phraseCount} (${phraseSec.toFixed(1)}s) ===`);
console.log('local Whisper found: 6 (3.3s)');

const disSec = dis.reduce((s, w) => s + (w.end - w.start), 0);
const totalSec = disSec + phraseSec;
console.log(`\n=== BOTTOM LINE ===`);
console.log(`removable in this ${acc.toFixed(0)}s sample: ${totalSec.toFixed(1)}s`);
console.log(`extrapolated to the full 1965s episode: ~${(totalSec * 1965 / acc).toFixed(0)}s (~${(totalSec*1965/acc/60).toFixed(1)} min)`);
console.log(`dead air already removes: 147s (2.4 min), no API`);
console.log(`\naudio_duration billed: ${result.audio_duration}s`);
