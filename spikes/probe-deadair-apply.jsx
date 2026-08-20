/*
 * Does a real dead-air trim plan actually cut and ripple the AUDIO tracks?
 *
 * Carter's report is that he ran dead air and saw no cuts in the audio at all. The
 * mechanism itself was proven by probe-audio-ripple.jsx, so this runs the real
 * 52-span plan that build-trim-plan.ts just produced from real Episode 30 analysis,
 * through the real cpswApplyTrimPlan in host.jsx, and reports audio clip counts and
 * track ends before and after.
 *
 * Expects host.jsx to have been concatenated ahead of this file, so
 * cpswApplyTrimPlan and its helpers are already defined. Runs on a duplicate
 * (DUPLICATE 1 in the plan), so the sequence it is launched from is never touched.
 */
(function () {
  var L = [];
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }

  function audioReport(seq) {
    var out = [];
    var an = Number(T(function () { return seq.audioTracks.numTracks; }, 0));
    for (var i = 0; i < an; i++) {
      var n = Number(T((function (x) { return function () { return seq.audioTracks[x].clips.numItems; }; })(i), 0));
      if (n <= 0) continue;
      var last = Number(T((function (x, c) { return function () { return seq.audioTracks[x].clips[c].end.seconds; }; })(i, n - 1), 0));
      out.push('    A' + i + '  clips=' + n + '  trackEnd=' + last.toFixed(2) + 's');
    }
    return out.join('\n');
  }

  var planPath = 'C:\\Users\\carte\\AppData\\Local\\Temp\\counterpoint-switcher\\deadair.trim.txt';

  var original = app.project.activeSequence;
  if (!original) return 'NO ACTIVE SEQUENCE';

  L.push('BEFORE  (' + T(function () { return original.name; }, '?') + ')');
  L.push(audioReport(original));

  var res = cpswApplyTrimPlan(planPath);
  L.push('');
  L.push('cpswApplyTrimPlan returned:');
  L.push('  ' + res);

  var now = app.project.activeSequence;
  L.push('');
  L.push('AFTER   (' + T(function () { return now.name; }, '?') + ')');
  L.push(audioReport(now));

  return L.join('\n');
})();
