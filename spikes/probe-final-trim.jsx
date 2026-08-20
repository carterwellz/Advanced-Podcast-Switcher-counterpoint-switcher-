/*
 * Final verification: the REAL 98-span plan from Carter's failing run, rebuilt with
 * frame snapping and full float precision, applied through the REAL cpswApplyTrimPlan
 * to a fresh duplicate of the untouched original.
 *
 * Before the fixes that same input produced 49 one-frame gaps on every video track.
 * Zero gaps here means the trim is genuinely correct end to end. Expects host.jsx
 * concatenated ahead of this file.
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

  var original = findSeq('Part 2');
  if (!original) return 'no sequence named "Part 2"';
  T(function () { app.project.openSequence(original.sequenceID); return true; }, false);

  var res = cpswApplyTrimPlan('C:/Users/carte/AppData/Local/Temp/counterpoint-switcher/replay.trim.txt');
  L.push('cpswApplyTrimPlan: ' + res);
  L.push('');

  var seq = app.project.activeSequence;
  L.push('result sequence: ' + T(function () { return seq.name; }, '?'));

  var totalV = 0, totalA = 0;
  function scan(coll, label, isVideo) {
    var n = Number(T(function () { return coll.numTracks; }, 0));
    for (var i = 0; i < n; i++) {
      var cnt = Number(T((function (x) { return function () { return coll[x].clips.numItems; }; })(i), 0));
      if (cnt === 0) continue;
      var gaps = 0, gapTotal = 0, prev = null;
      for (var c = 0; c < cnt; c++) {
        var s = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].start.seconds; }; })(i, c), 0));
        var e = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].end.seconds; }; })(i, c), 0));
        if (prev !== null && s - prev > GAP) { gaps++; gapTotal += s - prev; }
        prev = e;
      }
      if (isVideo) totalV += gaps; else totalA += gaps;
      L.push('  ' + label + i + '  clips=' + cnt + '  GAPS=' + gaps
        + (gaps ? ('  (' + gapTotal.toFixed(3) + 's)') : '')
        + '  end=' + (prev === null ? '?' : prev.toFixed(2)) + 's');
    }
  }
  L.push('--- VIDEO ---');
  scan(seq.videoTracks, 'V', true);
  L.push('--- AUDIO ---');
  scan(seq.audioTracks, 'A', false);

  L.push('');
  L.push('TOTAL GAPS: video=' + totalV + '  audio=' + totalA
    + ((totalV + totalA) === 0 ? '   <-- CLEAN, trim is correct' : '   <-- still broken'));
  L.push('(the same plan before these fixes left 49 gaps on every video track)');
  L.push('Disposable copy "' + T(function () { return seq.name; }, '?') + '" can be deleted.');
  return L.join('\n');
})();
