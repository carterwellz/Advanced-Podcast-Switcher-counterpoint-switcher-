/*
 * Read-only. Carter reports the trim left blank spaces instead of closing up, i.e.
 * it behaved like Lift rather than Extract on at least some tracks.
 *
 * probe-audio-ripple.jsx proved extract() ripples every video AND audio track on
 * "Part 2", where every audio track happened to be targeted. Premiere's Extract is
 * documented to act on TARGETED tracks and to respect SYNC LOCK, so the most likely
 * difference on a different sequence is different targeting/lock state.
 *
 * Measures the reported symptom directly: real gaps between consecutive clips on
 * every track, plus each track's targeted/locked state. Changes nothing.
 */
(function () {
  var L = [];
  function say(k, v) { L.push(k + ': ' + v); }
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }

  var seq = app.project.activeSequence;
  if (!seq) return 'NO ACTIVE SEQUENCE';
  say('sequence', T(function () { return seq.name; }, '?'));
  say('sequenceEnd', Number(T(function () { return Number(seq.end) / 254016000000; }, 0)).toFixed(2) + 's');

  // A gap is any place a clip starts later than the previous clip ended. Anything
  // above a frame is a real hole, not rounding.
  var FRAME = 1 / 23.976;
  function scan(coll, label) {
    var n = Number(T(function () { return coll.numTracks; }, 0));
    for (var i = 0; i < n; i++) {
      var cnt = Number(T((function (x) { return function () { return coll[x].clips.numItems; }; })(i), 0));
      if (cnt === 0) continue;

      var targeted = T((function (x) { return function () { return coll[x].isTargeted(); }; })(i), '?');
      var locked = T((function (x) { return function () { return coll[x].isLocked(); }; })(i), '?');

      var gaps = 0, gapTotal = 0, firstGapAt = null, prevEnd = null, firstStart = null;
      for (var c = 0; c < cnt; c++) {
        var s = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].start.seconds; }; })(i, c), 0));
        var e = Number(T((function (x, ci) { return function () { return coll[x].clips[ci].end.seconds; }; })(i, c), 0));
        if (firstStart === null) firstStart = s;
        if (prevEnd !== null && s - prevEnd > FRAME) {
          gaps++;
          gapTotal += s - prevEnd;
          if (firstGapAt === null) firstGapAt = prevEnd;
        }
        prevEnd = e;
      }

      L.push('  ' + label + i
        + '  clips=' + cnt
        + '  targeted=' + targeted
        + '  locked=' + locked
        + '  GAPS=' + gaps
        + (gaps ? ('  gapTotal=' + gapTotal.toFixed(2) + 's  firstGapAt=' + firstGapAt.toFixed(2) + 's') : '')
        + '  trackEnd=' + (prevEnd === null ? '?' : prevEnd.toFixed(2)) + 's');
    }
  }

  L.push('--- VIDEO ---');
  scan(seq.videoTracks, 'V');
  L.push('--- AUDIO ---');
  scan(seq.audioTracks, 'A');

  L.push('');
  L.push('If GAPS is 0 everywhere, the ripple closed up correctly and the blank spaces');
  L.push('are something else (disabled clips showing through, or the camera-cut pass).');
  L.push('If GAPS is non-zero, extract() lifted instead of rippling on those tracks,');
  L.push('and targeted/locked above is the first thing to correlate it against.');
  return L.join('\n');
})();
