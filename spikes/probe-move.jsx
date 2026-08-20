/*
 * Can we do the ripple ourselves instead of trusting extract()?
 *
 * extract() is non-deterministic on this build: the identical 20-span input produced
 * 2 gaps on one run and 10 on the next. Pre-razoring every track does not change it.
 * So the plan is to stop delegating: razor every track at both boundaries (identical
 * frame everywhere by construction), delete the isolated clips, then move each
 * following clip left by an exact, known amount we compute ourselves.
 *
 * That whole design rests on DOM TrackItem.move() behaving predictably, which is
 * unverified. This establishes: does move() take a RELATIVE delta or an ABSOLUTE
 * position, does it accept negative values, and is it frame-exact?
 */
(function () {
  app.enableQE();
  var L = [];
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }
  var FRAME = 1001 / 24000, FPS = 24000 / 1001;

  function tc(seconds) {
    var nominal = Math.round(FPS);
    var f = Math.round(seconds * FPS);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var ts = Math.floor(f / nominal);
    return p(Math.floor(ts / 3600)) + ':' + p(Math.floor(ts / 60) % 60) + ':' + p(ts % 60) + ':' + p(f % nominal);
  }
  function findSeq(name) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (String(T(function () { return s.name; }, '')) === name) return s;
    }
    return null;
  }

  var original = findSeq('Part 2');
  if (!original) return 'no sequence named "Part 2"';
  T(function () { app.project.openSequence(original.sequenceID); return true; }, false);
  T(function () { app.project.activeSequence.clone(); return true; }, null);
  var seq = app.project.activeSequence;
  var qs = T(function () { return qe.project.getActiveSequence(); }, null);
  L.push('working on: ' + T(function () { return seq.name; }, '?'));

  // Razor V0 and A0 at 100s and 102s so there is an isolated middle clip on each.
  var A = Math.round(100 / FRAME) * FRAME;
  var B = Math.round(102 / FRAME) * FRAME;
  T(function () { qs.getVideoTrackAt(0).razor(tc(A)); return true; }, false);
  T(function () { qs.getVideoTrackAt(0).razor(tc(B)); return true; }, false);
  T(function () { qs.getAudioTrackAt(0).razor(tc(A)); return true; }, false);
  T(function () { qs.getAudioTrackAt(0).razor(tc(B)); return true; }, false);
  L.push('razored V0 and A0 at ' + tc(A) + ' and ' + tc(B));

  function clipAtIndex(coll, ti, ci, what) {
    return Number(T(function () { return coll[ti].clips[ci][what].seconds; }, -1));
  }
  function describe(label) {
    var n = Number(T(function () { return seq.videoTracks[0].clips.numItems; }, 0));
    var out = label + '  V0 clips=' + n + ': ';
    for (var i = 0; i < Math.min(n, 5); i++) {
      out += '[' + clipAtIndex(seq.videoTracks, 0, i, 'start').toFixed(3) + '-' + clipAtIndex(seq.videoTracks, 0, i, 'end').toFixed(3) + '] ';
    }
    L.push(out);
  }
  describe('after razor:');

  // Find the clip that starts at B on V0 (the one after the middle piece).
  var n = Number(T(function () { return seq.videoTracks[0].clips.numItems; }, 0));
  var targetIdx = -1;
  for (var i = 0; i < n; i++) {
    if (Math.abs(clipAtIndex(seq.videoTracks, 0, i, 'start') - B) < FRAME * 0.5) { targetIdx = i; break; }
  }
  if (targetIdx === -1) { L.push('could not find the clip starting at B'); return L.join('\n'); }

  var beforeStart = clipAtIndex(seq.videoTracks, 0, targetIdx, 'start');
  L.push('target clip index ' + targetIdx + ' starts at ' + beforeStart.toFixed(4));

  // move() with a NEGATIVE delta of exactly (B - A). If it is relative, the clip
  // lands on A. If it is absolute, it lands somewhere near -2s (or errors).
  var delta = -(B - A);
  var moveResult = T((function (d, idx) {
    return function () { return seq.videoTracks[0].clips[idx].move(d); };
  })(delta, targetIdx), 'THREW');
  L.push('move(' + delta.toFixed(4) + ') returned: ' + moveResult);

  var afterStart = clipAtIndex(seq.videoTracks, 0, targetIdx, 'start');
  L.push('target clip now starts at ' + afterStart.toFixed(4));
  L.push('');
  var movedBy = beforeStart - afterStart;
  L.push('moved by: ' + movedBy.toFixed(4) + 's  (' + (movedBy / FRAME).toFixed(3) + ' frames)');
  if (Math.abs(afterStart - A) < FRAME * 0.5) {
    L.push('VERDICT: move() takes a RELATIVE delta and is frame-exact. The deterministic');
    L.push('ripple is buildable: razor everywhere, delete, then move by a known amount.');
  } else if (Math.abs(movedBy) < FRAME * 0.5) {
    L.push('VERDICT: move() did nothing. Deterministic ripple needs another mechanism.');
  } else {
    L.push('VERDICT: move() moved by an unexpected amount, semantics unclear.');
  }
  describe('after move: ');
  L.push('Disposable copy created.');
  return L.join('\n');
})();
