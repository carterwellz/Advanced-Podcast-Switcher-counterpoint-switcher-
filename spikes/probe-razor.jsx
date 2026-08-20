/*
 * Razor verification, on a duplicate only.
 *
 * Clones the active sequence, opens the clone, makes one cut on the first video
 * track that has media, and reports what happened. The original sequence is never
 * touched. The clone is named so it is obvious it can be deleted.
 */
(function () {
  var L = [];
  function say(k, v) { L.push(k + ': ' + v); }
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }

  var original = app.project.activeSequence;
  if (!original) return 'NO ACTIVE SEQUENCE';
  say('originalSequence', original.name);

  var originalId = String(T(function () { return original.sequenceID; }, ''));

  // 1. Duplicate. clone() returns something unreadable in this build, but it does
  //    make the copy active by itself, so the active sequence is the source of truth.
  try { original.clone(); } catch (e) { say('cloneError', e.message); }

  var seq = app.project.activeSequence;
  say('activeNow', T(function () { return seq.name; }, '?'));

  // The only guard that matters: we must not be on the original.
  if (String(T(function () { return seq.sequenceID; }, '')) === originalId) {
    return L.join('\n') + '\nRESULT: still on the original sequence. Aborted before razoring.';
  }

  // 3. Frame rate, needed to build a timecode.
  var tb = Number(T(function () { return seq.timebase; }, 0));
  var fps = tb > 0 ? 254016000000 / tb : 30;
  say('timebase', tb);
  say('fps', fps);

  // 4. Find a track and a time that is genuinely inside a clip.
  var trackIndex = -1, at = -1, before = 0;
  for (var i = 0; i < seq.videoTracks.numTracks; i++) {
    var n = T(function () { return seq.videoTracks[i].clips.numItems; }, 0);
    if (!n) continue;
    for (var c = 0; c < n; c++) {
      var cs = Number(T(function () { return seq.videoTracks[i].clips[c].start.seconds; }, 0));
      var ce = Number(T(function () { return seq.videoTracks[i].clips[c].end.seconds; }, 0));
      if (ce - cs > 10) { trackIndex = i; at = cs + 5; before = n; break; }
    }
    if (trackIndex !== -1) break;
  }
  if (trackIndex === -1) return L.join('\n') + '\nRESULT: no clip longer than 10s to test on.';

  say('testTrack', 'V' + (trackIndex + 1));
  say('razorAtSeconds', at.toFixed(3));
  say('clipsBefore', before);

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tc(sec) {
    var f = Math.round(sec * fps);
    var r = Math.round(fps);
    return pad(Math.floor(f / fps / 3600)) + ':' + pad(Math.floor(f / fps / 60) % 60) + ':' +
           pad(Math.floor(f / fps) % 60) + ':' + pad(f % r);
  }

  app.enableQE();
  var qeTrack = T(function () { return qe.project.getActiveSequence().getVideoTrackAt(trackIndex); }, null);
  if (!qeTrack || typeof qeTrack.razor !== 'function') {
    return L.join('\n') + '\nRESULT: QE razor not available.';
  }

  // Try the formats razor is documented and rumoured to accept, stopping at the
  // first that actually increases the clip count.
  var attempts = [
    ['timecode', tc(at)],
    ['seconds', String(at)],
    ['ticks', String(Math.round(at * 254016000000))]
  ];

  var winner = null;
  for (var a = 0; a < attempts.length; a++) {
    var label = attempts[a][0], arg = attempts[a][1];
    var ret = T(function () { return qeTrack.razor(arg); }, 'threw');
    var now = Number(T(function () { return seq.videoTracks[trackIndex].clips.numItems; }, before));
    say('try:' + label, 'arg=' + arg + ' returned=' + ret + ' clips=' + now);
    if (now > before) { winner = label; before = now; break; }
  }

  say('clipsAfter', T(function () { return seq.videoTracks[trackIndex].clips.numItems; }, '?'));
  L.push('');
  L.push(winner
    ? 'RESULT: razor works. Accepted format = ' + winner
    : 'RESULT: razor did not split the clip in any format.');
  L.push('The copy "' + T(function () { return seq.name; }, '?') + '" can be deleted from the project bin.');
  return L.join('\n');
})();
