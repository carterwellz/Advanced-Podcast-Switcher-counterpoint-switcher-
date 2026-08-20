/*
 * End-to-end test of the REAL cpswApplyTrimPlan implementation now in host.jsx,
 * run against a real duplicate via the bridge before trusting it's wired
 * correctly into the panel. Defines the same helper functions host.jsx has
 * (cpswTry, cpswEsc, cpswNum, cpswDuplicateSequence, cpswApplyTrimPlan) inline,
 * since the bridge's ExtendScript engine is a separate context from the
 * Counterpoint Switcher panel's own and does not share its function definitions.
 * Copy-checked against cep/jsx/host.jsx to stay identical.
 *
 * Builds a small trim plan (two REMOVE spans, latest-first, DUPLICATE 1) against
 * whatever sequence is active, applies it, and reports the result plus a
 * before/after sanity check on total sequence length.
 */
(function () {
  function cpswEsc(s) {
    s = String(s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 32) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
      else out += c;
    }
    return '"' + out + '"';
  }
  function cpswNum(v) {
    if (v === null || v === undefined) return 'null';
    var n = Number(v);
    return isFinite(n) ? String(n) : 'null';
  }
  function cpswTry(fn, fallback) {
    try {
      var v = fn();
      return (v === undefined || v === null) ? fallback : v;
    } catch (e) { return fallback; }
  }
  function cpswDuplicateSequence(seq) {
    var originalId = String(cpswTry(function () { return seq.sequenceID; }, ''));
    cpswTry(function () { seq.clone(); return true; }, null);
    var now = app.project.activeSequence;
    var nowId = String(cpswTry(function () { return now.sequenceID; }, ''));
    if (!now || nowId === originalId) return null;
    return now;
  }

  function cpswApplyTrimPlan(planPath) {
    try {
      var f = new File(planPath);
      if (!f.exists) return '{"ok":false,"error":"Trim plan file not found"}';
      f.open('r');
      var text = f.read();
      f.close();

      var duplicate = false;
      var removals = [];

      var lines = text.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].replace(/[\r\n]+$/, '').split(' ');
        if (parts[0] === 'DUPLICATE') duplicate = parts[1] === '1';
        else if (parts[0] === 'REMOVE') removals.push([Number(parts[1]), Number(parts[2])]);
      }

      if (removals.length === 0) return '{"ok":false,"error":"Trim plan has no REMOVE directives"}';

      app.enableQE();
      var seq = app.project.activeSequence;
      if (!seq) return '{"ok":false,"error":"No active sequence"}';

      if (duplicate) {
        var duped = cpswDuplicateSequence(seq);
        if (!duped) {
          return '{"ok":false,"error":"Could not duplicate the sequence, and refused to write to the original. Duplicate it yourself, or turn off Work on a duplicate."}';
        }
        seq = duped;
      }

      var qeSeq = cpswTry(function () { return qe.project.getActiveSequence(); }, null);
      if (!qeSeq || typeof qeSeq.extract !== 'function') {
        return '{"ok":false,"error":"qe.project.getActiveSequence().extract is not available on this Premiere build."}';
      }

      function sequenceTailSeconds() {
        var tail = 0;
        var vn = cpswTry(function () { return seq.videoTracks.numTracks; }, 0);
        for (var v = 0; v < vn; v++) {
          var n = cpswTry((function (idx) { return function () { return seq.videoTracks[idx].clips.numItems; }; })(v), 0);
          if (n === 0) continue;
          var e = cpswTry((function (idx, ci) { return function () { return seq.videoTracks[idx].clips[ci].end.seconds; }; })(v, n - 1), 0);
          if (e > tail) tail = e;
        }
        return tail;
      }

      var before = sequenceTailSeconds();
      var removed = 0;

      for (var r = 0; r < removals.length; r++) {
        var start = removals[r][0], end = removals[r][1];
        if (!(end > start)) continue;
        var setIn = cpswTry(function () { seq.setInPoint(start); return true; }, false);
        var setOut = cpswTry(function () { seq.setOutPoint(end); return true; }, false);
        if (!setIn || !setOut) continue;
        var ok = cpswTry(function () { return qeSeq.extract(); }, false);
        if (ok) removed++;
      }

      var after = sequenceTailSeconds();
      var totalRemovedSeconds = before - after;

      return '{"ok":true,"sequence":' + cpswEsc(seq.name)
        + ',"duplicated":' + (duplicate ? 'true' : 'false')
        + ',"removed":' + removed
        + ',"totalRemovedSeconds":' + cpswNum(totalRemovedSeconds) + '}';
    } catch (e) {
      return '{"ok":false,"error":' + cpswEsc(e.message) + '}';
    }
  }

  // --- driver: build a real, small, two-removal plan against the active sequence ---
  var seq0 = app.project.activeSequence;
  if (!seq0) return '{"ok":false,"error":"NO ACTIVE SEQUENCE"}';

  // Find two short, well-separated, gap-free spans inside real clips so the test
  // exercises the descending-order contract (later interval removed first) for real.
  var spans = [];
  for (var t = 0; t < seq0.videoTracks.numTracks && spans.length < 2; t++) {
    var n = cpswTry((function (ti) { return function () { return seq0.videoTracks[ti].clips.numItems; }; })(t), 0);
    for (var c = 0; c < n && spans.length < 2; c++) {
      var cs = Number(cpswTry((function (ti, ci) { return function () { return seq0.videoTracks[ti].clips[ci].start.seconds; }; })(t, c), 0));
      var ce = Number(cpswTry((function (ti, ci) { return function () { return seq0.videoTracks[ti].clips[ci].end.seconds; }; })(t, c), 0));
      if (ce - cs > 20) {
        spans.push([cs + 5, cs + 6]);
        spans.push([cs + 12, cs + 13]);
      }
    }
  }
  if (spans.length < 2) return '{"ok":false,"error":"Could not find a clip long enough to build a two-span test plan."}';

  // Descending order, exactly the contract sortDescendingForRipple() enforces.
  spans.sort(function (a, b) { return b[0] - a[0]; });

  var planLines = ['MODE ripple', 'DUPLICATE 1', 'RANGE 0 100000'];
  for (var s = 0; s < spans.length; s++) {
    planLines.push('REMOVE ' + spans[s][0].toFixed(4) + ' ' + spans[s][1].toFixed(4));
  }
  var planText = planLines.join('\n');

  var planFile = new File(Folder.temp.fsName + '/cpsw-test-trim.txt');
  planFile.open('w');
  planFile.write(planText);
  planFile.close();

  var expectedRemoved = (spans[0][1] - spans[0][0]) + (spans[1][1] - spans[1][0]);
  var result = cpswApplyTrimPlan(planFile.fsName);

  return 'planFile: ' + planFile.fsName + '\nplan:\n' + planText +
    '\n\nexpectedRemovedSeconds: ' + expectedRemoved.toFixed(3) +
    '\n\ncpswApplyTrimPlan result:\n' + result;
})();
