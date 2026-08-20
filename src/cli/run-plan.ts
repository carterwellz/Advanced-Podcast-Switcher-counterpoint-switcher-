/*
 * The bridge between the panel and the engine.
 *
 * The panel spawns this with a config file and reads back a plan. It runs under the
 * system Node rather than CEP's bundled runtime, so the engine is not constrained by
 * whatever Node version Premiere happens to ship.
 *
 * Writes two outputs from one run:
 *   <out>.json  full plan and statistics, for the panel to display
 *   <out>.txt   KEEP directives, for ExtendScript to execute
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../core/analyze.js';
import { planCuts, type PlannerConfig } from '../core/planner.js';
import type { VideoAngle } from '../core/types.js';
import { bool, num, resolveSpeakers, toGateConfig, type PanelConfig } from './config-bridge.js';

function toPlannerConfig(s: PanelConfig['settings']): PlannerConfig {
  return {
    minShotSec: num(s.minShotSec, 1.8),
    maxShotSec: num(s.maxShotSec, 30),
    cutDelayMs: num(s.cutDelayMs, 150),
    returnCooldownSec: num(s.returnCooldownSec, 60),
    wideBudgetPct: num(s.wideBudgetPct, 15),
    wideMinSec: num(s.wideMinSec, 1.5),
    wideMaxSec: num(s.wideMaxSec, 8),
    wideOnCrosstalk: bool(s.wideOnCrosstalk, true),
    wideOnPrompt: bool(s.wideOnPrompt, true),
    wideOnHandoffPct: num(s.wideOnHandoffPct, 60),
    wideHandoffSec: num(s.wideHandoffSec, 2.0),
    wideBreatherPct: num(s.wideBreatherPct, 12),
    wideBreatherSec: num(s.wideBreatherSec, 5.0),
    reactEnabled: bool(s.reactEnabled, true),
    reactSensitivity: num(s.reactSensitivity, 6),
    reactMinSec: num(s.reactMinSec, 1.0),
    reactMaxSec: num(s.reactMaxSec, 2.5),
    reactCooldownSec: num(s.reactCooldownSec, 25),
    reactAfterFloorSec: num(s.reactAfterFloorSec, 15),
    opposingBiasPct: num(s.opposingBiasPct, 75),
    interruptEnabled: bool(s.interruptEnabled, true),
    monologueSec: num(s.monologueSec, 30),
    monologueCutawaySec: num(s.monologueCutawaySec, 2),
    snapToPause: bool(s.snapToPause, true),
    sameCameraPenalty: bool(s.sameCameraPenalty, true),
  };
}

async function main() {
  const configPath = process.argv[2];
  const outBase = process.argv[3];
  if (!configPath || !outBase) {
    console.error('usage: run-plan <config.json> <outputBasePath>');
    process.exit(2);
  }

  const cfg: PanelConfig = JSON.parse(readFileSync(configPath, 'utf8'));

  const speakers = resolveSpeakers(cfg);

  const angles: VideoAngle[] = cfg.angles.map((a) => ({
    id: a.id,
    name: a.name,
    videoTrackIndex: a.videoTrackIndex,
    shows: a.shows,
    shotType: a.shotType,
    physicalCamera: a.physicalCamera,
    targetShare: a.targetSharePct === null ? undefined : a.targetSharePct / 100,
  }));

  const analysis = await analyze(speakers, {
    gate: toGateConfig(cfg.settings),
    range: cfg.range,
    onProgress: (m) => console.error(m),
  });

  const plan = planCuts(analysis, angles, toPlannerConfig(cfg.settings));

  const speakerNames: Record<string, string> = {};
  for (const s of speakers) speakerNames[s.id] = s.name;
  const angleNames: Record<string, string> = {};
  for (const a of angles) angleNames[a.id] = a.name;

  writeFileSync(
    `${outBase}.json`,
    JSON.stringify(
      {
        ok: true,
        stats: plan.stats,
        warnings: [...analysis.warnings, ...plan.warnings],
        range: plan.range,
        speakerNames,
        angleNames,
        shotCount: plan.cuts.length,
        // A sample, not the whole plan: an episode is thousands of shots and the
        // panel only needs enough to show what the edit looks like.
        sample: plan.cuts.slice(0, 60),
      },
      null,
      2,
    ),
    'utf8',
  );

  const lines: string[] = [
    `MODE ${cfg.settings.method === 'delete' ? 'delete' : 'disable'}`,
    `DUPLICATE ${bool(cfg.settings.workOnDuplicate, true) ? 1 : 0}`,
    `RANGE ${plan.range.start.toFixed(4)} ${plan.range.end.toFixed(4)}`,
  ];
  for (const c of plan.cuts) {
    lines.push(`KEEP ${c.videoTrackIndex} ${c.start.toFixed(4)} ${c.end.toFixed(4)}`);
  }
  writeFileSync(`${outBase}.txt`, lines.join('\n'), 'utf8');

  console.error(`plan written: ${plan.cuts.length} shots`);
}

main().catch((e) => {
  const outBase = process.argv[3];
  if (outBase) {
    try {
      writeFileSync(
        `${outBase}.json`,
        JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2),
        'utf8',
      );
    } catch { /* fall through to the exit code */ }
  }
  console.error(e);
  process.exit(1);
});
