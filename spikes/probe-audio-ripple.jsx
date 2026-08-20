/*
 * Does qeSequence.extract() actually ripple the AUDIO tracks?
 *
 * Carter reports that after a real trim run, video got shorter but the audio
 * tracks were untouched, which would desync the whole episode. probe-extract.jsx
 * claimed every track shifted, but its shift check only looked at "the first clip
 * starting after the test span" on each track -- and on this rig every audio track
 * is ONE full-length Auphonic clip, so there is no clip starting after the span and
 * every audio track was silently skipped by that check. The video tracks passed
 * only because a previous camera-cut apply had already razored them.
 *
 * This probe closes that hole by measuring the thing that actually moves on a
 * single-clip track: the LAST clip's end time, per track, before and after. It also
 * reports track targeting and lock state, since Premiere's Extract is documented to
 * operate on targeted tracks and to respect sync lock, which is the most likely
 * reason audio would be left behind.
 *
 * Runs on a duplicate only. Never touches the original.
 */
(function () {
  var L = [];
  function say(k, v) { L.push(k + ': ' + v); }
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }
  function n(v) { var x = Number(v); return isFinite(x) ? x : null; }

  var original = app.project.activeSequence;
  if (!original) return 'NO ACTIVE SEQUENCE';
  var originalId = String(T(function () { return original.sequenceID; }, ''));
  say('originalSequence', original.name);

  try { original.clone(); } catch (e) { say('cloneError', e.message); }
  var seq = app.project.activeSequence;
  if (String(T(function () { return seq.sequenceID; }, '')) === originalId) {
    return L.join('\n') + '\nABORTED: clone did not activate a copy. Nothing was touched.';
  }
  say('workingOn', T(function () { return seq.name; }, '?'));

  var vn = n(T(function () { return seq.videoTracks.numTracks; }, 0)) || 0;
  var an = n(T(function () { return seq.audioTracks.numTracks; }, 0)) || 0;
  say('videoTracks', vn);
  say('audioTracks', an);

  // --- targeting / lock state, the prime suspect ---
  L.push('--- track state before ---');
  for (var i = 0; i < vn; i++) {
    L.push('  V' + i
      + ' targeted=' + T((function (x) { return function () { return seq.videoTracks[x].isTargeted(); }; })(i), '?')
      + ' locked=' + T((function (x) { return function () { return seq.videoTracks[x].isLocked(); }; })(i), '?')
      + ' clips=' + T((function (x) { return function () { return seq.videoTracks[x].clips.numItems; }; })(i), '?'));
  }
  for (var j = 0; j < an; j++) {
    L.push('  A' + j
      + ' targeted=' + T((function (x) { return function () { return seq.audioTracks[x].isTargeted(); }; })(j), '?')
      + ' locked=' + T((function (x) { return function () { return seq.audioTracks[x].isLocked(); }; })(j), '?')
      + ' clips=' + T((function (x) { return function () { return seq.audioTracks[x].clips.numItems; }; })(j), '?'));
  }

  // --- snapshot: per track, clip count AND last clip end (what moves on a single-clip track) ---
  function snap() {
    var o = { v: [], a: [] };
    function scan(coll, count, out) {
      for (var i = 0; i < count; i++) {
        var cnt = n(T((function (x) { return function () { return coll[x].clips.numItems; }; })(i), 0));
        var lastEnd = null;
        if (cnt > 0) {
          lastEnd = n(T((function (x, c) { return function () { return coll[x].clips[c].end.seconds; }; })(i, cnt - 1), null));
        }
        out.push({ count: cnt, end: lastEnd });
      }
    }
    scan(seq.videoTracks, vn, o.v);
    scan(seq.audioTracks, an, o.a);
    return o;
  }

  var before = snap();

  // Pick a 2 second span comfortably inside real content on every track: use the
  // SHORTEST populated track's end so the span is inside everything at once.
  var shortest = null;
  for (var bv = 0; bv < before.v.length; bv++) {
    if (before.v[bv].end !== null && (shortest === null || before.v[bv].end < shortest)) shortest = before.v[bv].end;
  }
  for (var ba = 0; ba < before.a.length; ba++) {
    if (before.a[ba].end !== null && (shortest === null || before.a[ba].end < shortest)) shortest = before.a[ba].end;
  }
  if (shortest === null || shortest < 20) {
    return L.join('\n') + '\nABORTED: no populated track long enough to test on (shortest end = ' + shortest + ').';
  }
  var spanStart = Math.floor(shortest / 2);
  var spanEnd = spanStart + 2;
  say('testSpan', spanStart + ' - ' + spanEnd + ' (2.000s), shortestTrackEnd=' + shortest.toFixed(3));

  app.enableQE();
  var qeSeq = T(function () { return qe.project.getActiveSequence(); }, null);
  if (!qeSeq || typeof qeSeq.extract !== 'function') {
    return L.join('\n') + '\nABORTED: qe extract() not available.';
  }

  var setIn = T(function () { seq.setInPoint(spanStart); return true; }, false);
  var setOut = T(function () { seq.setOutPoint(spanEnd); return true; }, false);
  say('setInPoint', setIn);
  say('setOutPoint', setOut);
  say('inPointReadBack', T(function () { return seq.getInPoint(); }, '?'));
  say('outPointReadBack', T(function () { return seq.getOutPoint(); }, '?'));

  var extractReturned = T(function () { return qeSeq.extract(); }, 'threw');
  say('extractReturned', extractReturned);

  var after = snap();

  // --- the real verdict: did EVERY populated track lose the same 2.000s? ---
  L.push('--- per track: lastClipEnd before -> after (shift) ---');
  var videoShifted = 0, videoTotal = 0, audioShifted = 0, audioTotal = 0;

  function report(bList, aList, label, tally) {
    for (var i = 0; i < bList.length; i++) {
      var b = bList[i], af = aList[i];
      if (b.end === null) { L.push('  ' + label + i + ' (empty track, skipped)'); continue; }
      var shift = (af.end === null) ? null : (b.end - af.end);
      tally.total++;
      var ok = shift !== null && Math.abs(shift - 2.0) < 0.06;
      if (ok) tally.shifted++;
      L.push('  ' + label + i
        + ' clips ' + b.count + '->' + af.count
        + '  end ' + b.end.toFixed(3) + ' -> ' + (af.end === null ? 'null' : af.end.toFixed(3))
        + '  shift=' + (shift === null ? 'n/a' : shift.toFixed(3)) + 's'
        + (ok ? '  OK' : '  <-- DID NOT RIPPLE'));
    }
  }

  var vt = { shifted: 0, total: 0 }, at = { shifted: 0, total: 0 };
  report(before.v, after.v, 'V', vt);
  report(before.a, after.a, 'A', at);

  L.push('');
  say('videoTracksRippled', vt.shifted + ' / ' + vt.total);
  say('audioTracksRippled', at.shifted + ' / ' + at.total);

  L.push('');
  if (at.total === 0) {
    L.push('VERDICT: this sequence has no populated audio tracks, so this probe proves nothing about audio. Run it on the real episode sequence.');
  } else if (at.shifted === at.total && vt.shifted === vt.total) {
    L.push('VERDICT: extract() DID ripple every video and audio track. Carter\'s desync has another cause.');
  } else if (at.shifted === 0) {
    L.push('VERDICT: CONFIRMED BUG. extract() rippled ' + vt.shifted + '/' + vt.total + ' video tracks and ZERO audio tracks. Audio is left behind, which is exactly the desync reported.');
  } else {
    L.push('VERDICT: PARTIAL ripple, which is worse than none. video ' + vt.shifted + '/' + vt.total + ', audio ' + at.shifted + '/' + at.total + '.');
  }
  L.push('The copy "' + T(function () { return seq.name; }, '?') + '" is disposable and can be deleted from the project bin.');
  return L.join('\n');
})();
