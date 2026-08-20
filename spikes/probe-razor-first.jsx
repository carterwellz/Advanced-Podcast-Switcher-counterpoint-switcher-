/*
 * Carter's approach: cut every track at the same instant FIRST (Premiere's "Add Edit
 * to All Tracks"), so the edit points are identical on all of them by construction,
 * and only then remove and ripple.
 *
 * The theory being tested: extract() gaps because it creates the edit points itself
 * and resolves seconds -> frame slightly differently per track. If the razors already
 * exist at exactly the same frame everywhere, there is nothing left for it to get
 * wrong. QE razor() takes TIMECODE STRINGS, which name a frame exactly.
 *
 * Same dense 20-span case that produced 2 gaps without pre-razoring.
 *   ARM 1: extract() alone            (current behaviour)
 *   ARM 2: razor all tracks, then extract()
 */
(function () {
  app.enableQE();
  var L = [];
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }
  var FRAME = 1001 / 24000, FPS = 24000 / 1001, GAP = FRAME * 0.5;

  function tc(seconds) {
    var nominal = Math.round(FPS);
    var f = Math.round(seconds * FPS);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var totalSec = Math.floor(f / nominal);
    return p(Math.floor(totalSec / 3600)) + ':' + p(Math.floor(totalSec / 60) % 60) + ':' +
      p(totalSec % 60) + ':' + p(f % nominal);
  }
  function findSeq(name) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (String(T(function () { return s.name; }, '')) === name) return s;
    }
    return null;
  }
  function measure(seq) {
    var vG = 0, aG = 0, vT = 0, aT = 0;
    function scan(coll, isVideo) {
      var n = Number(T(function () { return coll.numTracks; }, 0));
      for (var i = 0; i < n; i++) {
        var cnt = Number(T((function (x) { return function () { return coll[x].clips.numItems; }; })(i), 0));
        if (cnt === 0) continue;
        var prev = null;
        for (var c = 0; c < cnt; c++) {
          var s = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].start.seconds; }; })(i, c), 0));
          var e = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].end.seconds; }; })(i, c), 0));
          if (prev !== null && s - prev > GAP) { if (isVideo) { vG++; vT += s - prev; } else { aG++; aT += s - prev; } }
          prev = e;
        }
      }
    }
    scan(seq.videoTracks, true);
    scan(seq.audioTracks, false);
    return { vG: vG, aG: aG, vT: vT, aT: aT };
  }

  var original = findSeq('Part 2');
  if (!original) return 'no sequence named "Part 2"';

  var spans = [];
  for (var i = 0; i < 20; i++) {
    var sF = Math.round((100 + i * 3.0) / FRAME);
    spans.push([sF * FRAME, (sF + 24) * FRAME]);
  }
  spans.sort(function (a, b) { return b[0] - a[0]; });

  /** Razor every video and audio track at one instant, exactly like Add Edit to All Tracks. */
  function razorAllTracks(qs, seconds) {
    var code = tc(seconds);
    var vn = Number(T(function () { return qs.numVideoTracks; }, 0));
    for (var v = 0; v < vn; v++) {
      T((function (idx) { return function () { qs.getVideoTrackAt(idx).razor(code); return true; }; })(v), false);
    }
    var an = Number(T(function () { return qs.numAudioTracks; }, 0));
    for (var a = 0; a < an; a++) {
      T((function (idx) { return function () { qs.getAudioTrackAt(idx).razor(code); return true; }; })(a), false);
    }
  }

  function runArm(label, preRazor) {
    T(function () { app.project.openSequence(original.sequenceID); return true; }, false);
    var base = app.project.activeSequence;
    T(function () { base.clone(); return true; }, null);
    var seq = app.project.activeSequence;
    var qs = T(function () { return qe.project.getActiveSequence(); }, null);
    if (!qs) { L.push('  ' + label + ': no QE sequence'); return null; }

    for (var j = 0; j < spans.length; j++) {
      if (preRazor) { razorAllTracks(qs, spans[j][0]); razorAllTracks(qs, spans[j][1]); }
      T((function (v) { return function () { seq.setInPoint(v); return true; }; })(spans[j][0]), false);
      T((function (v) { return function () { seq.setOutPoint(v); return true; }; })(spans[j][1]), false);
      T(function () { return qs.extract(); }, false);
    }
    var m = measure(seq);
    L.push('  ' + label + ':  videoGaps=' + m.vG + ' (' + m.vT.toFixed(3) + 's)'
      + '  audioGaps=' + m.aG + ' (' + m.aT.toFixed(3) + 's)');
    return m;
  }

  L.push('20 dense spans (3s apart), which gap without pre-razoring:');
  var a = runArm('ARM 1  extract alone        ', false);
  var b = runArm('ARM 2  razor all, then extract', true);
  L.push('');
  if (a && b) {
    L.push('VERDICT: ' + ((b.vG + b.aG) === 0
      ? 'pre-razoring ALL tracks eliminates the gaps entirely.'
      : ((b.vG + b.aG) < (a.vG + a.aG)
        ? 'pre-razoring helps (' + (b.vG + b.aG) + ' vs ' + (a.vG + a.aG) + ') but does not fully fix it.'
        : 'pre-razoring does not help.')));
  }
  L.push('Two disposable copies created.');
  return L.join('\n');
})();
