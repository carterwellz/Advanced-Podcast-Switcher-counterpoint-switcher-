/*
 * Every control the panel exposes, declared once.
 *
 * The tools this replaces ship dials named "Delay Cuts", "Ignore Small", "Smoothing"
 * and "Force Cuts" with no units and no explanation. Every entry here carries a
 * plain-English label, the unit it is measured in, and one line saying what it
 * actually does. If a setting cannot be explained in one line it does not belong.
 */
var CPSW_SETTINGS = [
  /* ---------------- wide shot ---------------- */
  {
    group: 'wide', key: 'wideBudgetPct', type: 'range',
    label: 'Wide shot ceiling', unit: '%', min: 0, max: 60, step: 1, def: 15,
    help: 'Strict cap. Wide never exceeds this and is never padded out to reach it. Unlike a camera Target %, this only ever pushes wide down.'
  },
  {
    group: 'wide', key: 'wideMinSec', type: 'range',
    label: 'Shortest wide shot', unit: 's', min: 0.5, max: 6, step: 0.1, def: 1.5,
    help: 'Going wide for less than this reads as a flinch rather than a choice.'
  },
  {
    group: 'wide', key: 'wideMaxSec', type: 'range',
    label: 'Longest wide shot', unit: 's', min: 2, max: 30, step: 0.5, def: 8,
    help: 'Force a return to a tighter angle after this long on the wide.'
  },
  {
    group: 'wide', key: 'wideOnCrosstalk', type: 'check',
    label: 'Go wide on crosstalk', def: true,
    help: 'When three or more people talk at once nobody holds the floor, so show the room.'
  },
  {
    group: 'wide', key: 'wideOnPrompt', type: 'check',
    label: 'Go wide when a prompt lands', def: true,
    help: 'Show the room for a beat after the host finishes asking, before anyone answers.'
  },
  {
    group: 'wide', key: 'wideOnHandoffPct', type: 'range',
    label: 'Go wide when the speaker changes', unit: '%', min: 0, max: 100, step: 5, def: 60,
    help: 'How often a handoff between speakers goes to the room first. A preference, not a rule: it loses to a strong tight shot, and the ceiling above still caps the total. 0 turns it off.'
  },
  {
    group: 'wide', key: 'wideHandoffSec', type: 'range',
    label: 'How long to hold that handoff', unit: 's', min: 0.5, max: 5, step: 0.1, def: 2.0,
    help: 'The beat on the room before settling onto whoever just started talking. Minimum shot length still applies.'
  },
  {
    group: 'wide', key: 'wideBreatherPct', type: 'range',
    label: 'Wide breather frequency', unit: '%', min: 0, max: 40, step: 1, def: 12,
    help: 'How often a monologue cutaway becomes a longer look at the room instead of a quick tight cutaway. Meant to be rare. Still counts against the wide ceiling above.'
  },
  {
    group: 'wide', key: 'wideBreatherSec', type: 'range',
    label: 'Wide breather length', unit: 's', min: 2, max: 10, step: 0.5, def: 5.0,
    help: 'How long that occasional room shot runs, instead of the usual monologue cutaway length below.'
  },

  /* ---------------- reactions ---------------- */
  {
    group: 'reaction', key: 'reactEnabled', type: 'check',
    label: 'Cut to audible reactions', def: true,
    help: 'A laugh, scoff or "that’s not true" on a listener’s own mic cuts to that listener.'
  },
  {
    group: 'reaction', key: 'reactSensitivity', type: 'range',
    label: 'Reaction sensitivity', unit: 'dB', min: 1, max: 20, step: 1, def: 6,
    help: 'How far above the speech gate a burst must peak to count. Lower catches more, including coughs.'
  },
  {
    group: 'reaction', key: 'reactMinSec', type: 'range',
    label: 'Shortest reaction shot', unit: 's', min: 0.4, max: 4, step: 0.1, def: 1.0,
    help: 'How long to hold on the reactor before returning to the speaker.'
  },
  {
    group: 'reaction', key: 'reactMaxSec', type: 'range',
    label: 'Longest reaction shot', unit: 's', min: 0.6, max: 8, step: 0.1, def: 2.5,
    help: 'Upper bound, so a reaction never turns into a scene.'
  },
  {
    group: 'reaction', key: 'reactCooldownSec', type: 'range',
    label: 'Minimum gap between reaction cuts', unit: 's', min: 0, max: 120, step: 1, def: 25,
    help: 'Stops a lively listener from taking over the edit.'
  },
  {
    group: 'reaction', key: 'reactAfterFloorSec', type: 'range',
    label: 'Only react once someone has talked for', unit: 's', min: 0, max: 60, step: 1, def: 15,
    help: 'Reactions earn their place during a monologue. During a fast exchange the cut should follow the argument instead.'
  },
  {
    group: 'reaction', key: 'opposingBiasPct', type: 'range',
    label: 'Prefer the opposing side', unit: '%', min: 0, max: 100, step: 5, def: 75,
    help: 'How strongly reactions and forced cutaways favour the other side of the debate, the whole premise of the show. Not all-or-nothing: at 75%, up to a quarter of reactions and a quarter of forced cutaways may still land on the speaker’s own side, so it stays mostly the other side without being robotic about it. 100% is strictly opposing, never the speaker’s own side.'
  },
  {
    group: 'reaction', key: 'interruptEnabled', type: 'check',
    label: 'Cut to interruptions', def: true,
    help: 'When someone breaks in and takes the floor, be on them as it happens.'
  },
  {
    group: 'reaction', key: 'monologueSec', type: 'range',
    label: 'Break up monologues after', unit: 's', min: 5, max: 120, step: 5, def: 30,
    help: 'One person talking longer than this forces a cutaway to somebody listening.'
  },
  {
    group: 'reaction', key: 'monologueCutawaySec', type: 'range',
    label: 'Monologue cutaway length', unit: 's', min: 0.5, max: 6, step: 0.1, def: 2.0,
    help: 'How long that forced cutaway lasts before returning to the speaker.'
  },

  /* ---------------- pacing ---------------- */
  {
    group: 'pacing', key: 'minShotSec', type: 'number',
    label: 'Minimum shot length', unit: 's', min: 0.5, max: 30, step: 0.1, def: 1.8,
    help: 'No shot is ever shorter than this, whatever else the audio says. This one is absolute.'
  },
  {
    group: 'pacing', key: 'maxShotSec', type: 'number',
    label: 'Maximum shot length', unit: 's', min: 2, max: 120, step: 0.5, def: 30,
    help: 'After this long on one angle, cut somewhere. Soft: splitting needs room for a cutaway plus a fresh minimum shot, so a few long runs survive rather than producing a flash.'
  },
  {
    group: 'pacing', key: 'cutDelayMs', type: 'range',
    label: 'Cut delay after speech starts', unit: 'ms', min: 0, max: 600, step: 10, def: 150,
    help: 'Cutting a beat late feels human. Cutting exactly on the first syllable feels robotic.'
  },
  {
    group: 'pacing', key: 'ignoreShorterSec', type: 'range',
    label: 'Ignore speech shorter than', unit: 's', min: 0, max: 3, step: 0.1, def: 0.6,
    help: 'Below this a burst is treated as a reaction, not as taking the floor.'
  },
  {
    group: 'pacing', key: 'holdThroughPauseSec', type: 'range',
    label: 'Hold shot through pauses under', unit: 's', min: 0, max: 3, step: 0.05, def: 0.35,
    help: 'Someone drawing breath should not lose the shot.'
  },
  {
    group: 'pacing', key: 'returnCooldownSec', type: 'range',
    label: 'Wait before reusing a cutaway camera', unit: 's', min: 0, max: 180, step: 5, def: 60,
    help: 'Only applies to forced monologue and max-length cutaways, not ordinary speaker-following. Stops every cutaway on a side landing on the same camera and person, cycling through the others on that side instead.'
  },
  {
    group: 'pacing', key: 'snapToPause', type: 'check',
    label: 'Land cuts in natural pauses', def: true,
    help: 'Nudge a cut into a nearby silence so it reads as intentional.'
  },
  {
    group: 'pacing', key: 'sameCameraPenalty', type: 'check',
    label: 'Avoid cutting between crops of one camera', def: true,
    help: 'Two crops of the same sensor cut together look like a jump cut.'
  },

  /* ---------------- output ---------------- */
  {
    group: 'output', key: 'workOnDuplicate', type: 'check',
    label: 'Work on a duplicate sequence', def: true,
    help: 'Premiere has no reliable scripted undo, so the original is left untouched.'
  },
  {
    group: 'output', key: 'method', type: 'select',
    label: 'How unused shots are removed', def: 'disable',
    options: [
      { value: 'disable', label: 'Disable clips (reversible)' },
      { value: 'delete', label: 'Delete clips (smaller project)' }
    ],
    help: 'Picture is identical either way. Disabling keeps every option on the timeline.'
  },
  {
    group: 'output', key: 'trimDeadAir', type: 'check',
    label: 'Trim dead air', def: false,
    help: 'Ripple out long pauses across every track together, so sync is preserved.'
  },
  {
    group: 'output', key: 'deadAirSec', type: 'range',
    label: 'Trim pauses longer than', unit: 's', min: 0.3, max: 8, step: 0.1, def: 1.5,
    help: 'Only silence longer than this is removed.'
  },
  {
    group: 'output', key: 'deadAirPadMs', type: 'range',
    label: 'Room tone left around a dead-air cut', unit: 'ms', min: 0, max: 500, step: 10, def: 150,
    help: 'A pause trimmed flush to its own edge reads as a dropout, not a cut. This much of the silence survives on each side.'
  },
  {
    group: 'output', key: 'trimFillerWords', type: 'check',
    label: 'Trim filler words', def: false,
    help: '"Um", "you know", "I just think" and similar disposable words, found by transcribing each speaker and matched against a curated list. Always reviewed before anything is cut — never applied silently.'
  },
  {
    group: 'output', key: 'fillerPadMs', type: 'range',
    label: 'Trim margin around a filler word', unit: 'ms', min: 0, max: 200, step: 5, def: 40,
    help: 'Shrinks the cut in from the transcript’s own word boundary, so an imprecise timestamp nibbles the filler word rather than the real word next to it.'
  }
];

function cpswDefaultSettings() {
  var out = {};
  for (var i = 0; i < CPSW_SETTINGS.length; i++) {
    out[CPSW_SETTINGS[i].key] = CPSW_SETTINGS[i].def;
  }
  return out;
}

/*
 * Presets.
 *
 * The list above is the full control surface, and it is too much to walk through
 * before every episode. These bundle the settings that actually move together into
 * two choices. Anything not covered by a preset keeps its default and lives in
 * Advanced, where it can be ignored indefinitely.
 *
 * Touching a setting a preset owns flips that preset to "Custom" rather than
 * silently disagreeing with the label.
 */
var CPSW_PRESETS = {
  // Shot length is deliberately NOT in here. It used to be, which meant picking a
  // pace silently overwrote numbers the editor had typed. Pace now controls only how
  // eagerly the edit chases the conversation; how long a shot runs is an explicit
  // number the editor owns.
  //
  // returnCooldownSec used to be listed here too, back when it was unwired and this
  // was as good a place for it as any. It now governs something unrelated to pace
  // entirely (how long before a forced cutaway may reuse the same camera), so a
  // pace choice silently overwriting it would be the exact bug the comment above
  // already warns about, just for a different setting.
  pace: {
    label: 'Pace',
    help: 'How eagerly it chases the conversation.',
    options: [
      {
        value: 'relaxed', label: 'Relaxed',
        note: 'Lets a moment play. Slower to leave whoever is talking.',
        settings: {
          cutDelayMs: 200,
          holdThroughPauseSec: 0.5, ignoreShorterSec: 0.8
        }
      },
      {
        value: 'balanced', label: 'Balanced',
        note: 'The default. Follows the conversation without chasing it.',
        settings: {
          cutDelayMs: 150,
          holdThroughPauseSec: 0.35, ignoreShorterSec: 0.6
        }
      },
      {
        value: 'fast', label: 'Fast',
        note: 'Jumps on every exchange. Suits a heated argument.',
        settings: {
          cutDelayMs: 100,
          holdThroughPauseSec: 0.25, ignoreShorterSec: 0.4
        }
      }
    ]
  },
  reactions: {
    label: 'Reaction shots',
    help: 'How often it cuts to someone listening instead of talking.',
    options: [
      {
        value: 'off', label: 'Off',
        note: 'Follow the active speaker only.',
        settings: {
          reactEnabled: false, interruptEnabled: false, monologueSec: 120,
          reactCooldownSec: 60, reactAfterFloorSec: 30
        }
      },
      {
        value: 'some', label: 'Some',
        note: 'Only during a long monologue, and strictly from the other side.',
        settings: {
          reactEnabled: true, interruptEnabled: true, reactSensitivity: 10,
          reactCooldownSec: 40, reactMinSec: 1.0, reactMaxSec: 2.0, monologueSec: 45,
          reactAfterFloorSec: 25, opposingBiasPct: 100
        }
      },
      {
        value: 'balanced', label: 'Balanced',
        note: 'The default. Cuts to the other side once someone has been holding forth, with an occasional glance back to their own side.',
        settings: {
          reactEnabled: true, interruptEnabled: true, reactSensitivity: 6,
          reactCooldownSec: 25, reactMinSec: 1.0, reactMaxSec: 2.5, monologueSec: 30,
          reactAfterFloorSec: 15, opposingBiasPct: 75
        }
      },
      {
        value: 'lots', label: 'Lots',
        note: 'Cuts away often, and will take a reaction from either side.',
        settings: {
          reactEnabled: true, interruptEnabled: true, reactSensitivity: 4,
          reactCooldownSec: 10, reactMinSec: 0.8, reactMaxSec: 3.0, monologueSec: 18,
          reactAfterFloorSec: 6, opposingBiasPct: 40
        }
      }
    ]
  }
};

/** Every setting key any preset controls, so edits to them can flip it to Custom. */
function cpswPresetKeys(name) {
  var keys = {};
  var opts = CPSW_PRESETS[name].options;
  for (var i = 0; i < opts.length; i++) {
    for (var k in opts[i].settings) keys[k] = true;
  }
  return keys;
}

/** Which preset option the current settings match, or 'custom'. */
function cpswDetectPreset(name, settings) {
  var opts = CPSW_PRESETS[name].options;
  for (var i = 0; i < opts.length; i++) {
    var match = true;
    for (var k in opts[i].settings) {
      if (settings[k] !== opts[i].settings[k]) { match = false; break; }
    }
    if (match) return opts[i].value;
  }
  return 'custom';
}

function cpswApplyPreset(name, value, settings) {
  var opts = CPSW_PRESETS[name].options;
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].value !== value) continue;
    for (var k in opts[i].settings) settings[k] = opts[i].settings[k];
    return opts[i];
  }
  return null;
}
