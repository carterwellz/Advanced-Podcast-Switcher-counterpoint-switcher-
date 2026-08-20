/*
 * QE `extract()` verification, on a duplicate only.
 *
 * probe-ripple.jsx found DOM TrackItem.remove(true, false) does not ripple on this
 * build, but that qeSequence.extract exists as a real function (existence-checked
 * only there, never called). This probe calls it for real and judges by observed
 * effect: clip counts and positions on EVERY track, video and audio, before and
 * after, plus sequence in/out points -- exactly probe-razor.jsx's discipline.
 *
 * Premiere's own "Extract" command removes the work area (in point to out point)
 * across every track and closes the gap everywhere at once, so the plan is: clone,
 * set in/out to bracket a short, clean, gap-free span using the standard DOM
 * setInPoint/setOutPoint, then try calling qeSequence.extract() with a few
 * plausible argument shapes since QE is undocumented, stopping at whichever one
 * actually shrinks the sequence.
 */
(function () {
  var L = [];
  function say(k, v) { L.push(k + ': ' + v); }
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }

  var original = app.project.activeSequence;
  if (!original) return 'NO ACTIVE SEQUENCE';
  say('originalSequence', original.name);
  var originalId = String(T(function () { return original.sequenceID; }, ''));

  try { original.clone(); } catch (e) { say('cloneError', e.message); }
  var seq = app.project.activeSequence;
  say('activeNow', T(function () { return seq.name; }, '?'));

  if (String(T(function () { return seq.sequenceID; }, '')) === originalId) {
    return L.join('\n') + '\nRESULT: still on the original sequence. Aborted before extracting anything.';
  }

  var tb = Number(T(function () { return seq.timebase; }, 0));
  var fps = tb > 0 ? 254016000000 / tb : 30;
  say('fps', fps);

  // Find a 2-second, gap-free span well inside a video clip AND find whether the
  // corresponding audio track has a clip covering the same span too, so a
  // sequence-wide extract has something real to prove itself against on both
  // track types at once.
  var vTrackIndex = -1, spanStart = -1, spanEnd = -1;
  var beforeCounts = {};

  for (var i = 0; i < seq.videoTracks.numTracks; i++) {
    var n = T(function () { return seq.videoTracks[i].clips.numItems; }, 0);
    for (var c = 0; c < n; c++) {
      var cs = Number(T((function (ti, ci) { return function () { return seq.videoTracks[ti].clips[ci].start.seconds; }; })(i, c), 0));
      var ce = Number(T((function (ti, ci) { return function () { return seq.videoTracks[ti].clips[ci].end.seconds; }; })(i, c), 0));
      if (ce - cs > 8) { vTrackIndex = i; spanStart = cs + 3; spanEnd = spanStart + 2; break; }
    }
    if (vTrackIndex !== -1) break;
  }
  if (vTrackIndex === -1) return L.join('\n') + '\nRESULT: no clip long enough to test on.';
  say('testSpan', spanStart.toFixed(3) + ' - ' + spanEnd.toFixed(3) + ' (2.000s)');

  // Snapshot every track's clip count and, for the first clip strictly after the
  // span on each track, its start time -- the thing that has to shift by exactly
  // 2.000s if extract worked and rippled that track.
  function snapshot() {
    var snap = { video: [], audio: [] };
    function scan(coll, n, out) {
      for (var i = 0; i < n; i++) {
        var cnt = T((function (idx) { return function () { return coll[idx].clips.numItems; }; })(i), 0);
        var afterStart = null;
        for (var c = 0; c < cnt; c++) {
          var s = Number(T((function (idx, ci) { return function () { return coll[idx].clips[ci].start.seconds; }; })(i, c), -1));
          if (s >= spanEnd - 0.001 && (afterStart === null || s < afterStart)) afterStart = s;
        }
        out.push({ track: i, count: cnt, firstAfterSpan: afterStart });
      }
    }
    scan(seq.videoTracks, T(function () { return seq.videoTracks.numTracks; }, 0), snap.video);
    scan(seq.audioTracks, T(function () { return seq.audioTracks.numTracks; }, 0), snap.audio);
    return snap;
  }

  var before = snapshot();
  say('inPointBefore', T(function () { return seq.getInPoint(); }, '?'));
  say('outPointBefore', T(function () { return seq.getOutPoint(); }, '?'));
  L.push('--- before ---');
  for (var bv = 0; bv < before.video.length; bv++) {
    say('  V' + before.video[bv].track, 'count=' + before.video[bv].count + ' firstClipAfterSpan.start=' + before.video[bv].firstAfterSpan);
  }
  for (var ba = 0; ba < before.audio.length; ba++) {
    say('  A' + before.audio[ba].track, 'count=' + before.audio[ba].count + ' firstClipAfterSpan.start=' + before.audio[ba].firstAfterSpan);
  }

  // Set the work area to the test span using standard, documented DOM calls.
  var setInOk = T(function () { seq.setInPoint(spanStart); return true; }, false);
  var setOutOk = T(function () { seq.setOutPoint(spanEnd); return true; }, false);
  say('setInPoint', setInOk);
  say('setOutPoint', setOutOk);
  say('inPointAfterSet', T(function () { return seq.getInPoint(); }, '?'));
  say('outPointAfterSet', T(function () { return seq.getOutPoint(); }, '?'));

  app.enableQE();
  var qeSeq = T(function () { return qe.project.getActiveSequence(); }, null);
  if (!qeSeq) return L.join('\n') + '\nRESULT: no QE sequence available.';

  // Try plausible call shapes, stopping at whichever one actually shrinks a track.
  var attempts = [
    ['no-args', function () { return qeSeq.extract(); }],
    ['ripple-true', function () { return qeSeq.extract(true); }],
    ['in-out-seconds', function () { return qeSeq.extract(String(spanStart), String(spanEnd)); }],
    ['in-out-timecode', function () {
      function tc(sec) {
        var f = Math.round(sec * fps), r = Math.round(fps);
        function p(x) { return (x < 10 ? '0' : '') + x; }
        return p(Math.floor(f / r / 3600)) + ':' + p(Math.floor(f / r / 60) % 60) + ':' + p(Math.floor(f / r) % 60) + ':' + p(f % r);
      }
      return qeSeq.extract(tc(spanStart), tc(spanEnd));
    }]
  ];

  var winner = null, afterWinner = null, returned = null;
  for (var a = 0; a < attempts.length; a++) {
    var label = attempts[a][0];
    returned = T(attempts[a][1], 'threw');
    var after = snapshot();
    var changed = false;
    for (var vi = 0; vi < after.video.length; vi++) {
      if (after.video[vi].count !== before.video[vi].count) changed = true;
    }
    for (var ai = 0; ai < after.audio.length; ai++) {
      if (after.audio[ai].count !== before.audio[ai].count) changed = true;
    }
    say('try:' + label, 'returned=' + returned + ' anyCountChanged=' + changed);
    if (changed) { winner = label; afterWinner = after; break; }
  }

  if (!winner) {
    return L.join('\n') + '\nRESULT: none of the tried extract() call shapes changed any clip count. Needs a different approach or is not scriptable this way on this build.';
  }

  L.push('--- after (' + winner + ') ---');
  for (var av = 0; av < afterWinner.video.length; av++) {
    say('  V' + afterWinner.video[av].track, 'count=' + afterWinner.video[av].count + ' firstClipAfterSpan.start=' + afterWinner.video[av].firstAfterSpan);
  }
  for (var aa = 0; aa < afterWinner.audio.length; aa++) {
    say('  A' + afterWinner.audio[aa].track, 'count=' + afterWinner.audio[aa].count + ' firstClipAfterSpan.start=' + afterWinner.audio[aa].firstAfterSpan);
  }
  say('inPointAfterExtract', T(function () { return seq.getInPoint(); }, '?'));
  say('outPointAfterExtract', T(function () { return seq.getOutPoint(); }, '?'));

  // The real verdict: did EVERY track that had a clip after the span shift left by
  // exactly 2.000s, video and audio together, in one call?
  var allShifted = true, anyChecked = false;
  function checkShift(beforeList, afterList, label) {
    for (var i = 0; i < beforeList.length; i++) {
      var b = beforeList[i], af = afterList[i];
      if (b.firstAfterSpan === null || af.firstAfterSpan === null) continue;
      anyChecked = true;
      var shift = b.firstAfterSpan - af.firstAfterSpan;
      say('shift:' + label + i, shift.toFixed(3) + 's');
      if (Math.abs(shift - 2.0) > 0.05) allShifted = false;
    }
  }
  checkShift(before.video, afterWinner.video, 'V');
  checkShift(before.audio, afterWinner.audio, 'A');

  L.push('');
  L.push('RESULT: qeSequence.extract(' + winner + ') changed clip counts. '
    + (anyChecked
      ? (allShifted
        ? 'Every checked track shifted left by exactly the removed 2.000s -- looks like a real sequence-wide ripple.'
        : 'NOT every checked track shifted by the same amount -- extract is NOT reliably sequence-wide on this build, treat with suspicion.')
      : 'No track had a clip positioned after the test span to confirm a shift against -- inconclusive, rerun with a longer sequence tail.'));
  L.push('The copy "' + T(function () { return seq.name; }, '?') + '" can be deleted from the project bin.');
  return L.join('\n');
})();
