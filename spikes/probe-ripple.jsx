/*
 * Ripple-delete verification, on a duplicate only.
 *
 * Nothing in host.jsx has ever removed time from a sequence. cpswApplyPlan only
 * ever disables or removes(false,false)s a clip in place, which leaves a gap, not
 * a ripple. Dead-air and filler-word trim both need a real ripple: cut a span out
 * of a track and have everything after it shift left to close the gap, on every
 * video and audio track together, with sync preserved.
 *
 * This is judged by OBSERVED EFFECT (clip count and position before/after), the
 * same discipline probe-razor.jsx already used for razor's argument format, not by
 * trusting what any call claims to return. Clones the active sequence, opens the
 * clone, never touches the original.
 *
 * What this tries, in order of confidence:
 *
 *   1. DOM TrackItem.remove(true, false) -- documented Adobe scripting API,
 *      (ripple, alignToVideo). cpswApplyPlan's existing remove(false, false) call
 *      already flags those two args as almost certainly this signature with both
 *      left off. Highest confidence candidate, tried first, on one video track.
 *   2. The same call on the matching audio track, independently, to check whether
 *      applying it per-track (once per track, same absolute [start,end)) is a
 *      viable fallback if there is no sequence-wide primitive: if every track
 *      loses the identical stretch, sync holds regardless of how many separate
 *      calls it took.
 *   3. Whether sequence getInPoint()/getOutPoint() shift on their own as a side
 *      effect of either removal, or need to be recomputed and set by hand.
 *   4. A handful of QE method NAMES, existence-checked only (typeof === 'function'),
 *      never called -- QE is undocumented and reverse-engineered by convention, so
 *      guessing at behavior here would be worse than not trying at all. This is
 *      purely a discovery aid for a follow-up probe if DOM remove(true,...) turns
 *      out not to ripple.
 */
(function () {
  var L = [];
  function say(k, v) { L.push(k + ': ' + v); }
  function T(fn, fb) { try { var v = fn(); return (v === undefined || v === null) ? fb : v; } catch (e) { return 'ERR(' + e.message + ')'; } }

  var original = app.project.activeSequence;
  if (!original) return 'NO ACTIVE SEQUENCE';
  say('originalSequence', original.name);
  var originalId = String(T(function () { return original.sequenceID; }, ''));

  try { original.clone(); } catch (e) { say('cloneError', e.message); }
  var seq = app.project.activeSequence;
  say('activeNow', T(function () { return seq.name; }, '?'));

  if (String(T(function () { return seq.sequenceID; }, '')) === originalId) {
    return L.join('\n') + '\nRESULT: still on the original sequence. Aborted before removing anything.';
  }

  var tb = Number(T(function () { return seq.timebase; }, 0));
  var fps = tb > 0 ? 254016000000 / tb : 30;
  say('fps', fps);

  // --- find a video track/clip pair with a real neighbour to watch shift -------
  var vTrackIndex = -1, vClipIndex = -1, vCutAt = -1, vClipsBefore = 0, vNeighbourStartBefore = null;
  for (var i = 0; i < seq.videoTracks.numTracks; i++) {
    var n = T(function () { return seq.videoTracks[i].clips.numItems; }, 0);
    for (var c = 0; c < n - 1; c++) {
      var cs = Number(T((function (ti, ci) { return function () { return seq.videoTracks[ti].clips[ci].start.seconds; }; })(i, c), 0));
      var ce = Number(T((function (ti, ci) { return function () { return seq.videoTracks[ti].clips[ci].end.seconds; }; })(i, c), 0));
      var nextStart = Number(T((function (ti, ci) { return function () { return seq.videoTracks[ti].clips[ci + 1].start.seconds; }; })(i, c), -1));
      // A genuine gap-free neighbour, and enough room in this clip to cut cleanly
      // a couple seconds from its tail without touching its own start.
      if (ce - cs > 6 && Math.abs(nextStart - ce) < 0.01) {
        vTrackIndex = i; vClipIndex = c; vCutAt = ce - 2; vClipsBefore = n; vNeighbourStartBefore = nextStart;
        break;
      }
    }
    if (vTrackIndex !== -1) break;
  }
  if (vTrackIndex === -1) {
    return L.join('\n') + '\nRESULT: no video clip with a clean, gap-free neighbour found to test on. Try a different in/out range.';
  }
  say('videoTestTrack', 'V' + (vTrackIndex + 1));
  say('videoClipsBefore', vClipsBefore);
  say('videoNeighbourStartBefore', vNeighbourStartBefore.toFixed(3));

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tc(sec) {
    var f = Math.round(sec * fps);
    var r = Math.round(fps);
    return pad(Math.floor(f / fps / 3600)) + ':' + pad(Math.floor(f / fps / 60) % 60) + ':' +
           pad(Math.floor(f / fps) % 60) + ':' + pad(f % r);
  }

  app.enableQE();
  var qeSeq = T(function () { return qe.project.getActiveSequence(); }, null);
  var qeVTrack = T(function () { return qeSeq.getVideoTrackAt(vTrackIndex); }, null);

  say('inPointBefore', T(function () { return seq.getInPoint(); }, '?'));
  say('outPointBefore', T(function () { return seq.getOutPoint(); }, '?'));

  // --- candidate 1: DOM TrackItem.remove(true, false) on video -----------------
  var removedDurationSec = 2; // vCutAt is 2s before the clip's own end
  var razorOk = qeVTrack && typeof qeVTrack.razor === 'function'
    ? T(function () { return qeVTrack.razor(tc(vCutAt)); }, 'threw')
    : 'no razor';
  say('videoRazorAt', tc(vCutAt) + ' -> ' + razorOk);

  var clipsAfterRazor = Number(T(function () { return seq.videoTracks[vTrackIndex].clips.numItems; }, vClipsBefore));
  say('videoClipsAfterRazor', clipsAfterRazor);

  var removeResult = 'not attempted (razor did not split)';
  var neighbourStartAfter = vNeighbourStartBefore;
  if (clipsAfterRazor > vClipsBefore) {
    // The razor split vClipIndex into two; the new tail piece (index vClipIndex+1)
    // is the ~2s sliver ending at the clip's original end. Remove THAT with ripple.
    var tailIndex = vClipIndex + 1;
    removeResult = T((function (ti, ci) { return function () {
      return seq.videoTracks[ti].clips[ci].remove(true, false);
    }; })(vTrackIndex, tailIndex), 'threw');
    say('videoRemoveRippleTrue', String(removeResult));

    var clipsAfterRemove = Number(T(function () { return seq.videoTracks[vTrackIndex].clips.numItems; }, clipsAfterRazor));
    say('videoClipsAfterRemove', clipsAfterRemove);

    // Whatever is now at vClipIndex+1 (the old neighbour, however removal shuffled
    // indices) -- find the clip whose name matches, or just re-scan by position.
    neighbourStartAfter = null;
    for (var k = 0; k < clipsAfterRemove; k++) {
      var s = Number(T((function (ti, ki) { return function () { return seq.videoTracks[ti].clips[ki].start.seconds; }; })(vTrackIndex, k), -1));
      if (s > vCutAt - 0.01 && s < vNeighbourStartBefore + 0.01 && s > vCutAt) { neighbourStartAfter = s; }
    }
    // Fallback: just take the clip immediately at-or-after the cut point.
    if (neighbourStartAfter === null) {
      for (var k2 = 0; k2 < clipsAfterRemove; k2++) {
        var s2 = Number(T((function (ti, ki) { return function () { return seq.videoTracks[ti].clips[ki].start.seconds; }; })(vTrackIndex, k2), -1));
        if (s2 >= vCutAt - 0.01) { neighbourStartAfter = s2; break; }
      }
    }
  }

  say('videoNeighbourStartAfter', neighbourStartAfter === null ? 'NOT FOUND' : neighbourStartAfter.toFixed(3));
  var shiftedBy = (neighbourStartAfter === null) ? null : (vNeighbourStartBefore - neighbourStartAfter);
  say('videoNeighbourShiftedBySeconds', shiftedBy === null ? 'n/a' : shiftedBy.toFixed(3));

  var videoRippled = shiftedBy !== null && Math.abs(shiftedBy - removedDurationSec) < 0.05;
  say('videoRippleWorked', videoRippled ? 'YES, shifted by the removed duration' : 'NO');

  say('inPointAfterVideoOnly', T(function () { return seq.getInPoint(); }, '?'));
  say('outPointAfterVideoOnly', T(function () { return seq.getOutPoint(); }, '?'));

  // --- candidate: does the SAME operation on video also move AUDIO tracks? -----
  // If cpswApplyPlan's own comment is right that today's apply loop is video-only,
  // there is no reason to expect a per-track DOM call to touch other track types.
  // Check directly rather than assume.
  var audioUnaffected = 'no audio tracks to check';
  if (T(function () { return seq.audioTracks.numTracks; }, 0) > 0) {
    var aClipStart0 = T(function () { return seq.audioTracks[0].clips.numItems > 0 ? seq.audioTracks[0].clips[0].start.seconds : null; }, null);
    audioUnaffected = 'audioTracks[0].clips[0].start = ' + aClipStart0 + ' (compare across runs / by eye to confirm untouched by the video-only removal above)';
  }
  say('audioTrackCheck', audioUnaffected);

  // --- candidate 2: repeat the identical removal on the matching audio track ---
  // Only if there IS a matching audio track and clip geometry to test on.
  var audioRippleNote = 'not attempted';
  if (T(function () { return seq.audioTracks.numTracks; }, 0) > vTrackIndex) {
    var aN = T(function () { return seq.audioTracks[vTrackIndex].clips.numItems; }, 0);
    var aClipIndex = -1, aCutAt = -1, aNeighbourStartBefore = null;
    for (var ac = 0; ac < aN - 1; ac++) {
      var acs = Number(T((function (ci) { return function () { return seq.audioTracks[vTrackIndex].clips[ci].start.seconds; }; })(ac), 0));
      var ace = Number(T((function (ci) { return function () { return seq.audioTracks[vTrackIndex].clips[ci].end.seconds; }; })(ac), 0));
      var aNextStart = Number(T((function (ci) { return function () { return seq.audioTracks[vTrackIndex].clips[ci + 1].start.seconds; }; })(ac), -1));
      if (Math.abs(acs - (vCutAt - 2)) < 0.5 && Math.abs(aNextStart - ace) < 0.01) {
        aClipIndex = ac; aCutAt = vCutAt; aNeighbourStartBefore = aNextStart;
        break;
      }
    }
    if (aClipIndex !== -1) {
      var qeATrack = T(function () { return qeSeq.getAudioTrackAt(vTrackIndex); }, null);
      var aRazorOk = qeATrack && typeof qeATrack.razor === 'function'
        ? T(function () { return qeATrack.razor(tc(aCutAt)); }, 'threw')
        : 'no audio razor';
      say('audioRazorAt', tc(aCutAt) + ' -> ' + aRazorOk);
      var aClipsAfterRazor = Number(T(function () { return seq.audioTracks[vTrackIndex].clips.numItems; }, aN));
      if (aClipsAfterRazor > aN) {
        var aRemoveResult = T((function (ci) { return function () {
          return seq.audioTracks[vTrackIndex].clips[ci].remove(true, false);
        }; })(aClipIndex + 1), 'threw');
        say('audioRemoveRippleTrue', String(aRemoveResult));
        audioRippleNote = 'attempted, see audioRazorAt/audioRemoveRippleTrue above';
      } else {
        audioRippleNote = 'audio razor did not split, skipped remove';
      }
    } else {
      audioRippleNote = 'no matching gap-free audio clip pair found near the video cut point';
    }
  }
  say('audioRippleAttempt', audioRippleNote);

  // --- candidate 4: QE method existence only, never invoked --------------------
  L.push('');
  L.push('--- QE method existence (typeof check only, none of these were called) ---');
  var qeCandidates = ['extract', 'ripple', 'razorAndRipple', 'deleteAndRipple', 'rippleDelete', 'removeAndRipple'];
  for (var qc = 0; qc < qeCandidates.length; qc++) {
    var name = qeCandidates[qc];
    say('qeSequence.' + name, T(function () { return typeof qeSeq[name]; }, 'n/a'));
    say('qeVTrack.' + name, T(function () { return typeof qeVTrack[name]; }, 'n/a'));
  }

  L.push('');
  L.push('RESULT: ' + (videoRippled
    ? 'DOM TrackItem.remove(true, false) DOES ripple its own track. Use this as the primary mechanism, applied per-track.'
    : 'DOM TrackItem.remove(true, false) did NOT observably ripple. Needs a different mechanism -- check the QE existence dump above for a follow-up probe, or this may not be scriptable on this build at all.'));
  L.push('The copy "' + T(function () { return seq.name; }, '?') + '" can be deleted from the project bin.');
  return L.join('\n');
})();
