/*
 * What gap-closing / ripple tools actually exist on this build?
 *
 * extract() leaves a one-frame hole on ~30% of video cuts even with perfectly
 * frame-aligned spans, and nudging the boundary off the frame line makes it worse
 * (every cut gaps). So the fix is not in how the span is expressed. Either another
 * API does a clean ripple, or gaps have to be closed as a second pass.
 *
 * QE objects do not enumerate under for...in, so this existence-checks likely names
 * directly. Read-only: checks typeof, calls nothing.
 */
(function () {
  app.enableQE();
  var L = [];
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR'; } }

  function check(getObj, label, names) {
    L.push('=== ' + label + ' ===');
    var obj = T(getObj, null);
    if (!obj || obj === 'ERR') { L.push('  (unavailable)'); L.push(''); return; }
    var found = [], missing = [];
    for (var i = 0; i < names.length; i++) {
      var t = T((function (o, n) { return function () { return typeof o[n]; }; })(obj, names[i]), 'undefined');
      if (t === 'function') found.push(names[i]); else missing.push(names[i]);
    }
    L.push('  PRESENT: ' + (found.length ? found.join(', ') : '(none)'));
    L.push('  absent:  ' + missing.join(', '));
    L.push('');
  }

  var seqNames = ['extract', 'lift', 'closeGap', 'closeGaps', 'deleteGap', 'deleteGaps',
    'rippleDelete', 'rippleTrim', 'remove', 'razor', 'insert', 'overwrite',
    'setInPoint', 'setOutPoint', 'getInPoint', 'getOutPoint', 'trim', 'deleteInToOut'];
  check(function () { return qe.project.getActiveSequence(); }, 'qeSequence', seqNames);

  var trackNames = ['closeGap', 'closeGaps', 'deleteGap', 'deleteGaps', 'razor', 'remove',
    'rippleDelete', 'getItemAt', 'numItems', 'insert', 'overwrite', 'setTargeted', 'isTargeted'];
  check(function () { return qe.project.getActiveSequence().getVideoTrackAt(0); }, 'qeVideoTrack', trackNames);

  var domTrackNames = ['insertClip', 'overwriteClip', 'isTargeted', 'setTargeted', 'isLocked',
    'setLocked', 'isMuted', 'setMute'];
  check(function () { return app.project.activeSequence.videoTracks[0]; }, 'DOM VideoTrack', domTrackNames);

  var itemNames = ['remove', 'move', 'setStart', 'setEnd', 'getSpeed', 'isSelected', 'setSelected'];
  check(function () { return app.project.activeSequence.videoTracks[0].clips[0]; }, 'DOM TrackItem', itemNames);

  var domSeqNames = ['setInPoint', 'setOutPoint', 'getInPoint', 'getOutPoint', 'clone',
    'exportAsMediaDirect', 'createSubsequence', 'getSettings', 'setSettings'];
  check(function () { return app.project.activeSequence; }, 'DOM Sequence', domSeqNames);

  return L.join('\n');
})();
