/* Counterpoint Switcher panel. */
(function () {
  'use strict';

  // Anything host-related can fail outside Premiere, or inside a Premiere whose CEP
  // runtime did not come up. None of it may take the UI down with it: a panel that
  // renders and says what is wrong beats a blank rectangle.
  var cs = null, hostError = null;
  try {
    cs = new CSInterface();
  } catch (e) {
    hostError = 'Not connected to Premiere (' + (e && e.message ? e.message : 'CEP unavailable') + ').';
  }

  var fs = null, path = null, os = null;
  try { fs = require('fs'); path = require('path'); os = require('os'); } catch (e) { /* no node */ }

  var state = {
    seq: null,
    speakers: [],
    angles: [],
    settings: cpswDefaultSettings(),
    templateName: '',
    plan: null,
    // Dead air / filler word trim. All null/false until a trim toggle is on and
    // Preview has actually run one; none of this is touched otherwise.
    trimResult: null,
    trimApprovedIds: null,
    forceNoDuplicate: false
  };

  /* ------------------------------------------------------------------ utils */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function status(msg, kind) {
    var s = $('status');
    s.textContent = msg;
    s.className = kind || '';
  }

  function showWarnings(list) {
    var box = $('warnings');
    box.innerHTML = '';
    (list || []).forEach(function (w) { box.appendChild(el('div', null, '! ' + w)); });
  }

  function fmtTime(sec) {
    if (sec === null || sec === undefined || !isFinite(sec)) return '-';
    var s = Math.max(0, sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    var r = Math.floor(s % 60);
    var mm = (m < 10 ? '0' : '') + m, ss = (r < 10 ? '0' : '') + r;
    return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss;
  }

  function baseName(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  function parentName(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    return parts.length > 1 ? parts[parts.length - 2] : '';
  }

  function stripExt(n) { return String(n).replace(/\.[^.]+$/, ''); }

  function evalHost(fnCall) {
    return new Promise(function (resolve, reject) {
      if (!cs) { reject(new Error(hostError || 'Not connected to Premiere.')); return; }
      try {
        cs.evalScript(fnCall, function (res) {
          if (res === 'EvalScript error.') { reject(new Error('ExtendScript failed: ' + fnCall)); return; }
          resolve(res);
        });
      } catch (e) { reject(e); }
    });
  }

  /* ------------------------------------------------------- sequence reading */

  function inferSpeakerName(track) {
    var withMedia = null;
    for (var i = 0; i < track.clips.length; i++) {
      if (track.clips[i].mediaPath) { withMedia = track.clips[i]; break; }
    }
    if (!withMedia) return track.name;
    var leaf = stripExt(baseName(withMedia.mediaPath));
    // Auphonic writes a folder per session holding "Track 1.wav" .. "Track N.wav",
    // which tells us nothing. The folder above is no better. Fall back to the
    // Premiere track name in that case so at least the rows are distinguishable.
    if (/^track\s*\d+$/i.test(leaf)) return track.name;
    return leaf;
  }

  /**
   * Two video tracks that reference the same source file are crops of one camera.
   * Detecting it from the media path is exact, so nobody has to remember which of
   * V2 and V3 came off the right-hand body.
   */
  function inferPhysicalCamera(track) {
    for (var i = 0; i < track.clips.length; i++) {
      var c = track.clips[i];
      if (c.mediaPath && !c.isSequence) return parentName(c.mediaPath) || baseName(c.mediaPath);
    }
    return 'cam' + (track.index + 1);
  }

  function inferShotType(label) {
    var s = String(label).toLowerCase();
    if (/wide|master|all|room/.test(s)) return 'wide';
    if (/\bgroup|quad|four\b/.test(s)) return 'group';
    if (/two|pair|2\s*shot/.test(s)) return 'two';
    return 'group';
  }

  /**
   * Fold a fresh read of the sequence into the panel without discarding the roster.
   *
   * Refresh used to rebuild speakers and angles from scratch, which threw away every
   * name, side, chip assignment, shot type and camera id, so asking "did the in and
   * out points move" silently destroyed the loaded template. The track list and the
   * clips on it belong to the sequence and are always re-read. Who those tracks
   * contain is the editor's knowledge and nothing here can re-derive it.
   *
   * Rows are matched on track index, which is the only stable identity Premiere
   * offers. New tracks come in filled from the media path; tracks that have gone take
   * their row with them.
   */
  function applySequence(data, rebuild) {
    state.seq = data;

    var audio = data.audioTracks.filter(function (t) { return t.clipCount > 0; });
    var video = data.videoTracks.filter(function (t) { return t.clipCount > 0; });

    var oldSpk = {}, oldAng = {};
    if (!rebuild) {
      state.speakers.forEach(function (s) { oldSpk[s.audioTrackIndex] = s; });
      state.angles.forEach(function (a) { oldAng[a.videoTrackIndex] = a; });
    }

    var added = 0;
    var kept = 0;

    state.speakers = audio.map(function (t, i) {
      var prev = oldSpk[t.index];
      if (prev) {
        delete oldSpk[t.index];
        kept++;
        prev.clips = t.clips;
        return prev;
      }
      added++;
      var name = inferSpeakerName(t);
      var isHost = /ryan|host|mod/i.test(name);
      return {
        id: 'A' + t.index,
        name: name,
        audioTrackIndex: t.index,
        // A rough split by seating order, since track order usually follows the room.
        // Wrong is two clicks to fix; unset would be eight.
        side: isHost ? 'host' : (i < Math.floor(audio.length / 2) ? 'A' : 'B'),
        clips: t.clips
      };
    });

    state.angles = video.map(function (t) {
      var prev = oldAng[t.index];
      if (prev) {
        delete oldAng[t.index];
        kept++;
        return prev;
      }
      added++;
      var cam = inferPhysicalCamera(t);
      var label = cam || t.name;
      return {
        id: 'V' + t.index,
        name: label,
        videoTrackIndex: t.index,
        shows: [],
        shotType: inferShotType(label),
        physicalCamera: cam,
        targetSharePct: null
      };
    });

    // A camera cannot still be tagged with somebody whose track has gone.
    var live = {};
    state.speakers.forEach(function (s) { live[s.id] = true; });
    state.angles.forEach(function (a) {
      a.shows = a.shows.filter(function (id) { return live[id]; });
    });

    var dropped = 0;
    for (var k in oldSpk) dropped++;
    for (var k2 in oldAng) dropped++;

    renderAll();
    return { added: added, kept: kept, dropped: dropped };
  }

  function refresh(rebuild) {
    status(rebuild ? 'Rebuilding roster from the sequence...' : 'Reading sequence...');
    evalHost('cpswReadSequence()')
      .then(function (raw) {
        var data;
        try { data = JSON.parse(raw); }
        catch (e) { throw new Error('Could not parse host response: ' + String(raw).slice(0, 300)); }
        if (!data.ok) throw new Error(data.error || 'Unknown host error');

        var changed = applySequence(data, rebuild);
        $('seqLabel').textContent = data.sequenceName || 'sequence';
        invalidatePlan();

        var msgs = [];
        if (!state.speakers.length) msgs.push('No audio tracks with clips. Load the Auphonic tracks first.');
        if (state.angles.length < 2) msgs.push('Fewer than two camera tracks with clips: nothing to cut between.');
        // Say it rather than let it be discovered halfway through a run.
        if (changed.dropped) {
          msgs.push(changed.dropped + ' row(s) were removed because those tracks are no longer in the sequence.');
        }
        if (changed.added && changed.kept) {
          msgs.push(changed.added + ' new track(s) need a name and tagging.');
        }
        showWarnings(msgs);

        var roster = rebuild
          ? 'Roster rebuilt from scratch.'
          : changed.kept
            ? 'Your roster and template were kept.'
            : '';

        status(
          data.sequenceName + ': ' + state.angles.length + ' camera track(s), ' +
          state.speakers.length + ' speaker track(s). ' +
          (data.hasInOut
            ? 'In/out set: ' + fmtTime(data.inPoint) + ' to ' + fmtTime(data.outPoint) + '. '
            : 'No in/out set, the whole sequence will be used. ') + roster,
          msgs.length ? '' : 'ok'
        );
      })
      .catch(function (e) { status(String(e.message || e), 'err'); });
  }

  /* --------------------------------------------------------------- rendering */

  function renderAll() {
    renderSpeakers();
    renderAngles();
    renderQuick();
    renderSettings();
    renderRange();
  }

  function renderRange() {
    var d = state.seq;
    if (!d) { $('rangeLabel').textContent = ''; return; }
    var useInOut = $('useInOut').checked && d.hasInOut;
    var from = useInOut ? d.inPoint : 0;
    var to = useInOut ? d.outPoint : d.sequenceEnd;

    var label = fmtTime(from) + ' - ' + fmtTime(to);
    // Say which end is actually pinned. A one-sided range is legitimate but looks
    // identical to the whole sequence once it is just two timecodes.
    if (useInOut && !d.hasOut) label += '  (in point to end)';
    else if (useInOut && !d.hasIn) label += '  (start to out point)';
    else if (d.inOutIgnored) label += '  (whole sequence, ignoring in/out points that fall outside it)';
    else if (!d.hasInOut) label += '  (whole sequence, no in/out set)';
    $('rangeLabel').textContent = label;

    $('useInOut').disabled = !d.hasInOut;
  }

  /*
   * A stable colour per person, keyed on the audio track rather than on position in
   * the list, so somebody's colour does not change when a track above them is added
   * or removed. Learning that Bree is teal is only worth anything if she stays teal.
   */
  var CPSW_PALETTE = [
    '#4a9eff', '#e07c4a', '#3fbf7f', '#d4658f',
    '#9b7fd4', '#e0c04a', '#4ec9c9', '#c96a4e',
    '#8fbf5a', '#6a8fd4', '#d48fc9', '#a89060'
  ];

  function speakerColor(sp) {
    return CPSW_PALETTE[sp.audioTrackIndex % CPSW_PALETTE.length];
  }

  function renderSpeakers() {
    var box = $('speakerList');
    box.innerHTML = '';
    $('spkCount').textContent = state.speakers.length + ' tracks';

    state.speakers.forEach(function (sp) {
      var row = el('div', 'row speaker');
      var colour = speakerColor(sp);

      var tag = el('span', 'tag', 'A' + (sp.audioTrackIndex + 1));
      tag.style.background = colour;
      tag.style.color = '#101010';
      row.appendChild(tag);

      var name = el('input');
      name.type = 'text';
      name.value = sp.name;
      // The person's colour on their own field, so the roster and the camera chips
      // read as the same set of people rather than two unrelated lists.
      name.style.borderLeft = '3px solid ' + colour;
      name.addEventListener('input', function () { sp.name = name.value; renderAngles(); });
      row.appendChild(name);

      var side = el('select');
      [['A', 'Side A'], ['B', 'Side B'], ['host', 'Host']].forEach(function (o) {
        var opt = el('option', null, o[1]);
        opt.value = o[0];
        if (sp.side === o[0]) opt.selected = true;
        side.appendChild(opt);
      });
      side.addEventListener('change', function () { sp.side = side.value; renderAngles(); });
      row.appendChild(side);

      box.appendChild(row);
    });
  }

  /**
   * The camera bodies this sequence actually contains.
   *
   * Collected from the angles themselves, which are prefilled from the footage
   * folder, so on a normal project the list is already correct and nobody types
   * anything. Deduplicated case insensitively to match how the planner compares them.
   */
  function cameraChoices() {
    var seen = {}, out = [];
    state.angles.forEach(function (a) {
      var k = String(a.physicalCamera || '').trim();
      if (!k) return;
      var low = k.toLowerCase();
      if (!seen[low]) { seen[low] = true; out.push(k); }
    });
    out.sort(function (x, y) { return x.toLowerCase() < y.toLowerCase() ? -1 : 1; });
    return out;
  }

  function renderAngles() {
    var box = $('angleList');
    box.innerHTML = '';
    $('angCount').textContent = state.angles.length + ' cameras';

    // Column headers, because four unlabelled inputs in a row is a guessing game.
    var cols = el('div', 'row angle-head colhead');
    ['', 'Camera name', 'Shot', 'Cam id', 'Target %'].forEach(function (t) {
      cols.appendChild(el('span', null, t));
    });
    box.appendChild(cols);

    state.angles.forEach(function (ang) {
      var wrap = el('div', 'angle' + (ang.shows.length ? '' : ' empty'));

      var head = el('div', 'row angle-head');
      head.appendChild(el('span', 'tag', 'V' + (ang.videoTrackIndex + 1)));

      var name = el('input');
      name.type = 'text';
      name.value = ang.name;
      name.addEventListener('input', function () { ang.name = name.value; });
      head.appendChild(name);

      var shot = el('select');
      [['single', 'Single'], ['two', 'Two shot'], ['group', 'Group'], ['wide', 'Wide']].forEach(function (o) {
        var opt = el('option', null, o[1]);
        opt.value = o[0];
        if (ang.shotType === o[0]) opt.selected = true;
        shot.appendChild(opt);
      });
      shot.addEventListener('change', function () { ang.shotType = shot.value; renderAngles(); });
      head.appendChild(shot);

      // A picker, not a text field. The set of real camera bodies on a shoot is tiny
      // and already known from the media paths, so typing it again is just a chance
      // to spell it differently and quietly lose the jump-cut protection.
      var cam = el('select');
      var choices = cameraChoices();
      var current = String(ang.physicalCamera || '');
      choices.forEach(function (c) {
        var opt = el('option', null, c);
        opt.value = c;
        if (c.toLowerCase() === current.trim().toLowerCase()) opt.selected = true;
        cam.appendChild(opt);
      });
      var addOpt = el('option', null, 'New camera...');
      addOpt.value = '__cpsw_new__';
      cam.appendChild(addOpt);
      cam.title = 'Which physical camera body this track came from.\n\n'
        + 'Two tracks that are crops of the same body share an id, and the planner then\n'
        + 'never cuts between them, because that reads as a jump cut. This is about the\n'
        + 'camera, not about which side of the debate it points at: two different bodies\n'
        + 'covering the same side should have different ids so they can cut together.\n\n'
        + 'Detected automatically from the source footage folder.';
      cam.addEventListener('change', function () {
        if (cam.value === '__cpsw_new__') {
          var n = window.prompt('Name this camera body (for example "CENTRE CAM"):', '');
          if (n && n.trim()) ang.physicalCamera = n.trim();
        } else {
          ang.physicalCamera = cam.value;
        }
        renderAngles();
        invalidatePlan();
      });
      head.appendChild(cam);

      // A wide angle's share is governed by the Wide shot ceiling, so showing a
      // second control for it here would mean two dials fighting over one number.
      var share = el('input');
      share.type = 'text';
      if (ang.shotType === 'wide') {
        share.value = '';
        share.placeholder = 'wide budget';
        share.disabled = true;
        share.title = 'Governed by the Wide shot ceiling setting (currently '
          + state.settings.wideBudgetPct + '%). Change it there.';
      } else {
        share.value = ang.targetSharePct === null ? '' : String(ang.targetSharePct);
        share.placeholder = 'auto';
        share.title = 'Target share of screen time, in percent.\n'
          + 'The planner aims for it, spending cutaway and reaction time on this camera when\n'
          + 'the audio leaves room. Following the active speaker still wins, so the number is\n'
          + 'not guaranteed: the Speaking balance panel reports what it actually got.\n'
          + 'Leave blank for no target.';
        share.addEventListener('input', function () {
          var v = parseFloat(share.value);
          ang.targetSharePct = isFinite(v) ? v : null;
        });
      }
      head.appendChild(share);

      wrap.appendChild(head);

      var chips = el('div', 'chips');
      state.speakers.forEach(function (sp) {
        var on = ang.shows.indexOf(sp.id) !== -1;
        var chip = el('span', 'chip' + (on ? ' on' : ''), sp.name);
        var colour = speakerColor(sp);
        if (on) {
          chip.style.background = colour;
          chip.style.borderColor = colour;
          chip.style.color = '#101010';
        } else {
          // Off, but still identifiably that person, so scanning for who is missing
          // from a camera does not mean reading eight words.
          chip.style.borderColor = colour;
          chip.style.color = colour;
          chip.style.opacity = '.45';
        }
        chip.title = sp.name + ' - ' +
          (sp.side === 'host' ? 'Host' : 'Side ' + sp.side) +
          (on ? '\nVisible on this camera. Click to remove.' : '\nNot on this camera. Click to add.');
        chip.addEventListener('click', function () {
          var i = ang.shows.indexOf(sp.id);
          if (i === -1) ang.shows.push(sp.id); else ang.shows.splice(i, 1);
          renderAngles();
          invalidatePlan();
        });
        chips.appendChild(chip);
      });

      // Eight people times twelve cameras is ninety-six clicks to tag a show by hand.
      // The wide sees everyone by definition, and "none" is the fastest way to start
      // over on a camera that was tagged wrong.
      var all = el('span', 'chipbtn', ang.shows.length === state.speakers.length ? 'none' : 'all');
      all.title = 'Tag everyone on this camera, or clear it.';
      all.addEventListener('click', function () {
        ang.shows = ang.shows.length === state.speakers.length
          ? []
          : state.speakers.map(function (s) { return s.id; });
        renderAngles();
        invalidatePlan();
      });
      chips.appendChild(all);

      // Side tally, because per-person colours are for identity and this is the thing
      // that decides whether a camera can carry an opposing-side cutaway at all.
      var tally = { A: 0, B: 0, host: 0 };
      ang.shows.forEach(function (id) {
        var sp = null;
        state.speakers.forEach(function (s) { if (s.id === id) sp = s; });
        if (sp) tally[sp.side]++;
      });
      var summary = [];
      if (tally.A) summary.push(tally.A + 'A');
      if (tally.B) summary.push(tally.B + 'B');
      if (tally.host) summary.push('host');
      chips.appendChild(el('span', 'tally', summary.length ? summary.join(' · ') : 'nobody tagged'));

      // Sharing a Cam id is a real restriction and it was invisible: nothing in the
      // panel said which cuts it had just forbidden. Naming them makes an accidental
      // grouping obvious instead of showing up later as a camera nobody visits.
      var locked = [];
      state.angles.forEach(function (other) {
        if (other === ang) return;
        var a = String(ang.physicalCamera || '').trim().toLowerCase();
        var b = String(other.physicalCamera || '').trim().toLowerCase();
        if (a && a === b) locked.push('V' + (other.videoTrackIndex + 1));
      });
      if (locked.length) {
        var warn = el('div', 'locked',
          'Same body as ' + locked.join(', ') + ', so it will never cut to ' +
          (locked.length > 1 ? 'them' : 'it') + '.');
        warn.title = 'Two crops of one sensor cut together read as a jump cut, so the planner '
          + 'treats angles sharing a Cam id as the same shot. If these are actually different '
          + 'cameras, give them different ids or you lose those cuts.';
        wrap.appendChild(warn);
      }

      wrap.appendChild(chips);

      box.appendChild(wrap);
    });
  }

  /**
   * The short view: two presets and the one slider Carter actually cares about.
   * Everything else keeps its default and stays in Advanced.
   */
  function renderQuick() {
    var box = $('quickSettings');
    if (!box) return;
    box.innerHTML = '';

    ['pace', 'reactions'].forEach(function (name) {
      var def = CPSW_PRESETS[name];
      var current = cpswDetectPreset(name, state.settings);

      var wrap = el('div', 'setting');
      var lab = el('div', 'label');
      lab.appendChild(el('span', null, def.label));
      var note = el('small', null, def.help);
      lab.appendChild(note);
      wrap.appendChild(lab);

      var holder = el('div');
      var sel = el('select');
      def.options.forEach(function (o) {
        var opt = el('option', null, o.label);
        opt.value = o.value;
        if (current === o.value) opt.selected = true;
        sel.appendChild(opt);
      });
      if (current === 'custom') {
        var c = el('option', null, 'Custom');
        c.value = 'custom';
        c.selected = true;
        sel.appendChild(c);
      }
      sel.addEventListener('change', function () {
        if (sel.value === 'custom') return;
        cpswApplyPreset(name, sel.value, state.settings);
        renderQuick();
        renderSettings();
        settingChanged();
      });
      holder.appendChild(sel);
      wrap.appendChild(holder);
      wrap.appendChild(el('div'));
      box.appendChild(wrap);

      // Say what the chosen option actually does, so the label is not the only clue.
      var chosen = null;
      for (var i = 0; i < def.options.length; i++) {
        if (def.options[i].value === current) chosen = def.options[i];
      }
      note.textContent = chosen ? chosen.note : def.help + ' Edited in Advanced.';
    });

    // These are numbers with a real opinion behind them, so they get promoted
    // out of Advanced rather than being implied by a preset. Shot length in
    // particular is something an editor watches back and then wants to type.
    ['minShotSec', 'maxShotSec', 'wideBudgetPct'].forEach(function (key) {
      for (var i = 0; i < CPSW_SETTINGS.length; i++) {
        if (CPSW_SETTINGS[i].key === key) {
          box.appendChild(renderSetting(CPSW_SETTINGS[i]));
          return;
        }
      }
    });
  }

  function renderSettings() {
    var targets = {
      wide: $('wideSettings'),
      reaction: $('reactionSettings'),
      pacing: $('pacingSettings'),
      output: $('outputSettings')
    };
    for (var k in targets) if (targets[k]) targets[k].innerHTML = '';

    CPSW_SETTINGS.forEach(function (def) {
      var host = targets[def.group];
      if (!host) return;
      host.appendChild(renderSetting(def));
    });

    var custom = [];
    if (cpswDetectPreset('pace', state.settings) === 'custom') custom.push('pace');
    if (cpswDetectPreset('reactions', state.settings) === 'custom') custom.push('reactions');
    var adv = $('advLabel');
    if (adv) adv.textContent = custom.length ? 'custom ' + custom.join(' + ') : '';
  }

  function renderSetting(def) {
    if (def.type === 'check') {
      var wrap = el('div', 'setting');
      var lab = el('div', 'label');
      var cb = el('label', 'check');
      var input = el('input');
      input.type = 'checkbox';
      input.checked = !!state.settings[def.key];
      input.addEventListener('change', function () {
        state.settings[def.key] = input.checked;
        renderQuick();
        settingChanged();
      });
      cb.appendChild(input);
      cb.appendChild(el('span', null, def.label));
      lab.appendChild(cb);
      lab.appendChild(el('small', null, def.help));
      wrap.appendChild(lab);
      wrap.appendChild(el('div'));
      wrap.appendChild(el('div'));
      return wrap;
    }

    if (def.type === 'select') {
      var w2 = el('div', 'setting');
      var l2 = el('div', 'label');
      l2.appendChild(el('span', null, def.label));
      l2.appendChild(el('small', null, def.help));
      w2.appendChild(l2);
      var sel = el('select');
      def.options.forEach(function (o) {
        var opt = el('option', null, o.label);
        opt.value = o.value;
        if (state.settings[def.key] === o.value) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function () {
        state.settings[def.key] = sel.value;
        settingChanged();
      });
      var holder = el('div');
      holder.appendChild(sel);
      w2.appendChild(holder);
      w2.appendChild(el('div'));
      return w2;
    }

    if (def.type === 'number') {
      var w4 = el('div', 'setting');
      var l4 = el('div', 'label');
      l4.appendChild(el('span', null, def.label));
      l4.appendChild(el('small', null, def.help));
      w4.appendChild(l4);

      var box = el('div', 'numwrap');
      var nin = el('input', 'num');
      nin.type = 'number';
      nin.min = def.min; nin.max = def.max; nin.step = def.step;
      nin.value = state.settings[def.key];
      box.appendChild(nin);
      box.appendChild(el('span', 'unit', def.unit || ''));
      w4.appendChild(box);
      w4.appendChild(el('div'));

      // Commit on blur rather than on every keystroke, so typing "12" through "1"
      // does not briefly apply a 1 second maximum.
      var commit = function () {
        var v = parseFloat(nin.value);
        if (!isFinite(v)) { nin.value = state.settings[def.key]; return; }
        v = Math.max(def.min, Math.min(def.max, v));
        nin.value = v;
        state.settings[def.key] = v;
        renderQuick();
        settingChanged();
      };
      nin.addEventListener('change', commit);
      nin.addEventListener('blur', commit);
      return w4;
    }

    var wrap3 = el('div', 'setting');
    var lab3 = el('div', 'label');
    lab3.appendChild(el('span', null, def.label));
    lab3.appendChild(el('small', null, def.help));
    wrap3.appendChild(lab3);

    var range = el('input');
    range.type = 'range';
    range.min = def.min; range.max = def.max; range.step = def.step;
    range.value = state.settings[def.key];
    wrap3.appendChild(range);

    // The readout is an input, not a label. Dragging to a number you already know is
    // the slowest way to enter it, and on a percentage with a strong opinion behind
    // it, typing 15 should not require hitting one pixel.
    var box = el('div', 'numwrap');
    var val = el('input', 'num');
    val.type = 'number';
    val.min = def.min; val.max = def.max; val.step = def.step;
    val.value = state.settings[def.key];
    box.appendChild(val);
    box.appendChild(el('span', 'unit', def.unit || ''));
    wrap3.appendChild(box);

    function commit(v, redraw) {
      v = Math.max(def.min, Math.min(def.max, v));
      state.settings[def.key] = v;
      if (range.value != v) range.value = v;
      if (parseFloat(val.value) !== v) val.value = v;
      settingChanged();
      // A preset whose settings have been edited must stop claiming to be that preset,
      // but only once the drag is over. Re-rendering on every input event replaced the
      // slider under the cursor mid-drag, which is what made it feel dead.
      if (redraw) renderQuick();
    }

    range.addEventListener('input', function () {
      var v = parseFloat(range.value);
      state.settings[def.key] = v;
      val.value = v;
      invalidatePlan();
    });
    // Disk write happens on 'change', not here: one file write per drag, not per pixel.
    range.addEventListener('change', function () { commit(parseFloat(range.value), true); });

    val.addEventListener('change', function () {
      var v = parseFloat(val.value);
      if (!isFinite(v)) { val.value = state.settings[def.key]; return; }
      commit(v, true);
    });

    return wrap3;
  }

  function invalidatePlan() {
    if (!state.plan) return;
    state.plan = null;
    $('btnApply').disabled = true;
  }

  /**
   * A setting moved: the plan is stale, and the new value is now the preference.
   *
   * Every settings write goes through here so that persistence cannot be forgotten at
   * one of the eight controls that can change one.
   */
  function settingChanged() {
    invalidatePlan();
    savePrefs();
  }

  /* --------------------------------------------------------------- templates */

  function templateDir() {
    if (!fs || !path || !os) return null;
    var dir = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'CounterpointSwitcher', 'templates'
    );
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    return dir;
  }

  function listTemplates() {
    var dir = templateDir();
    if (!dir) return [];
    try {
      return fs.readdirSync(dir)
        .filter(function (f) { return /\.json$/i.test(f); })
        .map(function (f) { return f.replace(/\.json$/i, ''); })
        .sort();
    } catch (e) { return []; }
  }

  function refreshTemplateList() {
    var sel = $('templateSelect');
    var current = state.templateName;
    sel.innerHTML = '';
    var blank = el('option', null, '(unsaved setup)');
    blank.value = '';
    sel.appendChild(blank);
    listTemplates().forEach(function (n) {
      var o = el('option', null, n);
      o.value = n;
      if (n === current) o.selected = true;
      sel.appendChild(o);
    });
  }

  /**
   * A template is the roster, and only the roster.
   *
   * It used to carry every setting as well, so loading one silently replaced whatever
   * had been tuned. That is the wrong ownership: who sits on which mic and which
   * camera sees them changes every episode, while how the edit should feel is a taste
   * being converged on across episodes. Settings live in preferences instead, which
   * no template touches.
   */
  function currentTemplate() {
    var tpl = {
      version: 2,
      speakers: state.speakers.map(function (s) {
        return { name: s.name, audioTrackIndex: s.audioTrackIndex, side: s.side };
      }),
      angles: state.angles.map(function (a) {
        return {
          name: a.name, videoTrackIndex: a.videoTrackIndex, shows: a.shows.slice(),
          shotType: a.shotType, physicalCamera: a.physicalCamera, targetSharePct: a.targetSharePct
        };
      })
    };
    // Opt in, per template, and off unless asked for. A show whose feel is genuinely
    // different can carry its own settings; the usual case leaves the tuning alone.
    if ($('tplIncludeSettings').checked) {
      tpl.settings = JSON.parse(JSON.stringify(state.settings));
    }
    return tpl;
  }

  /*
   * Settings persistence, separate from templates and from any one project.
   *
   * Stored beside the template folder rather than inside it, so it never shows up in
   * the template dropdown.
   */
  function prefsPath() {
    if (!fs || !path || !os) return null;
    var dir = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'CounterpointSwitcher'
    );
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    return path.join(dir, 'settings.json');
  }

  function savePrefs() {
    var p = prefsPath();
    if (!p) return;
    try { fs.writeFileSync(p, JSON.stringify(state.settings, null, 2), 'utf8'); }
    catch (e) { /* a settings file that cannot be written is not worth a dialog */ }
  }

  function loadPrefs() {
    var p = prefsPath();
    if (!p || !fs.existsSync(p)) return false;
    try {
      var saved = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Key by key, so a setting added in a later version keeps its new default
      // rather than coming back undefined from an older file.
      var found = false;
      Object.keys(saved).forEach(function (k) {
        if (k in state.settings) { state.settings[k] = saved[k]; found = true; }
      });
      return found;
    } catch (e) { return false; }
  }

  function saveTemplate(name) {
    var dir = templateDir();
    if (!dir) { status('Templates need Node access, which this panel does not have.', 'err'); return; }
    try {
      var tpl = currentTemplate();
      fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(tpl, null, 2), 'utf8');
      state.templateName = name;
      refreshTemplateList();
      status(
        'Saved template "' + name + '": ' +
        tpl.speakers.length + ' speakers, ' + tpl.angles.length + ' cameras' +
        (tpl.settings ? ', and the current settings.' : '. Settings not included.'),
        'ok'
      );
    } catch (e) { status('Could not save template: ' + e.message, 'err'); }
  }

  /**
   * Load a template onto whatever sequence is open now.
   *
   * Track counts move between episodes, so a mismatch reconciles rather than
   * refusing: match by track index first, fall back to name, and report what could
   * not be placed instead of blocking the run.
   */
  function loadTemplate(name) {
    var dir = templateDir();
    if (!dir || !name) return;
    var tpl;
    try { tpl = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8')); }
    catch (e) { status('Could not read template: ' + e.message, 'err'); return; }

    var unmatched = [];

    // Version 1 files always carried settings, whether or not that was wanted, so
    // only an explicit opt-in counts. Without the flag the tuning is left alone,
    // which is what makes loading a roster safe.
    var appliedSettings = false;
    if (tpl.settings && tpl.version >= 2) {
      Object.keys(tpl.settings).forEach(function (k) {
        if (k in state.settings) state.settings[k] = tpl.settings[k];
      });
      appliedSettings = true;
      // The template's values are the working values now, so they are what a later
      // session should come back to.
      savePrefs();
    }
    $('tplIncludeSettings').checked = appliedSettings;

    (tpl.speakers || []).forEach(function (ts) {
      var target = null;
      for (var i = 0; i < state.speakers.length; i++) {
        if (state.speakers[i].audioTrackIndex === ts.audioTrackIndex) { target = state.speakers[i]; break; }
      }
      if (!target) { unmatched.push('speaker "' + ts.name + '" (A' + (ts.audioTrackIndex + 1) + ') has no matching track'); return; }
      target.name = ts.name;
      target.side = ts.side;
    });

    var idMap = {};
    (tpl.speakers || []).forEach(function (ts) { idMap['A' + ts.audioTrackIndex] = 'A' + ts.audioTrackIndex; });

    (tpl.angles || []).forEach(function (ta) {
      var target = null;
      for (var i = 0; i < state.angles.length; i++) {
        if (state.angles[i].videoTrackIndex === ta.videoTrackIndex) { target = state.angles[i]; break; }
      }
      if (!target) { unmatched.push('camera "' + ta.name + '" (V' + (ta.videoTrackIndex + 1) + ') has no matching track'); return; }
      target.name = ta.name;
      target.shotType = ta.shotType;
      target.physicalCamera = ta.physicalCamera;
      target.targetSharePct = ta.targetSharePct;
      target.shows = (ta.shows || []).filter(function (id) {
        for (var i = 0; i < state.speakers.length; i++) if (state.speakers[i].id === id) return true;
        unmatched.push('camera "' + ta.name + '" refers to a speaker track that is not here');
        return false;
      });
    });

    state.templateName = name;
    renderAll();
    showWarnings(unmatched);

    // Settings changing under you is the surprising outcome, so it is always stated.
    var tail = appliedSettings
      ? ' Its saved settings were applied.'
      : ' Your settings were left alone.';
    status(
      unmatched.length
        ? 'Loaded "' + name + '" with ' + unmatched.length + ' thing(s) that did not match. Check the flags below.' + tail
        : 'Loaded template "' + name + '".' + tail,
      unmatched.length ? '' : 'ok'
    );
  }

  /* ------------------------------------------------------------ preview/apply */

  function workDir() {
    if (!fs || !path || !os) return null;
    var dir = path.join(os.tmpdir(), 'counterpoint-switcher');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    return dir;
  }

  function enginePath(filename) {
    // The panel is installed as a junction to <repo>/cep, so the compiled engine
    // sits one level up. CEP may report either the junction or the real folder, and
    // one level up from the junction is the extensions directory, where dist is not.
    // So resolve the link before walking up, and keep the unresolved path as a
    // fallback for a plain (non-junction) install.
    var ext = cs ? cs.getSystemPath(SystemPath.EXTENSION) : null;
    if (!ext || !path || !fs) return null;

    var candidates = [];
    try { candidates.push(fs.realpathSync(ext)); } catch (e) { /* not a link */ }
    candidates.push(ext);

    for (var i = 0; i < candidates.length; i++) {
      var p = path.join(candidates[i], '..', 'dist', 'cli', filename);
      if (fs.existsSync(p)) return p;
    }
    // Nothing found. Return the most likely path so the caller's error names a real place.
    return path.join(candidates[0], '..', 'dist', 'cli', filename);
  }

  function activeRange() {
    var d = state.seq;
    if (!d) return null;
    var useInOut = $('useInOut').checked && d.hasInOut;
    var start = useInOut ? d.inPoint : 0;
    var end = useInOut ? d.outPoint : d.sequenceEnd;
    if (!(end > start)) return null;
    return { start: start, end: end };
  }

  /** Everything the engine needs, with no Premiere objects in it. */
  function buildEngineConfig(range) {
    var settings = state.settings;
    // Trim already made its own duplicate (or wrote to the original, per the same
    // setting) before the camera-cut plan runs against the freshly-trimmed
    // sequence. Duplicating a second time here would silently orphan the trim work
    // on a copy the panel never looks at again. A transient flag, not a mutation of
    // the persisted preference: cleared at the top of every fresh preview().
    if (state.forceNoDuplicate) {
      settings = JSON.parse(JSON.stringify(state.settings));
      settings.workOnDuplicate = false;
    }
    return {
      range: range,
      settings: settings,
      speakers: state.speakers.map(function (s) {
        return {
          id: s.id, name: s.name, audioTrackIndex: s.audioTrackIndex, side: s.side,
          clips: (s.clips || [])
            .filter(function (c) { return c.mediaPath; })
            .map(function (c) {
              return {
                mediaPath: c.mediaPath,
                timelineStart: c.start,
                timelineEnd: c.end,
                sourceIn: c.inPoint
              };
            })
        };
      }),
      angles: state.angles.map(function (a) {
        return {
          id: a.id, name: a.name, videoTrackIndex: a.videoTrackIndex,
          shows: a.shows, shotType: a.shotType,
          physicalCamera: a.physicalCamera, targetSharePct: a.targetSharePct
        };
      })
    };
  }

  /**
   * Re-read the in and out points, then plan.
   *
   * In/out is the thing most likely to have moved since the last Refresh, and
   * silently planning the whole sequence when a range was set is the worst failure
   * this panel has, because it looks like it worked. So it is never taken on trust.
   */
  function wantsTrim() {
    return !!(state.settings.trimDeadAir || state.settings.trimFillerWords);
  }

  function preview() {
    if (!state.seq) { status('Press Refresh first.', 'err'); return; }
    // A fresh preview always starts clean: the no-duplicate override only applies
    // for the one camera-cut plan that follows a trim actually being applied.
    state.forceNoDuplicate = false;
    $('cardFillerReview').className = 'card collapsed';

    evalHost('cpswReadSequence()')
      .then(function (raw) {
        try {
          var d = JSON.parse(raw);
          if (d && d.ok) {
            state.seq.hasIn = d.hasIn;
            state.seq.hasOut = d.hasOut;
            state.seq.hasInOut = d.hasInOut;
            state.seq.inOutIgnored = d.inOutIgnored;
            state.seq.inPoint = d.inPoint;
            state.seq.outPoint = d.outPoint;
            state.seq.sequenceEnd = d.sequenceEnd;
            renderRange();
          }
        } catch (e) { /* plan on what we already have */ }
        if (wantsTrim()) runTrimDetect(); else runPlan();
      })
      .catch(function () {
        if (wantsTrim()) runTrimDetect(); else runPlan();
      });
  }

  function runPlan() {
    if (!fs) { status('Preview needs Node access, which this panel does not have.', 'err'); return; }
    if (!state.seq) { status('Press Refresh first.', 'err'); return; }

    var range = activeRange();
    if (!range) { status('Nothing to work on: the range is empty.', 'err'); return; }

    var tagged = state.angles.filter(function (a) { return a.shows.length > 0; });
    if (tagged.length === 0) {
      status('No camera has anyone tagged yet. Click names under each camera first.', 'err');
      return;
    }
    var withAudio = state.speakers.filter(function (s) {
      return (s.clips || []).some(function (c) { return c.mediaPath; });
    });
    if (withAudio.length === 0) {
      status('No speaker track has media on disk. Load the Auphonic tracks first.', 'err');
      return;
    }

    var dir = workDir();
    var engine = enginePath('run-plan.js');
    if (!engine || !fs.existsSync(engine)) {
      status('Engine not built. Run "npm run build" in the project folder.', 'err');
      return;
    }

    var cfgPath = path.join(dir, 'config.json');
    var outBase = path.join(dir, 'plan');
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(buildEngineConfig(range)), 'utf8');
    } catch (e) { status('Could not write the job file: ' + e.message, 'err'); return; }

    $('btnPreview').disabled = true;
    $('btnApply').disabled = true;
    // Name the actual boundaries, not just the duration, so a range that failed to
    // apply is obvious here rather than after the cuts land.
    status('Analysing ' + withAudio.length + ' mic track(s) from ' +
      fmtTime(range.start) + ' to ' + fmtTime(range.end) +
      ' (' + fmtTime(range.end - range.start) + '). First run reads the audio, later runs are cached.');

    var cp = require('child_process');
    // System Node, not Premiere's bundled runtime, so the engine is not held back
    // by whichever version CEP happens to ship.
    var proc = cp.spawn('node', [engine, cfgPath, outBase], { windowsHide: true });
    var tail = '';
    proc.stderr.on('data', function (d) {
      tail = String(d).trim().split('\n').pop();
      status(tail);
    });
    proc.on('error', function (e) {
      $('btnPreview').disabled = false;
      status('Could not start Node: ' + e.message + '. Is Node on PATH?', 'err');
    });
    proc.on('close', function () {
      $('btnPreview').disabled = false;
      var result;
      try { result = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8')); }
      catch (e) { status('The engine did not produce a plan. Last output: ' + tail, 'err'); return; }
      if (!result.ok) { status('Planning failed: ' + result.error, 'err'); return; }

      state.plan = result;
      state.planFile = outBase + '.txt';
      renderBalance(result);
      $('btnApply').disabled = false;
      $('cardBalance').className = 'card';

      status(
        result.shotCount + ' shots, ' +
        (result.stats.cutsPerMinute).toFixed(1) + '/min. ' +
        'On the person speaking ' + (result.stats.onSpeakerAccuracy * 100).toFixed(0) + '% of the time. ' +
        result.stats.reactionCuts + ' reaction cuts. ' +
        'Wide ' + (result.stats.wideShare * 100).toFixed(1) + '%.',
        'ok'
      );
      showWarnings(result.warnings || []);
    });
  }

  /* --------------------------------------------------------- dead air / filler */

  /**
   * Find what could be trimmed, without touching the timeline. Only runs when a
   * trim toggle is on; the ordinary camera-cut path never invokes this at all.
   */
  function runTrimDetect() {
    if (!fs) { status('Preview needs Node access, which this panel does not have.', 'err'); return; }
    if (!state.seq) { status('Press Refresh first.', 'err'); return; }

    var range = activeRange();
    if (!range) { status('Nothing to work on: the range is empty.', 'err'); return; }
    var withAudio = state.speakers.filter(function (s) {
      return (s.clips || []).some(function (c) { return c.mediaPath; });
    });
    if (withAudio.length === 0) {
      status('No speaker track has media on disk. Load the Auphonic tracks first.', 'err');
      return;
    }

    var dir = workDir();
    var engine = enginePath('detect-trim.js');
    if (!engine || !fs.existsSync(engine)) {
      status('Engine not built. Run "npm run build" in the project folder.', 'err');
      return;
    }

    var cfgPath = path.join(dir, 'trim-config.json');
    var outBase = path.join(dir, 'trim');
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(buildEngineConfig(range)), 'utf8');
    } catch (e) { status('Could not write the job file: ' + e.message, 'err'); return; }

    $('btnPreview').disabled = true;
    $('btnApply').disabled = true;
    status(state.settings.trimFillerWords
      ? 'Finding dead air and filler words. This transcribes every speaker, so it takes longer than a normal preview.'
      : 'Finding dead air...');

    var cp = require('child_process');
    var proc = cp.spawn('node', [engine, cfgPath, outBase], { windowsHide: true });
    var tail = '';
    proc.stderr.on('data', function (d) { tail = String(d).trim().split('\n').pop(); status(tail); });
    proc.on('error', function (e) {
      $('btnPreview').disabled = false;
      status('Could not start Node: ' + e.message + '. Is Node on PATH?', 'err');
    });
    proc.on('close', function () {
      var result;
      try { result = JSON.parse(fs.readFileSync(outBase + '.trim.json', 'utf8')); }
      catch (e) {
        $('btnPreview').disabled = false;
        status('Trim detection did not produce a result. Last output: ' + tail, 'err');
        return;
      }
      if (!result.ok) {
        $('btnPreview').disabled = false;
        status('Trim detection failed: ' + result.error, 'err');
        return;
      }

      state.trimResult = result;
      showWarnings(result.warnings || []);

      // Auto-cut candidates (um/uh/ah/er -- unambiguous enough that a human never
      // needs to look at them) go straight into the removal set, the same way dead
      // air already does. Only the rest -- review-tier phrases, and any burst of
      // "like"/"so" caught by the frequency threshold -- ever appear in the card.
      var all = result.filler.candidates || [];
      var autoCut = all.filter(function (c) { return !c.requiresReview; });
      var needsReview = all.filter(function (c) { return c.requiresReview; });
      state.trimAutoCutSpans = autoCut.map(function (c) { return { start: c.start, end: c.end }; });
      state.trimReviewCandidates = needsReview;

      if (state.settings.trimFillerWords && needsReview.length > 0) {
        $('btnPreview').disabled = false;
        renderFillerReview(result, needsReview, autoCut);
      } else {
        // Either filler trim is off, or nothing needs a human decision this run.
        // Either way, proceed straight through with dead air plus whatever auto-cut
        // filler words were found. Say what that is first: with no review card on
        // screen this is the only feedback about how much time is about to come off
        // the timeline, and a silent multi-span ripple is exactly the kind of thing
        // that should never happen without a number attached.
        var bits = [];
        if (state.settings.trimDeadAir) {
          bits.push(result.deadAir.count > 0
            ? (result.deadAir.count + ' dead-air span(s), ' + result.deadAir.totalSeconds.toFixed(1) + 's')
            : 'no dead air over the threshold');
        }
        if (state.settings.trimFillerWords) {
          var autoSec = autoCut.reduce(function (s, c) { return s + (c.end - c.start); }, 0);
          bits.push(autoCut.length
            ? (autoCut.length + ' filler word(s) auto-cut, ' + autoSec.toFixed(1) + 's')
            : 'no filler words found');
        }
        status((bits.length ? bits.join('; ') : 'Nothing to trim.') + '. Trimming...');
        proceedWithTrim(state.trimAutoCutSpans);
      }
    });
  }

  function renderFillerReview(result, needsReview, autoCut) {
    var card = $('cardFillerReview');
    card.className = 'card';
    $('fillerLabel').textContent = needsReview.length + ' to review';

    var box = $('fillerReviewList');
    box.innerHTML = '';

    state.trimApprovedIds = {};
    needsReview.forEach(function (c) { state.trimApprovedIds[c.id] = true; });

    var totalSec = needsReview.reduce(function (s, c) { return s + (c.end - c.start); }, 0);
    var speakerCount = {};
    needsReview.forEach(function (c) { speakerCount[c.speakerId] = true; });

    var summaryBits = [
      needsReview.length + ' filler word(s) need a look, across ' +
      Object.keys(speakerCount).length + ' speaker(s), totalling ' + totalSec.toFixed(1) + 's.'
    ];
    if (autoCut.length) {
      var autoSec = autoCut.reduce(function (s, c) { return s + (c.end - c.start); }, 0);
      summaryBits.push(
        autoCut.length + ' more (um/uh/ah/er) will be auto-cut, ' + autoSec.toFixed(1) + 's, no review needed.'
      );
    }
    if (state.settings.trimDeadAir && result.deadAir.count) {
      summaryBits.push(
        result.deadAir.count + ' dead-air span(s) (' + result.deadAir.totalSeconds.toFixed(1) +
        's) will also be trimmed automatically.'
      );
    }
    box.appendChild(el('div', 'hint', summaryBits.join(' ')));

    var byId = {};
    state.speakers.forEach(function (s) { byId[s.id] = s; });

    needsReview.forEach(function (c) {
      var row = el('div', 'filler-row');
      var sp = byId[c.speakerId];

      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', function () {
        if (cb.checked) state.trimApprovedIds[c.id] = true; else delete state.trimApprovedIds[c.id];
      });
      row.appendChild(cb);

      var main = el('div', 'filler-main');
      var head = el('div', 'filler-head');
      var who = el('span', 'tag', c.speakerName);
      if (sp) { who.style.background = speakerColor(sp); who.style.color = '#101010'; }
      head.appendChild(who);
      head.appendChild(el('span', 'tag', fmtTime(c.start)));
      head.appendChild(el('span', 'filler-text', '"' + c.text + '"'));
      // Threshold-gated candidates ("like"/"so" bursts) carry a reason -- surface it
      // so a reviewer sees at a glance why this particular instance was flagged.
      if (c.note) head.appendChild(el('span', 'tag', c.note));
      main.appendChild(head);

      var ctx = el('div', 'filler-context');
      var before = c.contextBefore ? c.contextBefore + ' ' : '';
      var after = c.contextAfter ? ' ' + c.contextAfter : '';
      ctx.appendChild(document.createTextNode(before));
      var b = el('b', null, c.text);
      ctx.appendChild(b);
      ctx.appendChild(document.createTextNode(after));
      main.appendChild(ctx);

      row.appendChild(main);
      box.appendChild(row);
    });
  }

  function applyTrimAndContinue() {
    if (!state.trimResult) return;
    // Auto-cut spans are always included, regardless of what the review card shows.
    var approvedFillerSpans = (state.trimAutoCutSpans || []).slice();
    (state.trimReviewCandidates || []).forEach(function (c) {
      if (state.trimApprovedIds[c.id]) approvedFillerSpans.push({ start: c.start, end: c.end });
    });
    proceedWithTrim(approvedFillerSpans);
  }

  /** Turn detected + approved candidates into a real ripple-delete plan, and apply it. */
  function proceedWithTrim(approvedFillerSpans) {
    var range = activeRange();
    if (!range) { status('Nothing to work on: the range is empty.', 'err'); return; }

    var dir = workDir();
    var approvedPath = path.join(dir, 'trim-approved.json');
    var outBase = path.join(dir, 'trim');
    var approved = {
      deadAirIntervals: state.settings.trimDeadAir ? (state.trimResult.deadAir.intervals || []) : [],
      approvedFillerSpans: approvedFillerSpans,
      range: range,
      // Removal spans have to land on frame boundaries or video ripples with holes
      // while audio closes cleanly. Sourced from the sequence rather than assumed.
      fps: state.seq && state.seq.fps ? state.seq.fps : 0,
      settings: state.settings
    };
    try {
      fs.writeFileSync(approvedPath, JSON.stringify(approved), 'utf8');
    } catch (e) { status('Could not write the trim plan job file: ' + e.message, 'err'); return; }

    var engine = enginePath('build-trim-plan.js');
    if (!engine || !fs.existsSync(engine)) {
      status('Engine not built. Run "npm run build" in the project folder.', 'err');
      return;
    }

    status('Building the trim plan...');
    var cp = require('child_process');
    var proc = cp.spawn('node', [engine, approvedPath, outBase], { windowsHide: true });
    var tail = '';
    proc.stderr.on('data', function (d) { tail = String(d).trim().split('\n').pop(); status(tail); });
    proc.on('error', function (e) { status('Could not start Node: ' + e.message, 'err'); });
    proc.on('close', function () {
      var planResult;
      try { planResult = JSON.parse(fs.readFileSync(outBase + '.trimplan.json', 'utf8')); }
      catch (e) { status('Trim plan build did not produce a result. Last output: ' + tail, 'err'); return; }
      if (!planResult.ok) {
        $('btnPreview').disabled = false;
        status(planResult.error || 'Trim plan build failed.', 'err');
        return;
      }

      $('cardFillerReview').className = 'card collapsed';

      if (planResult.removedCount === 0) {
        // Nothing actually needs removing: skip the ripple pass and the extra
        // duplicate/re-read round trip, and go straight to the normal plan.
        runPlan();
        return;
      }

      applyTrimToSequence(outBase + '.trim.txt');
    });
  }

  function applyTrimToSequence(trimPlanFile) {
    status('Trimming the sequence...');
    var esc = trimPlanFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    evalHost('cpswApplyTrimPlan("' + esc + '")')
      .then(function (raw) {
        var r;
        try { r = JSON.parse(raw); }
        catch (e) { throw new Error('Unreadable host response: ' + String(raw).slice(0, 200)); }
        if (!r.ok) throw new Error(r.error);

        status(
          'Trimmed ' + (r.removed || 0) + ' span(s), ' + (r.totalRemovedSeconds || 0).toFixed(1) +
          's removed' + (r.duplicated ? ' (on a duplicate)' : '') + '. Re-reading the sequence...'
        );

        // A ripple-delete does not change track indices, only clip start/end/
        // inPoint, so the reconciliation Refresh already does is exactly right here.
        return evalHost('cpswReadSequence()');
      })
      .then(function (raw2) {
        var d2 = JSON.parse(raw2);
        if (!d2.ok) throw new Error(d2.error);
        applySequence(d2, false);
        $('seqLabel').textContent = d2.sequenceName || 'sequence';
        // Trim already made its own duplicate (or wrote to the original, per the
        // same setting); the camera-cut plan that follows must not duplicate again.
        state.forceNoDuplicate = true;
        runPlan();
      })
      .catch(function (e) {
        $('btnPreview').disabled = false;
        status('Trim failed: ' + (e.message || e), 'err');
      });
  }

  function renderBalance(result) {
    var box = $('balanceList');
    box.innerHTML = '';
    $('balLabel').textContent = result.shotCount + ' shots';

    state.speakers.forEach(function (sp) {
      var talk = (result.stats.talkShare[sp.id] || 0) * 100;
      var screen = (result.stats.screenShare[sp.id] || 0) * 100;
      var row = el('div', 'bal');
      // Same colour as the roster and the chips, so a name is recognisable in all
      // three places without reading it.
      var who = el('span', null, sp.name);
      who.style.borderLeft = '3px solid ' + speakerColor(sp);
      who.style.paddingLeft = '5px';
      row.appendChild(who);

      var t = el('div', 'bar talk');
      var ts = el('span'); ts.style.width = Math.min(100, talk) + '%'; t.appendChild(ts);
      ts.style.background = speakerColor(sp);
      var tl = el('em', null, 'talk ' + talk.toFixed(0) + '%'); t.appendChild(tl);
      row.appendChild(t);

      // Screen share and talk share have different denominators, so the useful
      // number is neither: it is how much of this person's own speaking time the
      // edit actually had a camera on them.
      var seen = (result.stats.seenWhenTalking && result.stats.seenWhenTalking[sp.id] != null)
        ? result.stats.seenWhenTalking[sp.id] * 100
        : null;

      var s = el('div', 'bar screen');
      var ss = el('span');
      ss.style.width = Math.min(100, seen === null ? screen : seen) + '%';
      if (seen !== null && seen < 60) ss.style.background = 'var(--bad)';
      else if (seen !== null && seen < 80) ss.style.background = 'var(--warn)';
      s.appendChild(ss);
      s.appendChild(el('em', null, seen === null
        ? 'screen ' + screen.toFixed(0) + '%'
        : 'seen ' + seen.toFixed(0) + '% when talking'));
      row.appendChild(s);

      var note = el('span', 'subtle', 'on screen ' + screen.toFixed(0) + '% overall');
      note.title = sp.name + ' is visible whenever any tagged camera is up, including '
        + 'the wide and any group shot. Several people are on screen at once, so these '
        + 'do not add up to 100% and are not comparable with talk share.';
      row.appendChild(note);

      box.appendChild(row);
    });

    // The identity that makes the screen numbers checkable by hand. Every camera
    // contributes its share once per person tagged on it, so the total is not a
    // percentage of anything, it is people-time. Spelling it out is the difference
    // between a number that looks wrong and one that can be verified.
    var totalScreen = 0;
    state.speakers.forEach(function (sp) {
      totalScreen += (result.stats.screenShare[sp.id] || 0) * 100;
    });
    var terms = [];
    state.angles.forEach(function (a) {
      var share = (result.stats.angleShare[a.id] || 0) * 100;
      if (share < 0.05 || !a.shows.length) return;
      terms.push(share.toFixed(0) + '% x ' + a.shows.length);
    });
    // Stating it as a face count rather than a percentage, because "290%" invites the
    // question "percent of what" and the honest answer is "not of the timeline".
    // Video layers partition time and add to 100%. Faces do not, because a two-shot
    // puts two of them on screen at once.
    var faces = totalScreen / 100;
    var maths = el('div', 'maths',
      'Averaging ' + faces.toFixed(1) + ' faces on screen  (' + terms.join(' + ') + ')' +
      '. Layers add to 100%, faces do not.');
    maths.title = 'Each camera contributes its share once per person tagged on it.\n\n'
      + 'Two people on separate cameras can each be on screen 36% of the time, because '
      + 'they are on screen at different moments. They only coincide where their cameras '
      + 'overlap, which on a two-shot rig is just the wide.\n\n'
      + 'These would only add to 100% if every camera were a single.';
    box.appendChild(maths);

    var camHead = el('div', 'subhead', 'Camera shares');
    box.appendChild(camHead);
    state.angles.forEach(function (a) {
      var got = (result.stats.angleShare[a.id] || 0) * 100;
      var row = el('div', 'bal');
      row.appendChild(el('span', null, a.name));
      var bar = el('div', 'bar screen');
      var sp2 = el('span'); sp2.style.width = Math.min(100, got) + '%'; bar.appendChild(sp2);
      var lab = el('em', null, got.toFixed(1) + '%' +
        (a.targetSharePct !== null && a.targetSharePct !== undefined ? ' of ' + a.targetSharePct + '% target' : ''));
      bar.appendChild(lab);
      row.appendChild(bar);
      row.appendChild(el('div'));
      box.appendChild(row);
    });
  }

  function apply() {
    if (!state.plan || !state.planFile) { status('Preview the cuts first.', 'err'); return; }
    if (!fs.existsSync(state.planFile)) { status('The plan file has gone. Preview again.', 'err'); return; }

    // forceNoDuplicate means a trim pass already made (or deliberately did not
    // make) the one duplicate this whole run gets; reading the persisted setting
    // here instead would describe a duplicate that is not actually about to happen.
    var onDup = state.forceNoDuplicate ? false : state.settings.workOnDuplicate;
    var msg = 'Apply ' + state.plan.shotCount + ' shots to ' +
      (onDup ? 'a duplicate of "' + state.seq.sequenceName + '"' : 'the sequence "' + state.seq.sequenceName + '" itself') +
      '?' + (onDup ? '' : '\n\nThis writes to your open sequence. Premiere has no reliable scripted undo.');
    if (!window.confirm(msg)) return;

    $('btnApply').disabled = true;
    status('Writing cuts...');

    var esc = state.planFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    evalHost('cpswApplyPlan("' + esc + '")')
      .then(function (raw) {
        var r;
        try { r = JSON.parse(raw); }
        catch (e) { throw new Error('Unreadable host response: ' + String(raw).slice(0, 200)); }
        if (!r.ok) throw new Error(r.error);
        status(
          'Done on "' + r.sequence + '"' + (r.duplicated ? ' (a duplicate, your original is untouched)' : '') +
          '. ' + r.razors + ' razors, ' + r.kept + ' shots kept, ' +
          (r.removed ? r.removed + ' removed.' : r.disabled + ' disabled.'),
          'ok'
        );
        refresh();
      })
      .catch(function (e) {
        $('btnApply').disabled = false;
        status('Apply failed: ' + (e.message || e), 'err');
      });
  }

  /* ------------------------------------------------------------------- wiring */

  function wireCards() {
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      (function (card) {
        card.querySelector('header').addEventListener('click', function () {
          card.className = card.className.indexOf('collapsed') !== -1
            ? card.className.replace(/\s*collapsed/, '')
            : card.className + ' collapsed';
        });
      })(cards[i]);
    }
  }

  function init() {
    // Render the UI before touching anything that can fail, so a host problem
    // leaves a usable panel with a readable message instead of an empty one.
    var restored = false;
    try {
      // Before the first render, so the controls come up showing the tuned values
      // rather than defaults that flicker.
      restored = loadPrefs();
      wireCards();
      renderQuick();
      renderSettings();
      refreshTemplateList();
    } catch (e) {
      status('Panel failed to build: ' + (e && e.message ? e.message : e), 'err');
      return;
    }

    if (hostError) {
      status(hostError + ' Settings and templates still work; reading the sequence does not.', 'err');
    } else if (restored) {
      status('Settings restored from last session.');
    }

    // Wrapped, not passed directly: the click Event would arrive as `rebuild` and
    // every Refresh would silently wipe the roster, which is the bug being fixed.
    $('btnRefresh').addEventListener('click', function () { refresh(false); });
    $('btnRebuild').addEventListener('click', function () {
      if (state.speakers.length || state.angles.length) {
        if (!window.confirm(
          'Rebuild discards every name, side, camera tag, shot type and camera id, and re-detects them from the sequence.\n\n' +
          'Your saved templates are not touched. Continue?'
        )) return;
      }
      refresh(true);
    });
    $('useInOut').addEventListener('change', function () { renderRange(); invalidatePlan(); });

    $('templateSelect').addEventListener('change', function () {
      var n = $('templateSelect').value;
      if (n) loadTemplate(n); else state.templateName = '';
    });
    $('btnTplSave').addEventListener('click', function () {
      var n = state.templateName || window.prompt('Template name:', 'Counterpoint');
      if (n) saveTemplate(n.trim());
    });
    $('btnTplSaveAs').addEventListener('click', function () {
      var n = window.prompt('Save as:', state.templateName || 'Counterpoint');
      if (n) saveTemplate(n.trim());
    });
    $('btnTplDup').addEventListener('click', function () {
      if (!state.templateName) { status('Nothing loaded to duplicate.', 'err'); return; }
      var n = window.prompt('Duplicate as:', state.templateName + ' copy');
      if (n) saveTemplate(n.trim());
    });
    $('btnTplDelete').addEventListener('click', function () {
      var n = state.templateName;
      if (!n) { status('No template selected.', 'err'); return; }
      if (!window.confirm('Delete template "' + n + '"?')) return;
      try {
        fs.unlinkSync(path.join(templateDir(), n + '.json'));
        state.templateName = '';
        refreshTemplateList();
        status('Deleted "' + n + '".', 'ok');
      } catch (e) { status('Could not delete: ' + e.message, 'err'); }
    });

    $('btnResetAdvanced').addEventListener('click', function () {
      if (!window.confirm('Reset every setting to its default? Speakers and cameras are not affected.')) return;
      state.settings = cpswDefaultSettings();
      renderQuick();
      renderSettings();
      settingChanged();
      status('Settings reset to defaults.', 'ok');
    });

    $('btnPreview').addEventListener('click', preview);
    $('btnApply').addEventListener('click', apply);
    $('btnFillerContinue').addEventListener('click', applyTrimAndContinue);

    // Capability check on load, so a missing mechanism surfaces now rather than
    // halfway through writing a cut.
    evalHost('cpswCapabilities()').then(function (raw) {
      try {
        var cap = JSON.parse(raw);
        if (cap.trackItemDisabled !== 'boolean' && state.settings.method === 'disable') {
          showWarnings(['This Premiere build does not expose clip disable. Switch Output method to Delete.']);
        }
        if (cap.hasSequence) refresh();
      } catch (e) { /* leave the default status */ }
    }).catch(function () { /* panel still usable */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
