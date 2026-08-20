# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An audio-driven multicam switcher for Adobe Premiere Pro, built for the Counterpoint
Studios YouTube channel. It reads isolated per-person mic tracks, works out who is
speaking and who is reacting, plans a cut, and writes it to the timeline.

The full design rationale lives in `C:\Users\carte\.claude\plans\what-up-what-do-peppy-cocke.md`.
Read it before changing planner behaviour.

## Commands

```bash
npm test                  # node --test against test/*.test.ts
npm run typecheck         # tsc --noEmit over src and test
npm run build             # tsc -p tsconfig.build.json, emits dist/ (the panel runs dist/, not src/)
npm run analyze -- <args> # tsx src/cli/analyze.ts, standalone analysis without Premiere
```

Run a single test by name:

```bash
node --import tsx --test --test-name-pattern "wide shot stays under its ceiling" test/constraints.test.ts
```

Tests run through `tsx`, not Node's `--experimental-strip-types`: type stripping does not
resolve the `.js` specifiers in the source to their `.ts` files, so the imports fail.

**The tests read real media off `R:\EPISODE 29 Entrepreneurs vs 9-5\...` and will fail
if that drive is not mounted.** This is deliberate. The gate was tuned against real
room tone and synthetic audio would not have caught the bug it was written to prevent.
First run costs about 15 seconds for ffmpeg extraction, then `.cache/envelopes/` makes
reruns instant.

**After changing anything under `src/`, run `npm run build`.** The panel spawns
`dist/cli/run-plan.js`, so an unbuilt change is invisible to it.

## Architecture

Three layers with one hard rule: **nothing under `src/` may import CEP, ExtendScript,
or anything Premiere-shaped.** The engine is plain TypeScript that takes file paths and
returns a cut plan. That is what makes it testable without Premiere open, and what
keeps a future UXP port confined to one layer.

```
cep/js/panel.js  ──spawns system Node──>  dist/cli/run-plan.js  ──>  src/core/*
      │                                          │
      │  <── reads <out>.json (stats, preview)    │
      │                                          │
      └──CSInterface.evalScript──> cep/jsx/host.jsx ──reads <out>.txt──> timeline
```

### Layer 1, signal (`src/core/envelope.ts`, `gate.ts`, `events.ts`, `analyze.ts`)

One ffmpeg pass per source file produces a 20ms RMS envelope in dBFS. The filter chain
is `asetnsamples` then `astats` then `ametadata=mode=print`, which gives exact hop
alignment without moving samples through JS. Cached on path plus size plus mtime plus
range plus hop.

`analyze()` is the entry point. It gates each track into turns, drops sub-minimum bursts
into reaction candidates, and derives overlaps, crosstalk and silence.

**The gate is two-pass and must stay that way.** Measuring a mic in isolation fails for
someone who barely speaks in the selected range: their own room tone becomes their
"speech" statistic and the gate opens on nothing. So every track is measured first, a
room-level speech reference is taken across all of them, and only then is each track
gated against both its own floor and that reference. A track peaking far below the room
is marked inactive and skipped with a warning rather than contributing garbage turns.

### Layer 2, planning (`src/core/planner.ts`)

The core IP, and the reason this exists rather than a purchased plugin. `planCuts()`
builds a segment lattice, scores every angle against every segment, and solves with
Viterbi dynamic programming across the whole sequence. Greedy per-segment picking is
what makes other tools' frequency dials not work.

Things that are easy to break here:

- **Share targets are reached by re-solving.** Solve, measure, bias, solve again. Target
  share is a target moved toward from either direction. The wide budget is a strict cap
  that only ever pushes wide down.
- **Max shot length is a soft ceiling with a bounded overshoot.** Splitting a long run
  costs a cutaway plus a fresh minimum-length shot, so a run with less than
  `maxShot + cutaway + minShot` of material cannot be split without creating a flash.
  When min and max collide, min wins. The test asserts that documented bound and an
  overshoot rate under 15%, not zero. Do not "fix" it to zero.
- **`normalize()` is the single owner of output invariants** (no gaps, no overlaps, tiles
  the range) and runs to a fixed point. Any new pass that reorders or splits cuts must
  run before it, not after.
- **Snapping to pauses may only pull a cut earlier,** never later, or it walks shots past
  the max.
- **`physicalCamera` is why this beats generic tools on this rig.** Several video tracks
  are crops of one sensor, and cutting between two of them reads as a jump cut. This is
  enforced in **two** places and needs both: a prohibitive transition cost in the solver,
  and `mergeSameCamera()` inside `normalize()`. The solver alone is not enough, because
  dropping a short run to satisfy the minimum makes its two neighbours adjacent and
  creates a pairing the solver never chose. A pure penalty is also not enough: it was 14,
  which stopped working the moment emission began scaling with duration, since the
  emission gap on a long turn runs past 100.
- **Emission is weighted by `sqrt(duration)`.** Without it a boundary sliver votes as
  loudly as a whole turn, and any preference living in a short window can never repay
  the cost of cutting there and back.
- **The wide carries `WIDE_SUBJECT_HANDICAP`.** It technically "shows the subject" on
  every segment because it shows everyone, which used to leave it a point or two from
  winning everywhere, so its share moved unpredictably whenever anything else changed.
  It now loses clearly when an individual is the subject and earns time from crosstalk,
  prompts and handoffs instead.
- **A setting must change scoring, not the lattice.** `wideOnHandoffPct` originally
  suppressed the handoff boundaries at 0, so moving the slider compared two different
  segmentations and the result was not monotonic. Boundaries are free when nothing wants
  to cut on them; add them unconditionally and dial only the bonus.
- **Any window shorter than `minShotSec` is a control that does nothing,** because the
  minimum-shot pass absorbs whatever it creates. Clamp such windows up to the minimum.
- **`max-shot` and `monologue-break` are separate reasons on purpose.** Both look away
  from the speaker, but one is the timer and one is the conversation. They shared a
  label once, which hid a 12s maximum producing a forced cutaway every 14 seconds and
  made the panel report those as reaction cuts.
- **`floorHolderAt` ties on which overlapping turn has itself been running long
  enough as of the query instant, not on total turn duration.** The old rule's
  stated purpose, protecting against a brief agreement noise stealing the floor, is
  already handled upstream: `gate.ts` keeps anything under `minTurnSeconds` out of
  `turns` entirely, it becomes a reaction candidate instead. Comparing total
  duration instead let an established monologue outlast a genuine same-side
  takeover for however long its own turn happened to keep running. Elapsed-since-
  start alone does not fix it either, since the earlier turn's elapsed time is
  bigger for almost the whole overlap purely from its head start; see
  `FLOOR_TAKEOVER_GRACE_SEC`.
- **`diversifyCutaways()` runs inside `normalize()`, after its length fixed-point
  loop has converged, followed by one more `mergeSameCamera()` pass.** It exists
  because two sibling cameras that score identically on a `monologue-break`/
  `max-shot` cutaway (same tightness, same opposing composition) tie-break to the
  same camera every time that exact tie recurs across an episode; the per-angle
  `bias` map used for wide-budget/target-share convergence cannot fix this, since
  those segments are all close to the same duration and a bias delta big enough to
  flip one tied instance flips essentially all of them at once. It only ever
  reassigns `angleId`/`videoTrackIndex`, never `start`/`end`, so it cannot create a
  length violation, but it can create a new same-camera adjacency, which is why the
  trailing merge exists.
- **A `wideBreather`-flagged cut must never enter `diversifyCutaways()`'s rotation
  or its same-side quota.** The flag has to survive every merge
  (`pathToCuts()`'s run collapse, `joinAdjacent()`, `mergeSameCamera()`) or the two
  features, both on by default and both touching `monologue-break` cuts, silently
  fight: diversify would rotate a deliberately-chosen breather back to a tight shot
  the moment it is stale.
- **`returnCooldownSec` is scoped to monologue-break/max-shot cutaway reuse only,
  not ordinary speaker-follow cuts,** and is not part of the `pace` preset. It was
  fully unwired before `diversifyCutaways()` gave it a job, so there was no
  existing behaviour to preserve when its meaning changed. Applying a time cooldown
  to normal camera choice would force the wrong camera onto a genuinely fast
  back-and-forth exchange just because it was used a few seconds ago for something
  else, and pace controlling it would mean a "Fast" preset silently zeroing out
  cutaway rotation as a side effect of an unrelated choice.
- **The same-side quotas and the wide-breather quota use opposite bootstrap
  rules on purpose.** `pickReactions()` and `diversifyCutaways()` each admit their
  first same-side candidate unconditionally: it is a ceiling on a majority pool
  (`opposingBiasPct`), and refusing the first candidate before any opposing one has
  landed would make the ceiling unreachable rather than stricter. The wide-breather
  quota in `applyMonologueBreaks()` never bootstraps its first candidate: it is
  selecting a sparse minority from zero, and bootstrapping would front-load a
  breather onto whichever monologue-break happens to occur first, the opposite of
  rare. Matching one rule to the other is a bug, not a simplification.
- **`reactOpposingOnly` is gone. Do not re-add a hard boolean gate for same-side
  reactions or cutaways.** It is replaced by two independent running-ratio quotas,
  one in `pickReactions()` for genuine reactions and one in `diversifyCutaways()`
  for forced monologue-break/max-shot cutaways, both driven by `opposingBiasPct`
  and each tracked with its own counters, since the two are different populations
  of cuts at different moments and sharing counters would make either ratio jumpy.

### Layer 3, timeline write (`cep/jsx/host.jsx`)

Every camera lives on its own full-length video track. The plugin razors and then sets
`trackItem.disabled`. Premiere composites the topmost enabled clip, so a disabled clip
lets the track below show through. `V1` is the wide, which means **wide is the structural
default**: it is whatever shows when everything above is off. The planner has to place it
deliberately, not inherit it.

Verified on this machine, do not re-derive:

- `trackItem.disabled` is a real settable boolean.
- QE `razor()` works and takes **timecode strings**, not seconds.
- `sequence.clone()` works and auto-activates the copy, but **returns an object this build
  will not let you read** (`.name` throws, `.sequenceID` is undefined). Ignore the return
  value and re-read `app.project.activeSequence`.
- An unset `getInPoint()` returns `-400000`.
- The sequence is 23.976 fps. `cpswTimecode()` converts using the **actual** rate for the
  frame number and the **nominal** rate (24) for non-drop counting. Mixing them agrees
  near zero and drifts about 2.4 seconds by minute 40.

ExtendScript here is ES3: no `JSON`, no `let`/`const`, no array extras. That is why
`cpswApplyPlan` reads a **line-oriented directive file** rather than JSON:

```
MODE disable
DUPLICATE 1
RANGE 1200.0000 1800.0000
KEEP 1 1200.0000 1210.4000
```

### Layer 4, panel (`cep/js/`, `cep/index.html`)

`settings.js` is a declarative array of setting definitions, every one carrying a label,
a unit and a one-line explanation. `panel.js` renders from it. Presets (`CPSW_PRESETS`)
map a few plain-English choices onto the full set, so the quick path does not require
touching all 27 controls. Adding a setting means adding one entry to that array plus one
line in the mapping below.

**The three balance measures have different denominators**, and conflating them is how
the panel ended up looking wrong. `talkShare` is share of the range spent talking (lands
near 100% across everyone, not exactly on it, because of silence and overlap).
`screenShare` is fraction of runtime visible and sums to ~450% on a group-shot rig,
because four people accrue the same shot. `seenWhenTalking` is the only one that answers
"is this person being missed", because it is measured against that person's own speaking
time. Never present screen share and talk share as directly comparable.

**Re-rendering on `input` breaks sliders.** `renderQuick()` rebuilds the DOM, so calling
it from a range's `input` handler replaces the element under the cursor mid-drag and the
control feels dead. Update state on `input`, re-render on `change`.

**Templates carry the roster; settings are preferences.** A template is speakers plus
cameras. Every setting persists to `%APPDATA%\CounterpointSwitcher\settings.json`
(deliberately beside the templates folder, not inside it, or it would appear in the
template dropdown) and survives template switches, project changes and restarts.
Templates used to always carry the whole settings object, which meant loading a roster
silently replaced tuning being converged on across episodes. Every settings write goes
through `settingChanged()` so persistence cannot be forgotten at one of the eight
controls that can change one.

A template *may* pin settings, opt in via the `tplIncludeSettings` checkbox, off by
default. Loading such a template applies them and re-saves prefs, so the template's
values become the working baseline. **Only `version >= 2` files are trusted for this**:
v1 files always carried settings whether or not that was wanted, so honouring them would
resurrect exactly the behaviour this replaced.

Note that "Set the look" is a *view* onto the same values Advanced shows, not a separate
tier, so there is no coherent way to save one without the other. That is why the opt-in
is all-or-nothing.

**Refresh reconciles, it does not rebuild.** The track list and the clips on it belong to
the sequence and are always re-read; names, sides, chip tagging, shot types and camera
ids are the editor's and are matched forward on track index. Rebuilding from scratch is
a separate button, because Refresh is what you press to ask whether the in and out
points moved, and that must not cost you the roster. Note `refresh(rebuild)` takes an
argument, so never pass it straight to `addEventListener` (the click Event is truthy).

`src/cli/config-bridge.ts` holds `toGateConfig()`, and `src/cli/run-plan.ts` holds
`toPlannerConfig()` beside it, **the single place the panel's vocabulary and the
engine's vocabulary meet.** Everything above that line can be renamed, regrouped or
re-presented without touching the engine, as long as the keys survive.
`detect-trim.ts` imports the same `toGateConfig()` rather than defining its own, so
dead-air detection and the camera-cut plan can never disagree about what counts as a
pause.

The panel is symlinked into `%APPDATA%\Adobe\CEP\extensions\CounterpointSwitcher`, so
edits to `cep/` are live on panel reload. `PlayerDebugMode=1` is already set on CSXS 10,
11 and 12.

**Reload loop.** `cep/.debug` exposes DevTools on port 8088 (8860 and 8861 were already
taken by Phantom, Echoe Scribe and AutoCut). With the panel open, browse to
`http://localhost:8088`, click the panel, and Ctrl+R reloads the changed JS without
restarting Premiere. Closing and reopening the panel from the Window menu does not
reliably drop the CEF instance, so it is not a substitute. That DevTools console is also
the only place `panel.js` exceptions are visible.

### Dead air trim and filler-word trim (`src/core/trim.ts`, `filler.ts`, `transcribe.ts`, `src/cli/detect-trim.ts`, `build-trim-plan.ts`)

The first thing this plugin has ever done that removes time from the timeline rather
than choosing which camera is up. Two independent toggles, `trimDeadAir` and
`trimFillerWords`, both off by default; with both off, `preview()` in `panel.js` takes
the exact code path it took before either existed, and none of this code runs.

**Sequential physical pass, not simulated coordinate math.** When a toggle is on, the
panel duplicates the sequence once, physically ripple-deletes the removal spans on that
duplicate, re-reads it via the existing `cpswReadSequence()`/`applySequence()` (a
ripple-delete does not change track indices, only clip start/end/inPoint, so the
reconciliation Refresh already does is exactly right here), and only then runs the
**entirely unmodified** `analyze()` → `planCuts()` → apply-KEEP flow against the
already-shorter sequence. `analyze.ts` and `planner.ts` needed zero changes for either
feature. The alternative (plan cuts in a simulated trimmed-time coordinate space, then
convert back) was considered and rejected: it would put a new, easy-to-get-wrong
coordinate-remap layer directly in front of the most heavily-tuned code in the repo, to
save one extra `analyze()` pass that costs seconds, not minutes, because
`extractFileEnvelope()`'s cache key hashes on file identity, not timeline position.

**The two removal-interval sources are detected together, applied once.** `detect-trim.ts`
writes `<outBase>.trim.json`: `analysis.silences` verbatim for dead air, and (if
`trimFillerWords`) transcribed-and-lexicon-matched candidates for filler words, both
still just candidates, nothing padded or merged yet. Filler candidates go through a
review card in the panel (dead air does not: it is pure silence, no wording risk, and
gets no review of its own). `build-trim-plan.ts` is deliberately separate and much
faster: it turns whichever dead-air intervals plus approved filler spans exist into
`<outBase>.trim.txt` via `src/core/trim.ts`'s pure interval math, and never
re-transcribes anything, so toggling a checkbox in review and rebuilding the plan is
instant.

**Ripple-delete ordering is TypeScript's job, not ExtendScript's.** `REMOVE` lines in
`<outBase>.trim.txt` are written in descending order by start time
(`sortDescendingForRipple()` in `trim.ts`), and `cpswApplyTrimPlan` in `host.jsx` applies
them top-to-bottom with no re-sorting. This is not a style choice: removing the
rightmost remaining interval next means every interval still queued is entirely to the
left of everything already touched, so its absolute coordinates are still valid, and no
coordinate-remapping code has to exist in ExtendScript at all. Reversed, the second
removal's coordinates go stale the instant the first lands.

**The ripple is done by hand — razor every track, delete, then move by a computed
amount — because `extract()` is not reliable on this build. Do not go back to it.**
It was the original mechanism and it produced gaps on real episodes. Measured directly,
in order:

- Spans not on frame boundaries: a hole on **every** video cut.
- Frame-aligned but written through `toFixed(6)`: 49 holes per video track.
- Frame-aligned at full float precision: still 25 per track, every one exactly 1 frame.
- **Non-deterministic**: the identical 20-span input gave 2 gaps on one run and 10 on the
  next. That is what ruled it out for good.
- It holes video and audio at *different* rates (25 vs 10 on one run), so the two drift
  apart over an episode. This is the sync bug, not a cosmetic one.
- Pre-razoring every track and then calling `extract()` changed nothing.

What replaced it (`cpswRazorAllTracks` + `cpswRippleTrack`), and why each part matters:

1. **Razor every video and audio track at every boundary first**, from ONE
   `cpswTimecode()` string per instant. This is scripted "Add Edit to All Tracks": one
   timecode names one frame, so no track can disagree about where the edit is.
2. **Delete the isolated pieces walking backwards**, so removing an item cannot
   invalidate the indices still to be visited.
3. **Move each survivor left by `cpswRemovedBefore()`, walking forwards**, so the clip
   to the left has already moved and left room. `TrackItem.move()` takes a relative
   delta and was verified frame-exact (48.000 frames asked, 48.000 delivered). Note it
   can **throw while still moving correctly**, so its return value is deliberately
   ignored and the result is verified by measuring sequence length instead.

Verified on the real 98-span Episode 30 plan: **0 gaps on all 5 video and all 6 audio
tracks**, 174.132s removed against 174.13s planned, every audio track and V1/V2 ending
on the identical frame.

Spans still must be frame-aligned before they get here (`snapIntervalsToFrames()` in
`trim.ts`) and written at **full float precision, never `toFixed()`** — at 23.976fps a
frame edge is a repeating decimal and rounding it moves the cut off the frame.

Superseded, kept because the reasoning still holds for anything else reaching for QE:
`TrackItem.remove(true, false)` does **not** ripple on this build despite its argument
names, confirmed via `spikes/probe-ripple.jsx`.

**Historical: the original `extract()` investigation**, still accurate about that API's
existence and about `setInPoint`/`setOutPoint` semantics, retained for context: Three
spikes, in order, each run for real against a disposable duplicate before being trusted:

1. `spikes/probe-ripple.jsx` found DOM `TrackItem.remove(true, false)` does **not**
   ripple on this build, despite the argument names looking like it should — the clip
   after the removed one did not move at all. It also found `qeSequence.extract` exists
   as a real function (existence-checked only, not yet called).
2. `spikes/probe-extract.jsx` called it for real: set the sequence's work area with the
   standard DOM `seq.setInPoint()`/`setOutPoint()` (seconds, not ticks), then
   `qe.project.getActiveSequence().extract()` with **no arguments**. Every video track
   and every populated audio track shifted left by the same amount, in one call — a
   genuine sequence-wide ripple, not a per-track operation needing to be repeated
   manually across tracks.
3. `spikes/probe-apply-trim.jsx` ran the actual `cpswApplyTrimPlan` code (copied inline,
   since the bridge's ExtendScript engine is a separate context from the panel's own and
   does not share function definitions with it) against a real two-`REMOVE` plan file in
   the exact format `build-trim-plan.ts` produces. Both removals applied correctly, in
   the required descending-start-time order, on a fresh duplicate, for a total removed
   duration matching what was asked for within ordinary frame-quantization tolerance.

Sequence in/out points come back unset (`-400000`) after `extract()`, not advanced or
preserved — `cpswApplyTrimPlan` never relies on them past that point, only on the
`REMOVE` list it was given.

**`extract()` really does ripple the audio tracks, re-verified properly by
`spikes/probe-audio-ripple.jsx` after a real episode appeared not to.** Worth recording
how the original verification managed to be wrong: `probe-extract.jsx` measured the ripple
as "did the first clip *starting after* the removed span move left", and on this rig every
audio track is one full-length Auphonic clip, so no audio track has a clip starting after
anything and every one of them was silently skipped by that check. It passed on video only
because a previous camera-cut apply had already razored those tracks into pieces. **On a
single-clip track, measure the last clip's `end`, not the position of a following clip.**
The re-run confirms all five video and all seven populated audio tracks shift by the same
amount from one `extract()` call.

**A trim pass must never be able to conclude the whole range is dead air.** Four
independent guards exist because Episode 30 Part 2 produced exactly that, and every stage
was individually behaving as written:

- **`cpswReadSequence()` ignores in/out points that fall outside the sequence** and reports
  `inOutIgnored` so the range label can say so. A sequence made by duplicating and then
  shortening a longer one keeps the original's in/out points, which now sit past its own
  end. Premiere itself just ignores them, so nothing on screen looks wrong, but reading
  them back hands the engine a window containing no media at all. That is the root cause:
  the range was 7529-9857s on a 2328s sequence, every track measured silent, and the
  complement of "no speech anywhere" is the entire range.
- **`detect-trim.ts` returns zero dead-air intervals when `analysis.turns` is empty,** with
  a warning. Silence is only meaningful relative to speech; with no turns there is nothing
  to measure against, and the honest answer is zero candidates, not the whole episode.
- **`exceedsRemovalCeiling()` in `trim.ts` (`MAX_REMOVED_FRACTION = 0.5`)** makes
  `build-trim-plan.ts` refuse outright. It is a wrong-answer detector, not a taste control.
- **`cpswApplyTrimPlan` pre-flights every span against the sequence length *before*
  duplicating,** and afterwards judges by measured length change rather than by
  `extract()`'s return value. `extract()` returns truthy for a work area past the end of
  the sequence having removed nothing, so the old code duplicated, no-opped across every
  span, and reported success. Nothing downstream can tell a silent no-op from a real trim
  except by measuring.

**Filler-word transcription is AssemblyAI, and every local option was tried and
retired first. Do not re-litigate this without new evidence.** In order:

- **Parakeet TDT 0.6B v2** (bundled with Carter's dictation app, Vowen) was the original
  choice on paper, since `parakeet-cli.exe --timestamps` matched the requirement exactly.
  A direct spike (`spikes/probe-parakeet.mjs`) found it hangs indefinitely at 0% CPU under
  every invocation tried: different shells, different working directories, with and
  without its dependency DLLs on PATH. It almost certainly needs IPC with Vowen's own
  running app and does not work headless.
- **Local `whisper-cli.exe`** (Vowen's `ggml-medium.en.bin`) ran correctly and was shipped
  first, then measured and removed. Whisper is trained to emit clean readable transcripts
  and **silently drops disfluencies**: across five minutes of real Episode 30 speech it
  returned **zero** instances of "um" or "uh", which are the entire point of the feature.
  That is a property of the model, not of the plumbing, so no amount of batching fixes it.
  It was also spawned once per turn at ~9.5s of model load each, making 696 turns ~110
  minutes of pure startup for ~9 minutes of real compute.
- **`whisper-server.exe`** loads the model once and looked like the fix for that, but
  **does not return word-level timestamps**: `verbose_json` segments come back with no
  `start`/`end`, and `max_len=1` + `split_on_word` does not add them. Not usable.
- **AssemblyAI with `disfluencies: true`** is what shipped. Measured against local Whisper
  on identical audio: 8 disfluencies vs 0, 17 lexicon phrase matches vs 6, and 11s vs 176s.

Head-to-head on the full Episode 30 range, which is the number to reason from:

| | runtime | removes |
|---|---|---|
| dead air (local, no API) | 0.75s | **146.9s** |
| filler words (AssemblyAI) | 53s | 37.3s |

Filler-word trim is a polish pass worth about a quarter of dead air, so **dead air is the
feature that earns its keep and must never grow an API dependency.** `trimFillerWords`
stays off by default.

**All turns go up as ONE request, never one per turn.** `transcribeTurns()` concatenates
every turn into a single 16kHz mono WAV with a `SEPARATOR_SEC` silence between each, and
unpicks the response through an offset table. Cost here is dominated by per-request
overhead, not audio length: the same per-turn shape that made local Whisper take over an
hour would mean 696 round trips. Words landing inside a separator are dropped as
non-speech. Transcription stays scoped to `analysis.turns` rather than whole tracks, since
the gate has already found where people actually talk: 32.8 minutes of speech instead of
7 x 38.6 minutes of mostly silence and bleed.

**The API key lives in `.env` as `CPSW_ASSEMBLYAI_KEY`, gitignored, read by
`findApiKey()`.** The panel spawns these CLIs as plain child processes with no dotenv
preloading, so the file is read explicitly rather than assumed to be in the environment.
With `trimFillerWords` off, no key is read and **no audio ever leaves the machine** —
worth preserving, since this is unreleased episode audio.

**Filler detection is a curated lexicon match (`src/core/filler.ts`), never an ML
judgment call, across four tiers.** A false positive here deletes real dialogue, the one
outcome this feature exists to avoid, so every candidate has to be explainable in one
sentence: "it matched entry X in the lexicon" or "it burst more than N times in M
seconds," never a semantic guess about what a specific instance meant. The four tiers,
redesigned from real editing on Episode 30/31 (`you know` was landing correctly, which is
what prompted moving `like` from fully-excluded to frequency-gated rather than leaving it
out):

1. **`autoCut`** (`um`, `uh`, `uhh`, `erm`, `ah`, `er`) — real disfluencies with no
   plausible literal reading, cut without landing in the review card at all. `panel.js`
   folds these into the removal set the same way it already does dead air.
2. **`review`** (`you know`, `I mean`, `sort of`, `kind of`, `so yeah`, `I just think`,
   `if that makes sense`, `basically`) — single words or exact phrases, matched by the
   same longest-match-wins scan as before, always surfaced for a human decision.
3. **`contextGated`** (`well`, `right`, `actually`) — turn-initial-plus-pause, off by
   default, unchanged by this redesign.
4. **`thresholdGated`** (`like`, `so`) — the new mechanism. `like` is still never matched
   on lexicon membership alone: separating filler "like" ("it's, like, really important")
   from a real comparative use ("it's like this") is exactly the semantic judgment call
   this feature is built to avoid. What changed is the gate itself is no longer semantic —
   `findThresholdGatedCandidates()` in `filler.ts` flags a word only when a speaker bursts
   through it more than `minCount` (3) times within a `windowSec` (30) forward window, and
   flags *every* occurrence in a qualifying window, not just the one that tipped it over,
   so the whole crutch-word run is caught rather than only its tail. This runs across a
   speaker's **entire chronological word list**, not turn by turn like the other three
   tiers — a 30-second window routinely spans several of the short conversational turns
   this show produces, so a per-turn scan would systematically undercount and rarely fire.
   `so` moved here from `contextGated` for the same reason: gate on frequency, not position.

Multi-word phrases in the `review` tier are matched only as an exact contiguous sequence,
never a single word pulled from inside one, which is itself the safety mechanism. A turn
made entirely of filler tokens is never proposed for removal, unconditionally, across all
four tiers — including a threshold-flagged burst, so a turn that really is just "like"
repeated still gets excluded rather than auto-approved by volume.

**Padding direction differs between the two features on purpose.** `deadAirRemovalIntervals`
shrinks a silence inward so a little room tone survives on each side, avoiding a
vacuum-cut sound. `fillerRemovalIntervals` also insets inward, but for a different
reason: ASR word timestamps are accurate to tens of milliseconds, not frame-exact, and
the failure mode that matters is the cut boundary clipping into the *neighbouring real
word*, not leaving an inaudible fragment of the filler word itself. Both live in
`trim.ts` as thin wrappers over one shared `padInward()`, kept as two named functions
because the reasoning, and potentially the behaviour, can diverge later (a context-aware
dead-air pad is a real, named, deliberately deferred follow-up).

## Distribution to a second machine

The repo is private on GitHub at `carterwellz/counterpoint-switcher`, and a second
editor runs it on his own Windows machine. Two things follow from that.

**Nothing may hardcode a path off this machine.** `src/core/ffmpeg.ts` used to name
Carter's exact winget install directly, with a bare `'ffmpeg'` first in the candidate
list. That fallback was never a real check: the loop returned `'ffmpeg'` unconditionally
whenever nothing else matched, so a machine without ffmpeg installed did not fail in
`findFfmpeg()` with a message naming ffmpeg, it failed several layers down inside an
envelope extraction with a raw spawn ENOENT. Resolution is now explicit flag, then
`CPSW_FFMPEG`, then a real walk of PATH, then a scan of the winget Packages directory
(the version folder name changes with every build, so it has to be scanned rather than
named), then scoop/chocolatey/Program Files. `ffprobe` resolves independently rather than
by string-substituting the ffmpeg path, so a machine with them in different places works.
The remaining machine-specific paths are in `spikes/` and `test/constraints.test.ts`, and
both are deliberate: spikes are one-shot probes kept as evidence, and the test suite reads
real media off `R:` on purpose.

**`install.ps1` is the setup path, and README.md is the front door.** The installer checks
Node and ffmpeg, runs `npm install` and `npm run build`, sets `PlayerDebugMode` as a
**string** (CSXS ignores a DWORD) across CSXS 9 through 12, and junctions `cep/` into
`%APPDATA%\Adobe\CEP\extensions\CounterpointSwitcher`. It is a **junction, not a
symlink, so it does not need administrator rights**. Removing the link goes through
`[System.IO.Directory]::Delete($path, $false)` rather than `Remove-Item -Recurse`, which
can follow the junction and delete the repo behind it. The uninstall path refuses to
delete anything that is not a link.

`dist/` stays gitignored, so a fresh clone has no engine until `npm run build` runs. That
is what the installer is for, and it verifies `dist/cli/run-plan.js` actually landed
rather than trusting npm's exit code.

## Media quirk that will bite

Auphonic multitrack output is a **folder** named `<something>.wav` containing real mono
`Track N.wav` files. Premiere also reports a channel of a polyphonic WAV as a path whose
parent is a `.wav`. The two are indistinguishable by name, so `resolveMediaRef()` stats
the parent to tell them apart. Never infer from the extension.

## Working agreements

- Carter's video files and Premiere projects are read-only unless he says otherwise.
  Probes go in `spikes/` and run through the `MCPBridgeCEP` panel.
- No em dashes in anything he reads.
