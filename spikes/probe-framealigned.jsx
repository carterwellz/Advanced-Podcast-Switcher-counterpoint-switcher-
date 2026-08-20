/*
 * Does snapping removal spans to frame boundaries actually eliminate the video gaps?
 *
 * The failing run left 0 gaps on audio and 49 two-frame gaps on every video track,
 * from 98 spans of which none were frame-aligned at either end. This applies a plan
 * whose spans ARE all frame-aligned, to a duplicate, and scans every track for gaps
 * afterwards. Expects host.jsx concatenated ahead of it.
 */
(function () {
  var L = [];
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }

  var res = cpswApplyTrimPlan('C:/Users/carte/AppData/Local/Temp/counterpoint-switcher/framealigned.trim.txt');
  L.push('cpswApplyTrimPlan: ' + res);

  var seq = app.project.activeSequence;
  L.push('now on: ' + T(function () { return seq.name; }, '?'));
  L.push('');

  var FRAME = 1001 / 24000;
  function scan(coll, label) {
    var n = Number(T(function () { return coll.numTracks; }, 0));
    for (var i = 0; i < n; i++) {
      var cnt = Number(T((function (x) { return function () { return coll[x].clips.numItems; }; })(i), 0));
      if (cnt === 0) continue;
      var gaps = 0, gapTotal = 0, prevEnd = null;
      for (var c = 0; c < cnt; c++) {
        var s = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].start.seconds; }; })(i, c), 0));
        var e = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].end.seconds; }; })(i, c), 0));
        if (prevEnd !== null && s - prevEnd > FRAME * 0.5) { gaps++; gapTotal += s - prevEnd; }
        prevEnd = e;
      }
      L.push('  ' + label + i + '  clips=' + cnt + '  GAPS=' + gaps
        + (gaps ? ('  gapTotal=' + gapTotal.toFixed(3) + 's') : '')
        + '  end=' + (prevEnd === null ? '?' : prevEnd.toFixed(2)) + 's');
    }
  }
  L.push('--- VIDEO ---');
  scan(seq.videoTracks, 'V');
  L.push('--- AUDIO ---');
  scan(seq.audioTracks, 'A');
  L.push('');
  L.push('Before the fix: video showed 49 gaps per track. Zero here means snapping worked.');
  L.push('The copy "' + T(function () { return seq.name; }, '?') + '" is disposable.');
  return L.join('\n');
})();
