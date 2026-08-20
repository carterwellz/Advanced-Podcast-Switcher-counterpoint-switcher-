/*
 * Counterpoint Switcher: Phase 0 read-only probe.
 *
 * READS ONLY. Sets no property, razors nothing, creates nothing, deletes nothing.
 * Answers spikes 3 and 4, and reports whether the `disabled` property exists on a
 * TrackItem without ever assigning to it.
 */
(function () {
  var L = [];
  function say(k, v) { L.push(k + ": " + v); }
  function tryGet(fn, fallback) {
    try { var v = fn(); return (v === undefined || v === null) ? fallback : v; }
    catch (e) { return fallback === undefined ? "ERR(" + e.message + ")" : fallback; }
  }

  say("appVersion", tryGet(function () { return app.version; }));
  say("buildNumber", tryGet(function () { return app.build; }, "n/a"));
  say("projectName", tryGet(function () { return app.project.name; }));

  var seq = tryGet(function () { return app.project.activeSequence; }, null);
  if (!seq) { return "NO ACTIVE SEQUENCE\n" + L.join("\n"); }

  say("sequenceName", tryGet(function () { return seq.name; }));
  say("sequenceID", tryGet(function () { return seq.sequenceID; }));
  say("timebase", tryGet(function () { return seq.timebase; }));
  say("zeroPoint", tryGet(function () { return seq.zeroPoint; }));
  say("end", tryGet(function () { return seq.end; }));

  // Spike 3: in/out points.
  say("getInPoint", tryGet(function () { return seq.getInPoint(); }));
  say("getOutPoint", tryGet(function () { return seq.getOutPoint(); }));
  say("inPointTicks", tryGet(function () { return seq.getInPointAsTime().ticks; }));
  say("outPointTicks", tryGet(function () { return seq.getOutPointAsTime().ticks; }));
  say("inPointSeconds", tryGet(function () { return seq.getInPointAsTime().seconds; }));
  say("outPointSeconds", tryGet(function () { return seq.getOutPointAsTime().seconds; }));

  var nV = tryGet(function () { return seq.videoTracks.numTracks; }, 0);
  var nA = tryGet(function () { return seq.audioTracks.numTracks; }, 0);
  say("numVideoTracks", nV);
  say("numAudioTracks", nA);

  var disabledProbe = "not-probed";

  function dumpTracks(coll, n, label) {
    for (var i = 0; i < n; i++) {
      var t = null;
      try { t = coll[i]; } catch (e) { L.push(label + i + " ERR " + e.message); continue; }

      var nClips = tryGet(function () { return t.clips.numItems; }, 0);
      var row = label + i
        + " | name=" + tryGet(function () { return t.name; }, "?")
        + " | clips=" + nClips
        + " | targeted=" + tryGet(function () { return t.isTargeted(); }, "?")
        + " | muted=" + tryGet(function () { return t.isMuted(); }, "?");
      L.push(row);

      // First two clips only, so the report stays readable on a long timeline.
      var show = nClips < 2 ? nClips : 2;
      for (var c = 0; c < show; c++) {
        (function (clip) {
          if (!clip) return;
          var path = tryGet(function () { return clip.projectItem.getMediaPath(); }, "NO-MEDIA-PATH");
          var isSeq = tryGet(function () { return clip.projectItem.isSequence(); }, "?");
          L.push("    " + label + i + ".clip" + c
            + " | name=" + tryGet(function () { return clip.name; }, "?")
            + " | start=" + tryGet(function () { return clip.start.seconds; }, "?")
            + " | end=" + tryGet(function () { return clip.end.seconds; }, "?")
            + " | inPoint=" + tryGet(function () { return clip.inPoint.seconds; }, "?")
            + " | isSequence=" + isSeq
            + " | type=" + tryGet(function () { return clip.type; }, "?")
            + " | mediaPath=" + path);

          // Spike 1, read half only. Does the property exist, and what is its current value?
          if (disabledProbe === "not-probed") {
            try {
              var d = clip.disabled;
              disabledProbe = (typeof d) + " (current value: " + d + ")";
            } catch (e) {
              disabledProbe = "THROWS: " + e.message;
            }
          }
        })(tryGet(function () { return t.clips[c]; }, null));
      }
    }
  }

  L.push("");
  L.push("--- VIDEO TRACKS ---");
  dumpTracks(tryGet(function () { return seq.videoTracks; }, []), nV, "V");
  L.push("");
  L.push("--- AUDIO TRACKS ---");
  dumpTracks(tryGet(function () { return seq.audioTracks; }, []), nA, "A");

  L.push("");
  L.push("--- CAPABILITY PROBES (read only) ---");
  say("trackItem.disabled", disabledProbe);
  say("qe available after enableQE", tryGet(function () {
    app.enableQE();
    return (typeof qe !== "undefined") ? "yes" : "no";
  }, "ERR"));
  say("qe sequence name", tryGet(function () { return qe.project.getActiveSequence().name; }, "ERR"));
  say("qe videoTrack0 has razor", tryGet(function () {
    return (typeof qe.project.getActiveSequence().getVideoTrackAt(0).razor === "function") ? "yes" : "no";
  }, "ERR"));
  say("qe numVideoTracks", tryGet(function () { return qe.project.getActiveSequence().numVideoTracks; }, "ERR"));

  return L.join("\n");
})();
