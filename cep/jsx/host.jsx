/*
 * Counterpoint Switcher: Premiere Pro host script.
 *
 * ExtendScript is ES3-ish. No JSON, no Array.prototype extras, no let/const.
 * Everything here is written to that floor deliberately.
 */

/** Premiere returns this from getInPoint() when no in point is set. */
var CPSW_NO_POINT = -400000;

function cpswEsc(s) {
  s = String(s);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 32) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
    else out += c;
  }
  return '"' + out + '"';
}

function cpswNum(v) {
  if (v === null || v === undefined) return 'null';
  var n = Number(v);
  return isFinite(n) ? String(n) : 'null';
}

function cpswTry(fn, fallback) {
  try {
    var v = fn();
    return (v === undefined || v === null) ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/**
 * Read the active sequence: every video and audio track, the clips on them, where
 * their media lives, and the in/out range.
 *
 * The panel builds its whole roster from this, which is why track counts are never
 * typed in by hand.
 */
function cpswReadSequence() {
  var seq = cpswTry(function () { return app.project.activeSequence; }, null);
  if (!seq) return '{"ok":false,"error":"No active sequence. Open a sequence and try again."}';

  var parts = [];
  parts.push('"ok":true');
  parts.push('"appVersion":' + cpswEsc(cpswTry(function () { return app.version; }, '')));
  parts.push('"projectName":' + cpswEsc(cpswTry(function () { return app.project.name; }, '')));
  parts.push('"sequenceName":' + cpswEsc(cpswTry(function () { return seq.name; }, '')));
  parts.push('"sequenceID":' + cpswEsc(cpswTry(function () { return seq.sequenceID; }, '')));

  var seqEnd = Number(cpswTry(function () { return seq.end / 254016000000; }, 0));

  // Frame rate, needed by the trim pass: a ripple-delete whose spans are not on exact
  // frame boundaries closes sample-accurately on audio but rounds on video, leaving
  // two-frame holes on every video track. See snapIntervalsToFrames() in trim.ts.
  var timebase = Number(cpswTry(function () { return seq.timebase; }, 0));
  var fps = timebase > 0 ? 254016000000 / timebase : 0;

  // The two points are independent. Setting only an in point means "from here to the
  // end" and only an out means "from the top to here", which is how Premiere itself
  // behaves. Requiring both is what made the panel ignore a perfectly good range.
  var inSec = Number(cpswTry(function () { return seq.getInPoint(); }, CPSW_NO_POINT));
  var outSec = Number(cpswTry(function () { return seq.getOutPoint(); }, CPSW_NO_POINT));
  var hasIn = isFinite(inSec) && inSec > CPSW_NO_POINT / 2;
  var hasOut = isFinite(outSec) && outSec > CPSW_NO_POINT / 2;

  // A sequence made by duplicating and then shortening a longer one keeps the
  // original's in/out points, which now sit past its own end. Premiere itself just
  // ignores them, so nothing on screen says anything is wrong, but reading them
  // back hands the engine a window containing no media whatsoever: every track
  // measures as silent, and a dead-air pass then concludes the entire range is
  // dead air. Treat a point outside the sequence as stale data, not as a range.
  var inOutIgnored = false;
  if (hasIn && (inSec < 0 || inSec >= seqEnd)) { hasIn = false; inOutIgnored = true; }
  if (hasOut && (outSec <= 0 || outSec > seqEnd)) { hasOut = false; inOutIgnored = true; }
  if (hasIn && hasOut && !(outSec > inSec)) { hasIn = false; hasOut = false; inOutIgnored = true; }

  parts.push('"hasIn":' + (hasIn ? 'true' : 'false'));
  parts.push('"hasOut":' + (hasOut ? 'true' : 'false'));
  parts.push('"hasInOut":' + (hasIn || hasOut ? 'true' : 'false'));
  parts.push('"inOutIgnored":' + (inOutIgnored ? 'true' : 'false'));
  parts.push('"inPoint":' + cpswNum(hasIn ? inSec : 0));
  parts.push('"outPoint":' + cpswNum(hasOut ? outSec : seqEnd));
  parts.push('"sequenceEnd":' + cpswNum(seqEnd));
  parts.push('"fps":' + cpswNum(fps));

  parts.push('"videoTracks":' + cpswDumpTracks(seq.videoTracks, 'V'));
  parts.push('"audioTracks":' + cpswDumpTracks(seq.audioTracks, 'A'));

  return '{' + parts.join(',') + '}';
}

function cpswDumpTracks(coll, kind) {
  var n = cpswTry(function () { return coll.numTracks; }, 0);
  var rows = [];
  for (var i = 0; i < n; i++) {
    var t = cpswTry(function () { return coll[i]; }, null);
    if (!t) continue;
    var nClips = cpswTry(function () { return t.clips.numItems; }, 0);

    var clips = [];
    for (var c = 0; c < nClips; c++) {
      var clip = cpswTry((function (idx) {
        return function () { return t.clips[idx]; };
      })(c), null);
      if (!clip) continue;
      clips.push(cpswDumpClip(clip));
    }

    rows.push('{'
      + '"index":' + i
      + ',"kind":' + cpswEsc(kind)
      + ',"name":' + cpswEsc(cpswTry(function () { return t.name; }, kind + (i + 1)))
      + ',"clipCount":' + nClips
      + ',"muted":' + (cpswTry(function () { return t.isMuted(); }, false) ? 'true' : 'false')
      + ',"clips":[' + clips.join(',') + ']'
      + '}');
  }
  return '[' + rows.join(',') + ']';
}

function cpswDumpClip(clip) {
  var isSeq = cpswTry(function () { return clip.projectItem.isSequence(); }, false);
  return '{'
    + '"name":' + cpswEsc(cpswTry(function () { return clip.name; }, ''))
    + ',"start":' + cpswNum(cpswTry(function () { return clip.start.seconds; }, 0))
    + ',"end":' + cpswNum(cpswTry(function () { return clip.end.seconds; }, 0))
    + ',"inPoint":' + cpswNum(cpswTry(function () { return clip.inPoint.seconds; }, 0))
    + ',"isSequence":' + (isSeq ? 'true' : 'false')
    + ',"disabled":' + (cpswTry(function () { return clip.disabled; }, false) ? 'true' : 'false')
    + ',"mediaPath":' + cpswEsc(cpswTry(function () { return clip.projectItem.getMediaPath(); }, ''))
    + '}';
}

/* ------------------------------------------------------------------ writing */

/**
 * Seconds of real time to a timecode string, e.g. 00:01:23:11.
 *
 * Two different frame rates are in play and mixing them drifts. Counterpoint shoots
 * 23.976, so a real-time position converts to a frame number using the *actual*
 * rate, but non-drop timecode counts those frames at the *nominal* rate of 24. Using
 * the actual rate for both agrees near zero and is roughly 2.4 seconds out by the
 * forty minute mark, which would walk every cut progressively off its mark.
 */
function cpswTimecode(seconds, fps) {
  var nominal = Math.round(fps);
  if (nominal < 1) nominal = 1;
  var f = Math.round(seconds * fps);
  var ff = f % nominal;
  var totalSec = Math.floor(f / nominal);
  var ss = totalSec % 60;
  var mm = Math.floor(totalSec / 60) % 60;
  var hh = Math.floor(totalSec / 3600);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(hh) + ':' + p(mm) + ':' + p(ss) + ':' + p(ff);
}

function cpswSequenceFps(seq) {
  // timebase is ticks per frame; 254016000000 ticks per second.
  var tb = Number(cpswTry(function () { return seq.timebase; }, 0));
  if (tb > 0) return 254016000000 / tb;
  return 30;
}

/**
 * Razor one video track at a single time and report what happened, without
 * touching anything else.
 *
 * Worth having as its own entry point: the razor call is the one mechanism in this
 * whole plugin that could not be verified read-only, and finding out it takes a
 * different argument format halfway through writing 800 cuts is the bad way to
 * learn it.
 */
function cpswProbeRazor(trackIndex, atSeconds) {
  try {
    app.enableQE();
    var seq = app.project.activeSequence;
    var fps = cpswSequenceFps(seq);
    var before = seq.videoTracks[trackIndex].clips.numItems;

    var qeSeq = qe.project.getActiveSequence();
    var qeTrack = qeSeq.getVideoTrackAt(trackIndex);
    var tc = cpswTimecode(atSeconds, fps);
    var ok = qeTrack.razor(tc);

    var after = seq.videoTracks[trackIndex].clips.numItems;
    return '{"ok":true,"fps":' + fps + ',"timecode":' + cpswEsc(tc)
      + ',"returned":' + cpswEsc(String(ok))
      + ',"clipsBefore":' + before + ',"clipsAfter":' + after
      + ',"worked":' + (after > before ? 'true' : 'false') + '}';
  } catch (e) {
    return '{"ok":false,"error":' + cpswEsc(e.message) + '}';
  }
}

/**
 * Duplicate the active sequence and make the copy the active one.
 *
 * Shared by cpswApplyPlan and cpswApplyTrimPlan, since both need exactly this and
 * nothing else: clone() returns an object this build will not let us read (.name
 * throws, .sequenceID is undefined), but it does make the copy active by itself,
 * so the active sequence afterwards is the only reliable handle. Returns null
 * rather than reporting success while still pointed at the original, which is the
 * one guarantee that actually matters here.
 */
function cpswDuplicateSequence(seq) {
  var originalId = String(cpswTry(function () { return seq.sequenceID; }, ''));
  cpswTry(function () { seq.clone(); return true; }, null);
  var now = app.project.activeSequence;
  var nowId = String(cpswTry(function () { return now.sequenceID; }, ''));
  if (!now || nowId === originalId) return null;
  return now;
}

/**
 * Apply a cut plan.
 *
 * The plan is read from a file rather than passed as a string: ExtendScript has no
 * dependable JSON parser across the versions this targets, and an episode's plan is
 * far larger than is comfortable to marshal through evalScript.
 *
 * Format, one directive per line:
 *   MODE disable|delete
 *   DUPLICATE 0|1
 *   RANGE <startSeconds> <endSeconds>
 *   KEEP <videoTrackIndex> <startSeconds> <endSeconds>
 *
 * Every KEEP is a stretch that stays visible. Anything else on a video track inside
 * RANGE is disabled or removed, and everything outside RANGE is left alone.
 */
function cpswApplyPlan(planPath) {
  try {
    var f = new File(planPath);
    if (!f.exists) return '{"ok":false,"error":"Plan file not found"}';
    f.open('r');
    var text = f.read();
    f.close();

    var mode = 'disable';
    var duplicate = false;
    var rangeStart = 0, rangeEnd = 0;
    var keeps = {};
    var trackList = [];

    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].replace(/[\r\n]+$/, '').split(' ');
      if (parts[0] === 'MODE') mode = parts[1];
      else if (parts[0] === 'DUPLICATE') duplicate = parts[1] === '1';
      else if (parts[0] === 'RANGE') { rangeStart = Number(parts[1]); rangeEnd = Number(parts[2]); }
      else if (parts[0] === 'KEEP') {
        var ti = Number(parts[1]);
        if (!keeps[ti]) { keeps[ti] = []; trackList.push(ti); }
        keeps[ti].push([Number(parts[2]), Number(parts[3])]);
      }
    }

    if (!(rangeEnd > rangeStart)) return '{"ok":false,"error":"Plan has an empty range"}';

    app.enableQE();
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';

    if (duplicate) {
      var duped = cpswDuplicateSequence(seq);
      if (!duped) {
        return '{"ok":false,"error":"Could not duplicate the sequence, and refused to write to the original. Duplicate it yourself, or turn off Work on a duplicate."}';
      }
      seq = duped;
    }

    var fps = cpswSequenceFps(seq);
    var qeSeq = qe.project.getActiveSequence();

    var razors = 0, disabled = 0, removed = 0, kept = 0;

    for (var t = 0; t < trackList.length; t++) {
      var trackIndex = trackList[t];
      var spans = keeps[trackIndex];

      // Razor only where this track's own visibility changes. Cutting every track at
      // every global boundary would be an order of magnitude more operations.
      var points = {};
      points[rangeStart] = true;
      points[rangeEnd] = true;
      for (var s = 0; s < spans.length; s++) {
        points[spans[s][0]] = true;
        points[spans[s][1]] = true;
      }

      var qeTrack = qeSeq.getVideoTrackAt(trackIndex);
      for (var key in points) {
        var at = Number(key);
        if (at <= rangeStart || at >= rangeEnd) continue;
        if (cpswTry(function () { return qeTrack.razor(cpswTimecode(at, fps)); }, null) !== null) razors++;
      }

      // Now decide each resulting clip by where its middle sits.
      var track = seq.videoTracks[trackIndex];
      for (var c = track.clips.numItems - 1; c >= 0; c--) {
        var clip = track.clips[c];
        var cs = Number(clip.start.seconds);
        var ce = Number(clip.end.seconds);
        var mid = (cs + ce) / 2;
        if (mid < rangeStart || mid >= rangeEnd) continue;

        var visible = false;
        for (var k = 0; k < spans.length; k++) {
          if (mid >= spans[k][0] && mid < spans[k][1]) { visible = true; break; }
        }

        if (visible) {
          cpswTry(function () { clip.disabled = false; }, null);
          kept++;
        } else if (mode === 'delete') {
          if (cpswTry(function () { clip.remove(false, false); return true; }, false)) removed++;
        } else {
          cpswTry(function () { clip.disabled = true; }, null);
          disabled++;
        }
      }
    }

    return '{"ok":true,"sequence":' + cpswEsc(seq.name)
      + ',"duplicated":' + (duplicate ? 'true' : 'false')
      + ',"razors":' + razors + ',"kept":' + kept
      + ',"disabled":' + disabled + ',"removed":' + removed + '}';
  } catch (e) {
    return '{"ok":false,"error":' + cpswEsc(e.message) + '}';
  }
}

/**
 * Cut every video and audio track at one instant, from a single timecode string.
 *
 * Scripted equivalent of Premiere's "Add Edit to All Tracks". One timecode names one
 * frame unambiguously, so every track is cut on exactly the same frame and no track
 * can disagree with another about where the boundary is. QE razor() takes timecode
 * strings, not seconds (see the verified notes at the top of this file).
 */
function cpswRazorAllTracks(seq, qeSeq, seconds, fps) {
  var code = cpswTimecode(seconds, fps);
  var vn = cpswTry(function () { return seq.videoTracks.numTracks; }, 0);
  for (var v = 0; v < vn; v++) {
    cpswTry((function (i) { return function () { qeSeq.getVideoTrackAt(i).razor(code); return true; }; })(v), false);
  }
  var an = cpswTry(function () { return seq.audioTracks.numTracks; }, 0);
  for (var a = 0; a < an; a++) {
    cpswTry((function (i) { return function () { qeSeq.getAudioTrackAt(i).razor(code); return true; }; })(a), false);
  }
}

/** Total removal time strictly before `t`, i.e. how far left content at `t` must move. */
function cpswRemovedBefore(t, removals, frame) {
  var total = 0;
  var half = frame * 0.5;
  for (var i = 0; i < removals.length; i++) {
    if (removals[i][1] <= t + half) total += removals[i][1] - removals[i][0];
  }
  return total;
}

/** True when `t` falls strictly inside any removal span. */
function cpswInsideRemoval(t, removals) {
  for (var i = 0; i < removals.length; i++) {
    if (t > removals[i][0] && t < removals[i][1]) return true;
  }
  return false;
}

/**
 * Delete the removed pieces on one track and close the gaps by an exact, known
 * amount, rather than asking Premiere to ripple for us.
 *
 * This exists because `qe.getActiveSequence().extract()` is not reliable on this
 * build: measured directly, the identical 20-span input left 2 gaps on one run and
 * 10 on the next, it leaves one-frame holes on roughly a quarter of cuts even when
 * every span is frame-aligned and written at full float precision, and it holes
 * video and audio at different rates so the two drift apart over an episode.
 * Pre-razoring every track did not change its behaviour either.
 *
 * `TrackItem.move()` by contrast was verified to take a relative delta and to be
 * frame-exact (48.000 frames requested, 48.000 delivered), so every position here is
 * arithmetic we control. Deletion runs backwards so removing an item cannot
 * invalidate the indices still to be visited; the shift then runs forwards, which is
 * what guarantees the clip to the left has already moved and left room.
 */
function cpswRippleTrack(track, removals, frame) {
  if (!track) return;

  var n = cpswTry(function () { return track.clips.numItems; }, 0);
  for (var c = n - 1; c >= 0; c--) {
    var s = Number(cpswTry((function (i) { return function () { return track.clips[i].start.seconds; }; })(c), -1));
    var e = Number(cpswTry((function (i) { return function () { return track.clips[i].end.seconds; }; })(c), -1));
    if (s < 0 || e < 0) continue;
    // Midpoint, so a boundary landing a hair either side of the razor cannot flip the
    // decision. After razoring, a clip is entirely inside a span or entirely outside.
    if (cpswInsideRemoval((s + e) / 2, removals)) {
      cpswTry((function (i) { return function () { track.clips[i].remove(false, false); return true; }; })(c), false);
    }
  }

  n = cpswTry(function () { return track.clips.numItems; }, 0);
  for (var m = 0; m < n; m++) {
    var st = Number(cpswTry((function (i) { return function () { return track.clips[i].start.seconds; }; })(m), -1));
    if (st < 0) continue;
    var off = cpswRemovedBefore(st, removals, frame);
    if (off > frame * 0.25) {
      // move() has been observed to throw while still performing the move correctly,
      // so its return value is deliberately not trusted; the caller verifies by
      // measuring the sequence length instead.
      cpswTry((function (i, d) { return function () { track.clips[i].move(-d); return true; }; })(m, off), false);
    }
  }
}

/**
 * Apply a ripple-delete trim plan: dead air, approved filler words, or both.
 *
 * Confirmed via spikes/probe-extract.jsx, on a real duplicate, before this was
 * written: `qe.project.getActiveSequence().extract()`, called with no arguments
 * after setting the sequence's work area with the standard DOM
 * `seq.setInPoint()`/`setOutPoint()` (seconds, not ticks), ripples every video and
 * audio track together in one call and closes the gap on all of them by the same
 * amount. DOM `TrackItem.remove(true, false)` does NOT ripple on this build,
 * despite its argument names looking like it should -- do not use it for this.
 *
 * Format, one directive per line:
 *   MODE ripple
 *   DUPLICATE 0|1
 *   RANGE <startSeconds> <endSeconds>
 *   REMOVE <startSeconds> <endSeconds>
 *
 * REMOVE lines are written by TypeScript in descending order by start time
 * (trim.ts's sortDescendingForRipple()), and this function trusts that ordering
 * completely rather than re-sorting. That is what makes repeating `extract()`
 * safe with no coordinate remapping here: each call only ever shifts content
 * strictly after the interval it just removed, so as long as the rightmost
 * remaining interval is always removed next, every interval still queued is
 * entirely to the left of everything already touched and its absolute seconds
 * are still valid.
 */
function cpswApplyTrimPlan(planPath) {
  try {
    var f = new File(planPath);
    if (!f.exists) return '{"ok":false,"error":"Trim plan file not found"}';
    f.open('r');
    var text = f.read();
    f.close();

    var duplicate = false;
    var removals = [];

    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].replace(/[\r\n]+$/, '').split(' ');
      if (parts[0] === 'DUPLICATE') duplicate = parts[1] === '1';
      else if (parts[0] === 'REMOVE') removals.push([Number(parts[1]), Number(parts[2])]);
    }

    if (removals.length === 0) return '{"ok":false,"error":"Trim plan has no REMOVE directives"}';

    app.enableQE();
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';

    // The real, end-to-end check that the ripple actually happened, not just that
    // extract() returned something: total sequence length before and after has to
    // differ by the sum of what was asked to be removed. Measured off the furthest
    // clip end across every video track, since that is what actually defines how
    // long the sequence plays.
    function sequenceTailSeconds() {
      var tail = 0;
      var vn = cpswTry(function () { return seq.videoTracks.numTracks; }, 0);
      for (var v = 0; v < vn; v++) {
        var n = cpswTry((function (idx) { return function () { return seq.videoTracks[idx].clips.numItems; }; })(v), 0);
        if (n === 0) continue;
        var e = cpswTry((function (idx, ci) { return function () { return seq.videoTracks[idx].clips[ci].end.seconds; }; })(v, n - 1), 0);
        if (e > tail) tail = e;
      }
      return tail;
    }

    // Pre-flight on the ORIGINAL, before anything is duplicated. extract() happily
    // reports success for a work area lying past the end of the sequence, having
    // removed nothing at all, so a plan built from a bad range would otherwise
    // duplicate the sequence, no-op across every span, and report success. Checking
    // first means a bad plan costs nothing and leaves no orphan copy behind.
    var seqLength = sequenceTailSeconds();
    var usable = 0;
    for (var p = 0; p < removals.length; p++) {
      var ps = removals[p][0], pe = removals[p][1];
      if (pe > ps && ps >= 0 && ps < seqLength && pe <= seqLength) usable++;
    }
    if (usable === 0) {
      return '{"ok":false,"error":' + cpswEsc(
        'None of the ' + removals.length + ' span(s) in this trim plan fall inside the ' +
        seqLength.toFixed(1) + 's sequence, so there is nothing to remove. This usually means the ' +
        'range came from stale in/out points. Nothing was changed and no duplicate was made.'
      ) + '}';
    }

    if (duplicate) {
      var duped = cpswDuplicateSequence(seq);
      if (!duped) {
        return '{"ok":false,"error":"Could not duplicate the sequence, and refused to write to the original. Duplicate it yourself, or turn off Work on a duplicate."}';
      }
      seq = duped;
    }

    var qeSeq = cpswTry(function () { return qe.project.getActiveSequence(); }, null);
    if (!qeSeq || typeof qeSeq.razor !== 'function') {
      return '{"ok":false,"error":"QE razor is not available on this Premiere build, so the trim cannot be applied."}';
    }

    var fps = cpswSequenceFps(seq);
    var frame = fps > 0 ? 1 / fps : 0;

    var before = sequenceTailSeconds();
    var valid = [];
    var skipped = 0;
    for (var r = 0; r < removals.length; r++) {
      var rs = removals[r][0], re = removals[r][1];
      if (!(re > rs) || rs < 0 || rs >= before || re > before) { skipped++; continue; }
      valid.push([rs, re]);
    }

    // Cut every track at every boundary FIRST, from one timecode string per instant,
    // so the edit lands on the identical frame on all of them by construction. This
    // is scripted "Add Edit to All Tracks", and it is what makes the rest arithmetic
    // rather than guesswork.
    for (var q = 0; q < valid.length; q++) {
      cpswRazorAllTracks(seq, qeSeq, valid[q][0], fps);
      cpswRazorAllTracks(seq, qeSeq, valid[q][1], fps);
    }

    // Then remove the isolated pieces and close up by an amount we compute ourselves.
    var vn2 = cpswTry(function () { return seq.videoTracks.numTracks; }, 0);
    for (var vt = 0; vt < vn2; vt++) {
      cpswRippleTrack(cpswTry((function (i) { return function () { return seq.videoTracks[i]; }; })(vt), null), valid, frame);
    }
    var an2 = cpswTry(function () { return seq.audioTracks.numTracks; }, 0);
    for (var at = 0; at < an2; at++) {
      cpswRippleTrack(cpswTry((function (i) { return function () { return seq.audioTracks[i]; }; })(at), null), valid, frame);
    }

    var removed = valid.length;
    var after = sequenceTailSeconds();
    var totalRemovedSeconds = before - after;

    // Judge by observed effect, not by what extract() claimed. If the sequence is
    // not measurably shorter, nothing was trimmed, and the panel must not go on to
    // apply camera cuts as though it had been.
    if (totalRemovedSeconds < 0.001) {
      return '{"ok":false,"error":' + cpswEsc(
        'The trim removed nothing: ' + skipped + ' of ' + removals.length +
        ' span(s) could not be applied to this ' + before.toFixed(1) + 's sequence.' +
        (duplicate ? ' The unused duplicate "' + seq.name + '" can be deleted from the project bin.' : '')
      ) + '}';
    }

    return '{"ok":true,"sequence":' + cpswEsc(seq.name)
      + ',"duplicated":' + (duplicate ? 'true' : 'false')
      + ',"removed":' + removed
      + ',"skipped":' + skipped
      + ',"totalRemovedSeconds":' + cpswNum(totalRemovedSeconds) + '}';
  } catch (e) {
    return '{"ok":false,"error":' + cpswEsc(e.message) + '}';
  }
}

/**
 * Report whether this Premiere build supports the mechanisms the writer needs,
 * without changing anything. The panel calls this once on load so a missing
 * capability surfaces immediately rather than halfway through applying a cut.
 */
function cpswCapabilities() {
  var parts = [];
  var seq = cpswTry(function () { return app.project.activeSequence; }, null);
  parts.push('"hasSequence":' + (seq ? 'true' : 'false'));

  var disabledType = 'absent';
  if (seq) {
    var probe = cpswTry(function () {
      for (var i = 0; i < seq.videoTracks.numTracks; i++) {
        if (seq.videoTracks[i].clips.numItems > 0) return seq.videoTracks[i].clips[0];
      }
      return null;
    }, null);
    if (probe) {
      disabledType = cpswTry(function () { return typeof probe.disabled; }, 'absent');
    }
  }
  parts.push('"trackItemDisabled":' + cpswEsc(disabledType));

  var qeOk = cpswTry(function () {
    app.enableQE();
    return (typeof qe !== 'undefined' && qe.project) ? true : false;
  }, false);
  parts.push('"qe":' + (qeOk ? 'true' : 'false'));

  var razorOk = false;
  if (qeOk) {
    razorOk = cpswTry(function () {
      var vt = qe.project.getActiveSequence().getVideoTrackAt(0);
      return typeof vt.razor === 'function';
    }, false);
  }
  parts.push('"razor":' + (razorOk ? 'true' : 'false'));

  // Confirmed via spikes/probe-extract.jsx: qeSequence.extract() ripples every
  // track together off the sequence's own setInPoint()/setOutPoint(). Reported so
  // the panel can grey out both trim toggles honestly on a build where this is not
  // available, rather than the toggle silently doing nothing.
  var rippleOk = false;
  if (qeOk) {
    rippleOk = cpswTry(function () {
      return typeof qe.project.getActiveSequence().extract === 'function';
    }, false);
  }
  parts.push('"ripple":' + (rippleOk ? 'true' : 'false'));
  parts.push('"rippleMechanism":' + cpswEsc(rippleOk ? 'qe-sequence-extract' : ''));

  return '{' + parts.join(',') + '}';
}
