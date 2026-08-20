# Counterpoint Switcher

An audio-driven multicam switcher for Adobe Premiere Pro, built for the Counterpoint
Studios YouTube channel.

It reads the isolated per-person mic tracks in your sequence, works out who is speaking
and who is reacting, plans a cut across the whole range at once, and writes it to the
timeline. It can also ripple out dead air and filler words before it cuts.

Windows only. It has only ever been run on Windows and the installer is PowerShell.

---

## What you need before installing

| | | |
|---|---|---|
| **Premiere Pro** | 2020 or newer (CEP host version 14.0+) | you already have this |
| **Node.js** | 18 or newer, on PATH | https://nodejs.org (LTS installer) |
| **ffmpeg** | any recent build | `winget install Gyan.FFmpeg` |
| **Git** | only if you want to pull updates | https://git-scm.com |

Both Node and ffmpeg must be findable from a normal terminal. After installing either
one, **open a new terminal** so PATH refreshes, then check:

```bash
node -v
```

```bash
ffmpeg -version
```

If `ffmpeg` is not on PATH the plugin will still find it in the usual winget, scoop,
chocolatey and `C:\ffmpeg` locations. If it lives somewhere unusual, set an environment
variable `CPSW_FFMPEG` to the full path of `ffmpeg.exe`.

---

## Install

Close Premiere Pro first. Then, from the folder you cloned this into, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

That script does five things, and prints what it did:

1. checks Node and ffmpeg are present
2. runs `npm install`
3. runs `npm run build`, which compiles `src/` into `dist/` (the panel runs `dist/`)
4. sets `PlayerDebugMode` for CSXS 9 through 12, which is what lets Premiere load an
   unsigned extension
5. links `cep/` into `%APPDATA%\Adobe\CEP\extensions\CounterpointSwitcher`

Start Premiere and open **Window > Extensions > Counterpoint Switcher**.

To remove it later: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall`

---

## Running an episode

Open the sequence first, then the panel.

**1. Refresh.** The panel reads the sequence: track list, clips, in and out points. Press
Refresh any time you change the in/out points. Refresh keeps your roster. **Rebuild**
throws the roster away and re-detects everything, which is what you want when you move to
a completely different show.

**2. Check the roster.** Two cards:

- **Speakers**, one row per audio track that has clips. Set each person's name and which
  **side** they are on. Side is what drives reaction shots toward the opposing party.
- **Cameras**, one row per video track. Click a name to toggle whether that person is
  visible on that camera. **Cam id** is which physical camera body the footage came off.
  Tracks that share a cam id are never cut against each other, because two crops of one
  sensor read as a jump cut. Two separate bodies covering the same side get different
  ids so they can still cut together. **Target %** is optional and auto is fine.

Save all of that as a **Template** once and reuse it every episode. A template stores the
roster only, not your settings, so tuning you land on persists across templates, projects
and restarts.

**3. Range.** Leave "Only cut between the sequence in and out points" on and set in/out in
Premiere. Everything outside the range is left untouched. Use this when camera assignments
change partway through: set in/out, remap the cameras, run, then move to the next stretch.

**4. Set the look.** Pace (Relaxed / Balanced / Fast) and a few plain-English choices.
Balanced is the default and is right for most episodes. Everything under **Advanced** is
ignorable for a normal episode.

**5. Preview cuts.** This runs the analysis and planning without touching the timeline.
First run on a range takes roughly 15 to 30 seconds while ffmpeg reads the audio. Later
runs on the same media are near instant because the envelopes are cached.

You get back a shot count, a cuts-per-minute figure, and a balance table. **The three
balance numbers have different denominators and are not comparable to each other:**

- **Talk share** is share of the range that person spent talking. Sums to near 100%.
- **Screen share** is fraction of runtime they were visible. Sums to well over 100% on a
  group-shot rig, because a wide shot shows four people at once.
- **Seen when talking** is the one that answers "is this person being missed", because it
  is measured against that person's own speaking time.

**6. Apply to timeline.** By default this works on a **duplicate** of the sequence, since
Premiere has no reliable scripted undo. The original is left alone.

---

## Dead air and filler word trim

Both are off by default. Both are under Advanced.

**Trim dead air** removes silence. It runs entirely on your machine, no network, and is
worth roughly 2.5 minutes on a 40 minute episode.

**Trim filler words** removes "um", "uh" and similar. This one **uploads the speech
portions of your audio to AssemblyAI** for transcription, so only turn it on if that is
acceptable for the material. It needs an API key: copy `.env.example` to `.env` and fill in
`CPSW_ASSEMBLYAI_KEY`. Every candidate except the obvious disfluencies lands in a review
card and nothing touches the timeline until you approve it.

With filler trim off, no key is read and no audio leaves the machine.

Both work by physically ripple-deleting on a duplicate first, then planning camera cuts
against the already-shortened sequence.

---

## Where your data lives

```
%APPDATA%\CounterpointSwitcher\settings.json    your settings, persisted
%APPDATA%\CounterpointSwitcher\templates\       your saved rosters
<repo>\.cache\envelopes\                        cached audio analysis, safe to delete
```

---

## Media layout it expects

Every camera on its own full-length video track. **V1 is the wide**, because the plugin
works by disabling clips on the tracks above and letting the track below show through, so
whatever is on V1 is the structural default.

Auphonic multitrack output is a **folder** named `<something>.wav` containing real mono
`Track N.wav` files inside it. That is handled, but it is worth knowing when you are
pointing Premiere at the audio in the first place.

---

## If something goes wrong

**The panel does not appear in Window > Extensions.** The install script did not finish, or
Premiere was open when it ran. Close Premiere, run `install.ps1` again, reopen Premiere.

**"Could not start Node. Is Node on PATH?"** Node is not installed, or it was installed
after Premiere was started. Install Node, then fully quit and restart Premiere, since it
inherits PATH at launch.

**"ffmpeg not found."** Install it with `winget install Gyan.FFmpeg`, open a new terminal to
confirm `ffmpeg -version` works, then restart Premiere. If it is installed somewhere
unusual, set `CPSW_FFMPEG` to the full path of `ffmpeg.exe`.

**"The engine did not produce a plan."** Usually means the range contains no readable
audio. Check that the in and out points are actually inside the sequence, and that the mic
tracks have clips on them.

**Everything measures as silent, or the whole range reads as dead air.** Almost always
in/out points inherited from a longer sequence that now sit past the end of this one. The
panel reports when it has ignored out-of-range in/out points. Clear them and set them again.

**Nothing else works.** The panel's own errors are only visible in its DevTools console.
With the panel open, browse to `http://localhost:8088` in Chrome, click the panel entry,
and you get a normal console. Ctrl+R there reloads the panel without restarting Premiere.

---

## For developers

```bash
npm test          # node --test against test/*.test.ts
npm run typecheck # tsc --noEmit over src and test
npm run build     # compiles src/ into dist/
```

**After changing anything under `src/`, run `npm run build`.** The panel spawns
`dist/cli/run-plan.js`, so an unbuilt change is invisible to it. Changes under `cep/` are
live on panel reload, because it is installed as a link.

The test suite reads real media off `R:\EPISODE 29 ...` and will fail without that drive
mounted. That is deliberate: the gate was tuned against real room tone and synthetic audio
would not have caught the bug those tests exist to prevent. On any other machine, expect
`constraints.test.ts` to fail and the rest to pass.

`CLAUDE.md` holds the full design rationale, including a long list of things that look
like bugs but are load-bearing. Read it before changing planner behaviour.
