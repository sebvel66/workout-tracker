// ui.js — DOM rendering, UI-only state, modal management, and all event listeners.
//
// Loads after data.js so every `buildDay`/`persistSet`/etc. reference inside
// event handlers resolves when the user interacts. Event-listener attachment at
// the top level is safe because scripts sit at the end of <body>, so the DOM is
// already parsed by the time this file runs.

// ---- UI-only state ----

// Rest timer uses a wall-clock deadline (restTargetMs) so it survives
// backgrounding: iOS suspends setInterval when the PWA loses focus, but
// Date.now() is still the real clock when we return. restCompleted makes
// the completion path idempotent since the tick and the visibilitychange
// catch-up can both observe the deadline in the same foreground pass.
var restInterval = null;
var restTargetMs = 0;
var restCompleted = false;
var restAudioCtx = null;
var sessionTimerInterval = null;

var pickerState = { search: '', equipment: [], muscleGroup: [] };

// History browser state — week-scoped summary view with a detail drill-down
// when a workout card is tapped. weekStart keys are 'YYYY-MM-DD' (Sunday).
var historyView = 'week';           // 'week' | 'detail'
var historyWeekStart = null;        // currently-viewed Sunday, YYYY-MM-DD
var historyWeekCache = {};          // weekStart → fetchWeekSummary result
var historyWeekLoading = false;
var historyDetails = {};            // workoutId → { workout, state } for detail view

// Physique photos browser state — modal with three sub-views.
var photosView = 'gallery';         // 'gallery' | 'upload' | 'viewer'
var photosPendingFile = null;       // File selected in the picker, pending upload
var photosPendingPreviewUrl = null; // blob: URL for the pending file (revoke when done)
var photosViewerId = null;          // id of the photo currently in the viewer

// AI plan generator state — modal with a loading view while the Edge
// Function runs (~30-60s) and a review view once the plan comes back.
var generateView = 'loading';       // 'loading' | 'review'
var generatedPlan = null;           // the full plan JSON returned by /api/generate-plan
var generatedMeta = null;           // { model, usage, generated_at }
var generateStartedAt = 0;          // ms timestamp when the API call started
var generateInFlight = false;       // prevents double-fire of the generate button
var generateAbortController = null; // wired to the in-flight fetch so Cancel can abort

// Plans management state — list view with activate/delete actions.
var plansList = [];                 // [{id, title, week, is_active, created_at, start_date, workout_count}]
var plansLoading = false;

// Picker option lists
var EQUIPMENT_OPTIONS = ['barbell', 'dumbbell', 'cable', 'machine', 'smith machine', 'bodyweight', 'band'];
var MUSCLE_OPTIONS = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'quads', 'hamstrings', 'glutes', 'core', 'calves'];

// Toast incrementing id
var toastCounter = 0;

// ---- Escape helpers ----
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function(c){ return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

// ---- Format helpers ----
function fmtElapsed(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return h > 0 ? (h + ':' + pad(m) + ':' + pad(sec)) : (pad(m) + ':' + pad(sec));
}

function fmtDuration(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var pad2 = function(n) { return n < 10 ? '0' + n : '' + n; };
  return h > 0 ? (h + 'h ' + pad2(m) + 'm') : (m + 'm');
}

// ---- Render helpers ----
function renderSetRow(di, ei, si, sl, prescribedSet, weightMode, disabledAttr, prText, deletable) {
  var currentUnit = getWeightUnit();
  var prescribedLbs = normalizePrescribedLbs(prescribedSet);
  var weightCls = prescribedLbs != null ? inputCls(sl.weight, prescribedLbs) : '';
  var repsCls = prescribedSet ? inputCls(sl.reps, prescribedSet.reps_target) : '';
  var weightPlaceholder = prescribedLbs != null ? displayWeight(prescribedLbs, currentUnit) : '—';
  var repsPlaceholder = prescribedSet && prescribedSet.reps_target ? prescribedSet.reps_target : '—';

  var out = '';
  var extraCls = sl && sl.isExtra ? ' set-extra' : '';
  out += '<div class="set-row' + (deletable ? ' deletable' : '') + extraCls + '">';
  out += '<div class="set-label">S' + (si+1) + '</div>';
  out += '<div class="set-prescribed">' + (prText || '—') + '</div>';
  out += '<div class="set-actual">';
  if (weightMode !== 'none') {
    var lbl;
    if (weightMode === 'bodyweight') {
      lbl = 'ADD WT';
    } else {
      lbl = currentUnit === 'kg' ? 'KG' : 'LBS';
    }
    out += '<div class="input-group"><label class="input-label">' + lbl + '</label>';
    out += '<input type="number" inputmode="decimal" class="set-input ' + weightCls + '" value="' + displayWeight(sl.weight, currentUnit) + '" placeholder="' + weightPlaceholder + '" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '" data-field="weight" onfocus="this.select()"' + disabledAttr + '>';
    if (weightMode === 'per_side') out += '<div class="weight-mode-hint">per side</div>';
    out += '</div>';
  }
  out += '<div class="input-group"><label class="input-label">REPS</label>';
  out += '<input type="number" inputmode="numeric" class="set-input ' + repsCls + '" value="' + (sl.reps != null ? sl.reps : '') + '" placeholder="' + repsPlaceholder + '" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '" data-field="reps" onfocus="this.select()"' + disabledAttr + '>';
  out += '</div>';
  out += '</div>';
  out += '<button class="set-check ' + (sl.done ? 'done' : '') + '" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '"' + disabledAttr + '>' + (sl.done ? '✓' : '·') + '</button>';
  if (deletable) {
    out += '<button class="set-delete" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '"' + disabledAttr + ' aria-label="Delete set" type="button">×</button>';
  }
  out += '</div>';
  return out;
}

function fmtP(s) {
  var p = [];
  var lbsP = normalizePrescribedLbs(s);
  if (lbsP != null) {
    var u = getWeightUnit();
    p.push(displayWeight(lbsP, u) + u);
  }
  // Prefer reps_range (e.g. "8-12") since it carries more information, and
  // fall back to reps_target (the specific number) when no range is present.
  if (s.reps_range) p.push('x' + s.reps_range);
  else if (s.reps_target) p.push('x' + s.reps_target);
  return p.join(' ') || '—';
}

function inputCls(a, t) {
  if (!a || !t) return '';
  a = parseFloat(a); t = parseFloat(t);
  if (isNaN(a) || isNaN(t)) return '';
  if (a >= t) return 'over';
  if (a >= t * 0.85) return 'under';
  return 'miss';
}

// ---- Session-view sub-renderers (notes + location) ----
function renderSessionNotes(di, state, readOnly) {
  var notes = (state && state.notes) || '';
  var expanded = !!(state && state.notesExpanded);
  var preview = notes ? notes.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  var previewHtml = preview
    ? '<div class="session-notes-preview">' + escapeHtml(preview) + (notes.length > 40 ? '…' : '') + '</div>'
    : '<div class="session-notes-preview"></div>';
  var diAttr = 'data-di="' + escapeAttr(String(di)) + '"';
  var disabled = readOnly ? ' disabled readonly' : '';
  var h = '<div class="session-notes' + (expanded ? ' expanded' : '') + '" ' + diAttr + '>';
  h += '<div class="session-notes-header" ' + diAttr + '>';
  h += '<div class="session-notes-label">Session notes</div>';
  h += previewHtml;
  h += '<div class="session-notes-chevron">▾</div>';
  h += '</div>';
  h += '<div class="session-notes-body">';
  h += '<textarea class="session-notes-input" ' + diAttr + ' placeholder="How are you feeling today? Energy, soreness, sleep, stress..."' + disabled + '>' + escapeHtml(notes) + '</textarea>';
  h += '</div>';
  h += '</div>';
  return h;
}

function renderSessionLocation(di, state, readOnly) {
  // Zero-gym case: show a prompt that opens the management modal.
  if (!locations.length) {
    return '<div class="session-location">'
         + '<div class="session-location-label">Location</div>'
         + '<button type="button" class="session-location-prompt" data-action="open-gym-profiles">+ Add a gym to tag workouts</button>'
         + '</div>';
  }
  // Resolve the default selection per the spec:
  //   1. state.locationId if set (hydrated from a real workout row).
  //   2. state.pendingLocationId if user touched the dropdown pre-save.
  //   3. recentLocationId as the zero-state default.
  var selected;
  if (state && state.locationId != null) {
    selected = state.locationId;
  } else if (state && state.pendingLocationId !== undefined) {
    selected = state.pendingLocationId;
  } else {
    selected = recentLocationId;
  }
  // Sort options: selected first (if any), then the rest in created_at desc.
  var ordered = [];
  if (selected) {
    for (var s = 0; s < locations.length; s++) {
      if (locations[s].id === selected) { ordered.push(locations[s]); break; }
    }
  }
  for (var i = 0; i < locations.length; i++) {
    if (locations[i].id !== selected) ordered.push(locations[i]);
  }
  var diAttr = 'data-di="' + escapeAttr(String(di)) + '"';
  var disabledAttr = readOnly ? ' disabled' : '';
  var h = '<div class="session-location">';
  h += '<div class="session-location-label">Location</div>';
  h += '<select class="session-location-select" ' + diAttr + disabledAttr + '>';
  h += '<option value=""' + ((selected == null || selected === '') ? ' selected' : '') + '>— No gym</option>';
  for (var j = 0; j < ordered.length; j++) {
    var row = ordered[j];
    var sel = row.id === selected ? ' selected' : '';
    h += '<option value="' + escapeAttr(row.id) + '"' + sel + '>' + escapeHtml(row.name) + '</option>';
  }
  h += '</select>';
  h += '</div>';
  return h;
}

// ---- Day builders (tabs + plan-day + ad-hoc) ----
function buildTabs() {
  var sel = document.getElementById('dayPicker');
  if (!sel) return;
  var h = '';
  if (plan) {
    h += '<optgroup label="Plan days">';
    for (var i = 0; i < plan.days.length; i++) {
      var d = plan.days[i];
      var planDayState = todayPlanStates[i];
      var hasToday = planDayState && Object.keys(planDayState.exercises || {}).length > 0;
      var hasData = hasToday || historicalCache[i];
      var dot = hasData ? '● ' : '';
      var label = d.short ? d.short + ' — ' + (d.name || '') : (d.name || 'Day ' + (i + 1));
      var inProg = planDayState && planDayState.workoutId && planDayState.startedAt && !planDayState.endedAt;
      var suffix = inProg ? ' (in progress)' : '';
      var sel_attr = currentDay === i ? ' selected' : '';
      h += '<option value="' + i + '"' + sel_attr + '>' + dot + escapeHtml(label) + suffix + '</option>';
    }
    h += '</optgroup>';
  }
  if (todayAdHocs.length) {
    h += '<optgroup label="Ad-hoc sessions">';
    for (var j = 0; j < todayAdHocs.length; j++) {
      var ah = todayAdHocs[j];
      var hasAdData = Object.keys(ah.exercises || {}).length > 0;
      var adDot = hasAdData ? '● ' : '';
      var adLabel = ah.title && ah.title.trim() ? ah.title.trim() : 'Session ' + (j + 1);
      var adKey = 'ah_' + ah.workoutId;
      var adSel = currentDay === adKey ? ' selected' : '';
      var adInProg = ah.workoutId && ah.startedAt && !ah.endedAt;
      var adSuffix = adInProg ? ' (in progress)' : '';
      h += '<option value="' + adKey + '"' + adSel + '>' + adDot + 'S' + (j + 1) + ' — ' + escapeHtml(adLabel) + adSuffix + '</option>';
    }
    h += '</optgroup>';
  }
  sel.innerHTML = h;
}

function buildDay(di) {
  // Ad-hoc branch: renders title input, session bar, exercise cards, Add Exercise.
  if (isAdHocKey(di)) {
    buildAdHocDay(di);
    return;
  }
  if (!plan) return;
  var mode = viewModeFor(di);
  var state = stateForDay(di);
  var planBlob = _planForState(state) || plan;
  if (!planBlob || !planBlob.days[di]) return;
  var dayPlan = planBlob.days[di];
  var c = document.getElementById('workoutContainer');
  var ts = 0, cs = 0;
  var readOnly = mode !== 'editable';
  var modeLabel = mode === 'historical' ? ' <span class="day-mode-tag">historical</span>'
                : mode === 'template' ? ' <span class="day-mode-tag">template</span>'
                : '';
  var h = '<div class="day-header"><h2>' + escapeHtml(dayPlan.name) + modeLabel + '</h2>' +
          '<div class="day-meta">' + (dayPlan.sets_total || '') + ' · ' + (dayPlan.duration || '') + '</div></div>';

  // Session bar: Start button → running timer + Complete button → final duration text.
  if (mode === 'editable') {
    if (!todayState || !todayState.workoutId) {
      h += '<button class="session-btn session-start" id="btnStartSession">Start Session</button>';
    } else if (todayState.startedAt && !todayState.endedAt) {
      h += '<div class="session-bar"><div class="session-timer" id="sessionTimer">' + fmtElapsed(sessionElapsedMs(todayState)) + '</div>' +
           '<button class="session-btn session-complete" id="btnCompleteSession">Complete Session</button></div>';
    } else if (todayState.startedAt && todayState.endedAt) {
      h += '<div class="session-bar done resumable"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(todayState)) + '</div>' +
           '<button class="session-btn session-resume" id="btnResumeSession" type="button">Resume</button></div>';
    }
  } else if (mode === 'historical' && state && state.startedAt && state.endedAt) {
    h += '<div class="session-bar done"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(state)) + '</div></div>';
  }

  h += renderSessionLocation(di, state, readOnly);
  h += renderSessionNotes(di, state, readOnly);

  for (var ei = 0; ei < dayPlan.exercises.length; ei++) {
    var ex = dayPlan.exercises[ei];
    var ek = 'ex_' + ei;
    var exState = (state && state.exercises[ek]) || { sets: [], rpe: null, note: '', sub: '' };
    var exTotal = Math.max(ex.sets.length, exState.sets.length);
    ts += exTotal;
    var dn = 0;
    for (var s = 0; s < exState.sets.length; s++) { if (exState.sets[s] && exState.sets[s].done) dn++; }
    cs += dn;
    var ad = dn === exTotal, sd = dn > 0 && !ad;
    var sc = ad ? 'complete' : sd ? 'partial' : 'pending';
    var stat = ad ? dn + '/' + exTotal + ' ✓' : dn + '/' + exTotal;
    var cc = ad ? ' complete' : sd ? ' partial' : '';
    var dis = readOnly ? ' disabled' : '';
    var weightMode = weightModeForName(ex.name);

    h += '<div class="exercise-card' + cc + '">';
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(ex.name) + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(ex.name) + '">view recent</button></div><div class="exercise-status ' + sc + '">' + stat + '</div></div>';
    if (ex.note) h += '<div class="exercise-note">' + escapeHtml(ex.note) + '</div>';
    h += '<div class="sets-container">';

    for (var si = 0; si < ex.sets.length; si++) {
      var set = ex.sets[si];
      var sl = exState.sets[si] || {};
      var pr = fmtP(set);
      h += renderSetRow(di, ei, si, sl, set, weightMode, dis, pr);
    }

    // Extras on this prescribed exercise: sets past the plan-defined count.
    // sl.isExtra is set on these by addExtraSet / stateFromWorkout. Delete
    // button is rendered via the deletable flag; prescribed rows above stay
    // immutable.
    for (var siExtra = ex.sets.length; siExtra < exState.sets.length; siExtra++) {
      var slExtra = exState.sets[siExtra] || {};
      h += renderSetRow(di, ei, siExtra, slExtra, null, weightMode, dis, '—', !readOnly);
    }
    if (mode === 'editable') {
      h += '<button class="add-set-btn" data-add-set-ei="' + ei + '">+ Add Set</button>';
    }

    h += '<div class="rpe-row"><div class="rpe-label">RPE</div><div class="rpe-buttons">';
    var rv = [6,7,8,9,10];
    for (var r = 0; r < rv.length; r++) {
      h += '<button class="rpe-btn' + (exState.rpe === rv[r] ? ' selected' : '') + '" data-di="' + di + '" data-ei="' + ei + '" data-rpe="' + rv[r] + '"' + dis + '>' + rv[r] + '</button>';
    }
    h += '</div></div></div>';

    h += '<div class="sub-row"><div class="sub-label">SUB:</div><input type="text" class="sub-input" value="' + escapeAttr(exState.sub || '') + '" placeholder="Substituted exercise" data-di="' + di + '" data-ei="' + ei + '"' + dis + '></div>';
    h += '<div style="padding:0 14px 14px"><textarea class="exercise-note-input" rows="1" placeholder="Notes" data-di="' + di + '" data-ei="' + ei + '"' + dis + '>' + escapeHtml(exState.note || '') + '</textarea></div>';
    h += '</div>';
  }

  // Render extras (ad-hoc exercises) after the prescribed loop.
  var planLen = dayPlan.exercises.length;
  var extraKeys = [];
  if (state && state.exercises) {
    for (var k in state.exercises) {
      if (state.exercises[k].isExtra) extraKeys.push(k);
    }
    extraKeys.sort(function(a, b) { return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10); });
  }
  if (extraKeys.length) h += '<div class="extras-divider">Added exercises</div>';
  for (var xi = 0; xi < extraKeys.length; xi++) {
    var xek = extraKeys[xi];
    var xei = parseInt(xek.slice(3), 10);
    var xState = state.exercises[xek];
    var xMeta = xState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
    var xWeightMode = xMeta.weight_mode || 'total';
    var xSetCount = xState.sets.length || 1;
    ts += xSetCount;
    var xdn = 0;
    for (var xsi = 0; xsi < xState.sets.length; xsi++) {
      if (xState.sets[xsi] && xState.sets[xsi].done) xdn++;
    }
    cs += xdn;
    var xad = xdn === xSetCount, xsd = xdn > 0 && !xad;
    var xsc = xad ? 'complete' : xsd ? 'partial' : 'pending';
    var xstat = xad ? xdn + '/' + xSetCount + ' ✓' : xdn + '/' + xSetCount;
    var xcc = xad ? ' complete' : xsd ? ' partial' : '';

    h += '<div class="exercise-card' + xcc + '">';
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(xMeta.name) + '<span class="extras-badge">added</span></div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(xMeta.name) + '">view recent</button></div><div class="exercise-status ' + xsc + '">' + xstat + '</div>' + (readOnly ? '' : '<button class="card-delete" data-di="' + di + '" data-ei="' + xei + '" aria-label="Delete exercise" type="button">×</button>') + '</div>';
    h += '<div class="sets-container">';
    for (var xsi2 = 0; xsi2 < xSetCount; xsi2++) {
      var xsl = xState.sets[xsi2] || {};
      h += renderSetRow(di, xei, xsi2, xsl, null, xWeightMode, dis, '—', !readOnly);
    }
    if (mode === 'editable') {
      h += '<button class="add-set-btn" data-add-set-ei="' + xei + '">+ Add Set</button>';
    }
    h += '</div>';
    h += '<div class="rpe-row"><div class="rpe-label">RPE</div><div class="rpe-buttons">';
    for (var xr = 0; xr < rv.length; xr++) {
      h += '<button class="rpe-btn' + (xState.rpe === rv[xr] ? ' selected' : '') + '" data-di="' + di + '" data-ei="' + xei + '" data-rpe="' + rv[xr] + '"' + dis + '>' + rv[xr] + '</button>';
    }
    h += '</div></div>';
    h += '<div style="padding:0 14px 14px"><textarea class="exercise-note-input" rows="1" placeholder="Notes" data-di="' + di + '" data-ei="' + xei + '"' + dis + '>' + escapeHtml(xState.note || '') + '</textarea></div>';
    h += '</div>';
  }

  if (mode === 'editable') {
    h += '<button class="add-exercise-btn" id="btnAddExercise" type="button">+ Add Exercise</button>';
  }

  c.innerHTML = h;
  document.getElementById('setsComplete').textContent = cs;
  document.getElementById('setsTotal').textContent = ts;
  document.getElementById('dayProgress').textContent = ts > 0 ? Math.round((cs / ts) * 100) + '%' : '0%';

  // Manage the session timer ticker based on the rendered state.
  if (mode === 'editable' && todayState && todayState.startedAt && !todayState.endedAt && todayState.dayIndex === di) {
    startTimerTick();
  } else {
    stopTimerTick();
  }
}

function buildAdHocDay(di) {
  var state = findAdHoc(di);
  var c = document.getElementById('workoutContainer');
  if (!state) {
    c.innerHTML = '<div class="empty-state"><h3>Session not found</h3></div>';
    stopTimerTick();
    return;
  }
  var readOnly = false; // ad-hoc is always editable today; historical ad-hoc out of scope
  var dis = '';
  var dateLabel = state.startedAt
    ? new Date(state.startedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : '';

  var h = '';
  h += '<div class="adhoc-header">';
  h += '<input type="text" class="adhoc-title-input" id="adhocTitleInput" placeholder="What are you working on?" value="' + escapeAttr(state.title || '') + '" data-workout-id="' + state.workoutId + '">';
  h += '<div class="adhoc-date">' + escapeHtml(dateLabel) + '</div>';
  h += '</div>';

  // Session bar: ad-hoc always has a workoutId from the moment of creation,
  // so it starts on the running-timer state.
  if (state.startedAt && !state.endedAt) {
    h += '<div class="session-bar"><div class="session-timer" id="sessionTimer">' + fmtElapsed(sessionElapsedMs(state)) + '</div>' +
         '<button class="session-btn session-complete" id="btnCompleteSession">Complete Session</button></div>';
  } else if (state.startedAt && state.endedAt) {
    h += '<div class="session-bar done resumable"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(state)) + '</div>' +
         '<button class="session-btn session-resume" id="btnResumeSession" type="button">Resume</button></div>';
  }

  h += renderSessionLocation(di, state, false);
  h += renderSessionNotes(di, state, false);

  var ts = 0, cs = 0;
  var keys = Object.keys(state.exercises || {}).sort(function(a, b) {
    return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
  });

  for (var xi = 0; xi < keys.length; xi++) {
    var ek = keys[xi];
    var ei = parseInt(ek.slice(3), 10);
    var exState = state.exercises[ek];
    var meta = exState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
    var weightMode = meta.weight_mode || 'total';
    var setCount = exState.sets.length || 1;
    ts += setCount;
    var dn = 0;
    for (var s = 0; s < exState.sets.length; s++) {
      if (exState.sets[s] && exState.sets[s].done) dn++;
    }
    cs += dn;
    var ad = dn === setCount, sd = dn > 0 && !ad;
    var sc = ad ? 'complete' : sd ? 'partial' : 'pending';
    var stat = ad ? dn + '/' + setCount + ' ✓' : dn + '/' + setCount;
    var cc = ad ? ' complete' : sd ? ' partial' : '';

    h += '<div class="exercise-card' + cc + '">';
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(meta.name) + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(meta.name) + '">view recent</button></div><div class="exercise-status ' + sc + '">' + stat + '</div><button class="card-delete" data-di="' + di + '" data-ei="' + ei + '" aria-label="Delete exercise" type="button">×</button></div>';
    h += '<div class="sets-container">';
    for (var si = 0; si < setCount; si++) {
      var sl = exState.sets[si] || {};
      h += renderSetRow(di, ei, si, sl, null, weightMode, dis, '—', true);
    }
    h += '<button class="add-set-btn" data-add-set-ei="' + ei + '">+ Add Set</button>';
    h += '</div>';
    h += '<div class="rpe-row"><div class="rpe-label">RPE</div><div class="rpe-buttons">';
    var rv = [6,7,8,9,10];
    for (var r = 0; r < rv.length; r++) {
      h += '<button class="rpe-btn' + (exState.rpe === rv[r] ? ' selected' : '') + '" data-di="' + di + '" data-ei="' + ei + '" data-rpe="' + rv[r] + '"' + dis + '>' + rv[r] + '</button>';
    }
    h += '</div></div>';
    h += '<div style="padding:0 14px 14px"><textarea class="exercise-note-input" rows="1" placeholder="Notes" data-di="' + di + '" data-ei="' + ei + '"' + dis + '>' + escapeHtml(exState.note || '') + '</textarea></div>';
    h += '</div>';
  }

  h += '<button class="add-exercise-btn" id="btnAddExercise" type="button">+ Add Exercise</button>';
  h += '<button class="delete-session-btn" id="btnDeleteAdHoc" type="button">Delete session</button>';

  c.innerHTML = h;
  document.getElementById('setsComplete').textContent = cs;
  document.getElementById('setsTotal').textContent = ts;
  document.getElementById('dayProgress').textContent = ts > 0 ? Math.round((cs / ts) * 100) + '%' : '0%';

  // Timer ticker for ad-hoc: running if started but not ended.
  if (todayState && todayState.isAdHoc && todayState.workoutId === state.workoutId
      && state.startedAt && !state.endedAt) {
    startTimerTick();
  } else {
    stopTimerTick();
  }
}

// ---- Hamburger menu ----
function openMenu() {
  var row = document.getElementById('menuWeightUnit');
  if (row) {
    row.textContent = 'Weight unit (' + getWeightUnit() + ')';
  }
  document.getElementById('menuOverlay').classList.add('show');
}

function closeMenu() {
  document.getElementById('menuOverlay').classList.remove('show');
}

// ---- Gym Profiles management modal ----
function openGymProfiles() {
  renderGymProfiles();
  document.getElementById('gymProfilesOverlay').classList.add('show');
  var input = document.getElementById('gymProfilesAddInput');
  if (input) input.value = '';
}

function closeGymProfiles() {
  document.getElementById('gymProfilesOverlay').classList.remove('show');
  // Re-render the session view so any rename/delete effects are visible
  // in the dropdown / badges.
  buildDay(currentDay);
}

function renderGymProfiles() {
  var list = document.getElementById('gymProfilesList');
  if (!list) return;
  if (!locations.length) {
    list.innerHTML = '<div class="gym-profiles-empty">No gyms yet. Add one above to start tagging workouts.</div>';
    return;
  }
  var h = '';
  for (var i = 0; i < locations.length; i++) {
    var row = locations[i];
    h += '<div class="gym-profiles-row" data-id="' + escapeAttr(row.id) + '">';
    h += '<div class="gym-profiles-row-name" data-action="rename" data-id="' + escapeAttr(row.id) + '">' + escapeHtml(row.name) + '</div>';
    h += '<button type="button" class="gym-profiles-row-delete" data-action="delete" data-id="' + escapeAttr(row.id) + '" aria-label="Delete">×</button>';
    h += '</div>';
  }
  list.innerHTML = h;
}

// ---- Exercise picker ----
function openPicker() {
  pickerState.search = '';
  pickerState.equipment = [];
  pickerState.muscleGroup = [];
  var si = document.getElementById('pickerSearch');
  if (si) si.value = '';
  renderPicker();
  document.getElementById('pickerOverlay').classList.add('show');
  setTimeout(function(){ if (si) si.focus(); }, 100);
}

function closePicker() {
  document.getElementById('pickerOverlay').classList.remove('show');
}

function renderPicker() {
  renderPickerChips('pickerEquipmentChips', EQUIPMENT_OPTIONS, pickerState.equipment, 'equipment');
  renderPickerChips('pickerMuscleChips', MUSCLE_OPTIONS, pickerState.muscleGroup, 'muscle');
  renderPickerRecent();
  renderPickerResults();
}

function renderPickerChips(containerId, options, active, dataKind) {
  var el = document.getElementById(containerId);
  if (!el) return;
  var h = '';
  for (var i = 0; i < options.length; i++) {
    var val = options[i];
    var isActive = active.indexOf(val) !== -1;
    h += '<button type="button" class="chip' + (isActive ? ' active' : '') + '" data-chip="' + dataKind + '" data-value="' + val + '">' + val + '</button>';
  }
  el.innerHTML = h;
}

function renderPickerRecent() {
  var row = document.getElementById('pickerRecent');
  var label = document.getElementById('pickerRecentLabel');
  if (!row) return;
  if (!recentExercises.length) {
    row.innerHTML = '';
    if (label) label.style.display = 'none';
    return;
  }
  if (label) label.style.display = 'block';
  var h = '';
  for (var i = 0; i < recentExercises.length; i++) {
    var r = recentExercises[i];
    h += '<button type="button" class="recent-pill" data-exercise-id="' + r.id + '">' + escapeHtml(r.name) + '</button>';
  }
  row.innerHTML = h;
}

function renderPickerResults() {
  var el = document.getElementById('pickerResults');
  if (!el) return;
  var q = (pickerState.search || '').trim().toLowerCase();
  var eq = pickerState.equipment, mg = pickerState.muscleGroup;
  var matches = [];
  for (var i = 0; i < exerciseLibrary.length; i++) {
    var r = exerciseLibrary[i];
    if (q && r.name.indexOf(q) === -1) continue;
    if (eq.length && eq.indexOf(r.equipment) === -1) continue;
    if (mg.length && mg.indexOf(r.muscle_group) === -1) continue;
    matches.push(r);
    if (matches.length >= 200) break;
  }
  if (!matches.length) {
    el.innerHTML = '<div class="picker-empty">No matches — try adjusting filters or create a custom exercise below.</div>';
    return;
  }
  var h = '';
  for (var j = 0; j < matches.length; j++) {
    var m = matches[j];
    var meta = [];
    if (m.equipment) meta.push(m.equipment);
    if (m.muscle_group) meta.push(m.muscle_group);
    if (m.weight_mode && m.weight_mode !== 'total') meta.push(m.weight_mode.replace('_', ' '));
    h += '<button type="button" class="picker-item" data-exercise-id="' + m.id + '">';
    h += '<div class="picker-item-name">' + escapeHtml(m.name) + '</div>';
    if (meta.length) h += '<div class="picker-item-meta">' + meta.join(' <span class="sep">·</span> ') + '</div>';
    h += '</button>';
  }
  el.innerHTML = h;
}

function togglePickerChip(kind, value) {
  var arr = kind === 'equipment' ? pickerState.equipment : pickerState.muscleGroup;
  var idx = arr.indexOf(value);
  if (idx === -1) arr.push(value); else arr.splice(idx, 1);
  renderPickerChips(kind === 'equipment' ? 'pickerEquipmentChips' : 'pickerMuscleChips',
    kind === 'equipment' ? EQUIPMENT_OPTIONS : MUSCLE_OPTIONS, arr, kind);
  renderPickerResults();
}

function selectExerciseFromPicker(exerciseId) {
  var row = exerciseLibraryById[exerciseId];
  if (!row) { showToast('Exercise not found', null); return; }
  closePicker();
  addExerciseToSession(row);
}

// ---- Custom-exercise form ----
function openCustomForm() {
  document.getElementById('cfName').value = '';
  document.getElementById('cfEquipment').value = '';
  document.getElementById('cfMuscle').value = '';
  document.getElementById('cfWeightMode').value = 'total';
  document.getElementById('customFormOverlay').classList.add('show');
  setTimeout(function(){ document.getElementById('cfName').focus(); }, 100);
}

function closeCustomForm() {
  document.getElementById('customFormOverlay').classList.remove('show');
}

async function submitCustomForm() {
  var name = (document.getElementById('cfName').value || '').trim();
  if (!name) { showToast('Name is required', null); return; }
  var equipment = document.getElementById('cfEquipment').value || null;
  var muscle_group = document.getElementById('cfMuscle').value || null;
  var weight_mode = document.getElementById('cfWeightMode').value || 'total';
  var normalized = normName(name);
  // If a seed or user row already exists with this name, reuse it silently.
  if (exerciseLibraryByName[normalized]) {
    selectExerciseFromPicker(exerciseLibraryByName[normalized].id);
    closeCustomForm();
    return;
  }
  try {
    var res = await sb.from('exercises').insert({
      user_id: userId, name: normalized,
      equipment: equipment, muscle_group: muscle_group,
      weight_mode: weight_mode, is_custom: true,
    }).select().single();
    if (res.error) throw res.error;
    exerciseLibrary.push(res.data);
    exerciseLibraryByName[res.data.name] = res.data;
    exerciseLibraryById[res.data.id] = res.data;
    exerciseIdCache[res.data.name] = res.data.id;
    closeCustomForm();
    selectExerciseFromPicker(res.data.id);
  } catch(err) {
    console.error('submitCustomForm error:', err);
    showToast("Couldn't create exercise: " + err.message, null);
  }
}

// ---- Start screen modal (flexible session start) ----
function openStartScreen() {
  var overlay = document.getElementById('startScreenOverlay');
  var suggestedBtn = document.getElementById('startPathSuggested');
  var pickDayBtn = document.getElementById('startPathPickDay');
  var pickDayList = document.getElementById('startPathPickDayList');
  var blankBtn = document.getElementById('startPathBlank');
  var emptyHint = document.getElementById('startPathEmptyHint');
  var closeBtn = document.getElementById('btnStartClose');

  // Collapse the day-picker list on every re-open (fresh state each time).
  pickDayList.classList.add('hidden');
  pickDayList.innerHTML = '';

  var hasPlan = !!(plan && plan.days && plan.days.length);
  if (hasPlan) {
    suggestedBtn.style.display = '';
    pickDayBtn.style.display = '';
    emptyHint.classList.add('hidden');
    var si = (suggestedDayIndex != null && suggestedDayIndex >= 0 && suggestedDayIndex < plan.days.length)
      ? suggestedDayIndex : 0;
    var dayName = plan.days[si].name || ('Day ' + (si + 1));
    document.getElementById('startPathSuggestedTitle').textContent = 'Start ' + dayName;
    // Hint: last completed day name + a relative date if we have it in memory.
    // Keep it terse — empty when no prior completion known to the client.
    document.getElementById('startPathSuggestedHint').textContent = '';
    suggestedBtn.setAttribute('data-di', String(si));
  } else {
    suggestedBtn.style.display = 'none';
    pickDayBtn.style.display = 'none';
    emptyHint.classList.remove('hidden');
  }

  // Close affordance: only allowed when there is a fallback state to land on.
  // No-plan + nothing-focused case hides close; user must pick a path.
  var hasFallback = hasPlan || (todayAdHocs && todayAdHocs.length);
  if (hasFallback) {
    closeBtn.classList.remove('hidden');
  } else {
    closeBtn.classList.add('hidden');
  }

  overlay.classList.add('show');
}

function closeStartScreen() {
  document.getElementById('startScreenOverlay').classList.remove('show');
}

function renderStartPathDayList() {
  var list = document.getElementById('startPathPickDayList');
  list.innerHTML = '';
  if (!plan || !plan.days) return;
  for (var i = 0; i < plan.days.length; i++) {
    var d = plan.days[i];
    var name = d.name || ('Day ' + (i + 1));
    var badge = '';
    var st = todayPlanStates[i];
    if (st && st.workoutId) {
      if (st.endedAt) {
        badge = '<span class="start-card-badge">completed today</span>';
      } else if (st.startedAt) {
        badge = '<span class="start-card-badge in-progress">in progress</span>';
      }
    }
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'start-day-row';
    row.setAttribute('data-di', String(i));
    row.innerHTML = '<span>' + escapeHtml(name) + '</span><span>' + badge + '</span>';
    list.appendChild(row);
  }
}

// ---- Per-exercise recent history modal ----
async function openExerciseHistory(exerciseName) {
  var title = exerciseName || 'Recent';
  document.getElementById('exHistoryTitle').textContent = title;
  var body = document.getElementById('exHistoryBody');
  body.innerHTML = '<div class="history-empty">Loading…</div>';
  document.getElementById('exHistoryOverlay').classList.add('show');

  var row = resolveLibraryRow(exerciseName);
  if (!row) {
    body.innerHTML = '<div class="history-empty">No history for this exercise yet.</div>';
    return;
  }

  try {
    var res = await sb.from('sets')
      .select('id, weight, reps, rpe, set_order, done, workout_id, workouts(performed_at, plan_id, day_index, title, location_id)')
      .eq('user_id', userId)
      .eq('exercise_id', row.id)
      .eq('done', true)
      .limit(200);
    if (res.error) throw res.error;
    var sets = (res.data || []).filter(function(s) { return s.workouts; });

    // Exclude the currently-focused workout so "recent" means prior sessions.
    var excludeId = todayState && todayState.workoutId;
    if (excludeId) sets = sets.filter(function(s) { return s.workout_id !== excludeId; });

    // Sort by workout performed_at desc client-side.
    sets.sort(function(a, b) {
      return new Date(b.workouts.performed_at).getTime() - new Date(a.workouts.performed_at).getTime();
    });

    // Group by workout, preserving the order we just sorted by.
    var byWorkout = {};
    var order = [];
    for (var i = 0; i < sets.length; i++) {
      var wId = sets[i].workout_id;
      if (!byWorkout[wId]) {
        byWorkout[wId] = {
          workoutId: wId,
          performedAt: sets[i].workouts.performed_at,
          planId: sets[i].workouts.plan_id,
          dayIndex: sets[i].workouts.day_index,
          title: sets[i].workouts.title,
          locationId: sets[i].workouts.location_id,
          sets: [],
        };
        order.push(wId);
      }
      byWorkout[wId].sets.push(sets[i]);
    }
    var sessions = order.slice(0, 5).map(function(id) { return byWorkout[id]; });

    if (!sessions.length) {
      body.innerHTML = '<div class="history-empty">No prior sessions logged for this exercise.</div>';
      return;
    }

    // Prefetch uncached plan blobs so session labels resolve.
    var missingPlans = {};
    for (var s = 0; s < sessions.length; s++) {
      var pid = sessions[s].planId;
      if (pid && !planCache[pid]) missingPlans[pid] = true;
    }
    var mpIds = Object.keys(missingPlans);
    if (mpIds.length) {
      var pr = await sb.from('plans').select('id, data').in('id', mpIds);
      if (pr.data) {
        for (var p = 0; p < pr.data.length; p++) {
          planCache[pr.data[p].id] = pr.data[p].data;
        }
      }
    }

    var h = '';
    for (var j = 0; j < sessions.length; j++) {
      var sess = sessions[j];
      var dateText = new Date(sess.performedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      var contextText = '';
      var planBlob = sess.planId ? planCache[sess.planId] : null;
      if (planBlob && planBlob.days && planBlob.days[sess.dayIndex]) {
        contextText = ' · ' + planBlob.days[sess.dayIndex].name;
      } else if (!sess.planId) {
        contextText = ' · ' + (sess.title || 'Ad-hoc');
      }
      if (sess.locationId && locationById[sess.locationId]) {
        contextText += ' · ' + locationById[sess.locationId].name;
      }
      sess.sets.sort(function(a, b) { return a.set_order - b.set_order; });
      var recentUnit = getWeightUnit();
      var setStrs = sess.sets.map(function(s) {
        var w = s.weight != null ? displayWeight(s.weight, recentUnit) : '—';
        var r = s.reps != null ? s.reps : '—';
        return w + ' × ' + r;
      });
      var rpes = sess.sets.map(function(s) { return s.rpe; }).filter(function(r) { return r != null; });
      var rpeText = '';
      if (rpes.length) {
        var uniq = rpes.filter(function(v, idx, arr) { return arr.indexOf(v) === idx; });
        rpeText = 'RPE ' + (uniq.length === 1 ? uniq[0] : rpes.join(', '));
      }
      h += '<div class="ex-history-session">';
      h += '<div class="ex-history-session-date">' + escapeHtml(dateText + contextText) + '</div>';
      h += '<div class="ex-history-sets">' + escapeHtml(setStrs.join('  ·  ')) + '</div>';
      if (rpeText) h += '<div class="ex-history-rpe">' + escapeHtml(rpeText) + '</div>';
      h += '</div>';
    }
    body.innerHTML = h;
  } catch(err) {
    console.error('openExerciseHistory error:', err);
    body.innerHTML = '<div class="history-empty">Couldn\'t load history for this exercise.</div>';
  }
}

function closeExerciseHistory() {
  document.getElementById('exHistoryOverlay').classList.remove('show');
}

// ---- History browser (weekly summary + detail) ----
async function openHistory() {
  historyView = 'week';
  document.getElementById('historyOverlay').classList.add('show');

  // Lazy-resolve the earliest workout date so we can gate "Previous week"
  // at the user's first-ever entry.
  if (earliestWorkoutDate === null) {
    await loadEarliestWorkoutDate();
  }

  // Default to the most recent completed week (= current week - 7 days).
  // If the user's first workout is newer than that window, default to
  // their earliest-workout week so the view isn't empty out of the gate.
  if (!historyWeekStart) {
    var currentStart = weekStartForLocalDate(new Date(sessionTodayDateString() + 'T00:00:00'));
    var prevStart = addDaysToDateString(currentStart, -7);
    if (earliestWorkoutDate && addDaysToDateString(prevStart, 6) < earliestWorkoutDate) {
      historyWeekStart = weekStartForLocalDate(new Date(earliestWorkoutDate + 'T00:00:00'));
    } else {
      historyWeekStart = prevStart;
    }
  }

  renderHistoryWeek();
  if (!historyWeekCache[historyWeekStart]) {
    loadHistoryWeek(historyWeekStart);
  }
}

function closeHistory() {
  document.getElementById('historyOverlay').classList.remove('show');
}

function backToHistoryWeek() {
  historyView = 'week';
  renderHistoryWeek();
}

async function loadHistoryWeek(weekStart) {
  if (historyWeekLoading) return;
  historyWeekLoading = true;
  renderHistoryWeek();
  var weekEnd = addDaysToDateString(weekStart, 6);
  try {
    var summary = await fetchWeekSummary(userId, weekStart, weekEnd);
    historyWeekCache[weekStart] = summary;
  } catch(err) {
    console.error('loadHistoryWeek error:', err);
    showToast("Couldn't load week", function(){ loadHistoryWeek(weekStart); });
  } finally {
    historyWeekLoading = false;
    if (historyView === 'week' && historyWeekStart === weekStart) {
      renderHistoryWeek();
    }
  }
}

function navigateHistoryWeek(delta) {
  if (!historyWeekStart) return;
  var target = addDaysToDateString(historyWeekStart, delta * 7);
  // Prev-gate: never step past the earliest workout's week.
  if (delta < 0 && earliestWorkoutDate && addDaysToDateString(target, 6) < earliestWorkoutDate) return;
  historyWeekStart = target;
  renderHistoryWeek();
  if (!historyWeekCache[historyWeekStart]) {
    loadHistoryWeek(historyWeekStart);
  }
}

function renderHistoryWeek() {
  document.getElementById('btnHistoryBack').style.display = 'none';
  document.getElementById('historyBackSpacer').style.display = 'block';
  document.getElementById('historyTitle').textContent = 'History';
  var body = document.getElementById('historyBody');

  var weekStart = historyWeekStart;
  var weekEnd = addDaysToDateString(weekStart, 6);
  var currentStart = weekStartForLocalDate(new Date(sessionTodayDateString() + 'T00:00:00'));
  var isCurrent = weekStart === currentStart;
  var isFuture = weekStart > currentStart;
  var nextDisabled = isCurrent || isFuture;
  var prevDisabled = false;
  if (earliestWorkoutDate) {
    var prevEnd = addDaysToDateString(addDaysToDateString(weekStart, -7), 6);
    if (prevEnd < earliestWorkoutDate) prevDisabled = true;
  }

  var label = formatWeekLabel(weekStart, weekEnd);
  if (isCurrent) label += ' (Current)';

  var h = '';
  h += '<div class="history-week-nav">';
  h += '<button class="history-week-arrow" id="btnHistoryWeekPrev" type="button"' + (prevDisabled ? ' disabled' : '') + '>←</button>';
  h += '<div class="history-week-label">' + escapeHtml(label) + '</div>';
  h += '<button class="history-week-arrow" id="btnHistoryWeekNext" type="button"' + (nextDisabled ? ' disabled' : '') + '>→</button>';
  h += '</div>';

  var summary = historyWeekCache[weekStart];
  if (!summary) {
    h += '<div class="history-empty">' + (historyWeekLoading ? 'Loading…' : '—') + '</div>';
    body.innerHTML = h;
    return;
  }

  h += renderHistoryWeekSummary(summary);
  h += renderHistorySkipped(summary);

  if (summary.workouts.length === 0) {
    h += '<div class="history-empty">No workouts this week.</div>';
  } else {
    for (var i = 0; i < summary.workouts.length; i++) {
      h += renderHistoryWorkoutCard(summary.workouts[i]);
    }
  }
  body.innerHTML = h;
}

function renderHistoryWeekSummary(summary) {
  var stats = [];
  var sessionLine = summary.workouts.length + (summary.workouts.length === 1 ? ' session' : ' sessions');
  if (summary.adHocSessions > 0) sessionLine += ' (' + summary.adHocSessions + ' ad-hoc)';
  stats.push({ label: 'Sessions', value: sessionLine });
  if (summary.daysPlanned != null) {
    stats.push({ label: 'Days', value: summary.daysTrained + ' / ' + summary.daysPlanned });
  }
  stats.push({ label: 'Volume', value: fmtHistoryVolume(summary.weekTotalVolume) });
  if (summary.weekAvgRpe != null) {
    stats.push({ label: 'Avg RPE', value: String(summary.weekAvgRpe) });
  }
  if (summary.weekCompletionRate != null) {
    stats.push({ label: 'Plan complete', value: Math.round(summary.weekCompletionRate * 100) + '%' });
  }
  var h = '<div class="history-week-summary">';
  for (var i = 0; i < stats.length; i++) {
    h += '<div class="history-week-stat">';
    h += '<div class="history-week-stat-label">' + escapeHtml(stats[i].label) + '</div>';
    h += '<div class="history-week-stat-value">' + escapeHtml(stats[i].value) + '</div>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function renderHistorySkipped(summary) {
  if (!summary.exercisesSkippedAcrossWeek || !summary.exercisesSkippedAcrossWeek.length) return '';
  return '<div class="history-skipped">Skipped: ' +
    escapeHtml(summary.exercisesSkippedAcrossWeek.join(', ')) + '</div>';
}

function renderHistoryWorkoutCard(w) {
  var d = new Date(w.date + 'T00:00:00');
  var dateText = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  var metaParts = [];
  if (w.duration != null) metaParts.push(w.duration + ' min');
  if (w.totalSets > 0) {
    metaParts.push(w.completedSets + '/' + w.totalSets + ' sets');
    metaParts.push(Math.round(w.completionRate * 100) + '%');
  } else {
    metaParts.push('0 sets');
  }
  var cls = 'history-row' + (w.isAdHoc ? ' ad-hoc' : '');
  var h = '<button type="button" class="' + cls + '" data-workout-id="' + escapeAttr(w.id) + '">';
  h += '<div class="history-row-date">' + escapeHtml(dateText) + '</div>';
  h += '<div class="history-row-title">' + escapeHtml(w.dayName) + '</div>';
  h += '<div class="history-row-meta">';
  for (var i = 0; i < metaParts.length; i++) {
    if (i > 0) h += ' <span class="sep">·</span> ';
    h += escapeHtml(metaParts[i]);
  }
  h += '</div>';
  h += '</button>';
  return h;
}

// Volume in the user's current unit (lbs/kg), abbreviated to 'k' past 10,000.
function fmtHistoryVolume(lbs) {
  if (lbs == null) return '—';
  var unit = getWeightUnit();
  var v = unit === 'kg' ? (lbs / LBS_PER_KG) : lbs;
  if (v >= 10000) return (Math.round(v / 100) / 10) + 'k ' + unit;
  return Math.round(v) + ' ' + unit;
}

async function openHistoryDetail(workoutId) {
  historyView = 'detail';
  document.getElementById('btnHistoryBack').style.display = 'block';
  document.getElementById('historyBackSpacer').style.display = 'none';
  var body = document.getElementById('historyBody');
  document.getElementById('historyTitle').textContent = 'Loading…';
  body.innerHTML = '<div class="history-empty">Loading…</div>';

  var detail = historyDetails[workoutId];
  if (!detail) {
    try {
      var res = await sb.from('workouts').select('*, sets(*)')
        .eq('id', workoutId).maybeSingle();
      if (res.error || !res.data) throw res.error || new Error('Not found');
      var row = res.data;
      if (row.plan_id && !planCache[row.plan_id]) {
        var pr = await sb.from('plans').select('data').eq('id', row.plan_id).maybeSingle();
        if (pr.data) planCache[row.plan_id] = pr.data.data;
      }
      detail = { workout: row, state: stateFromWorkout(row) };
      historyDetails[workoutId] = detail;
    } catch(err) {
      console.error('openHistoryDetail error:', err);
      body.innerHTML = '<div class="history-empty">Couldn\'t load this workout.</div>';
      document.getElementById('historyTitle').textContent = 'History';
      return;
    }
  }
  renderHistoryDetail(detail);
}

function renderHistoryDetail(detail) {
  var body = document.getElementById('historyBody');
  var state = detail.state;
  var workout = detail.workout;
  var isAdHoc = workout.plan_id === null;
  var planBlob = workout.plan_id ? planCache[workout.plan_id] : null;
  var dayPlan = (planBlob && planBlob.days && planBlob.days[workout.day_index]) || null;
  var titleText = isAdHoc
    ? ((workout.title && workout.title.trim()) || 'Ad-hoc session')
    : (dayPlan ? dayPlan.name : 'Day ' + ((workout.day_index != null ? workout.day_index : 0) + 1));
  document.getElementById('historyTitle').textContent = titleText;

  var dateText = new Date(workout.performed_at).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  var gymText = '';
  if (workout.location_id && locationById[workout.location_id]) {
    gymText = ' · ' + locationById[workout.location_id].name;
  }
  var h = '<div class="history-detail">';
  h += '<div class="history-detail-header">';
  h += '<div class="history-detail-meta">' + escapeHtml(dateText) + (isAdHoc ? ' · ad-hoc' : '') + escapeHtml(gymText) + '</div>';
  if (state.startedAt && state.endedAt) {
    var ms = sessionElapsedMs(state);
    h += '<div class="session-bar done" style="margin-top:12px"><div class="session-duration">Session: ' + fmtDuration(ms) + '</div></div>';
  }
  h += '</div>';

  if (isAdHoc) {
    var keys = Object.keys(state.exercises || {}).sort(function(a, b) {
      return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
    });
    for (var i = 0; i < keys.length; i++) {
      var ek = keys[i];
      var ei = parseInt(ek.slice(3), 10);
      var exState = state.exercises[ek];
      var meta = exState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
      h += renderHistoryExerciseCard(ei, exState, meta.name, meta.weight_mode || 'total', null);
    }
  } else if (dayPlan) {
    var planLen = dayPlan.exercises.length;
    for (var j = 0; j < planLen; j++) {
      var ex = dayPlan.exercises[j];
      var ek2 = 'ex_' + j;
      var exState2 = state.exercises[ek2];
      if (!exState2) continue; // nothing logged for this prescribed exercise
      var wm = weightModeForName(ex.name);
      h += renderHistoryExerciseCard(j, exState2, ex.name, wm, ex.sets);
    }
    var extraKeys = Object.keys(state.exercises || {}).filter(function(k) {
      return parseInt(k.slice(3), 10) >= planLen;
    }).sort(function(a, b) {
      return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
    });
    if (extraKeys.length) h += '<div class="extras-divider">Added exercises</div>';
    for (var k = 0; k < extraKeys.length; k++) {
      var ek3 = extraKeys[k];
      var ei3 = parseInt(ek3.slice(3), 10);
      var exState3 = state.exercises[ek3];
      var meta3 = exState3.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
      h += renderHistoryExerciseCard(ei3, exState3, meta3.name, meta3.weight_mode || 'total', null);
    }
  } else {
    h += '<div class="history-empty">Plan data for this workout isn\'t available; showing raw sets instead.</div>';
    var fallbackKeys = Object.keys(state.exercises || {}).sort(function(a, b) {
      return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
    });
    for (var m = 0; m < fallbackKeys.length; m++) {
      var ek4 = fallbackKeys[m];
      var ei4 = parseInt(ek4.slice(3), 10);
      var exState4 = state.exercises[ek4];
      var meta4 = exState4.exerciseMeta || { name: 'Exercise ' + (ei4 + 1), weight_mode: 'total' };
      h += renderHistoryExerciseCard(ei4, exState4, meta4.name, meta4.weight_mode || 'total', null);
    }
  }
  h += '</div>';
  body.innerHTML = h;
}

function renderHistoryExerciseCard(ei, exState, name, weightMode, prescribedSets) {
  var dn = 0;
  var setCount = exState.sets.length;
  for (var i = 0; i < exState.sets.length; i++) {
    if (exState.sets[i] && exState.sets[i].done) dn++;
  }
  var ad = setCount > 0 && dn === setCount;
  var sd = dn > 0 && !ad;
  var sc = ad ? 'complete' : sd ? 'partial' : 'pending';
  var stat = setCount > 0 ? (ad ? dn + '/' + setCount + ' ✓' : dn + '/' + setCount) : '';
  var cc = ad ? ' complete' : sd ? ' partial' : '';

  var h = '';
  h += '<div class="exercise-card' + cc + '">';
  h += '<div class="exercise-header"><div class="exercise-name">' + escapeHtml(name) + '</div><div class="exercise-status ' + sc + '">' + stat + '</div></div>';
  h += '<div class="sets-container">';
  for (var si = 0; si < setCount; si++) {
    var sl = exState.sets[si] || {};
    var prescribed = prescribedSets ? prescribedSets[si] : null;
    var prText = prescribed ? fmtP(prescribed) : '—';
    h += renderSetRow('history', ei, si, sl, prescribed, weightMode, ' disabled', prText, false);
  }
  h += '</div>';
  if (exState.rpe != null) {
    h += '<div class="rpe-row"><div class="rpe-label">RPE</div><div class="rpe-buttons">';
    var rv = [6,7,8,9,10];
    for (var r = 0; r < rv.length; r++) {
      h += '<button class="rpe-btn' + (exState.rpe === rv[r] ? ' selected' : '') + '" disabled>' + rv[r] + '</button>';
    }
    h += '</div></div>';
  }
  if (exState.sub) {
    h += '<div class="sub-row"><div class="sub-label">SUB:</div><div style="font-size:12px;color:var(--text2);flex:1">' + escapeHtml(exState.sub) + '</div></div>';
  }
  if (exState.note) {
    h += '<div style="padding:10px 14px 14px"><div class="exercise-note" style="display:block;padding:0">' + escapeHtml(exState.note) + '</div></div>';
  }
  h += '</div>';
  return h;
}

// ---- Physique photos browser ----
async function openPhotos() {
  resetPhotosPendingPreview();
  photosView = 'gallery';
  photosViewerId = null;
  document.getElementById('photosOverlay').classList.add('show');
  renderPhotos();
  if (!photosLoaded) {
    await loadPhysiquePhotos();
    if (photosView === 'gallery') renderPhotos();
  }
}

function closePhotos() {
  document.getElementById('photosOverlay').classList.remove('show');
  resetPhotosPendingPreview();
  photosPendingFile = null;
  photosViewerId = null;
}

function backToPhotosGallery() {
  resetPhotosPendingPreview();
  photosPendingFile = null;
  photosViewerId = null;
  photosView = 'gallery';
  renderPhotos();
}

function resetPhotosPendingPreview() {
  if (photosPendingPreviewUrl) {
    URL.revokeObjectURL(photosPendingPreviewUrl);
    photosPendingPreviewUrl = null;
  }
}

function renderPhotos() {
  var backBtn = document.getElementById('btnPhotosBack');
  var spacer = document.getElementById('photosBackSpacer');
  var title = document.getElementById('photosTitle');
  var body = document.getElementById('photosBody');
  if (photosView === 'gallery') {
    backBtn.style.display = 'none';
    spacer.style.display = 'block';
    title.textContent = 'Photos';
    renderPhotosGallery(body);
  } else if (photosView === 'upload') {
    backBtn.style.display = 'block';
    spacer.style.display = 'none';
    title.textContent = 'Add photo';
    renderPhotosUploadForm(body);
  } else if (photosView === 'viewer') {
    backBtn.style.display = 'block';
    spacer.style.display = 'none';
    title.textContent = 'Photo';
    renderPhotosViewer(body);
  }
}

function renderPhotosGallery(body) {
  var h = '';
  h += '<div class="photos-gallery-actions">';
  h += '<button type="button" class="photos-upload-btn" id="photosUploadBtn">Upload Photo</button>';
  h += '</div>';

  if (!photosLoaded) {
    h += '<div class="history-empty">Loading…</div>';
    body.innerHTML = h;
    return;
  }

  h += '<div class="photos-section-title">Goal</div>';
  if (!photosGoal) {
    h += '<div class="photos-empty">No goal photo yet. Upload one to set your target physique.</div>';
  } else {
    h += '<div class="photos-goal-wrap">' + renderPhotosThumb(photosGoal, 'goal-hero') + '</div>';
  }

  h += '<div class="photos-section-title">Progress</div>';
  if (!photosProgress.length) {
    h += '<div class="photos-empty">No progress photos yet.</div>';
  } else {
    h += '<div class="photos-grid">';
    for (var i = 0; i < photosProgress.length; i++) {
      h += renderPhotosThumb(photosProgress[i], 'progress-thumb');
    }
    h += '</div>';
  }

  body.innerHTML = h;
  // Thumbs render with empty background-image placeholders; resolve the
  // signed URLs asynchronously and paint each slot as its URL returns.
  hydratePhotosThumbs();
}

function renderPhotosThumb(row, cssClass) {
  var dateStr = new Date(row.taken_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  return '<button type="button" class="photos-thumb ' + cssClass + '" data-photo-id="' + escapeAttr(row.id) + '">' +
    '<div class="photos-thumb-img" data-storage-path="' + escapeAttr(row.storage_path) + '"></div>' +
    '<div class="photos-thumb-date">' + escapeHtml(dateStr) + '</div>' +
    '</button>';
}

function hydratePhotosThumbs() {
  var slots = document.querySelectorAll('.photos-thumb-img[data-storage-path]');
  for (var i = 0; i < slots.length; i++) {
    (function(slot) {
      var path = slot.getAttribute('data-storage-path');
      getPhotoSignedUrl(path).then(function(url) {
        if (!url || !slot.isConnected) return;
        slot.style.backgroundImage = 'url("' + url + '")';
      });
    })(slots[i]);
  }
}

function renderPhotosUploadForm(body) {
  var today = sessionTodayDateString();
  var h = '<div class="photos-upload-form">';
  h += '<div class="photos-upload-preview" id="photosUploadPreview"></div>';
  h += '<label class="photos-form-row">';
  h += '<span class="photos-form-label">Type</span>';
  h += '<select id="photosFormType" class="photos-form-input">';
  h += '<option value="progress">Progress</option>';
  h += '<option value="goal">Goal</option>';
  h += '</select></label>';
  h += '<label class="photos-form-row">';
  h += '<span class="photos-form-label">Date</span>';
  h += '<input type="date" id="photosFormDate" class="photos-form-input" value="' + escapeAttr(today) + '">';
  h += '</label>';
  h += '<label class="photos-form-row">';
  h += '<span class="photos-form-label">Notes (optional)</span>';
  h += '<input type="text" id="photosFormNotes" class="photos-form-input" placeholder="e.g. front double biceps, morning">';
  h += '</label>';
  h += '<button type="button" class="photos-submit-btn" id="photosSubmitBtn">Upload</button>';
  h += '</div>';
  body.innerHTML = h;
  if (photosPendingPreviewUrl) {
    document.getElementById('photosUploadPreview').style.backgroundImage = 'url("' + photosPendingPreviewUrl + '")';
  }
}

function renderPhotosViewer(body) {
  var row = findPhotoById(photosViewerId);
  if (!row) {
    body.innerHTML = '<div class="history-empty">Photo not found.</div>';
    return;
  }
  var dateStr = new Date(row.taken_at).toLocaleDateString(undefined, {
    weekday: 'short', month: 'long', day: 'numeric', year: 'numeric',
  });
  var typeLabel = row.photo_type === 'goal' ? 'Goal' : 'Progress';
  var h = '<div class="photos-viewer">';
  h += '<div class="photos-viewer-img" id="photosViewerImg" data-storage-path="' + escapeAttr(row.storage_path) + '"></div>';
  h += '<div class="photos-viewer-meta">';
  h += '<div class="photos-viewer-type">' + escapeHtml(typeLabel) + '</div>';
  h += '<div class="photos-viewer-date">' + escapeHtml(dateStr) + '</div>';
  if (row.notes) h += '<div class="photos-viewer-notes">' + escapeHtml(row.notes) + '</div>';
  h += '</div>';
  h += '<button type="button" class="photos-delete-btn" id="photosDeleteBtn" data-photo-id="' + escapeAttr(row.id) + '">Delete photo</button>';
  h += '</div>';
  body.innerHTML = h;
  getPhotoSignedUrl(row.storage_path).then(function(url) {
    var slot = document.getElementById('photosViewerImg');
    if (url && slot) slot.style.backgroundImage = 'url("' + url + '")';
  });
}

function findPhotoById(id) {
  if (photosGoal && photosGoal.id === id) return photosGoal;
  for (var i = 0; i < photosProgress.length; i++) {
    if (photosProgress[i].id === id) return photosProgress[i];
  }
  return null;
}

function handlePhotoPicked(e) {
  var file = e.target.files && e.target.files[0];
  e.target.value = '';  // allow re-picking the same file in a later session
  if (!file) return;
  resetPhotosPendingPreview();
  photosPendingFile = file;
  photosPendingPreviewUrl = URL.createObjectURL(file);
  photosView = 'upload';
  renderPhotos();
}

async function submitPhotoUpload() {
  if (!photosPendingFile) return;
  var type = document.getElementById('photosFormType').value;
  var takenAt = document.getElementById('photosFormDate').value || sessionTodayDateString();
  var notes = (document.getElementById('photosFormNotes').value || '').trim();
  var btn = document.getElementById('photosSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    await uploadPhysiquePhoto(photosPendingFile, type, takenAt, notes);
    await loadPhysiquePhotos();
    backToPhotosGallery();
    showToast('Photo uploaded', null);
  } catch(err) {
    console.error('submitPhotoUpload error:', err);
    showToast('Upload failed: ' + (err.message || 'unknown error'), null);
    btn.disabled = false;
    btn.textContent = 'Upload';
  }
}

async function onPhotoDelete(id) {
  var row = findPhotoById(id);
  if (!row) return;
  if (!confirm('Delete this photo? This cannot be undone.')) return;
  try {
    await deletePhysiquePhoto(id, row.storage_path);
    await loadPhysiquePhotos();
    backToPhotosGallery();
    showToast('Photo deleted', null);
  } catch(err) {
    console.error('onPhotoDelete error:', err);
    showToast('Delete failed: ' + (err.message || 'unknown error'), null);
  }
}

// ---- AI plan generation (Generate + Review) ----
async function openGenerate() {
  // If a previous fetch is still running, re-surface the loading modal
  // rather than silently ignoring the click or firing a duplicate
  // request. vercel dev serializes local function invocations, so
  // without this guard the user could queue up multiple 30-60s calls.
  if (generateInFlight) {
    document.getElementById('generateOverlay').classList.add('show');
    renderGenerate();
    return;
  }
  generateInFlight = true;
  generateView = 'loading';
  generatedPlan = null;
  generatedMeta = null;
  generateStartedAt = Date.now();
  generateAbortController = new AbortController();
  document.getElementById('generateOverlay').classList.add('show');
  renderGenerate();

  try {
    var sessionRes = await sb.auth.getSession();
    var token = sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
    if (!token) throw new Error('Not signed in');

    var res = await fetch('/api/generate-plan', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      signal: generateAbortController.signal,
    });
    var body = await res.json().catch(function() { return null; });

    if (res.status !== 200 || !body || !body.plan) {
      var msg = (body && body.error) || ('HTTP ' + res.status);
      closeGenerate();
      showToast('Plan generation failed: ' + msg, null);
      return;
    }

    generatedPlan = body.plan;
    generatedMeta = {
      model: body.model || 'unknown',
      weeks_analyzed: body.weeks_analyzed,
      generated_at: body.generated_at,
      elapsed_s: Math.round((Date.now() - generateStartedAt) / 1000),
    };
    generateView = 'review';
    renderGenerate();
  } catch(err) {
    if (err && err.name === 'AbortError') {
      // User canceled — the close/cleanup already ran from cancelGenerate.
      return;
    }
    console.error('openGenerate error:', err);
    closeGenerate();
    showToast('Plan generation failed: ' + (err.message || 'network error'), null);
  } finally {
    generateInFlight = false;
    generateAbortController = null;
  }
}

function cancelGenerate() {
  if (generateAbortController) {
    try { generateAbortController.abort(); } catch(e) { /* already aborted */ }
  }
  closeGenerate();
  showToast('Generation canceled', null);
}

function closeGenerate() {
  // Closing aborts any in-flight request so the user doesn't dismiss
  // the modal and leave a 30-60s fetch running in the background.
  // generateInFlight is cleared by the finally block in openGenerate
  // when the fetch actually settles (including on AbortError) — don't
  // fake it to false here, or a real in-flight request gets orphaned.
  if (generateInFlight && generateAbortController) {
    try { generateAbortController.abort(); } catch(e) { /* already aborted */ }
  }
  document.getElementById('generateOverlay').classList.remove('show');
  generatedPlan = null;
  generatedMeta = null;
}

function renderGenerate() {
  var title = document.getElementById('generateTitle');
  var body = document.getElementById('generateBody');
  if (generateView === 'loading') {
    title.textContent = 'Generating…';
    renderGenerateLoading(body);
  } else if (generateView === 'review') {
    title.textContent = 'Review plan';
    renderGenerateReview(body);
  }
}

function renderGenerateLoading(body) {
  body.innerHTML =
    '<div class="generate-loading">' +
      '<div class="generate-spinner"></div>' +
      '<div class="generate-status">Reviewing your training…</div>' +
      '<div class="generate-status-sub">Analyzing 4 weeks of data · usually 30-60 seconds</div>' +
      '<button type="button" class="generate-btn-cancel" id="btnGenerateAbort" style="margin-top:20px;min-width:120px;padding:10px 16px;border-radius:10px;font-family:Outfit,sans-serif;font-size:14px;font-weight:600;cursor:pointer;">Cancel</button>' +
    '</div>';
}

function renderGenerateReview(body) {
  if (!generatedPlan) { body.innerHTML = ''; return; }
  var p = generatedPlan;
  var coaching = p.coaching_notes || '';
  var meta = generatedMeta || {};

  var h = '<div class="generate-review">';

  if (coaching) {
    h += '<div class="generate-coaching-card">';
    h += '<div class="generate-coaching-label">Coach\'s notes</div>';
    h += '<div class="generate-coaching-text">' + escapeHtml(coaching) + '</div>';
    h += '</div>';
  }

  h += '<div class="generate-meta">' +
    escapeHtml(p.title || 'New plan') +
    (p.week ? ' · ' + escapeHtml(p.week) : '') +
    (meta.model ? ' · ' + escapeHtml(meta.model) : '') +
    (meta.elapsed_s ? ' · ' + meta.elapsed_s + 's' : '') +
    '</div>';

  var days = Array.isArray(p.days) ? p.days : [];
  for (var di = 0; di < days.length; di++) {
    var day = days[di];
    var exCount = Array.isArray(day.exercises) ? day.exercises.length : 0;
    var setCount = 0;
    for (var i = 0; i < exCount; i++) {
      setCount += Array.isArray(day.exercises[i].sets) ? day.exercises[i].sets.length : 0;
    }
    h += '<div class="generate-day-card">';
    h += '<div class="generate-day-header">';
    h += '<div class="generate-day-name">' + escapeHtml(day.name || 'Day ' + (di + 1)) + '</div>';
    h += '<div class="generate-day-meta">' + exCount + ' exercise' + (exCount === 1 ? '' : 's') +
         ' · ' + setCount + ' set' + (setCount === 1 ? '' : 's') + '</div>';
    h += '</div>';
    for (var j = 0; j < exCount; j++) {
      h += renderGenerateExercise(day.exercises[j]);
    }
    h += '</div>';
  }

  h += '<div class="generate-actions">';
  h += '<button class="generate-btn-cancel" id="btnGenerateCancel" type="button">Cancel</button>';
  h += '<button class="generate-btn-accept" id="btnGenerateAccept" type="button">Accept plan</button>';
  h += '</div>';
  h += '</div>';
  body.innerHTML = h;
}

function renderGenerateExercise(ex) {
  var name = ex.name || 'exercise';
  var mode = weightModeForName(name);
  var sets = Array.isArray(ex.sets) ? ex.sets : [];
  var setsLine = formatGenerateSets(sets, mode);
  var h = '<div class="generate-exercise">';
  h += '<div class="generate-exercise-name">' + escapeHtml(name) + '</div>';
  h += '<div class="generate-exercise-sets">' + escapeHtml(setsLine) + '</div>';
  if (ex.note) {
    h += '<div class="generate-exercise-note">' + escapeHtml(ex.note) + '</div>';
  }
  h += '</div>';
  return h;
}

// Compact per-exercise set summary. Collapses runs of identical sets
// into "Nx reps @ weight" form; if sets differ, lists them inline.
function formatGenerateSets(sets, mode) {
  if (!sets.length) return '—';
  var unit = getWeightUnit();
  function fmtWeight(w) {
    if (w == null) return '';
    var val = displayWeight(w, unit);
    if (mode === 'per_side') return val + ' ' + unit + '/ea';
    if (mode === 'bodyweight') return w === 0 ? 'BW' : ('BW+' + val + ' ' + unit);
    if (mode === 'none') return '';
    return val + ' ' + unit;
  }
  function fmtReps(s) {
    if (s.reps_range) return s.reps_range;
    if (s.reps_target != null) return String(s.reps_target);
    return '?';
  }
  function sigKey(s) { return (s.weight != null ? s.weight : '') + '|' + fmtReps(s); }

  // Collapse contiguous identical sets.
  var groups = [];
  var current = null;
  for (var i = 0; i < sets.length; i++) {
    var s = sets[i];
    var k = sigKey(s);
    if (current && current.key === k) {
      current.count++;
    } else {
      current = { key: k, count: 1, set: s };
      groups.push(current);
    }
  }
  var parts = [];
  for (var g = 0; g < groups.length; g++) {
    var gp = groups[g];
    var reps = fmtReps(gp.set);
    var wt = fmtWeight(gp.set.weight);
    var line = gp.count + '×' + reps + (wt ? ' @ ' + wt : '');
    parts.push(line);
  }
  return parts.join(', ');
}

async function onAcceptGeneratedPlan() {
  if (!generatedPlan) return;
  var btn = document.getElementById('btnGenerateAccept');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await savePlanAsActive(generatedPlan);
    var label = generatedPlan.week || generatedPlan.title || 'New plan';
    closeGenerate();
    showToast(label + ' loaded', null);
  } catch(err) {
    console.error('onAcceptGeneratedPlan error:', err);
    showToast('Failed to save plan: ' + (err.message || 'unknown error'), null);
    if (btn) { btn.disabled = false; btn.textContent = 'Accept plan'; }
  }
}

// ---- Plans management ----
async function openPlans() {
  document.getElementById('plansOverlay').classList.add('show');
  await loadPlans();
  renderPlans();
}

function closePlans() {
  document.getElementById('plansOverlay').classList.remove('show');
}

async function loadPlans() {
  plansLoading = true;
  renderPlans();
  try {
    var pr = await sb.from('plans')
      .select('id, title, week, is_active, created_at, data')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (pr.error) throw pr.error;

    // Count workouts per plan in a single pass.
    var cr = await sb.from('workouts')
      .select('plan_id')
      .eq('user_id', userId)
      .not('plan_id', 'is', null);
    var counts = {};
    if (!cr.error && cr.data) {
      for (var i = 0; i < cr.data.length; i++) {
        var pid = cr.data[i].plan_id;
        counts[pid] = (counts[pid] || 0) + 1;
      }
    }

    plansList = (pr.data || []).map(function(p) {
      return {
        id: p.id,
        title: p.title,
        week: p.week,
        is_active: p.is_active,
        created_at: p.created_at,
        start_date: (p.data && p.data.start_date) || null,
        workout_count: counts[p.id] || 0,
      };
    });
  } catch(err) {
    console.error('loadPlans error:', err);
    showToast("Couldn't load plans", null);
    plansList = [];
  } finally {
    plansLoading = false;
  }
}

function renderPlans() {
  var body = document.getElementById('plansBody');
  if (plansLoading) {
    body.innerHTML = '<div class="history-empty">Loading…</div>';
    return;
  }
  if (!plansList.length) {
    body.innerHTML = '<div class="history-empty">No plans yet.</div>';
    return;
  }
  var h = '<div class="plans-list">';
  for (var i = 0; i < plansList.length; i++) {
    var p = plansList[i];
    var dateLabel = p.start_date
      ? 'Started ' + p.start_date
      : 'Created ' + new Date(p.created_at).toLocaleDateString();
    h += '<div class="plans-row' + (p.is_active ? ' active' : '') + '">';
    h += '<div class="plans-row-main">';
    h += '<div class="plans-row-title">' + escapeHtml(p.title || 'Untitled');
    if (p.is_active) h += '<span class="plans-active-badge">Active</span>';
    h += '</div>';
    h += '<div class="plans-row-meta">';
    if (p.week) h += escapeHtml(p.week) + ' · ';
    h += escapeHtml(dateLabel) + ' · ' + p.workout_count + ' workout' + (p.workout_count === 1 ? '' : 's');
    h += '</div>';
    h += '</div>';
    h += '<div class="plans-row-actions">';
    h += '<button type="button" class="plans-btn activate" data-plan-id="' + escapeAttr(p.id) + '"' +
         (p.is_active ? ' disabled' : '') + '>Activate</button>';
    h += '<button type="button" class="plans-btn delete" data-plan-id="' + escapeAttr(p.id) + '"' +
         (p.workout_count > 0 ? ' disabled title="Has logged workouts"' : '') + '>Delete</button>';
    h += '</div>';
    h += '</div>';
  }
  h += '</div>';
  body.innerHTML = h;
}

async function onActivatePlan(planId) {
  var p = null;
  for (var i = 0; i < plansList.length; i++) {
    if (plansList[i].id === planId) { p = plansList[i]; break; }
  }
  if (!p || p.is_active) return;
  if (!confirm('Switch to "' + (p.title || 'Untitled') + '" as the active plan?')) return;
  try {
    await activateExistingPlan(planId);
    closePlans();
    showToast('Activated: ' + (p.title || 'plan'), null);
  } catch(err) {
    console.error('onActivatePlan error:', err);
    showToast("Couldn't activate plan: " + (err.message || 'unknown error'), null);
  }
}

async function onDeletePlan(planId) {
  var p = null;
  for (var i = 0; i < plansList.length; i++) {
    if (plansList[i].id === planId) { p = plansList[i]; break; }
  }
  if (!p || p.workout_count > 0) return;
  if (!confirm('Delete "' + (p.title || 'Untitled') + '"? This cannot be undone.')) return;
  try {
    var dr = await sb.from('plans').delete().eq('id', planId);
    if (dr.error) throw dr.error;
    await loadPlans();
    renderPlans();
    showToast('Plan deleted', null);
  } catch(err) {
    console.error('onDeletePlan error:', err);
    showToast("Couldn't delete plan: " + (err.message || 'unknown error'), null);
  }
}

// ---- Toast ----
function showToast(msg, retryFn) {
  toastCounter++;
  var id = toastCounter;
  var stack = document.getElementById('toastStack');
  if (!stack) return;
  var el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('data-id', id);
  var msgEl = document.createElement('div'); msgEl.className = 'toast-msg'; msgEl.textContent = msg;
  el.appendChild(msgEl);
  if (retryFn) {
    var r = document.createElement('div'); r.className = 'toast-retry'; r.textContent = 'tap to retry';
    el.appendChild(r);
  }
  el.addEventListener('click', function() {
    dismissToast(id);
    if (retryFn) retryFn();
  });
  stack.appendChild(el);
  // Toasts that offer a retry (i.e. a write failed and the user needs to
  // react) stay visible until the user taps them — errors never auto-dismiss.
  // Plain informational toasts auto-dismiss after 20s so they're not missed
  // mid-set but don't linger.
  if (!retryFn) {
    setTimeout(function() { dismissToast(id); }, 20000);
  }
}
function dismissToast(id) {
  var el = document.querySelector('.toast[data-id="' + id + '"]');
  if (el) el.remove();
}

// ---- Session timer tick ----
function startTimerTick() {
  stopTimerTick();
  if (!todayState || !todayState.startedAt || todayState.endedAt) return;
  sessionTimerInterval = setInterval(function() {
    var el = document.getElementById('sessionTimer');
    if (!el) { stopTimerTick(); return; }
    el.textContent = fmtElapsed(sessionElapsedMs(todayState));
  }, 1000);
}

function stopTimerTick() {
  if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
}

// ---- History cache invalidation ----
// Force the history browser to re-query on its next open. Called whenever
// a workout's "finished" status changes (Complete or Resume) so the
// cached week summary isn't stale. earliestWorkoutDate is also cleared
// so deleting the user's first-ever workout re-gates "Previous week"
// correctly.
function invalidateHistoryCache() {
  historyWeekCache = {};
  historyDetails = {};
  earliestWorkoutDate = null;
}

// ---- Rest timer ----
function restRemainingMs() {
  if (!restTargetMs) return 0;
  return Math.max(0, restTargetMs - Date.now());
}

function startRestTimer(sec) {
  if (typeof sec !== 'number' || sec <= 0) sec = 90;
  stopRestTimer();
  restTargetMs = Date.now() + sec * 1000;
  restCompleted = false;
  document.getElementById('restTimer').classList.add('show');
  document.getElementById('restOverlay').classList.add('show');
  updateRestDisplay();
  // 250ms tick so catch-up after backgrounding feels snappy; the callback
  // itself is cheap (one DOM read, one Date.now(), one DOM write).
  restInterval = setInterval(function() {
    if (restRemainingMs() <= 0) { restComplete(); return; }
    updateRestDisplay();
  }, 250);
}

function stopRestTimer() {
  if (restInterval) { clearInterval(restInterval); restInterval = null; }
  restTargetMs = 0;
  restCompleted = false;
  document.getElementById('restTimer').classList.remove('show');
  document.getElementById('restOverlay').classList.remove('show');
}

function restComplete() {
  if (restCompleted) return;
  restCompleted = true;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  restBeep();
  stopRestTimer();
}

// Single 880Hz sine chime, ~¼ second, with a smooth attack/release envelope
// so there's no click. AudioContext is lazy-created and reused across rest
// periods (browsers cap pages at ~6 contexts). The starting gesture that
// opened the timer has already unlocked autoplay on iOS/Chrome.
function restBeep() {
  try {
    if (!restAudioCtx) restAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var ctx = restAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch(e) { /* audio is a nice-to-have; vibrate + UI still fire */ }
}

function updateRestDisplay() {
  var total = Math.ceil(restRemainingMs() / 1000);
  var m = Math.floor(total / 60), s = total % 60;
  document.getElementById('restTime').textContent = m + ':' + (s < 10 ? '0' : '') + s;
}

// ---- Export ----
// ---- Export ----
// Open the export modal, defaulting the range to the last 30 days (end = today).
function openExportModal() {
  var today = new Date();
  var start = new Date(today); start.setDate(start.getDate() - 30);
  document.getElementById('exportStart').value = localDateString(start);
  document.getElementById('exportEnd').value = localDateString(today);
  var radios = document.getElementsByName('exportFormat');
  for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === 'csv';
  document.getElementById('exportOverlay').classList.add('show');
}

function closeExportModal() {
  document.getElementById('exportOverlay').classList.remove('show');
}

function exportCsvEscape(v) {
  if (v == null) return '';
  var s = String(v);
  if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Run the export. Queries every workout (plan + ad-hoc) with performed_at in
// the selected [start, end) window and writes either CSV (one row per set)
// or JSON (flat by workout with nested sets).
async function runExport() {
  var startVal = document.getElementById('exportStart').value;
  var endVal = document.getElementById('exportEnd').value;
  if (!startVal || !endVal) { showToast('Pick a start and end date', null); return; }
  if (startVal > endVal) { showToast('Start date must be on or before end date', null); return; }
  var format = 'csv';
  var radios = document.getElementsByName('exportFormat');
  for (var r = 0; r < radios.length; r++) if (radios[r].checked) format = radios[r].value;

  // end is exclusive: add one day so the user's chosen end-date is inclusive.
  var startDate = new Date(startVal + 'T00:00:00');
  var endDateExclusive = new Date(endVal + 'T00:00:00');
  endDateExclusive.setDate(endDateExclusive.getDate() + 1);

  try {
    var wRes = await sb.from('workouts')
      .select('*, sets(*, exercises(name, equipment, muscle_group, weight_mode))')
      .eq('user_id', userId)
      .gte('performed_at', startDate.toISOString())
      .lt('performed_at', endDateExclusive.toISOString())
      .order('performed_at', { ascending: true });
    if (wRes.error) throw wRes.error;

    var rows = wRes.data || [];

    // Pre-fetch any pinned plan blobs not yet cached so day_name and
    // prescribed values can be resolved in one pass.
    var uncachedPlanIds = {};
    for (var i = 0; i < rows.length; i++) {
      var pid = rows[i].plan_id;
      if (pid && !planCache[pid]) uncachedPlanIds[pid] = true;
    }
    var planIdList = Object.keys(uncachedPlanIds);
    if (planIdList.length) {
      var pr = await sb.from('plans').select('id, title, data').in('id', planIdList);
      if (pr.data) {
        for (var p = 0; p < pr.data.length; p++) {
          planCache[pr.data[p].id] = pr.data[p].data;
          // Stash title too so CSV/JSON can show it even when the plan isn't active.
          planCache[pr.data[p].id]._title = pr.data[p].title;
        }
      }
    }

    var filenameBase = 'workout-export-' + startVal + '-to-' + endVal;
    if (format === 'json') {
      var payload = {
        exported_at: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        range: { start: startVal, end: endVal },
        workouts: rows.map(function(w) {
          var planBlob = w.plan_id ? planCache[w.plan_id] : null;
          var dayPlan = (planBlob && planBlob.days && planBlob.days[w.day_index]) || null;
          var duration = (w.started_at && w.ended_at)
            ? (new Date(w.ended_at).getTime() - new Date(w.started_at).getTime() - (w.paused_ms || 0))
            : null;
          return {
            workout_id: w.id,
            performed_at: w.performed_at,
            started_at: w.started_at,
            ended_at: w.ended_at,
            paused_ms: w.paused_ms || 0,
            duration_ms: duration,
            is_ad_hoc: w.plan_id === null,
            plan_id: w.plan_id,
            plan_title: planBlob ? (planBlob.title || planBlob._title || null) : null,
            day_index: w.day_index,
            day_name: dayPlan ? dayPlan.name : null,
            title: w.title || null,
            sets: (w.sets || [])
              .slice()
              .sort(function(a, b) {
                if (a.exercise_order !== b.exercise_order) return a.exercise_order - b.exercise_order;
                return a.set_order - b.set_order;
              })
              .map(function(s) {
                var ex = s.exercises || {};
                return {
                  exercise_name: ex.name || null,
                  equipment: ex.equipment || null,
                  muscle_group: ex.muscle_group || null,
                  weight_mode: ex.weight_mode || null,
                  exercise_order: s.exercise_order,
                  set_order: s.set_order,
                  prescribed_weight: s.prescribed_weight,
                  prescribed_reps: s.prescribed_reps,
                  actual_weight: s.weight,
                  actual_reps: s.reps,
                  rpe: s.rpe,
                  done: !!s.done,
                  completed_at: s.completed_at,
                  substitution: s.substitution,
                  note: s.note,
                };
              }),
          };
        }),
      };
      downloadBlob(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        filenameBase + '.json'
      );
    } else {
      var cols = [
        'performed_at', 'plan_title', 'day_name', 'is_ad_hoc', 'workout_title',
        'exercise_name', 'equipment', 'muscle_group', 'weight_mode',
        'exercise_order', 'set_order',
        'prescribed_weight', 'prescribed_reps',
        'actual_weight', 'actual_reps',
        'rpe', 'done', 'completed_at', 'substitution', 'note',
        'session_duration_ms',
      ];
      var lines = [cols.join(',')];
      for (var k = 0; k < rows.length; k++) {
        var w = rows[k];
        var planBlob = w.plan_id ? planCache[w.plan_id] : null;
        var dayPlan = (planBlob && planBlob.days && planBlob.days[w.day_index]) || null;
        var planTitle = planBlob ? (planBlob.title || planBlob._title || '') : '';
        var dayName = dayPlan ? dayPlan.name : '';
        var duration = (w.started_at && w.ended_at)
          ? (new Date(w.ended_at).getTime() - new Date(w.started_at).getTime() - (w.paused_ms || 0))
          : '';
        var sets = (w.sets || []).slice().sort(function(a, b) {
          if (a.exercise_order !== b.exercise_order) return a.exercise_order - b.exercise_order;
          return a.set_order - b.set_order;
        });
        for (var m = 0; m < sets.length; m++) {
          var s = sets[m];
          var ex = s.exercises || {};
          var row = [
            w.performed_at,
            planTitle,
            dayName,
            w.plan_id === null ? 'true' : 'false',
            w.title || '',
            ex.name || '',
            ex.equipment || '',
            ex.muscle_group || '',
            ex.weight_mode || '',
            s.exercise_order,
            s.set_order,
            s.prescribed_weight != null ? s.prescribed_weight : '',
            s.prescribed_reps != null ? s.prescribed_reps : '',
            s.weight != null ? s.weight : '',
            s.reps != null ? s.reps : '',
            s.rpe != null ? s.rpe : '',
            s.done ? 'true' : 'false',
            s.completed_at || '',
            s.substitution || '',
            s.note || '',
            duration,
          ].map(exportCsvEscape).join(',');
          lines.push(row);
        }
      }
      downloadBlob(
        new Blob([lines.join('\n')], { type: 'text/csv' }),
        filenameBase + '.csv'
      );
    }
    closeExportModal();
  } catch(err) {
    console.error('runExport error:', err);
    showToast('Export failed: ' + err.message, null);
  }
}

// ---- Event listeners ----
document.getElementById('btnMenu').addEventListener('click', openMenu);
document.getElementById('btnMenuClose').addEventListener('click', closeMenu);
document.getElementById('menuOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeMenu();
});
document.getElementById('menuImport').addEventListener('click', function() {
  closeMenu();
  document.getElementById('importModal').classList.add('show');
});
document.getElementById('menuExport').addEventListener('click', function() {
  closeMenu();
  openExportModal();
});
document.getElementById('menuStartAnother').addEventListener('click', function() {
  closeMenu();
  openStartScreen();
});
document.getElementById('menuHistory').addEventListener('click', function() {
  closeMenu();
  openHistory();
});
document.getElementById('menuGymProfiles').addEventListener('click', function() {
  closeMenu();
  openGymProfiles();
});
document.getElementById('menuPhotos').addEventListener('click', function() {
  closeMenu();
  openPhotos();
});
document.getElementById('menuGenerate').addEventListener('click', function() {
  closeMenu();
  openGenerate();
});
document.getElementById('menuPlans').addEventListener('click', function() {
  closeMenu();
  openPlans();
});
document.getElementById('btnPlansClose').addEventListener('click', closePlans);
document.getElementById('plansOverlay').addEventListener('click', function(e) {
  if (e.target === this) closePlans();
});
document.getElementById('plansBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  var btn = e.target.closest('.plans-btn');
  if (!btn || btn.disabled) return;
  var planId = btn.getAttribute('data-plan-id');
  if (!planId) return;
  if (btn.classList.contains('activate')) onActivatePlan(planId);
  else if (btn.classList.contains('delete')) onDeletePlan(planId);
});
document.getElementById('btnGenerateClose').addEventListener('click', closeGenerate);
document.getElementById('generateOverlay').addEventListener('click', function(e) {
  // Don't dismiss mid-generation — only allow overlay click to close on the review screen.
  if (e.target === this && generateView === 'review') closeGenerate();
});
document.getElementById('generateBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest('#btnGenerateAccept')) { onAcceptGeneratedPlan(); return; }
  if (e.target.closest('#btnGenerateCancel')) { closeGenerate(); return; }
  if (e.target.closest('#btnGenerateAbort')) { cancelGenerate(); return; }
});
document.getElementById('menuWeightUnit').addEventListener('click', function() {
  setWeightUnit(getWeightUnit() === 'lbs' ? 'kg' : 'lbs');
  closeMenu();
  buildDay(currentDay);
});
document.getElementById('menuSignOut').addEventListener('click', function() {
  closeMenu();
  sb.auth.signOut();
});

// Start-screen modal wiring.
document.getElementById('btnStartClose').addEventListener('click', closeStartScreen);
document.getElementById('startScreenOverlay').addEventListener('click', function(e) {
  // Only close on overlay tap when close is allowed (close button not hidden).
  if (e.target !== this) return;
  if (document.getElementById('btnStartClose').classList.contains('hidden')) return;
  closeStartScreen();
});
document.getElementById('startPathSuggested').addEventListener('click', function() {
  var di = parseInt(this.getAttribute('data-di'), 10);
  if (isNaN(di)) return;
  closeStartScreen();
  focusTab(di);
  buildTabs();
  buildDay(di);
});
document.getElementById('startPathPickDay').addEventListener('click', function() {
  var list = document.getElementById('startPathPickDayList');
  if (list.classList.contains('hidden')) {
    renderStartPathDayList();
    list.classList.remove('hidden');
  } else {
    list.classList.add('hidden');
  }
});
document.getElementById('startPathPickDayList').addEventListener('click', function(e) {
  var row = e.target.closest('.start-day-row');
  if (!row) return;
  var di = parseInt(row.getAttribute('data-di'), 10);
  if (isNaN(di)) return;
  closeStartScreen();
  focusTab(di);
  buildTabs();
  buildDay(di);
});
document.getElementById('startPathBlank').addEventListener('click', function() {
  closeStartScreen();
  createAdHocSession();
});
document.getElementById('startPathImportLink').addEventListener('click', function() {
  closeStartScreen();
  document.getElementById('fileInput').click();
});

// Gym Profiles modal wiring.
document.getElementById('btnGymProfilesClose').addEventListener('click', closeGymProfiles);
document.getElementById('gymProfilesOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeGymProfiles();
});
document.getElementById('btnGymProfilesAdd').addEventListener('click', function() {
  var input = document.getElementById('gymProfilesAddInput');
  var name = input.value;
  persistLocationAdd(name).then(function() {
    // Reset the input on success; leave as-is on failure so the user can retry.
    input.value = '';
  });
});
document.getElementById('gymProfilesAddInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btnGymProfilesAdd').click();
  }
});
document.getElementById('gymProfilesList').addEventListener('click', function(e) {
  var target = e.target;
  var action = target.getAttribute && target.getAttribute('data-action');
  if (action === 'delete') {
    var delId = target.getAttribute('data-id');
    if (delId) persistLocationDelete(delId);
    return;
  }
  if (action === 'rename') {
    // Swap the name div for an input; blur/Enter saves, Escape cancels.
    var id = target.getAttribute('data-id');
    var row = locationById[id];
    if (!row) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'gym-profiles-row-input';
    input.value = row.name;
    input.maxLength = 60;
    input.setAttribute('data-id', id);
    var parent = target.parentNode;
    parent.replaceChild(input, target);
    input.focus();
    input.select();
    var committed = false;
    function commit() {
      if (committed) return; committed = true;
      persistLocationRename(id, input.value);
    }
    function cancel() {
      if (committed) return; committed = true;
      renderGymProfiles(); // restore the name display
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
  }
});
document.getElementById('btnExportCancel').addEventListener('click', closeExportModal);
document.getElementById('btnExportRun').addEventListener('click', runExport);
document.getElementById('exportOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeExportModal();
});
document.getElementById('btnHistoryClose').addEventListener('click', closeHistory);
document.getElementById('btnExHistoryClose').addEventListener('click', closeExerciseHistory);
document.getElementById('exHistoryOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeExerciseHistory();
});
document.getElementById('btnHistoryBack').addEventListener('click', backToHistoryWeek);
document.getElementById('historyOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeHistory();
});
document.getElementById('btnPhotosClose').addEventListener('click', closePhotos);
document.getElementById('btnPhotosBack').addEventListener('click', backToPhotosGallery);
document.getElementById('photosOverlay').addEventListener('click', function(e) {
  if (e.target === this) closePhotos();
});
document.getElementById('photosFileInput').addEventListener('change', handlePhotoPicked);
document.getElementById('photosBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest('#photosUploadBtn')) {
    document.getElementById('photosFileInput').click();
    return;
  }
  if (e.target.closest('#photosSubmitBtn')) {
    submitPhotoUpload();
    return;
  }
  var delBtn = e.target.closest('#photosDeleteBtn');
  if (delBtn) {
    onPhotoDelete(delBtn.getAttribute('data-photo-id'));
    return;
  }
  var thumb = e.target.closest('.photos-thumb');
  if (thumb) {
    photosViewerId = thumb.getAttribute('data-photo-id');
    photosView = 'viewer';
    renderPhotos();
    return;
  }
});
document.getElementById('historyBody').addEventListener('click', function(e) {
  if (!e.target) return;
  var prev = e.target.closest ? e.target.closest('#btnHistoryWeekPrev') : null;
  if (prev) { navigateHistoryWeek(-1); return; }
  var next = e.target.closest ? e.target.closest('#btnHistoryWeekNext') : null;
  if (next) { navigateHistoryWeek(1); return; }
  var row = e.target.closest ? e.target.closest('.history-row') : null;
  if (row) {
    openHistoryDetail(row.getAttribute('data-workout-id'));
    return;
  }
});
document.getElementById('importZone').addEventListener('click', function() {
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', handleImport);
document.getElementById('btnCancelImport').addEventListener('click', function() {
  document.getElementById('importModal').classList.remove('show');
});
document.getElementById('importModal').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('show');
});
document.getElementById('btnRest').addEventListener('click', function() { startRestTimer(90); });
document.getElementById('btnStopRest').addEventListener('click', stopRestTimer);
document.getElementById('restOverlay').addEventListener('click', stopRestTimer);
document.getElementById('btnRestPlus').addEventListener('click', function() {
  if (!restInterval) return;
  restTargetMs += 15000;
  updateRestDisplay();
});
document.getElementById('btnRestMinus').addEventListener('click', function() {
  if (!restInterval) return;
  // Clamp so the deadline stays at least 5 seconds out from now. Preserves
  // the pre-existing 5s floor; additional -15s taps at the floor are no-ops.
  restTargetMs = Math.max(Date.now() + 5000, restTargetMs - 15000);
  updateRestDisplay();
});
// Wall-clock catch-up after backgrounding. If we return to the app past the
// deadline and the tick interval missed the completion, fire it now.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && restInterval && restRemainingMs() <= 0) {
    restComplete();
  }
});

// Exercise picker listeners
document.getElementById('btnPickerClose').addEventListener('click', closePicker);
document.getElementById('pickerOverlay').addEventListener('click', function(e) {
  if (e.target === this) closePicker();
});
document.getElementById('pickerSearch').addEventListener('input', function(e) {
  pickerState.search = e.target.value || '';
  renderPickerResults();
});
document.getElementById('pickerEquipmentChips').addEventListener('click', function(e) {
  var t = e.target.closest ? e.target.closest('[data-chip="equipment"]') : null;
  if (!t) return;
  togglePickerChip('equipment', t.getAttribute('data-value'));
});
document.getElementById('pickerMuscleChips').addEventListener('click', function(e) {
  var t = e.target.closest ? e.target.closest('[data-chip="muscle"]') : null;
  if (!t) return;
  togglePickerChip('muscle', t.getAttribute('data-value'));
});
document.getElementById('pickerRecent').addEventListener('click', function(e) {
  var t = e.target.closest ? e.target.closest('[data-exercise-id]') : null;
  if (!t) return;
  selectExerciseFromPicker(t.getAttribute('data-exercise-id'));
});
document.getElementById('pickerResults').addEventListener('click', function(e) {
  var t = e.target.closest ? e.target.closest('[data-exercise-id]') : null;
  if (!t) return;
  selectExerciseFromPicker(t.getAttribute('data-exercise-id'));
});
document.getElementById('btnOpenCustomForm').addEventListener('click', openCustomForm);
document.getElementById('btnCfCancel').addEventListener('click', closeCustomForm);
document.getElementById('btnCfSave').addEventListener('click', submitCustomForm);
document.getElementById('customFormOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeCustomForm();
});

// Day picker (replaces the old horizontal tab strip).
document.getElementById('dayPicker').addEventListener('change', async function(e) {
  var v = e.target.value;
  if (!v) return;
  var newDay = v.indexOf('ah_') === 0 ? v : parseInt(v, 10);
  focusTab(newDay);
  // Lazy-load historical only for plan-day tabs that don't have today's data
  // and aren't cached yet.
  if (!isAdHocKey(currentDay) && !todayPlanStates[currentDay] && !historicalCache[currentDay]) {
    await loadHistorical(currentDay);
  }
  buildTabs();
  buildDay(currentDay);
});

// WORKOUT CONTAINER clicks
document.getElementById('workoutContainer').addEventListener('click', function(e) {
  var target = e.target;
  // Delete buttons are checked FIRST. The card-delete × lives inside
  // .exercise-header, so without this ordering the header-expand handler
  // below would swallow the click and toggle the card instead of deleting.
  var delSetBtnEarly = target.closest ? target.closest('.set-delete') : null;
  if (delSetBtnEarly) {
    if (delSetBtnEarly.disabled) return;
    deleteSet(
      currentDay,
      parseInt(delSetBtnEarly.getAttribute('data-ei'), 10),
      parseInt(delSetBtnEarly.getAttribute('data-si'), 10)
    );
    return;
  }
  var delCardBtnEarly = target.closest ? target.closest('.card-delete') : null;
  if (delCardBtnEarly) {
    if (delCardBtnEarly.disabled) return;
    deleteExerciseCard(
      currentDay,
      parseInt(delCardBtnEarly.getAttribute('data-ei'), 10)
    );
    return;
  }
  // Per-exercise recent history — handled before header-expand because this
  // button lives inside .exercise-header.
  var histBtn = target.closest ? target.closest('.ex-history-btn') : null;
  if (histBtn) {
    openExerciseHistory(histBtn.getAttribute('data-exercise-name'));
    return;
  }
  // Session-location prompt (zero-gym case) — opens the Gym Profiles modal.
  var locPrompt = target.closest ? target.closest('.session-location-prompt') : null;
  if (locPrompt) {
    openGymProfiles();
    return;
  }
  // Session-notes header — toggle collapse/expand.
  var notesHeader = target.closest ? target.closest('.session-notes-header') : null;
  if (notesHeader) {
    var notesContainer = notesHeader.closest('.session-notes');
    var di = notesContainer ? notesContainer.getAttribute('data-di') : null;
    if (di != null) {
      var diVal = di.indexOf('ah_') === 0 ? di : parseInt(di, 10);
      toggleNotes(diVal);
    }
    return;
  }
  // Expand card
  var header = target.closest ? target.closest('.exercise-header') : null;
  if (header) {
    var card = header.parentElement;
    if (card) card.classList.toggle('expanded');
    return;
  }
  // Add Exercise (opens picker)
  var addExBtn = target.closest ? target.closest('#btnAddExercise') : null;
  if (addExBtn) {
    if (addExBtn.disabled) return;
    openPicker();
    return;
  }
  // Delete whole ad-hoc session
  var delAdHocBtn = target.closest ? target.closest('#btnDeleteAdHoc') : null;
  if (delAdHocBtn) {
    if (delAdHocBtn.disabled) return;
    deleteAdHocSession();
    return;
  }
  // Add Set on an extras exercise
  var addSetBtn = target.closest ? target.closest('.add-set-btn') : null;
  if (addSetBtn) {
    if (addSetBtn.disabled) return;
    addExtraSet(parseInt(addSetBtn.getAttribute('data-add-set-ei'), 10));
    return;
  }
  // Session start/complete
  var startBtn = target.closest ? target.closest('#btnStartSession') : null;
  if (startBtn) {
    if (startBtn.disabled) return;
    startSession(currentDay);
    return;
  }
  var completeBtn = target.closest ? target.closest('#btnCompleteSession') : null;
  if (completeBtn) {
    if (completeBtn.disabled) return;
    completeSession();
    return;
  }
  var resumeBtn = target.closest ? target.closest('#btnResumeSession') : null;
  if (resumeBtn) {
    if (resumeBtn.disabled) return;
    resumeSession();
    return;
  }
  // Set check
  var checkBtn = target.closest ? target.closest('.set-check') : null;
  if (checkBtn) {
    if (checkBtn.disabled) return;
    toggleSet(
      currentDay,
      parseInt(checkBtn.getAttribute('data-ei')),
      parseInt(checkBtn.getAttribute('data-si'))
    );
    return;
  }
  // RPE
  var rpeBtn = target.closest ? target.closest('.rpe-btn') : null;
  if (rpeBtn) {
    if (rpeBtn.disabled) return;
    logRPE(
      currentDay,
      parseInt(rpeBtn.getAttribute('data-ei')),
      parseInt(rpeBtn.getAttribute('data-rpe'))
    );
    return;
  }
});

// WORKOUT CONTAINER input changes
document.getElementById('workoutContainer').addEventListener('change', function(e) {
  var t = e.target;
  if (t.disabled) return;
  if (t.classList.contains('set-input')) {
    logSet(currentDay, parseInt(t.getAttribute('data-ei')),
      parseInt(t.getAttribute('data-si')), t.getAttribute('data-field'), t.value);
  }
  if (t.classList.contains('sub-input')) {
    logSub(currentDay, parseInt(t.getAttribute('data-ei')), t.value);
  }
  if (t.classList.contains('exercise-note-input')) {
    logNote(currentDay, parseInt(t.getAttribute('data-ei')), t.value);
  }
  if (t.classList.contains('adhoc-title-input')) {
    updateAdHocTitle(t.getAttribute('data-workout-id'), t.value);
  }
  if (t.classList.contains('session-notes-input')) {
    var sdi = t.getAttribute('data-di');
    if (sdi != null) {
      var sdiVal = sdi.indexOf('ah_') === 0 ? sdi : parseInt(sdi, 10);
      persistNotes(sdiVal, t.value);
    }
  }
  if (t.classList.contains('session-location-select')) {
    var ldi = t.getAttribute('data-di');
    if (ldi != null) {
      var ldiVal = ldi.indexOf('ah_') === 0 ? ldi : parseInt(ldi, 10);
      persistWorkoutLocation(ldiVal, t.value || null);
    }
  }
});
