/*
 * Read-only. Why did detect-trim get a range of 7529.81 - 9857.72 on a sequence
 * that is only 2327.87 seconds long?
 *
 * Hypothesis: this sequence's start timecode (zeroPoint) is non-zero, so
 * seq.getInPoint()/getOutPoint() report absolute time INCLUDING that offset, while
 * seq.end and every clip's start.seconds are zero-based. cpswReadSequence() mixes
 * the two, so a set in/out point lands far outside the sequence's own coordinates.
 *
 * Changes nothing. Reads the active sequence only.
 */
(function () {
  var L = [];
  function say(k, v) { L.push(k + ': ' + v); }
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }
  var TICKS = 254016000000;

  var s = app.project.activeSequence;
  if (!s) return 'NO ACTIVE SEQUENCE';

  say('sequence', T(function () { return s.name; }, '?'));
  say('zeroPointRaw', T(function () { return s.zeroPoint; }, 'ABSENT'));
  say('zeroPointSec', Number(T(function () { return Number(s.zeroPoint) / TICKS; }, -1)));
  say('endRaw', T(function () { return s.end; }, '?'));
  say('endSec', Number(T(function () { return Number(s.end) / TICKS; }, -1)));
  say('getInPoint', T(function () { return s.getInPoint(); }, '?'));
  say('getOutPoint', T(function () { return s.getOutPoint(); }, '?'));
  say('V0.firstClip.start.seconds', T(function () { return s.videoTracks[0].clips[0].start.seconds; }, '?'));
  say('V0.lastClip.end.seconds', T(function () {
    var n = s.videoTracks[0].clips.numItems;
    return s.videoTracks[0].clips[n - 1].end.seconds;
  }, '?'));

  L.push('');
  var zp = Number(T(function () { return Number(s.zeroPoint) / TICKS; }, 0));
  var ip = Number(T(function () { return Number(s.getInPoint()); }, -400000));
  if (zp > 1 && ip > -1000) {
    say('inPoint MINUS zeroPoint', (ip - zp).toFixed(4) + '  <-- if this is a sane in-sequence time, the zeroPoint offset is the bug');
  } else if (zp > 1) {
    say('note', 'zeroPoint is non-zero (' + zp.toFixed(4) + 's) but in/out are currently unset, which matches extract() having cleared them.');
  } else {
    say('note', 'zeroPoint is zero or unreadable on this sequence.');
  }
  return L.join('\n');
})();
