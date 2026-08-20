/*
 * After snapping spans to frame boundaries, every remaining gap is exactly ONE
 * frame, on roughly half the cut points. That is the signature of an inclusive vs
 * exclusive out point: extract() removes one more (or one fewer) frame than it
 * closes up by.
 *
 * Tests three variants of the SAME spans against three fresh duplicates of the
 * untouched original, measuring gaps identically for each:
 *   C1: out point as-is           (current behaviour)
 *   C2: out point minus one frame
 *   C3: out point plus one frame
 *
 * Whichever yields zero gaps is the correct convention. Expects host.jsx ahead.
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
          if (prev !== null && s - prev > GAP) {
            if (isVideo) { vG++; vT += s - prev; } else { aG++; aT += s - prev; }
          }
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

  function runVariant(label, frameDelta) {
    var lines = ['MODE ripple', 'DUPLICATE 1', 'RANGE 0.000000 2300.000000'];
    var spans = [];
    for (var i = 0; i < 10; i++) {
      var sF = Math.round((120 + i * 170) / FRAME);
      var eF = sF + Math.round(2.0 / FRAME) + frameDelta;
      spans.push([sF * FRAME, eF * FRAME]);
    }
    spans.sort(function (a, b) { return b[0] - a[0]; });
    for (var j = 0; j < spans.length; j++) {
      lines.push('REMOVE ' + spans[j][0].toFixed(6) + ' ' + spans[j][1].toFixed(6));
    }
    var p = Folder.temp.fsName + '/cpsw-' + label + '.txt';
    var f = new File(p); f.open('w'); f.write(lines.join('\n')); f.close();

    T(function () { app.project.openSequence(original.sequenceID); return true; }, false);
    var res = cpswApplyTrimPlan(p);
    var m = measure(app.project.activeSequence);
    L.push('  ' + label + ' (out ' + (frameDelta === 0 ? 'as-is' : (frameDelta > 0 ? '+1 frame' : '-1 frame')) + '):'
      + '  videoGaps=' + m.vG + ' (' + m.vT.toFixed(3) + 's)'
      + '  audioGaps=' + m.aG + ' (' + m.aT.toFixed(3) + 's)');
    return m;
  }

  L.push('10 identical spans, three out-point conventions, fresh duplicate each:');
  var c1 = runVariant('c1', 0);
  var c2 = runVariant('c2', -1);
  var c3 = runVariant('c3', 1);

  L.push('');
  var best = 'as-is', bestG = c1.vG + c1.aG;
  if (c2.vG + c2.aG < bestG) { best = 'out MINUS one frame'; bestG = c2.vG + c2.aG; }
  if (c3.vG + c3.aG < bestG) { best = 'out PLUS one frame'; bestG = c3.vG + c3.aG; }
  L.push('FEWEST GAPS: ' + best + ' (' + bestG + ' total)');
  L.push('Three disposable copies created; all can be deleted from the bin.');
  return L.join('\n');
})();
