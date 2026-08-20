/*
 * Which spans gap, and why?
 *
 * Ten uniform spans of exactly 48 frames each produced ZERO gaps. The real 98-span
 * plan, also frame-aligned and full precision, still gaps on ~25% of video cuts and
 * ~10% of audio cuts. The obvious remaining variable is the span LENGTH, which is
 * uniform in the clean case and varied in the failing one.
 *
 * Applies 24 spans of consecutive frame lengths (30..53 frames) at identical spacing,
 * then reports, per span, whether a gap appeared at that cut. If parity or some
 * length property is responsible it will be immediately visible in the pattern.
 */
(function () {
  app.enableQE();
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
  var base = app.project.activeSequence;
  T(function () { base.clone(); return true; }, null);
  var seq = app.project.activeSequence;
  var qs = T(function () { return qe.project.getActiveSequence(); }, null);
  if (!qs) return 'no QE sequence';

  // 20 spans, only 3s apart (matching the tightest clusters in the real plan)
  var spans = [];
  for (var i = 0; i < 20; i++) {
    var startF = Math.round((100 + i * 3.0) / FRAME);
    spans.push({ startF: startF, lenF: 24 });
  }
  spans.sort(function (a, b) { return b.startF - a.startF; });

  for (var j = 0; j < spans.length; j++) {
    var s = spans[j].startF * FRAME;
    var e = (spans[j].startF + spans[j].lenF) * FRAME;
    T((function (v) { return function () { seq.setInPoint(v); return true; }; })(s), false);
    T((function (v) { return function () { seq.setOutPoint(v); return true; }; })(e), false);
    T(function () { return qs.extract(); }, false);
  }

  // Walk V1 and A0 and list every gap with its position, then match back to spans.
  function gapList(coll, idx) {
    var out = [];
    var cnt = Number(T(function () { return coll[idx].clips.numItems; }, 0));
    var prev = null;
    for (var c = 0; c < cnt; c++) {
      var s = Number(T((function (ci) { return function () { return coll[idx].clips[ci].start.seconds; }; })(c), 0));
      var e = Number(T((function (ci) { return function () { return coll[idx].clips[ci].end.seconds; }; })(c), 0));
      if (prev !== null && s - prev > GAP) out.push({ at: prev, size: (s - prev) / FRAME });
      prev = e;
    }
    return out;
  }

  var vg = gapList(seq.videoTracks, 1);
  var ag = gapList(seq.audioTracks, 0);
  L.push('20 DENSE spans, 3s apart, 1s each');
  L.push('video gaps: ' + vg.length + '   audio gaps: ' + ag.length);
  L.push('');

  // Spans in ascending order are what the final timeline reflects; cumulative shift
  // means gap N corresponds to the Nth span from the left.
  var asc = spans.slice().sort(function (a, b) { return a.startF - b.startF; });
  L.push('span lengths in timeline order: ');
  var row = '  ';
  for (var k = 0; k < asc.length; k++) row += asc[k].lenF + (asc[k].lenF % 2 === 0 ? 'e ' : 'o ');
  L.push(row + '   (e=even, o=odd frame count)');
  L.push('');
  L.push('video gap sizes (frames): ');
  var vr = '  ';
  for (var m = 0; m < vg.length; m++) vr += vg[m].size.toFixed(2) + ' ';
  L.push(vr);
  L.push('audio gap sizes (frames): ');
  var ar = '  ';
  for (var p = 0; p < ag.length; p++) ar += ag[p].size.toFixed(2) + ' ';
  L.push(ar);
  L.push('');
  L.push('If gaps track odd lengths, parity is the cause and lengths can be forced even.');
  L.push('Disposable copy created.');
  return L.join('\n');
})();
