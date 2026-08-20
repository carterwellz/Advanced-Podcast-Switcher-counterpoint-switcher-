/*
 * Frame-snapped spans give perfect audio (0 gaps) but still leave a one-frame hole
 * on ~30% of video cuts. A boundary sitting exactly ON a frame line is ambiguous:
 * seconds -> frame conversion at 23.976fps can tip either way in floating point, so
 * the in and out points sometimes resolve to different frames than intended.
 *
 * Nudging the boundary a fraction of a frame INSIDE the intended frame should make
 * the rounding deterministic. Tests several offsets against fresh duplicates of the
 * untouched original, measuring identically. Expects host.jsx ahead.
 */
(function () {
  var L = [];
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }
  var FRAME = 1001 / 24000;
  var GAP = FRAME * 0.5;

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

  function runVariant(label, frac) {
    var lines = ['MODE ripple', 'DUPLICATE 1', 'RANGE 0.000000 2300.000000'];
    var spans = [];
    for (var i = 0; i < 10; i++) {
      var sF = Math.round((120 + i * 170) / FRAME);
      var eF = sF + Math.round(2.0 / FRAME);
      // Nudge both boundaries `frac` of a frame past the frame line.
      spans.push([(sF + frac) * FRAME, (eF + frac) * FRAME]);
    }
    spans.sort(function (a, b) { return b[0] - a[0]; });
    for (var j = 0; j < spans.length; j++) {
      lines.push('REMOVE ' + spans[j][0].toFixed(6) + ' ' + spans[j][1].toFixed(6));
    }
    var p = Folder.temp.fsName + '/cpsw-eps-' + label + '.txt';
    var f = new File(p); f.open('w'); f.write(lines.join('\n')); f.close();

    T(function () { app.project.openSequence(original.sequenceID); return true; }, false);
    cpswApplyTrimPlan(p);
    var m = measure(app.project.activeSequence);
    L.push('  offset +' + frac.toFixed(2) + ' frame:  videoGaps=' + m.vG + ' (' + m.vT.toFixed(3) + 's)'
      + '  audioGaps=' + m.aG + ' (' + m.aT.toFixed(3) + 's)');
    return m;
  }

  L.push('same 10 spans, boundary nudged progressively inside the frame:');
  var results = [];
  results.push({ frac: 0.0, m: runVariant('a', 0.0) });
  results.push({ frac: 0.25, m: runVariant('b', 0.25) });
  results.push({ frac: 0.5, m: runVariant('c', 0.5) });

  L.push('');
  var best = results[0];
  for (var i = 1; i < results.length; i++) {
    if (results[i].m.vG + results[i].m.aG < best.m.vG + best.m.aG) best = results[i];
  }
  L.push('BEST: +' + best.frac.toFixed(2) + ' frame, ' + (best.m.vG + best.m.aG) + ' total gaps'
    + (best.m.vG + best.m.aG === 0 ? '  <-- CLEAN' : '  <-- still gapping, cause is not rounding'));
  L.push('Three disposable copies created; all can be deleted.');
  return L.join('\n');
})();
