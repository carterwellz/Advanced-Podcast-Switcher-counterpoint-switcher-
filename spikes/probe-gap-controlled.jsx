/*
 * Controlled A/B: does frame-snapping remove the video gaps, or not?
 *
 * Earlier attempts were contaminated: they applied to "Part 2 Copy", which already
 * carried 49 video gaps from the failing run, and compared numbers taken at two
 * different gap thresholds. This starts from the untouched original every time, uses
 * ONE threshold throughout, and runs both arms back to back.
 *
 * Arm A: spans deliberately NOT frame-aligned (reproduces the bug).
 * Arm B: the same spans snapped to frame boundaries (tests the fix).
 *
 * Both arms run on their own fresh duplicate. The original is never modified.
 * Expects host.jsx concatenated ahead of it.
 */
(function () {
  var L = [];
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }
  var FRAME = 1001 / 24000;
  var GAP_THRESHOLD = FRAME * 0.5; // one threshold, used for every measurement below

  function findSequenceByName(name) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (String(T(function () { return s.name; }, '')) === name) return s;
    }
    return null;
  }

  function measure(seq, label) {
    var vGaps = 0, vTotal = 0, aGaps = 0, aTotal = 0, vClips = 0, aClips = 0;
    function scan(coll, isVideo) {
      var n = Number(T(function () { return coll.numTracks; }, 0));
      for (var i = 0; i < n; i++) {
        var cnt = Number(T((function (x) { return function () { return coll[x].clips.numItems; }; })(i), 0));
        if (cnt === 0) continue;
        if (isVideo) vClips += cnt; else aClips += cnt;
        var prevEnd = null;
        for (var c = 0; c < cnt; c++) {
          var s = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].start.seconds; }; })(i, c), 0));
          var e = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].end.seconds; }; })(i, c), 0));
          if (prevEnd !== null && s - prevEnd > GAP_THRESHOLD) {
            if (isVideo) { vGaps++; vTotal += s - prevEnd; } else { aGaps++; aTotal += s - prevEnd; }
          }
          prevEnd = e;
        }
      }
    }
    scan(seq.videoTracks, true);
    scan(seq.audioTracks, false);
    L.push('  ' + label + ':  video ' + vClips + ' clips / ' + vGaps + ' gaps (' + vTotal.toFixed(3) + 's)'
      + '   audio ' + aClips + ' clips / ' + aGaps + ' gaps (' + aTotal.toFixed(3) + 's)');
    return { vGaps: vGaps, aGaps: aGaps };
  }

  var original = findSequenceByName('Part 2');
  if (!original) return 'Could not find a sequence named exactly "Part 2".';
  T(function () { app.project.openSequence(original.sequenceID); return true; }, false);
  var base = app.project.activeSequence;
  L.push('BASELINE, untouched original "' + T(function () { return base.name; }, '?') + '":');
  measure(base, 'baseline');
  L.push('');

  // Build both plans from the same underlying spans.
  function writePlan(path, aligned) {
    var lines = ['MODE ripple', 'DUPLICATE 1', 'RANGE 0.000000 2300.000000'];
    var spans = [];
    for (var i = 0; i < 12; i++) {
      var rawStart = 100 + i * 150 + 0.017;   // deliberately off-frame
      var rawEnd = rawStart + 2.031;
      var s = rawStart, e = rawEnd;
      if (aligned) {
        s = Math.ceil(rawStart / FRAME) * FRAME;
        e = Math.floor(rawEnd / FRAME) * FRAME;
      }
      spans.push([s, e]);
    }
    spans.sort(function (a, b) { return b[0] - a[0]; });
    for (var j = 0; j < spans.length; j++) {
      lines.push('REMOVE ' + spans[j][0].toFixed(6) + ' ' + spans[j][1].toFixed(6));
    }
    var f = new File(path);
    f.open('w'); f.write(lines.join('\n')); f.close();
  }

  var pathA = Folder.temp.fsName + '/cpsw-armA.txt';
  var pathB = Folder.temp.fsName + '/cpsw-armB.txt';
  writePlan(pathA, false);
  writePlan(pathB, true);

  // --- Arm A: unaligned ---
  T(function () { app.project.openSequence(original.sequenceID); return true; }, false);
  var rA = cpswApplyTrimPlan(pathA);
  L.push('ARM A, spans NOT frame-aligned:');
  L.push('    ' + rA);
  var a = measure(app.project.activeSequence, 'after A');
  L.push('');

  // --- Arm B: aligned ---
  T(function () { app.project.openSequence(original.sequenceID); return true; }, false);
  var rB = cpswApplyTrimPlan(pathB);
  L.push('ARM B, spans SNAPPED to frame boundaries:');
  L.push('    ' + rB);
  var b = measure(app.project.activeSequence, 'after B');

  L.push('');
  L.push('VERDICT: unaligned video gaps=' + a.vGaps + ', aligned video gaps=' + b.vGaps
    + (b.vGaps < a.vGaps ? '  -> snapping helps' : (b.vGaps === a.vGaps ? '  -> snapping makes NO difference, cause is elsewhere' : '  -> snapping made it worse')));
  L.push('Two disposable copies were created; both can be deleted from the bin.');
  return L.join('\n');
})();
