/*
 * Setting the work area via QE timecode instead of DOM seconds.
 *
 * qeSequence has its own setInPoint/setOutPoint, and QE methods on this build take
 * TIMECODE STRINGS rather than seconds (already established for razor(), see
 * CLAUDE.md). A timecode string names a frame exactly, with no seconds -> frame
 * rounding anywhere in the path, which is precisely where the surviving one-frame
 * video gaps are coming from: frame-aligned seconds still leave ~30% of video cuts
 * holed, and deliberately un-aligning them makes every cut hole.
 *
 * Arm 1: DOM setInPoint/setOutPoint in seconds (what ships today).
 * Arm 2: QE setInPoint/setOutPoint in timecode.
 * Same spans, fresh duplicate of the untouched original for each, same measurement.
 */
(function () {
  app.enableQE();
  var L = [];
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }
  var FRAME = 1001 / 24000;
  var FPS = 24000 / 1001;
  var GAP = FRAME * 0.5;

  function tc(seconds) {
    var nominal = Math.round(FPS);
    var f = Math.round(seconds * FPS);
    var ff = f % nominal;
    var totalSec = Math.floor(f / nominal);
    var ss = totalSec % 60, mm = Math.floor(totalSec / 60) % 60, hh = Math.floor(totalSec / 3600);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(hh) + ':' + p(mm) + ':' + p(ss) + ':' + p(ff);
  }

  function findSeq(name) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (String(T(function () { return s.name; }, '')) === name) return s;
    }
    return null;
  }
  function measure(seq) {
    var vG = 0, vT = 0, aG = 0, aT = 0;
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
    return { vG: vG, vT: vT, aG: aG, aT: aT };
  }

  var original = findSeq('Part 2');
  if (!original) return 'no sequence named "Part 2"';

  // Ten identical frame-aligned spans, applied latest-first.
  var spans = [];
  for (var i = 0; i < 10; i++) {
    var sF = Math.round((120 + i * 170) / FRAME);
    var eF = sF + Math.round(2.0 / FRAME);
    spans.push([sF * FRAME, eF * FRAME]);
  }
  spans.sort(function (a, b) { return b[0] - a[0]; });

  function runArm(label, useQE) {
    T(function () { app.project.openSequence(original.sequenceID); return true; }, false);
    var base = app.project.activeSequence;
    T(function () { base.clone(); return true; }, null);
    var seq = app.project.activeSequence;
    var qs = T(function () { return qe.project.getActiveSequence(); }, null);
    if (!qs) { L.push('  ' + label + ': no QE sequence'); return null; }

    var applied = 0, firstErr = '';
    for (var j = 0; j < spans.length; j++) {
      var okIn, okOut;
      if (useQE) {
        okIn = T((function (v) { return function () { qs.setInPoint(tc(v)); return true; }; })(spans[j][0]), false);
        okOut = T((function (v) { return function () { qs.setOutPoint(tc(v)); return true; }; })(spans[j][1]), false);
      } else {
        okIn = T((function (v) { return function () { seq.setInPoint(v); return true; }; })(spans[j][0]), false);
        okOut = T((function (v) { return function () { seq.setOutPoint(v); return true; }; })(spans[j][1]), false);
      }
      if (okIn !== true || okOut !== true) { if (!firstErr) firstErr = 'in=' + okIn + ' out=' + okOut; continue; }
      if (T(function () { return qs.extract(); }, false)) applied++;
    }
    var m = measure(seq);
    L.push('  ' + label + ':  applied=' + applied + '/' + spans.length
      + '  videoGaps=' + m.vG + ' (' + m.vT.toFixed(3) + 's)'
      + '  audioGaps=' + m.aG + ' (' + m.aT.toFixed(3) + 's)'
      + (firstErr ? ('   note: ' + firstErr) : ''));
    return m;
  }

  L.push('same 10 frame-aligned spans, two ways of setting the work area:');
  var a = runArm('ARM 1  DOM seconds ', false);
  var b = runArm('ARM 2  QE timecode ', true);

  L.push('');
  if (a && b) {
    L.push('VERDICT: ' + (b.vG + b.aG < a.vG + a.aG
      ? 'QE timecode is cleaner (' + (b.vG + b.aG) + ' vs ' + (a.vG + a.aG) + ' gaps)'
      : (b.vG + b.aG === a.vG + a.aG ? 'no difference, the gap is not from in/out precision'
        : 'QE timecode is worse')));
  }
  L.push('Two disposable copies created; both can be deleted.');
  return L.join('\n');
})();
