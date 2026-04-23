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
// Callback invoked on exercise selection. Defaults to the "add to session"
// behavior. Alternative callers (e.g. substitution in v2.2.1) swap this in
// when opening the picker; always reset on close so stale callbacks can't fire.
var pickerOnSelect = null;

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

// AI plan generator state — modal cycles through three sub-views:
// 'inputs' (user sets start date, target duration, notes),
// 'loading' (spinner while the Edge Function runs, ~30-60s), and
// 'review' (accept/cancel the returned plan).
var generateView = 'inputs';        // 'inputs' | 'loading' | 'review'
var generateMode = 'plan';          // 'plan' | 'analyze' — set at submit time
var generatedPlan = null;           // the full plan JSON returned by /api/generate-plan
var generatedAnalysis = null;       // the analysis object from mode=analyze
var generatedMeta = null;           // { model, usage, generated_at, elapsed_s }
var generatedInputs = null;         // { start_date, target_duration, notes } from the form
var generateStartedAt = 0;          // ms timestamp when the API call started
var generateInFlight = false;       // prevents double-fire of the generate button
var generateAbortController = null; // wired to the in-flight fetch so Cancel can abort
var generateAttempt = 0;            // 1 on first try, 2 on the silent retry (for loading-message swap)

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

// Clamp a form input value to [min, max]; fall back to `fallback` if missing/invalid.
function clampFormInt(raw, min, max, fallback) {
  var n = raw == null ? NaN : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

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

// Drag-to-reorder init. Called after buildDay / buildAdHocDay replaces the
// workoutContainer innerHTML. Attaches SortableJS instances to the two sort
// zones (plan + extras on plan days) or the single ad-hoc zone. Separate
// groups prevent cross-zone drops. Filters skip interactive children so
// tapping an input / button / set row doesn't trigger a drag. Long-press
// delay + delayOnTouchOnly means a normal tap never starts reorder.
function initSortableZones(di, isAdHoc) {
  if (typeof Sortable === 'undefined') return;

  var LONG_PRESS_MS = 400;
  var ANIM_MS = 150;
  var DRAG_FILTER = 'input, textarea, button, select, .set-row, .exercise-note, .exercise-note-input, .sub-row, .rpe-row';

  if (isAdHoc) {
    var adhocEl = document.querySelector('#workoutContainer [data-sort-zone="adhoc"]');
    if (adhocEl) {
      Sortable.create(adhocEl, {
        group: 'exercise-adhoc-session',
        filter: DRAG_FILTER,
        preventOnFilter: false,
        delay: LONG_PRESS_MS,
        delayOnTouchOnly: true,
        animation: ANIM_MS,
        onEnd: function(evt) {
          if (evt.oldIndex === evt.newIndex) return;
          // Pure ad-hoc: zone covers all exercises (zoneStartEi = 0).
          reorderAdHocExtras(evt.oldIndex, evt.newIndex, 0);
        },
      });
    }
    return;
  }

  var planEl = document.querySelector('#workoutContainer [data-sort-zone="plan"]');
  if (planEl) {
    Sortable.create(planEl, {
      group: 'exercise-plan-zone',
      filter: DRAG_FILTER,
      preventOnFilter: false,
      delay: LONG_PRESS_MS,
      delayOnTouchOnly: true,
      animation: ANIM_MS,
      onEnd: function(evt) {
        if (evt.oldIndex === evt.newIndex) return;
        reorderPlanExercises(di, evt.oldIndex, evt.newIndex);
      },
    });
  }

  var extrasEl = document.querySelector('#workoutContainer [data-sort-zone="extras"]');
  if (extrasEl) {
    var planLen = parseInt(extrasEl.getAttribute('data-plan-len'), 10) || 0;
    Sortable.create(extrasEl, {
      group: 'exercise-extras-zone',
      filter: DRAG_FILTER,
      preventOnFilter: false,
      delay: LONG_PRESS_MS,
      delayOnTouchOnly: true,
      animation: ANIM_MS,
      onEnd: function(evt) {
        if (evt.oldIndex === evt.newIndex) return;
        // Plan-day extras: zone-local DOM indices get translated inside
        // reorderAdHocExtras; zoneStartEi = planLen anchors the boundary.
        reorderAdHocExtras(evt.oldIndex, evt.newIndex, planLen);
      },
    });
  }
}

// Duration-edit affordance used wherever a session timer / duration is
// rendered. Clicking prompts for a new duration in minutes and updates
// started_at to back-compute the new span (paused_ms zeroed). workoutId
// drives the DB update; ctx distinguishes today (in-memory refresh) from
// history (detail re-fetch).
function renderDurationEditBtn(workoutId, currentMs, endedAt, ctx) {
  if (!workoutId) return '';
  var mins = Math.max(0, Math.round((currentMs || 0) / 60000));
  return '<button type="button" class="duration-edit-btn" data-workout-id="' +
    escapeAttr(workoutId) + '" data-current-min="' + mins +
    '" data-ended-at="' + escapeAttr(endedAt || '') +
    '" data-ctx="' + escapeAttr(ctx) + '" aria-label="Edit duration">✎</button>';
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
      // daysWithHistory is populated once at hydrate with every plan-day
      // index that has a workout row on the active plan — lets the dot
      // render correctly on first paint without lazy-loading per-day
      // historicalCache state. historicalCache is still checked as a
      // fallback so dots stay correct after a tab selection populates it
      // (e.g., if daysWithHistory was stale for any reason).
      var hasData = hasToday || daysWithHistory[i] || historicalCache[i];
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
           renderDurationEditBtn(todayState.workoutId, sessionElapsedMs(todayState), null, 'today') +
           '<button class="session-btn session-complete" id="btnCompleteSession">Complete Session</button></div>';
    } else if (todayState.startedAt && todayState.endedAt) {
      h += '<div class="session-bar done resumable"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(todayState)) + '</div>' +
           renderDurationEditBtn(todayState.workoutId, sessionElapsedMs(todayState), todayState.endedAt, 'today') +
           '<button class="session-btn session-resume" id="btnResumeSession" type="button">Resume</button></div>';
    }
    // Cancel affordance for accidentally-started sessions. Only shows when
    // the session is started (or paused) AND no sets have been completed —
    // safe to discard. The in-progress 0-set case is "tapped Start by
    // accident"; the paused 0-set case is "tapped Start then Complete by
    // accident" (becomes the historical orphan we're fixing).
    if (todayState && todayState.workoutId && todayState.startedAt) {
      var cancelableSets = 0;
      if (todayState.exercises) {
        for (var cek in todayState.exercises) {
          var cArr = todayState.exercises[cek].sets || [];
          for (var csi = 0; csi < cArr.length; csi++) if (cArr[csi] && cArr[csi].done) cancelableSets++;
        }
      }
      if (cancelableSets === 0) {
        h += '<button class="session-cancel-btn" id="btnCancelSession" type="button" data-workout-id="' +
             escapeAttr(todayState.workoutId) + '">Cancel session (no sets logged)</button>';
      }
    }
  } else if (mode === 'historical' && state && state.startedAt && state.endedAt) {
    h += '<div class="session-bar done"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(state)) + '</div>' +
         renderDurationEditBtn(state.workoutId, sessionElapsedMs(state), state.endedAt, 'today') + '</div>';
  }

  h += renderSessionLocation(di, state, readOnly);
  h += renderSessionNotes(di, state, readOnly);

  // v2.2.5 drag-to-reorder: prescribed plan exercises live inside a sort
  // zone. Reorder within this zone mutates plan.days[di].exercises AND
  // remaps the current workout's sets (see data.js reorderPlanExercises).
  // Ad-hoc extras below live in a separate sort zone — they reorder among
  // themselves only, no plan mutation.
  h += '<div class="sort-zone" data-sort-zone="plan" data-di="' + di + '">';
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
    // Weight mode + display name track the substitute when one is set —
    // a per_side substitute for a total prescribed exercise needs the
    // right label ("LBS/ea") and its own name visible on the card.
    var weightMode = (exState.subExercise && exState.subExercise.weight_mode)
      ? exState.subExercise.weight_mode
      : weightModeForName(ex.name);
    var displayName = exState.subExercise ? exState.subExercise.name : ex.name;
    var prescribedBadge = exState.subExercise
      ? '<span class="exercise-sub-origin">was: ' + escapeHtml(ex.name) + '</span>'
      : '';

    h += '<div class="exercise-card' + cc + '">';
    var swapBtn = readOnly ? '' : '<button class="card-swap" data-swap-di="' + di + '" data-swap-ei="' + ei + '" aria-label="Swap exercise" type="button">⇄</button>';
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(displayName) + prescribedBadge + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(displayName) + '">view recent</button></div><div class="exercise-status ' + sc + '">' + stat + '</div>' + swapBtn + '</div>';
    if (ex.note) h += '<div class="exercise-note">' + escapeHtml(ex.note) + '</div>';
    h += '<div class="sets-container">';

    for (var si = 0; si < ex.sets.length; si++) {
      var set = ex.sets[si];
      var sl = exState.sets[si] || {};
      // When substituted, the prescribed weight doesn't port to the
      // substitute (different weight_mode, different strength curve, etc).
      // Drop the weight anchor but keep rep targets — reps translate across
      // most substitutions and still give the user a target. User can enter
      // weight manually or (v2.2.2+) request an AI recommendation.
      var effectiveSet = exState.subExercise
        ? { reps_target: set && set.reps_target, reps_range: set && set.reps_range }
        : set;
      var pr = fmtP(effectiveSet);
      h += renderSetRow(di, ei, si, sl, effectiveSet, weightMode, dis, pr);
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

    // Substitution row. In editable mode, tapping opens the exercise picker.
    // When set: shows the substitute's name with a ✕ clear button.
    // Legacy free-text state.sub (pre-v2.2.1) still renders if present so
    // historical values don't vanish until the user re-saves.
    if (readOnly) {
      if (exState.subExercise || exState.sub) {
        var subLabel = exState.subExercise ? exState.subExercise.name : exState.sub;
        h += '<div class="sub-row"><div class="sub-label">SUB:</div><div class="sub-readonly">' + escapeHtml(subLabel) + '</div></div>';
      }
    } else {
      h += '<div class="sub-row"><div class="sub-label">SUB:</div>';
      if (exState.subExercise) {
        h += '<button type="button" class="sub-picker-btn has-value" data-di="' + di + '" data-ei="' + ei + '" data-action="pick">' + escapeHtml(exState.subExercise.name) + '</button>';
        h += '<button type="button" class="sub-clear-btn" data-di="' + di + '" data-ei="' + ei + '" data-action="clear" aria-label="Clear substitution">×</button>';
      } else if (exState.sub) {
        // Legacy free-text value — show it but with a note that tapping upgrades to a picker selection.
        h += '<button type="button" class="sub-picker-btn legacy" data-di="' + di + '" data-ei="' + ei + '" data-action="pick">' + escapeHtml(exState.sub) + ' (tap to re-link)</button>';
        h += '<button type="button" class="sub-clear-btn" data-di="' + di + '" data-ei="' + ei + '" data-action="clear" aria-label="Clear substitution">×</button>';
      } else {
        h += '<button type="button" class="sub-picker-btn" data-di="' + di + '" data-ei="' + ei + '" data-action="pick">Substitute exercise…</button>';
      }
      h += '</div>';
    }
    h += '<div style="padding:0 14px 14px"><textarea class="exercise-note-input" rows="1" placeholder="Notes" data-di="' + di + '" data-ei="' + ei + '"' + dis + '>' + escapeHtml(exState.note || '') + '</textarea></div>';
    h += '</div>';
  }

  h += '</div>';  // close plan sort-zone

  // Render extras (ad-hoc exercises) after the prescribed loop. They sit
  // in their own sort zone so reordering within them doesn't cross the
  // divider into plan exercises.
  var planLen = dayPlan.exercises.length;
  var extraKeys = [];
  if (state && state.exercises) {
    for (var k in state.exercises) {
      if (state.exercises[k].isExtra) extraKeys.push(k);
    }
    extraKeys.sort(function(a, b) { return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10); });
  }
  if (extraKeys.length) h += '<div class="extras-divider">Added exercises</div>';
  if (extraKeys.length) h += '<div class="sort-zone" data-sort-zone="extras" data-di="' + di + '" data-plan-len="' + planLen + '">';
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
  if (extraKeys.length) h += '</div>';  // close extras sort-zone

  if (mode === 'editable') {
    h += '<button class="add-exercise-btn" id="btnAddExercise" type="button">+ Add Exercise</button>';
    h += '<button class="add-exercise-btn" id="btnAddFromTemplate" type="button">+ Add from template</button>';
  }

  c.innerHTML = h;
  document.getElementById('setsComplete').textContent = cs;
  if (mode === 'editable') initSortableZones(di, false);
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
         renderDurationEditBtn(state.workoutId, sessionElapsedMs(state), null, 'today') +
         '<button class="session-btn session-complete" id="btnCompleteSession">Complete Session</button></div>';
  } else if (state.startedAt && state.endedAt) {
    h += '<div class="session-bar done resumable"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(state)) + '</div>' +
         renderDurationEditBtn(state.workoutId, sessionElapsedMs(state), state.endedAt, 'today') +
         '<button class="session-btn session-resume" id="btnResumeSession" type="button">Resume</button></div>';
  }

  h += renderSessionLocation(di, state, false);
  h += renderSessionNotes(di, state, false);

  var ts = 0, cs = 0;
  var keys = Object.keys(state.exercises || {}).sort(function(a, b) {
    return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
  });

  // Ad-hoc session has a single sort zone — all exercises are ad-hoc.
  // Reorder within remaps sets for the current workout only (no plan).
  if (keys.length) h += '<div class="sort-zone" data-sort-zone="adhoc" data-di="' + di + '">';
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
  if (keys.length) h += '</div>';  // close ad-hoc sort-zone

  h += '<button class="add-exercise-btn" id="btnAddExercise" type="button">+ Add Exercise</button>';
  h += '<button class="add-exercise-btn" id="btnAddFromTemplate" type="button">+ Add from template</button>';
  h += '<button class="delete-session-btn" id="btnDeleteAdHoc" type="button">Delete session</button>';

  c.innerHTML = h;
  document.getElementById('setsComplete').textContent = cs;
  document.getElementById('setsTotal').textContent = ts;
  document.getElementById('dayProgress').textContent = ts > 0 ? Math.round((cs / ts) * 100) + '%' : '0%';
  initSortableZones(di, true);

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
  var restRow = document.getElementById('menuRestTimerAuto');
  if (restRow) {
    restRow.textContent = 'Auto rest timer (' + (getRestTimerAuto() ? 'on' : 'off') + ')';
  }


  document.getElementById('menuOverlay').classList.add('show');
}

function closeMenu() {
  document.getElementById('menuOverlay').classList.remove('show');
}

// ---- Coaching Profile modal (v2.5) ----
// The modal is a single scrolling form with sections for basics, goal,
// phase, injuries (repeatable), and special instructions. Values load
// from coachingProfile (data.js) on open; Save upserts via
// saveCoachingProfile. Close + Cancel discard unsaved edits.
async function openCoachingProfile() {
  document.getElementById('coachingProfileOverlay').classList.add('show');
  // Lazy-load on first open so sign-in path doesn't pay for a profile
  // fetch the user may never need. Subsequent opens reuse the cached
  // coachingProfile; save path keeps it in sync.
  if (coachingProfile === null) {
    await loadCoachingProfile();
  }
  populateCoachingProfileForm(coachingProfile || {});
}

function closeCoachingProfile() {
  document.getElementById('coachingProfileOverlay').classList.remove('show');
}

// Fill every form control with the saved profile. Missing keys leave the
// control at its default empty state.
function populateCoachingProfileForm(p) {
  var setVal = function(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = (val == null) ? '' : String(val);
  };
  setVal('cpSex', p.sex);
  setVal('cpHeightFt', p.height_ft);
  setVal('cpHeightIn', p.height_in);
  setVal('cpWeightLbs', p.weight_lbs);
  setVal('cpExperienceLevel', p.experience_level);
  setVal('cpEnvironment', p.environment);
  setVal('cpSplitPreference', p.split_preference);
  setVal('cpGoalType', p.goal_type);
  setVal('cpGoalDetail', p.goal_detail);
  setVal('cpPhase', p.phase);
  setVal('cpPhaseStartDate', p.phase_start_date);
  setVal('cpPhaseNotes', p.phase_notes);
  setVal('cpSpecialInstructions', p.special_instructions);
  renderInjuryList(Array.isArray(p.injuries) ? p.injuries : []);
}

// Render the injury rows. Each row has a name input + notes textarea + ×
// remove button. The full list is re-rendered on add/remove for simplicity
// (the list is always short, so repainting a handful of rows is cheap).
function renderInjuryList(injuries) {
  var host = document.getElementById('cpInjuriesList');
  if (!host) return;
  var h = '';
  for (var i = 0; i < injuries.length; i++) {
    var inj = injuries[i] || {};
    h += '<div class="cp-injury-row" data-injury-idx="' + i + '">';
    h += '<button type="button" class="cp-injury-row-remove" data-cp-remove-injury="' + i + '" aria-label="Remove">×</button>';
    h += '<span class="cp-injury-row-label">Name</span>';
    h += '<input type="text" data-cp-injury-name="' + i + '" value="' + escapeAttr(inj.name || '') + '" placeholder="e.g., knee pain, lower back sensitivity">';
    h += '<span class="cp-injury-row-label" style="margin-top:6px;">Management notes</span>';
    h += '<textarea data-cp-injury-notes="' + i + '" placeholder="How to program around it (cues, substitutions, volume rules, etc.)">' + escapeHtml(inj.notes || '') + '</textarea>';
    h += '</div>';
  }
  host.innerHTML = h;
}

// Read the current injury rows off the DOM. Used both by the Save handler
// AND by add/remove so ongoing edits aren't lost when rows shift.
function readInjuryListFromDom() {
  var rows = document.querySelectorAll('#cpInjuriesList .cp-injury-row');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var nameEl = rows[i].querySelector('[data-cp-injury-name]');
    var notesEl = rows[i].querySelector('[data-cp-injury-notes]');
    var name = (nameEl && nameEl.value || '').trim();
    var notes = (notesEl && notesEl.value || '').trim();
    // Drop entries where both fields are blank — empty row after add + no typing.
    if (!name && !notes) continue;
    out.push({ name: name, notes: notes });
  }
  return out;
}

function addInjuryRow() {
  var current = readInjuryListFromDom();
  current.push({ name: '', notes: '' });
  renderInjuryList(current);
}

function removeInjuryRow(idx) {
  var current = readInjuryListFromDom();
  // Edge case: the row being removed is a brand-new empty row that
  // readInjuryListFromDom dropped. Fall back to reading by attribute.
  if (idx < 0) return;
  var domRows = document.querySelectorAll('#cpInjuriesList .cp-injury-row');
  var fromDom = [];
  for (var i = 0; i < domRows.length; i++) {
    var nameEl = domRows[i].querySelector('[data-cp-injury-name]');
    var notesEl = domRows[i].querySelector('[data-cp-injury-notes]');
    fromDom.push({
      name: (nameEl && nameEl.value || '').trim(),
      notes: (notesEl && notesEl.value || '').trim(),
    });
  }
  fromDom.splice(idx, 1);
  renderInjuryList(fromDom);
}

// Collect the full form, upsert to Supabase, close on success.
async function saveCoachingProfileFromForm() {
  var getVal = function(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  };
  var parseIntOrNull = function(v) {
    var trimmed = String(v || '').trim();
    if (!trimmed) return null;
    var n = parseInt(trimmed, 10);
    return Number.isFinite(n) ? n : null;
  };
  var parseNumOrNull = function(v) {
    var trimmed = String(v || '').trim();
    if (!trimmed) return null;
    var n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  };
  var trimOrNull = function(v) {
    var t = String(v || '').trim();
    return t || null;
  };
  var profile = {
    sex: trimOrNull(getVal('cpSex')),
    height_ft: parseIntOrNull(getVal('cpHeightFt')),
    height_in: parseIntOrNull(getVal('cpHeightIn')),
    weight_lbs: parseNumOrNull(getVal('cpWeightLbs')),
    experience_level: trimOrNull(getVal('cpExperienceLevel')),
    environment: trimOrNull(getVal('cpEnvironment')),
    split_preference: trimOrNull(getVal('cpSplitPreference')),
    goal_type: trimOrNull(getVal('cpGoalType')),
    goal_detail: trimOrNull(getVal('cpGoalDetail')),
    phase: trimOrNull(getVal('cpPhase')),
    phase_start_date: trimOrNull(getVal('cpPhaseStartDate')),
    phase_notes: trimOrNull(getVal('cpPhaseNotes')),
    injuries: readInjuryListFromDom(),
    special_instructions: trimOrNull(getVal('cpSpecialInstructions')),
  };
  var btn = document.getElementById('btnCoachingProfileSave');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await saveCoachingProfile(profile);
    closeCoachingProfile();
    showToast('Coaching profile saved', null);
  } catch (err) {
    console.error('saveCoachingProfileFromForm error:', err);
    showToast("Couldn't save profile: " + (err.message || 'unknown error'), null);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
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
// Open the exercise picker. `onSelect` (optional) is called with the
// selected library row when the user picks one — defaults to the
// "add exercise to current session" behavior for the existing Add
// Exercise entry point. Alternative callers (substitution in v2.2.1)
// pass their own callback. Always cleared on close so a subsequent
// default-open can't accidentally re-run the previous callback.
function openPicker(onSelect) {
  pickerState.search = '';
  pickerState.equipment = [];
  pickerState.muscleGroup = [];
  pickerOnSelect = onSelect || null;
  var si = document.getElementById('pickerSearch');
  if (si) si.value = '';
  renderPicker();
  document.getElementById('pickerOverlay').classList.add('show');
  setTimeout(function(){ if (si) si.focus(); }, 100);
}

function closePicker() {
  document.getElementById('pickerOverlay').classList.remove('show');
  pickerOnSelect = null;
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
  var cb = pickerOnSelect;
  closePicker();
  if (cb) cb(row);
  else addExerciseToSession(row);
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
  var templateList = document.getElementById('startPathTemplateList');
  if (templateList) {
    templateList.classList.add('hidden');
    templateList.innerHTML = '';
  }

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
      .select('id, weight, reps, rpe, set_order, done, note, workout_id, workouts(performed_at, plan_id, day_index, title, location_id)')
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
        // "@" prefix distinguishes the gym tag from other context pieces at a glance.
        contextText += ' · @ ' + locationById[sess.locationId].name;
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
      // Per-exercise note: all sets in one exercise-on-workout carry the same
      // note (buildSetPayload writes exState.note to every set). Pick the
      // first non-empty note; suppress entirely if none.
      var noteText = '';
      for (var ni = 0; ni < sess.sets.length; ni++) {
        var nv = sess.sets[ni] && sess.sets[ni].note;
        if (nv && String(nv).trim()) { noteText = String(nv).trim(); break; }
      }
      h += '<div class="ex-history-session">';
      h += '<div class="ex-history-session-date">' + escapeHtml(dateText + contextText) + '</div>';
      h += '<div class="ex-history-sets">' + escapeHtml(setStrs.join('  ·  ')) + '</div>';
      if (rpeText) h += '<div class="ex-history-rpe">' + escapeHtml(rpeText) + '</div>';
      if (noteText) h += '<div class="ex-history-note">' + escapeHtml(noteText) + '</div>';
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

// Discard a workout from the history detail view. Confirms with set count
// so the user doesn't nuke real training data. Returns to the week view on
// success so the discarded row stops appearing.
async function onDiscardWorkout(workoutId, completedCount, titleText) {
  var setWord = completedCount === 1 ? 'completed set' : 'completed sets';
  var msg = completedCount > 0
    ? 'Discard ' + titleText + ' and ' + completedCount + ' ' + setWord + '? This cannot be undone.'
    : 'Discard ' + titleText + '? No sets were logged; this just removes the empty session.';
  if (!confirm(msg)) return;
  try {
    await discardWorkout(workoutId);
    showToast('Session discarded', null);
    // Reset the history detail view back to the week list so the deleted
    // row isn't left dangling. goBack semantics mirror the ← button.
    historyView = 'week';
    document.getElementById('btnHistoryBack').style.display = 'none';
    document.getElementById('historyBackSpacer').style.display = 'block';
    await loadHistoryWeek(historyWeekStart);
    renderHistoryWeek();
  } catch(err) {
    console.error('onDiscardWorkout error:', err);
    showToast("Couldn't discard session: " + (err.message || 'unknown error'), null);
  }
}

// "Bring to today": move a historical workout to the current date and
// reset its timer. Post-success, close the history modal entirely and
// re-hydrate so today's view picks up the reactivated session.
async function onReactivateWorkout(workoutId) {
  if (!confirm('Move this session to today? The timer resets to now; any logged sets are kept.')) return;
  try {
    await reactivateWorkout(workoutId);
    closeHistory();
    showToast('Session brought to today', null);
    // Re-hydrate to pick up the reactivated workout in todayPlanStates /
    // todayAdHocs. Cheap compared to a full reload and keeps UI state clean.
    await hydrate();
  } catch(err) {
    console.error('onReactivateWorkout error:', err);
    showToast("Couldn't move session: " + (err.message || 'unknown error'), null);
  }
}

// Prompt the user for a new session duration in minutes, then update the
// workout's started_at so sessionElapsedMs(state) = new minutes. paused_ms
// is zeroed — a manual override collapses any accumulated pause accounting.
// `ctx` chooses the refresh strategy: 'today' patches in-memory state + re-
// renders; 'history' invalidates cache + re-opens the detail view.
async function promptAdjustDuration(workoutId, currentMin, endedAtIso, ctx) {
  if (!userId || !workoutId) return;
  var input = prompt('Session duration (minutes):', String(currentMin || 0));
  if (input == null) return;  // cancelled
  var trimmed = String(input).trim();
  if (!trimmed) return;
  var minutes = parseInt(trimmed, 10);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 600) {
    showToast('Duration must be 0-600 minutes', null);
    return;
  }
  // Anchor: completed sessions use ended_at as the right edge; running
  // sessions use "now" so the timer keeps ticking from the new base.
  var basis = endedAtIso ? new Date(endedAtIso).getTime() : Date.now();
  var newStartedAt = new Date(basis - minutes * 60000).toISOString();
  try {
    var r = await sb.from('workouts').update({
      started_at: newStartedAt,
      paused_ms: 0,
    }).eq('id', workoutId).eq('user_id', userId);
    if (r.error) throw new Error(r.error.message);
    showToast('Duration updated to ' + minutes + ' min', null);

    if (ctx === 'history') {
      // Force re-fetch of this workout's detail so the new started_at is reflected.
      if (historyDetails && historyDetails[workoutId]) delete historyDetails[workoutId];
      invalidateHistoryCache();
      await openHistoryDetail(workoutId);
      return;
    }
    // Today context: patch any in-memory state that owns this workout. Covers
    // the focused session and any non-focused plan-day / ad-hoc state that
    // happens to share the id (shouldn't overlap but belt-and-suspenders).
    if (todayState && todayState.workoutId === workoutId) {
      todayState.startedAt = newStartedAt;
      todayState.pausedMs = 0;
    }
    for (var k in todayPlanStates) {
      if (todayPlanStates[k] && todayPlanStates[k].workoutId === workoutId) {
        todayPlanStates[k].startedAt = newStartedAt;
        todayPlanStates[k].pausedMs = 0;
      }
    }
    for (var i = 0; i < todayAdHocs.length; i++) {
      if (todayAdHocs[i] && todayAdHocs[i].workoutId === workoutId) {
        todayAdHocs[i].startedAt = newStartedAt;
        todayAdHocs[i].pausedMs = 0;
      }
    }
    buildDay(currentDay);
    // If the focused session is running, restart the timer tick so the
    // displayed timer stays accurate from the new base.
    if (todayState && todayState.workoutId === workoutId && !todayState.endedAt) {
      startTimerTick();
    }
  } catch(err) {
    console.error('promptAdjustDuration error:', err);
    showToast("Couldn't update duration: " + (err.message || 'unknown error'), null);
  }
}

// Cancel the currently-focused plan-day session. Triggered from the
// dashed "Cancel session (no sets logged)" affordance under the session
// bar. Only rendered when zero sets are done, but we double-check here
// before destructive delete.
async function onCancelTodaySession(workoutId) {
  if (!workoutId || !todayState || todayState.workoutId !== workoutId) return;
  if (!confirm('Cancel this session? No sets were logged; this removes the empty session so you can start fresh.')) return;
  try {
    await discardWorkout(workoutId);
    // Clear in-memory state so the day-tab re-renders as not-started.
    if (typeof currentDay === 'number' && todayPlanStates[currentDay]) {
      delete todayPlanStates[currentDay];
    }
    todayState = null;
    stopTimerTick();
    buildTabs();
    buildDay(currentDay);
    showToast('Session canceled. Start fresh when ready.', null);
  } catch(err) {
    console.error('onCancelTodaySession error:', err);
    showToast("Couldn't cancel session: " + (err.message || 'unknown error'), null);
  }
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
    h += '<div class="session-bar done" style="margin-top:12px"><div class="session-duration">Session: ' + fmtDuration(ms) + '</div>' +
         renderDurationEditBtn(workout.id, ms, state.endedAt, 'history') + '</div>';
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
  // Lifecycle actions — discard + reactivate. Placed at the bottom of the
  // detail so the session content is what the user sees first. Reactivate
  // only offered when safe (ad-hoc, or plan-based on the currently-active
  // plan — reactivating a different plan's session would land it in a
  // state no today-view surfaces). See DECISIONS.md v2.2.2.
  var canReactivate = isAdHoc || (workout.plan_id && workout.plan_id === activePlanId);
  var completedCount = 0;
  var totalSetCount = 0;
  var stateExercises = state.exercises || {};
  for (var sek in stateExercises) {
    var sets = stateExercises[sek].sets || [];
    totalSetCount += sets.length;
    for (var sj = 0; sj < sets.length; sj++) if (sets[sj] && sets[sj].done) completedCount++;
  }
  h += '<div class="history-detail-actions">';
  if (canReactivate) {
    h += '<button type="button" class="history-action-btn reactivate" data-workout-id="' + escapeAttr(workout.id) + '">Bring to today</button>';
  }
  h += '<button type="button" class="history-action-btn discard" data-workout-id="' + escapeAttr(workout.id) + '" data-completed="' + completedCount + '" data-title="' + escapeAttr(titleText) + '">Discard session</button>';
  h += '</div>';
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
  if (exState.subExercise || exState.sub) {
    // subExercise is the structured v2.2.1 field (library row); sub is the
    // legacy free-text fallback. Prefer structured when both are present.
    var histSubLabel = exState.subExercise ? exState.subExercise.name : exState.sub;
    h += '<div class="sub-row"><div class="sub-label">SUB:</div><div style="font-size:12px;color:var(--text2);flex:1">' + escapeHtml(histSubLabel) + '</div></div>';
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
function openGenerate() {
  // If a previous fetch is still running, re-surface the loading modal
  // rather than silently ignoring the click or firing a duplicate
  // request. vercel dev serializes local function invocations, so
  // without this guard the user could queue up multiple 30-60s calls.
  if (generateInFlight) {
    document.getElementById('generateOverlay').classList.add('show');
    renderGenerate();
    return;
  }
  // Fresh open: show the inputs form. The fetch only fires when the
  // user submits via submitGenerateInputs().
  generateView = 'inputs';
  generateMode = 'plan';
  generatedPlan = null;
  generatedAnalysis = null;
  generatedMeta = null;
  generatedInputs = null;
  document.getElementById('generateOverlay').classList.add('show');
  renderGenerate();
}

// submitGenerateInputs dispatches on `mode` ('plan' | 'analyze'). v2.3.0
// splits the old one-call flow into two: plan-gen returns structured plan
// JSON only; analyze returns a four-section written assessment. The user
// can chain them via the "Use for next plan" button on the analyze review.
async function submitGenerateInputs(mode) {
  mode = mode || 'plan';
  var startEl = document.getElementById('genFormStartDate');
  var durEl = document.getElementById('genFormDuration');
  var daysEl = document.getElementById('genFormTrainingDays');
  var weeksEl = document.getElementById('genFormHistoryWeeks');
  var photosEl = document.getElementById('genFormIncludePhotos');
  var notesEl = document.getElementById('genFormNotes');
  var startDate = (startEl && startEl.value) || null;
  var targetDuration = durEl && durEl.value ? parseInt(durEl.value, 10) : null;
  if (!Number.isFinite(targetDuration)) targetDuration = null;
  var notes = (notesEl && notesEl.value || '').trim() || null;
  var trainingDays = clampFormInt(daysEl && daysEl.value, 1, 6, 5);
  var historyWeeks = clampFormInt(weeksEl && weeksEl.value, 1, 12, 4);
  var includePhotos = !!(photosEl && photosEl.checked);

  // Stash the full input set locally for display state. Payload to server
  // differs by mode below — analyze strips the forward-looking fields so
  // they don't leak into the analyze prompt's reasoning (per the v2.3.0
  // audit: inputs should not conflict with the system prompt).
  generatedInputs = {
    start_date: startDate,
    target_duration: targetDuration,
    training_days: trainingDays,
    history_weeks: historyWeeks,
    include_photos: includePhotos,
    notes: notes,
  };

  var payload;
  if (mode === 'analyze') {
    payload = {
      mode: 'analyze',
      history_weeks: historyWeeks,
      include_photos: includePhotos,
      notes: notes,
    };
  } else {
    payload = {
      start_date: startDate,
      target_duration: targetDuration,
      training_days: trainingDays,
      history_weeks: historyWeeks,
      include_photos: includePhotos,
      notes: notes,
    };
  }

  if (generateInFlight) return;
  generateInFlight = true;
  generateMode = mode;
  generateView = 'loading';
  generateStartedAt = Date.now();
  generateAttempt = 1;
  generateAbortController = new AbortController();
  // Reset prior output so the review dispatcher renders the right mode.
  generatedPlan = null;
  generatedAnalysis = null;
  renderGenerate();
  // Option L (2026-04-22): plan-gen doesn't log its submit anymore —
  // only the accept row persists (onAcceptGeneratedPlan). Cancelled
  // plan-gens leave no trace; the chat history reflects things that
  // happened to the training plan, not things the user considered
  // and abandoned. Analyze still logs its request because the
  // analysis content (the assistant response) is always informational
  // and the request row gives it the corresponding "Client asked" turn.
  // Notes are capped at 200 chars — chained-from-analyze or pasted-
  // analysis notes can be 1500+ chars of redundant content already
  // captured in the analyze response row.
  if (mode === 'analyze') {
    var rawNotes = notes ? String(notes).trim() : '';
    var notesForLog;
    if (!rawNotes) {
      notesForLog = 'none';
    } else if (rawNotes.length <= 200) {
      notesForLog = rawNotes;
    } else {
      notesForLog = rawNotes.slice(0, 200).trim() + '… [truncated, ' + rawNotes.length + ' chars]';
    }
    logCoachMessage('user',
      'Requested training analysis. Weeks of history: ' + historyWeeks + '. Notes: ' + notesForLog,
      'plan_generation', null);
  }

  try {
    var sessionRes = await sb.auth.getSession();
    var token = sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
    if (!token) throw new Error('Not signed in');

    var result = await attemptGenerate(token, generateAbortController.signal, payload, mode);
    if (result.retry) {
      console.log('[generate:' + mode + '] attempt 1 failed (' + result.error + ') — retrying with warm instance');
      generateAttempt = 2;
      renderGenerate();
      result = await attemptGenerate(token, generateAbortController.signal, payload, mode);
    }

    if (!result.success) {
      var msg = result.error || 'unknown error';
      closeGenerate();
      showToast((mode === 'analyze' ? 'Analysis' : 'Plan generation') + ' failed: ' + msg, null);
      return;
    }

    var body = result.body;
    if (mode === 'analyze') {
      generatedAnalysis = body.analysis;
      // Log the rich four-section assessment as the assistant message.
      // This is the analog of the (now-removed) coaching_notes — the
      // textual coaching content the user sees and Claude can reference
      // in future calls. Plan-gen has no equivalent (structure-only
      // since v2.3.0), so plan-gen logs only request + accept.
      logCoachMessage('assistant',
        formatAnalysisForLog(body.analysis),
        'plan_generation', null);
    } else {
      generatedPlan = body.plan;
    }
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
      return;
    }
    console.error('submitGenerateInputs error:', err);
    closeGenerate();
    showToast((mode === 'analyze' ? 'Analysis' : 'Plan generation') + ' failed: ' + (err.message || 'network error'), null);
  } finally {
    generateInFlight = false;
    generateAbortController = null;
  }
}

// Unified fetch for plan + analyze modes. Picks the body key to validate
// against by mode so the retry/success/failure classification matches.
async function attemptGenerate(token, signal, payload, mode) {
  try {
    var res = await fetch('/api/generate-plan', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: signal,
    });
    var body = await res.json().catch(function() { return null; });

    var successful;
    if (mode === 'analyze') {
      successful = res.status === 200 && body && body.analysis && typeof body.analysis === 'object';
    } else {
      successful = res.status === 200 && body && body.plan;
    }
    if (successful) return { success: true, body: body };

    var msg = (body && body.error) || ('HTTP ' + res.status);
    if (res.status >= 500) return { retry: true, error: msg };
    return { success: false, error: msg };
  } catch(err) {
    if (err && err.name === 'AbortError') throw err;
    return { retry: true, error: err.message || 'network error' };
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
  generatedAnalysis = null;
  generatedMeta = null;
}

function renderGenerate() {
  var title = document.getElementById('generateTitle');
  var body = document.getElementById('generateBody');
  if (generateView === 'inputs') {
    title.textContent = 'Analyze or generate plan';
    renderGenerateInputs(body);
  } else if (generateView === 'loading') {
    title.textContent = generateMode === 'analyze' ? 'Analyzing…' : 'Generating plan…';
    renderGenerateLoading(body);
  } else if (generateView === 'review') {
    title.textContent = generateMode === 'analyze' ? 'Training analysis' : 'Review plan';
    renderGenerateReview(body);
  }
}

function renderGenerateInputs(body) {
  // Default start date: next Sunday (start of a new training week).
  // If today is Sunday, that's today; else the upcoming Sunday.
  var todayStr = sessionTodayDateString();
  var d = new Date(todayStr + 'T00:00:00');
  var dow = d.getDay();  // 0 = Sunday
  d.setDate(d.getDate() + (dow === 0 ? 0 : (7 - dow)));
  var defaultStart = localDateString(d);

  var h = '<div class="generate-inputs">';
  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Start date</span>';
  h += '<input type="date" id="genFormStartDate" class="generate-form-input" value="' + escapeAttr(defaultStart) + '">';
  h += '<span class="generate-form-hint">When does this plan take effect. Typically the upcoming Sunday.</span>';
  h += '</label>';

  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Target session duration</span>';
  h += '<input type="number" id="genFormDuration" class="generate-form-input" value="60" min="30" max="120" step="5">';
  h += '<span class="generate-form-hint">Minutes per session. Claude will program toward this.</span>';
  h += '</label>';

  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Training days</span>';
  h += '<input type="number" id="genFormTrainingDays" class="generate-form-input" value="5" min="1" max="6" step="1">';
  h += '<span class="generate-form-hint">Sessions per week (1-6). Claude adapts the split to the count.</span>';
  h += '</label>';

  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">History context</span>';
  h += '<input type="number" id="genFormHistoryWeeks" class="generate-form-input" value="4" min="1" max="12" step="1">';
  h += '<span class="generate-form-hint">Weeks of past training to feed the AI (1-12). More = broader context, slightly longer prompts.</span>';
  h += '</label>';

  h += '<label class="generate-form-row generate-form-row-inline">';
  h += '<input type="checkbox" id="genFormIncludePhotos" class="generate-form-checkbox">';
  h += '<span class="generate-form-label">Include physique photos in analysis</span>';
  h += '<span class="generate-form-hint">Off by default. Turn on when you\'ve updated a progress photo or want visual-driven recommendations. Adds ~1-2s to generation.</span>';
  h += '</label>';

  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Notes to coach (optional)</span>';
  h += '<textarea id="genFormNotes" class="generate-form-textarea" rows="3" placeholder="e.g., knee acting up this week, traveling Mon-Wed (dumbbells only)"></textarea>';
  h += '</label>';

  h += '<div class="generate-inputs-actions">';
  h += '<button type="button" class="generate-btn-cancel" id="btnGenerateInputCancel">Cancel</button>';
  h += '<button type="button" class="generate-btn-secondary" id="btnGenerateInputAnalyze">Analyze</button>';
  h += '<button type="button" class="generate-btn-accept" id="btnGenerateInputSubmit">Generate Plan</button>';
  h += '</div>';
  h += '</div>';
  body.innerHTML = h;
}

function renderGenerateLoading(body) {
  var isRetry = generateAttempt === 2;
  var weeks = (generatedInputs && generatedInputs.history_weeks) || 4;
  var isAnalyze = generateMode === 'analyze';
  var status = isRetry
    ? 'Still running — warming up the AI…'
    : (isAnalyze ? 'Analyzing your training…' : 'Building your plan…');
  var sub = isRetry
    ? 'First call after idle can be slow; retry lands on a warm cache'
    : ('Reviewing ' + weeks + ' week' + (weeks === 1 ? '' : 's') + ' of data · usually ' +
       (isAnalyze ? '15-30 seconds' : '30-60 seconds'));
  body.innerHTML =
    '<div class="generate-loading">' +
      '<div class="generate-spinner"></div>' +
      '<div class="generate-status">' + escapeHtml(status) + '</div>' +
      '<div class="generate-status-sub">' + escapeHtml(sub) + '</div>' +
      '<button type="button" class="generate-btn-cancel" id="btnGenerateAbort" style="margin-top:20px;min-width:120px;padding:10px 16px;border-radius:10px;font-family:Outfit,sans-serif;font-size:14px;font-weight:600;cursor:pointer;">Cancel</button>' +
    '</div>';
}

function renderGenerateReview(body) {
  // Dispatch by mode. Analyze review shows the four-section written
  // assessment + a "Use for next plan" button that carries the analysis
  // forward into plan-gen's notes field. Plan review shows the structured
  // plan for Accept — coaching_notes dropped in v2.3.0.
  if (generateMode === 'analyze') {
    renderAnalyzeReview(body);
    return;
  }
  if (!generatedPlan) { body.innerHTML = ''; return; }
  var p = generatedPlan;
  var meta = generatedMeta || {};

  var h = '<div class="generate-review">';

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
  h += '<button class="generate-btn-secondary" id="btnGenerateSaveTemplate" type="button">Save as template</button>';
  h += '<button class="generate-btn-accept" id="btnGenerateAccept" type="button">Accept plan</button>';
  h += '</div>';
  h += '</div>';
  body.innerHTML = h;
}

// Format the four-section analysis as plain-text labeled blocks for the
// durable coach_messages log. Mirrors the "Use for next plan" formatter
// shape since both serve the same purpose: condense the analysis into a
// text block Claude can read in future calls. Sections with empty values
// are omitted so the log doesn't carry empty headers.
function formatAnalysisForLog(a) {
  if (!a) return '';
  var parts = [];
  if (a.trends) parts.push('TRENDS: ' + a.trends);
  if (a.progressing) parts.push('PROGRESSING: ' + a.progressing);
  if (a.concerns) parts.push('CONCERNS: ' + a.concerns);
  if (a.next_week) parts.push('NEXT WEEK: ' + a.next_week);
  return parts.join('\n\n');
}

// Render the four-section written analysis, any profile-update proposals
// (v2.5 layer 3), and sibling actions. Profile updates render as cards
// with per-field checkboxes + an "Apply selected" button that writes
// accepted changes to coaching_profile via saveCoachingProfile. "Use for
// next plan" is the existing ephemeral path that pastes the 4-section
// text into plan-gen's notes field.
function renderAnalyzeReview(body) {
  if (!generatedAnalysis) { body.innerHTML = ''; return; }
  var a = generatedAnalysis;
  var meta = generatedMeta || {};
  var h = '<div class="generate-review">';

  h += '<div class="generate-meta">Analysis' +
    (meta.weeks_analyzed ? ' · ' + meta.weeks_analyzed + ' week' + (meta.weeks_analyzed === 1 ? '' : 's') : '') +
    (meta.model ? ' · ' + escapeHtml(meta.model) : '') +
    (meta.elapsed_s ? ' · ' + meta.elapsed_s + 's' : '') +
    '</div>';

  var sections = [
    { key: 'trends', label: 'TRENDS' },
    { key: 'progressing', label: 'PROGRESSING' },
    { key: 'concerns', label: 'CONCERNS' },
    { key: 'next_week', label: 'NEXT WEEK' },
  ];
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    var val = a[s.key] || '';
    if (!val) continue;
    h += '<div class="analyze-section">';
    h += '<div class="analyze-section-label">' + s.label + '</div>';
    h += '<div class="analyze-section-text">' + escapeHtml(val) + '</div>';
    h += '</div>';
  }

  // Profile update proposals. Server validator normalizes to [] when the
  // field is absent, so guarded Array check covers both old and new shapes.
  // Empty array = nothing to propose this window; we skip the section
  // entirely to avoid visual noise when the profile is current.
  var updates = Array.isArray(a.profile_updates) ? a.profile_updates : [];
  if (updates.length > 0) {
    h += '<div class="profile-updates-section">';
    h += '<div class="analyze-section-label">PROPOSED PROFILE UPDATES</div>';
    for (var ui = 0; ui < updates.length; ui++) {
      h += renderProfileUpdateCard(updates[ui], ui);
    }
    h += '</div>';
  }

  h += '<div class="generate-actions">';
  h += '<button class="generate-btn-cancel" id="btnGenerateCancel" type="button">Close</button>';
  if (updates.length > 0) {
    h += '<button class="generate-btn-secondary" id="btnAnalyzeApplyProfile" type="button">Apply selected</button>';
  }
  h += '<button class="generate-btn-accept" id="btnAnalyzeUseForPlan" type="button">Use for next plan</button>';
  h += '</div>';
  h += '</div>';
  body.innerHTML = h;
}

// Build one proposal card. Shape depends on field type: scalars get an
// inline "old → new" diff; long free-text fields + injury operations get
// stacked current / proposed blocks for readability. Checkbox is keyed
// by the index so readSelectedProfileUpdates() can match on it.
function renderProfileUpdateCard(u, idx) {
  var label = profileUpdateLabel(u);
  var diff = renderProfileUpdateDiff(u);
  var reasoning = u.reasoning ? escapeHtml(u.reasoning) : '';
  var h = '<div class="pu-card">';
  h += '<input type="checkbox" class="pu-checkbox" data-pu-idx="' + idx + '" checked>';
  h += '<div class="pu-body">';
  h += '<div class="pu-field">' + escapeHtml(label) + '</div>';
  h += diff;
  if (reasoning) h += '<div class="pu-reasoning">' + reasoning + '</div>';
  h += '</div>';
  h += '</div>';
  return h;
}

// Human-readable label shown at the top of the proposal card. Appends the
// injury name for injury_* ops so the user can see which injury the card
// refers to without opening the stacked diff.
function profileUpdateLabel(u) {
  switch (u.field) {
    case 'weight_lbs': return 'Current weight';
    case 'phase': return 'Training phase';
    case 'phase_start_date': return 'Phase start date';
    case 'phase_notes': return 'Phase notes';
    case 'goal_type': return 'Goal type';
    case 'goal_detail': return 'Goal detail';
    case 'split_preference': return 'Split preference';
    case 'environment': return 'Training environment';
    case 'special_instructions': return 'Special instructions';
    case 'injury_add':
      return 'New injury: ' + ((u.proposed && u.proposed.name) || '(unnamed)');
    case 'injury_remove':
      return 'Mark resolved: ' + ((u.current && u.current.name) || '(unnamed)');
    case 'injury_update':
      return 'Update injury: ' + ((u.current && u.current.name) || '(unnamed)');
    default: return u.field || 'Profile change';
  }
}

// Render the current → proposed diff. Short scalars render inline with
// strikethrough on old + bold on new; long text / injuries render stacked
// so pre-wrap doesn't get squashed into a single line.
function renderProfileUpdateDiff(u) {
  var inlineScalars = { weight_lbs: 1, phase: 1, goal_type: 1, phase_start_date: 1 };
  var asStr = function(v) {
    if (v == null || v === '') return '—';
    if (u.field === 'weight_lbs' && typeof v === 'number') return v + ' lbs';
    return String(v);
  };
  if (inlineScalars[u.field]) {
    return '<div class="pu-diff-inline">' +
      '<span class="pu-old">' + escapeHtml(asStr(u.current)) + '</span>' +
      ' → ' +
      '<span class="pu-new">' + escapeHtml(asStr(u.proposed)) + '</span>' +
      '</div>';
  }
  if (u.field === 'injury_add') {
    var p = u.proposed || {};
    return '<div class="pu-stacked">' +
      '<div class="pu-stacked-label">Proposed notes</div>' +
      '<div class="pu-new-block">' + escapeHtml(p.notes || '(no notes)') + '</div>' +
      '</div>';
  }
  if (u.field === 'injury_remove') {
    var c = u.current || {};
    return '<div class="pu-stacked">' +
      '<div class="pu-stacked-label">Current notes (will be removed)</div>' +
      '<div class="pu-old-block">' + escapeHtml(c.notes || '(no notes)') + '</div>' +
      '</div>';
  }
  if (u.field === 'injury_update') {
    var cc = u.current || {}, pp = u.proposed || {};
    return '<div class="pu-stacked">' +
      '<div class="pu-stacked-label">Current notes</div>' +
      '<div class="pu-old-block">' + escapeHtml(cc.notes || '(no notes)') + '</div>' +
      '<div class="pu-stacked-label">Proposed notes</div>' +
      '<div class="pu-new-block">' + escapeHtml(pp.notes || '(no notes)') + '</div>' +
      '</div>';
  }
  // Long free-text scalars: stacked blocks.
  return '<div class="pu-stacked">' +
    '<div class="pu-stacked-label">Current</div>' +
    '<div class="pu-old-block">' + escapeHtml(u.current == null || u.current === '' ? '(empty)' : String(u.current)) + '</div>' +
    '<div class="pu-stacked-label">Proposed</div>' +
    '<div class="pu-new-block">' + escapeHtml(u.proposed == null || u.proposed === '' ? '(empty)' : String(u.proposed)) + '</div>' +
    '</div>';
}

// Return the proposals whose checkboxes are currently checked. Reads from
// the live DOM so the user's last-moment tick/untick is respected (no need
// to maintain a separate selected-state array).
function readSelectedProfileUpdates() {
  if (!generatedAnalysis || !Array.isArray(generatedAnalysis.profile_updates)) return [];
  var out = [];
  var boxes = document.querySelectorAll('#generateBody .pu-checkbox');
  for (var i = 0; i < boxes.length; i++) {
    if (!boxes[i].checked) continue;
    var idx = parseInt(boxes[i].getAttribute('data-pu-idx'), 10);
    if (Number.isFinite(idx) && generatedAnalysis.profile_updates[idx]) {
      out.push(generatedAnalysis.profile_updates[idx]);
    }
  }
  return out;
}

// Apply-selected handler. Load profile if needed, merge accepted updates,
// upsert, then re-render the review with the accepted entries removed so
// remaining (unchecked) proposals stay visible for another look.
async function onAnalyzeApplyProfileUpdates() {
  var selected = readSelectedProfileUpdates();
  if (!selected.length) {
    showToast('Select at least one update to apply', null);
    return;
  }
  var btn = document.getElementById('btnAnalyzeApplyProfile');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
  try {
    if (coachingProfile === null && typeof loadCoachingProfile === 'function') {
      await loadCoachingProfile();
    }
    var nextProfile = applyProfileUpdatesFrom(coachingProfile || {}, selected);
    await saveCoachingProfile(nextProfile);
    // Drop accepted entries from the in-memory analysis so the re-render
    // hides them. Unchecked entries remain visible for reconsideration.
    // Identity match is safe because readSelectedProfileUpdates returns
    // the same object references held in generatedAnalysis.profile_updates.
    generatedAnalysis.profile_updates = generatedAnalysis.profile_updates.filter(function(u) {
      return selected.indexOf(u) === -1;
    });
    renderAnalyzeReview(document.getElementById('generateBody'));
    showToast(
      selected.length + ' profile update' + (selected.length === 1 ? '' : 's') + ' applied',
      null
    );
  } catch (err) {
    console.error('onAnalyzeApplyProfileUpdates error:', err);
    showToast("Couldn't apply updates: " + (err.message || 'unknown error'), null);
    if (btn) { btn.disabled = false; btn.textContent = 'Apply selected'; }
  }
}

// Carry the four-section analysis into plan-gen's notes field and return
// the user to the inputs view with all their other inputs preserved. User
// can then tweak and click Generate Plan to produce a plan informed by the
// analysis. Each section is prefixed with a label so Claude parses them as
// coaching guidance rather than random free-text.
function useAnalysisForNextPlan() {
  if (!generatedAnalysis) return;
  var a = generatedAnalysis;
  var bits = [];
  if (a.trends) bits.push('TRENDS: ' + a.trends);
  if (a.progressing) bits.push('PROGRESSING: ' + a.progressing);
  if (a.concerns) bits.push('CONCERNS: ' + a.concerns);
  if (a.next_week) bits.push('NEXT WEEK FOCUS: ' + a.next_week);
  var carry = bits.join('\n\n');
  // Switch back to the inputs view, re-render, then populate the textarea
  // after DOM is ready. Existing inputs (training_days, duration, photos,
  // etc.) are preserved via generatedInputs — the form reads values from
  // the DOM only if the elements exist yet.
  generatedAnalysis = null;
  generateView = 'inputs';
  renderGenerate();
  setTimeout(function() {
    var ta = document.getElementById('genFormNotes');
    if (ta) {
      ta.value = carry;
      ta.focus();
      ta.scrollTop = ta.scrollHeight;
    }
  }, 0);
  showToast('Analysis carried forward. Review, then Generate Plan.', null);
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
  // Respect the user's chosen start_date from the inputs form. This
  // overrides savePlanAsActive's auto-stamp (which defaults to today)
  // so a plan generated Thursday for next Sunday's start is dated
  // correctly, not backdated to Thursday.
  if (generatedInputs && generatedInputs.start_date) {
    generatedPlan.start_date = generatedInputs.start_date;
  }
  var btn = document.getElementById('btnGenerateAccept');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await savePlanAsActive(generatedPlan);
    var label = generatedPlan.week || generatedPlan.title || 'New plan';
    // Option L: one outcome row per accepted plan — there's no separate
    // "submit" row anymore. Captures label + history window + user
    // notes. Notes are capped at 200 chars because chained-from-analyze
    // flows can put 1500+ chars of redundant analysis in the notes
    // field; the analyze assistant row already holds the analytical
    // content, and the full notes are sent to Claude at plan-gen
    // time via USER INPUTS regardless of what gets logged here.
    var weeksStr = (generatedInputs && generatedInputs.history_weeks != null)
      ? String(generatedInputs.history_weeks) : '?';
    var rawNotes = (generatedInputs && generatedInputs.notes)
      ? String(generatedInputs.notes).trim() : '';
    var notesForLog;
    if (!rawNotes) {
      notesForLog = 'none';
    } else if (rawNotes.length <= 200) {
      notesForLog = rawNotes;
    } else {
      notesForLog = rawNotes.slice(0, 200).trim() + '… [truncated, ' + rawNotes.length + ' chars]';
    }
    logCoachMessage('user',
      'Accepted plan: ' + label + '. Weeks of history: ' + weeksStr + '. Notes: ' + notesForLog,
      'plan_generation', null);
    closeGenerate();
    showToast(label + ' loaded', null);
  } catch(err) {
    console.error('onAcceptGeneratedPlan error:', err);
    showToast('Failed to save plan: ' + (err.message || 'unknown error'), null);
    if (btn) { btn.disabled = false; btn.textContent = 'Accept plan'; }
  }
}

// Save the currently-previewed generated plan as a reusable template,
// WITHOUT activating it. Reuses openSaveTemplate which opens the save-
// template modal on top of the generate review; closing the save modal
// returns the user to the review so they can still Accept plan afterward
// if they want both outcomes (template for future + activate now).
function onSaveGeneratedPlanAsTemplate() {
  if (!generatedPlan) return;
  if (generatedInputs && generatedInputs.start_date && !generatedPlan.start_date) {
    generatedPlan.start_date = generatedInputs.start_date;
  }
  openSaveTemplate(generatedPlan, null, '');
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
    // Templates live in the same plans table (is_template = true) but
    // belong in the Templates modal, not here. Without this filter, a
    // template row shows up in the Plans list and "deleting the plan"
    // actually deletes the template — which is what the user's "plan
    // delete took out my template" report turned out to be.
    var pr = await sb.from('plans')
      .select('id, title, week, is_active, created_at, data')
      .eq('user_id', userId)
      .eq('is_template', false)
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
    h += '<button type="button" class="plans-btn view" data-view-plan-id="' + escapeAttr(p.id) + '">View</button>';
    h += '<button type="button" class="plans-btn rename" data-rename-plan-id="' + escapeAttr(p.id) + '">Rename</button>';
    h += '<button type="button" class="plans-btn activate" data-plan-id="' + escapeAttr(p.id) + '"' +
         (p.is_active ? ' disabled' : '') + '>Activate</button>';
    h += '<button type="button" class="plans-btn template" data-plan-id="' + escapeAttr(p.id) + '">Template</button>';
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

async function onRenamePlan(planId) {
  var p = null;
  for (var i = 0; i < plansList.length; i++) {
    if (plansList[i].id === planId) { p = plansList[i]; break; }
  }
  if (!p) return;
  var current = p.title || '';
  var next = prompt('Rename plan', current);
  if (next === null) return;
  var trimmed = (next || '').trim();
  if (!trimmed) { showToast('Plan name required', null); return; }
  if (trimmed === current) return;
  try {
    await renamePlan(planId, trimmed);
    // If this is the active plan, keep in-memory state + tracker header
    // + hydration cache in sync so the user sees the rename immediately
    // without a reload.
    if (p.is_active && plan && activePlanId === planId) {
      plan.title = trimmed;
      var titleEl = document.getElementById('planTitle');
      if (titleEl) titleEl.textContent = trimmed;
      if (typeof saveHydrationSnapshot === 'function') saveHydrationSnapshot();
    }
    await loadPlans();
    renderPlans();
    showToast('Plan renamed', null);
  } catch(err) {
    console.error('onRenamePlan error:', err);
    showToast("Couldn't rename: " + (err.message || 'unknown error'), null);
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
    // Defensive: scope delete to non-template rows. Pre-v2.4.11 the
    // Plans list could include template rows; if a stale client still
    // has one in plansList, this prevents the delete from landing on
    // the template by id.
    var dr = await sb.from('plans').delete()
      .eq('id', planId)
      .eq('is_template', false);
    if (dr.error) throw dr.error;
    await loadPlans();
    renderPlans();
    showToast('Plan deleted', null);
  } catch(err) {
    console.error('onDeletePlan error:', err);
    showToast("Couldn't delete plan: " + (err.message || 'unknown error'), null);
  }
}

// ---- Coach Chat ----
// Session-level chat panel. coachContext (data.js) + getLiveContext() (data.js)
// are reassembled fresh on every send; only the Q/A history accumulates here.
// Two arrays now (post-v2.5):
//   chatHistory          — in-memory ring buffer for the API call (this
//                          session only). Sent to /api/coach-chat as the
//                          multi-turn conversation; capped at 20 entries.
//   chatLoadedHistory    — past 2 weeks + current week of coach_messages
//                          loaded from DB on chat open. Renders above the
//                          current session in the panel as historical
//                          context (date headers, muted style, context
//                          badges for swap / plan_generation rows).
// Persistence to coach_messages is durable (logCoachMessage in data.js);
// in-memory chatHistory is cleared on sign-out, session start, session
// complete — the historical view picks them back up on next chat open
// because the persistence already happened.
var chatHistory = [];         // [{ role: 'user'|'assistant', content }]
var chatLoadedHistory = [];   // [{ role, content, context_type, exercise_name, created_at }]
var chatLoadedAt = 0;         // ms epoch of last successful load; 0 = never
var chatLoadingHistory = false;
var chatPending = false;      // blocks double-sends + Enter-spam
var chatHasUnread = false;    // drives the fab dot while panel is closed
var chatAttempt = 0;          // 1 = first try, 2 = cold-start retry

// Keep only the last 20 messages (10 Q/A pairs) for the API call. Older
// entries drop off to prevent token bloat on long conversations. Context
// pair is NOT stored here — it's synthesized fresh from coachContext +
// getLiveContext() on every send.
var CHAT_HISTORY_MAX = 20;
// Cap rendered historical messages so a chatty user with months of history
// doesn't paint a 500-row scroll on chat open. "Load earlier messages"
// pagination deferred to a follow-up.
var CHAT_DISPLAY_MAX = 50;
// Re-query coach_messages only every ~5 min on chat open. Closing and
// reopening the panel rapidly should be instant; long-idle reopens get
// a fresh pull so cross-context writes (a swap or plan-gen done while
// the panel was closed) surface naturally on the next open.
var CHAT_HISTORY_REFRESH_MS = 5 * 60 * 1000;

function openCoachChat() {
  document.getElementById('coachOverlay').classList.add('show');
  setCoachUnread(false);
  renderCoachThread();
  // Build context on first open if the lifecycle triggers haven't already
  // populated it. Non-blocking — the thread renders immediately; the user
  // types, and the send flow will wait for context if still building.
  if (!coachContext && typeof buildCoachContext === 'function') {
    buildCoachContext();
  }
  // Lazy-load coach history on open. Uses a 5-min cache so rapid
  // open/close cycles don't re-query; first open or stale cache pulls
  // fresh. Non-blocking — the thread re-renders when load completes.
  var stale = (Date.now() - chatLoadedAt) > CHAT_HISTORY_REFRESH_MS;
  if (chatLoadedAt === 0 || stale) {
    loadChatHistory();
  }
  setTimeout(function() {
    var input = document.getElementById('coachInput');
    if (input) input.focus();
  }, 100);
}

function closeCoachChat() {
  document.getElementById('coachOverlay').classList.remove('show');
}

function clearChatHistory() {
  chatHistory = [];
  // The DURABLE log isn't cleared here — sign-out cascades the table
  // via auth.users ON DELETE; session start / complete just clear the
  // in-memory ring buffer. The historical view stays accurate for the
  // user's account either way. Drop the loaded-history cache so the
  // next chat open reloads fresh (covers the case where the user just
  // started a new session and wants to see today's prior chat in
  // historical context rather than as "current session").
  chatLoadedHistory = [];
  chatLoadedAt = 0;
  setCoachUnread(false);
  // If the thread is currently in the DOM (panel was left open at session
  // boundary), re-render so it reflects the cleared state.
  if (document.getElementById('coachOverlay').classList.contains('show')) {
    renderCoachThread();
  }
}

// Pull recent coach_messages (2 weeks back through current week) and
// re-render. Non-blocking on the input — the user can type while the
// query is in flight, and a small "Loading history…" tag renders at
// the top of the thread until results land. Failure is silent — the
// chat still works without the historical strip.
async function loadChatHistory() {
  if (!userId || chatLoadingHistory) return;
  chatLoadingHistory = true;
  // Re-render so the loading tag appears immediately if the thread is
  // visible. Avoids a "blank scroll" feel on first open.
  if (document.getElementById('coachOverlay').classList.contains('show')) {
    renderCoachThread();
  }
  try {
    // Sun-anchored window matching the server-side helper. Two full
    // prior weeks plus the current week to date.
    var today = new Date();
    var weekSunday = new Date(today);
    weekSunday.setHours(0, 0, 0, 0);
    weekSunday.setDate(today.getDate() - today.getDay());
    var start = new Date(weekSunday);
    start.setDate(start.getDate() - 14);
    var res = await sb.from('coach_messages')
      .select('role, content, context_type, exercise_name, created_at')
      .eq('user_id', userId)
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: true });
    if (res.error) {
      console.warn('loadChatHistory error:', res.error.message);
      chatLoadedHistory = [];
    } else {
      var rows = res.data || [];
      // Silent cap — most-recent CHAT_DISPLAY_MAX. Pagination
      // ("Load earlier messages") deferred per the original design.
      if (rows.length > CHAT_DISPLAY_MAX) {
        rows = rows.slice(rows.length - CHAT_DISPLAY_MAX);
      }
      chatLoadedHistory = rows;
      chatLoadedAt = Date.now();
    }
  } catch (err) {
    console.warn('loadChatHistory exception:', err);
  } finally {
    chatLoadingHistory = false;
    if (document.getElementById('coachOverlay').classList.contains('show')) {
      renderCoachThread();
    }
  }
}

function setCoachUnread(flag) {
  chatHasUnread = !!flag;
  var badge = document.getElementById('coachFabBadge');
  if (badge) badge.classList.toggle('hidden', !flag);
}

// Render order:
//   1. Loading tag while history is mid-fetch (only if there's nothing
//      else to show — otherwise the existing thread stays visible
//      under the optimistic cached array).
//   2. Historical block: chatLoadedHistory grouped by date with
//      "--- Tue, Apr 15 ---" headers, muted style, and inline context
//      badges for swap / plan_generation rows.
//   3. Current-session block: chatHistory entries that DON'T appear in
//      chatLoadedHistory (deduped by content + role on the tail). These
//      render at full opacity with no date header — they're "right now."
//   4. If both blocks are empty, the welcome empty-hint takes the panel.
function renderCoachThread() {
  var thread = document.getElementById('coachThread');
  if (!thread) return;

  var h = '';

  // Filter chatHistory to entries not already in chatLoadedHistory.
  // Comparison is by role + content. Logged messages from THIS open
  // get persisted by the success path AND fetched on next open / 5-min
  // refresh — without dedup, they'd appear twice (muted historical +
  // bright current). Tail-only check is fine because chatHistory is
  // append-only within a session.
  var loadedKeys = {};
  for (var li = 0; li < chatLoadedHistory.length; li++) {
    var lm = chatLoadedHistory[li];
    if (!lm) continue;
    loadedKeys[lm.role + '' + lm.content] = true;
  }
  var currentNew = [];
  for (var ci = 0; ci < chatHistory.length; ci++) {
    var cm = chatHistory[ci];
    if (cm && !loadedKeys[cm.role + '' + cm.content]) {
      currentNew.push(cm);
    }
  }

  if (chatLoadingHistory && !chatLoadedHistory.length && !currentNew.length) {
    h += '<div class="coach-history-loading">Loading recent conversations…</div>';
  }

  // Historical block with date headers + context badges.
  var lastDate = '';
  for (var i = 0; i < chatLoadedHistory.length; i++) {
    var m = chatLoadedHistory[i];
    if (!m || !m.content) continue;
    var d = new Date(m.created_at);
    var dateLabel = d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    });
    if (dateLabel !== lastDate) {
      lastDate = dateLabel;
      h += '<div class="coach-date-header">' + escapeHtml(dateLabel) + '</div>';
    }
    var roleCls = m.role === 'user' ? 'user' : 'coach';
    var badge = '';
    if (m.context_type === 'swap' && m.exercise_name) {
      badge = '<span class="coach-context-badge">swap: ' + escapeHtml(m.exercise_name) + '</span>';
    } else if (m.context_type === 'plan_generation') {
      badge = '<span class="coach-context-badge">plan</span>';
    }
    h += '<div class="coach-msg history ' + roleCls + '">' + badge + escapeHtml(m.content) + '</div>';
  }

  // Current-session block (deduped against historical).
  for (var k = 0; k < currentNew.length; k++) {
    var cur = currentNew[k];
    var curCls = cur.role === 'user' ? 'user' : 'coach';
    h += '<div class="coach-msg ' + curCls + '">' + escapeHtml(cur.content) + '</div>';
  }

  if (!h) {
    h = '<div class="coach-msg empty-hint">' +
      (todayState && todayState.workoutId
        ? 'Ask about weight, RPE, form, substitutions, or whatever comes up mid-session.'
        : 'Start a session for live coaching, or ask a general question. The coach knows your plan either way.') +
      '</div>';
  }

  thread.innerHTML = h;
  thread.scrollTop = thread.scrollHeight;
}

function appendTypingIndicator() {
  var thread = document.getElementById('coachThread');
  if (!thread) return;
  // Remove the empty-hint if present (first message of a session).
  var hint = thread.querySelector('.coach-msg.empty-hint');
  if (hint) hint.remove();
  var el = document.createElement('div');
  el.className = 'coach-typing';
  el.id = 'coachTypingIndicator';
  el.innerHTML = '<span></span><span></span><span></span>';
  thread.appendChild(el);
  if (chatAttempt === 2) {
    var sub = document.createElement('div');
    sub.className = 'coach-typing-sub';
    sub.id = 'coachTypingSub';
    sub.textContent = 'Warming up…';
    thread.appendChild(sub);
  }
  thread.scrollTop = thread.scrollHeight;
}

function removeTypingIndicator() {
  var el = document.getElementById('coachTypingIndicator');
  if (el) el.remove();
  var sub = document.getElementById('coachTypingSub');
  if (sub) sub.remove();
}

function appendChatError(msg, retryCallback) {
  var thread = document.getElementById('coachThread');
  if (!thread) return;
  var el = document.createElement('div');
  el.className = 'coach-msg error';
  var span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (retryCallback) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Retry';
    btn.addEventListener('click', function() {
      el.remove();
      retryCallback();
    });
    el.appendChild(btn);
  }
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

function appendUserMessage(content) {
  var thread = document.getElementById('coachThread');
  if (!thread) return;
  // Clear any empty-hint on first message.
  var hint = thread.querySelector('.coach-msg.empty-hint');
  if (hint) hint.remove();
  var el = document.createElement('div');
  el.className = 'coach-msg user';
  el.textContent = content;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

function appendCoachMessage(content) {
  var thread = document.getElementById('coachThread');
  if (!thread) return;
  var el = document.createElement('div');
  el.className = 'coach-msg coach';
  el.textContent = content;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

async function sendCoachMessage() {
  if (chatPending) return;
  var input = document.getElementById('coachInput');
  var text = (input.value || '').trim();
  if (!text) return;

  chatPending = true;
  input.value = '';
  input.style.height = '';
  var sendBtn = document.getElementById('btnCoachSend');
  if (sendBtn) sendBtn.disabled = true;

  // Lazy-build context if the lifecycle hooks haven't run yet (e.g., user
  // opens chat before a session starts). Awaited so the first message has
  // proper context — Haiku without context is noticeably less useful.
  if (!coachContext && typeof buildCoachContext === 'function') {
    try { await buildCoachContext(); } catch(e) { /* continue with empty ctx */ }
  }

  appendUserMessage(text);
  chatAttempt = 1;
  appendTypingIndicator();

  var userMsg = text;
  var outcome = await attemptCoachCall(userMsg);
  if (outcome.retry) {
    chatAttempt = 2;
    removeTypingIndicator();
    appendTypingIndicator();
    outcome = await attemptCoachCall(userMsg);
  }
  removeTypingIndicator();
  chatAttempt = 0;

  if (outcome.success) {
    var reply = outcome.reply;
    appendCoachMessage(reply);
    chatHistory.push({ role: 'user', content: userMsg });
    chatHistory.push({ role: 'assistant', content: reply });
    // Durable log alongside the in-memory ring buffer. Survives sign-out
    // and powers cross-session continuity in Claude prompts (v2.5+ B3).
    logCoachMessage('user', userMsg, 'chat', null);
    logCoachMessage('assistant', reply, 'chat', null);
    if (chatHistory.length > CHAT_HISTORY_MAX) {
      // Drop the two oldest entries (one Q/A pair). Keep length aligned on
      // pair boundaries so context ordering stays user/assistant/user/...
      chatHistory = chatHistory.slice(chatHistory.length - CHAT_HISTORY_MAX);
    }
    if (!document.getElementById('coachOverlay').classList.contains('show')) {
      setCoachUnread(true);
    }
  } else {
    appendChatError(outcome.error || 'Coach unavailable.', function() {
      // Retry by putting the question back into the input and resending.
      input.value = userMsg;
      // Also re-focus for edit.
      input.focus();
    });
  }

  chatPending = false;
  if (sendBtn) sendBtn.disabled = false;
}

// One POST to /api/coach-chat. Returns:
//   { success: true, reply }                  on 200 with reply
//   { retry: true, error }                    on 5xx / 504 / network error
//   { success: false, error }                 on 4xx, 401, 200-without-reply
// Never throws — caller handles display.
async function attemptCoachCall(userMsg) {
  try {
    var sessionRes = await sb.auth.getSession();
    var token = sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
    if (!token) return { success: false, error: 'Session expired. Please sign in again.' };

    // Assemble the messages array: context setup (first pair, fresh every
    // call because getLiveContext changes) + chatHistory + new user message.
    var liveCtx = (typeof getLiveContext === 'function') ? getLiveContext() : '';
    var contextBody = 'COACHING CONTEXT:\n' + (coachContext || '(no context available yet)') +
                      '\n\nCURRENT SESSION:\n' + (liveCtx || 'No active session.') +
                      '\n\nPlease acknowledge you have this context.';
    var messages = [
      { role: 'user', content: contextBody },
      { role: 'assistant', content: 'Ready to help with your session.' },
    ];
    for (var i = 0; i < chatHistory.length; i++) messages.push(chatHistory[i]);
    messages.push({ role: 'user', content: userMsg });

    var res = await fetch('/api/coach-chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages }),
    });
    var body = await res.json().catch(function() { return null; });

    if (res.status === 200 && body && typeof body.reply === 'string' && body.reply) {
      return { success: true, reply: body.reply };
    }
    var msg = (body && body.error) || ('HTTP ' + res.status);
    if (res.status === 401) return { success: false, error: 'Session expired. Please sign in again.' };
    if (res.status >= 500) return { retry: true, error: msg };
    return { success: false, error: msg };
  } catch(err) {
    return { retry: true, error: err.message || 'Network error. Check your connection.' };
  }
}

// ---- AI exercise swap ----
// Single-exercise replacement against the active plan. Modal cycles through
// three sub-views (input / loading / review) via swapState.view, same
// pattern as the Generate flow.
var swapState = null;               // { di, ei, snapshot, view, replacement?, reason }
var swapAbortController = null;

function openSwapModal(di, ei) {
  if (!plan || !plan.days || !plan.days[di]) return;
  var ex = plan.days[di].exercises[ei];
  if (!ex) return;
  var meta = exerciseLibraryByName ? exerciseLibraryByName[normName(ex.name)] : null;
  swapState = {
    di: di,
    ei: ei,
    // originalExercise holds a deep clone of the plan slot, used to revert
    // the in-memory mutation if the Supabase update fails in acceptSwap.
    originalExercise: JSON.parse(JSON.stringify(ex)),
    snapshot: {
      name: ex.name,
      sets: Array.isArray(ex.sets) ? ex.sets.slice() : [],
      muscle_group: meta ? (meta.muscle_group || null) : null,
      movement_pattern: meta ? (meta.movement_pattern || null) : null,
      equipment: meta ? (meta.equipment || null) : null,
      weight_mode: meta ? (meta.weight_mode || 'total') : 'total',
    },
    dayName: plan.days[di].name || ('Day ' + (di + 1)),
    view: 'input',
    replacement: null,
    reason: '',
  };
  document.getElementById('swapExerciseOverlay').classList.add('show');
  renderSwapModal();
}

function closeSwapModal() {
  if (swapAbortController) {
    try { swapAbortController.abort(); } catch(e) { /* already aborted */ }
    swapAbortController = null;
  }
  document.getElementById('swapExerciseOverlay').classList.remove('show');
  swapState = null;
}

function renderSwapModal() {
  if (!swapState) return;
  var body = document.getElementById('swapExerciseBody');
  var title = document.getElementById('swapExerciseTitle');
  if (swapState.view === 'input') {
    title.textContent = 'Replace exercise';
    renderSwapInput(body);
  } else if (swapState.view === 'loading') {
    title.textContent = 'Finding replacement…';
    renderSwapLoading(body);
  } else if (swapState.view === 'review') {
    title.textContent = 'Review replacement';
    renderSwapReview(body);
  }
}

function renderSwapInput(body) {
  var snap = swapState.snapshot;
  var h = '<div class="generate-inputs">';
  h += '<div class="generate-form-row">';
  h += '<span class="generate-form-label">Replacing</span>';
  h += '<div class="swap-review-name">' + escapeHtml(snap.name) + '</div>';
  if (snap.movement_pattern || snap.equipment) {
    var bits = [];
    if (snap.movement_pattern) bits.push(snap.movement_pattern);
    if (snap.equipment) bits.push(snap.equipment);
    h += '<span class="swap-review-meta">' + escapeHtml(bits.join(' · ')) + '</span>';
  }
  h += '</div>';
  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Why? (optional)</span>';
  h += '<input type="text" id="swapReasonInput" class="generate-form-input" placeholder="e.g., different gym, knee pain, variety" value="' + escapeAttr(swapState.reason || '') + '">';
  h += '<span class="generate-form-hint">Claude factors in the reason when choosing a replacement and setting the weight.</span>';
  h += '</label>';
  h += '<div class="generate-inputs-actions">';
  h += '<button type="button" class="generate-btn-cancel" id="btnSwapCancel">Cancel</button>';
  h += '<button type="button" class="generate-btn-accept" id="btnSwapSubmit">Find replacement</button>';
  h += '</div>';
  h += '</div>';
  body.innerHTML = h;
}

function renderSwapLoading(body) {
  body.innerHTML =
    '<div class="generate-loading">' +
      '<div class="generate-spinner"></div>' +
      '<div class="generate-status">Finding replacement…</div>' +
      '<div class="generate-status-sub">Usually 8-15 seconds. Analyzing movement pattern and recent history.</div>' +
      '<button type="button" class="generate-btn-cancel" id="btnSwapAbort" style="margin-top:20px;min-width:120px;padding:10px 16px;border-radius:10px;font-family:Outfit,sans-serif;font-size:14px;font-weight:600;cursor:pointer;">Cancel</button>' +
    '</div>';
}

function renderSwapReview(body) {
  var r = swapState.replacement || {};
  var h = '<div class="swap-review">';
  h += '<div><span class="swap-replacing-label">Replacing</span><div class="swap-review-name" style="opacity:0.7;text-decoration:line-through;">' +
       escapeHtml(swapState.snapshot.name) + '</div></div>';
  h += '<div><span class="swap-replacing-label">With</span><div class="swap-review-name">' + escapeHtml(r.name || '') + '</div>';
  var meta = exerciseLibraryByName ? exerciseLibraryByName[normName(r.name)] : null;
  if (meta && (meta.movement_pattern || meta.equipment)) {
    var bits = [];
    if (meta.movement_pattern) bits.push(meta.movement_pattern);
    if (meta.equipment) bits.push(meta.equipment);
    h += '<span class="swap-review-meta">' + escapeHtml(bits.join(' · ')) + '</span>';
  }
  h += '</div>';
  // Sets rendered in the same shape as fmtP output: weight × reps_target, and repeat count.
  if (Array.isArray(r.sets) && r.sets.length) {
    var setStrs = r.sets.map(function(s) {
      var w = s.weight != null ? s.weight : '?';
      var rp = s.reps_target != null ? s.reps_target : (s.reps_range || '?');
      return w + ' × ' + rp;
    });
    h += '<div class="swap-review-sets">' + escapeHtml(setStrs.join('   ·   ')) + '</div>';
  }
  if (r.rest) {
    h += '<div class="swap-review-meta">Rest: ' + Math.round(r.rest) + 's</div>';
  }
  if (r.note) h += '<div class="swap-review-note">' + escapeHtml(r.note) + '</div>';
  // Scope callout — makes the plan-level mutation explicit before the
  // user taps Accept. Paired with the substitution (SUB) flow's toast
  // that clarifies session-only scope. See DECISIONS v2.2.1 entry.
  h += '<div class="swap-scope-warning">Accepting replaces this exercise in your plan for the rest of the week. For a one-session change, close this and use <strong>SUB</strong> on the card.</div>';
  h += '<div class="swap-actions">';
  h += '<button type="button" class="swap-btn-cancel" id="btnSwapCancel">Cancel</button>';
  h += '<button type="button" class="swap-btn-retry" id="btnSwapRetry">Try again</button>';
  h += '<button type="button" class="swap-btn-accept" id="btnSwapAccept">Accept</button>';
  h += '</div>';
  h += '</div>';
  body.innerHTML = h;
}

async function submitSwapRequest() {
  if (!swapState) return;
  var reasonEl = document.getElementById('swapReasonInput');
  if (reasonEl) swapState.reason = (reasonEl.value || '').trim();
  // Option L: no pre-outcome logging. The accept row in acceptSwap
  // captures the whole flow (from → to, reason, coach's rationale).
  // Cancelled swaps leave no trace.
  await fireSwapFetch();
}

async function retrySwapRequest() {
  if (!swapState) return;
  // Option L: retries aren't logged — only the final accepted
  // replacement gets a single outcome row. Intermediate suggestions
  // and the user's "try again" action are session-scoped exploration
  // that Claude doesn't need in durable history.
  await fireSwapFetch();
}

async function fireSwapFetch() {
  if (!swapState) return;
  swapState.view = 'loading';
  swapState.replacement = null;
  renderSwapModal();
  if (swapAbortController) {
    try { swapAbortController.abort(); } catch(e) {}
  }
  swapAbortController = new AbortController();
  try {
    var sessionRes = await sb.auth.getSession();
    var token = sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
    if (!token) throw new Error('Not signed in');

    var exercise = {
      name: swapState.snapshot.name,
      muscle_group: swapState.snapshot.muscle_group,
      movement_pattern: swapState.snapshot.movement_pattern,
      equipment: swapState.snapshot.equipment,
      weight_mode: swapState.snapshot.weight_mode,
      sets: swapState.snapshot.sets,
    };
    var payload = {
      mode: 'swap',
      exercise: exercise,
      reason: swapState.reason || '',
      day_name: swapState.dayName,
    };
    var res = await fetch('/api/generate-plan', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: swapAbortController.signal,
    });
    var body = await res.json().catch(function() { return null; });
    if (res.status !== 200 || !body || !body.replacement) {
      var msg = (body && body.error) || ('HTTP ' + res.status);
      swapState.view = 'input';
      renderSwapModal();
      showToast('Swap failed: ' + msg, null);
      return;
    }
    swapState.replacement = body.replacement;
    swapState.view = 'review';
    renderSwapModal();
    // Option L: suggestions aren't persisted in isolation. On accept,
    // the acceptSwap log folds repl.note into the outcome row as
    // "Coach's rationale". On retry/cancel, the suggestion content
    // was session-scoped exploration — not durable.
  } catch(err) {
    if (err && err.name === 'AbortError') return;
    console.error('fireSwapFetch error:', err);
    if (swapState) { swapState.view = 'input'; renderSwapModal(); }
    showToast('Swap failed: ' + (err.message || 'network error'), null);
  } finally {
    swapAbortController = null;
  }
}

async function acceptSwap() {
  if (!swapState || !swapState.replacement) return;
  var di = swapState.di, ei = swapState.ei;
  if (!plan || !plan.days || !plan.days[di] || !plan.days[di].exercises[ei]) {
    showToast('Exercise no longer in plan', null);
    closeSwapModal();
    return;
  }
  var repl = swapState.replacement;
  var oldName = swapState.snapshot.name;
  // Mutate the plan blob in place at the same exercise_order slot. Logged
  // sets on the old exercise remain attached to their set rows (which reference
  // exercise_id directly, not the plan blob) — they become historical for the
  // old exercise on this one workout. Future set-done taps will use the
  // replacement's exercise_id via ensureExerciseId → resolveLibraryRow.
  plan.days[di].exercises[ei] = {
    name: repl.name,
    note: repl.note || '',
    rest: repl.rest,
    sets: Array.isArray(repl.sets) ? repl.sets.slice() : [],
  };

  var acceptBtn = document.getElementById('btnSwapAccept');
  if (acceptBtn) { acceptBtn.disabled = true; acceptBtn.textContent = 'Saving…'; }
  try {
    var up = await sb.from('plans').update({ data: plan }).eq('id', activePlanId);
    if (up.error) throw up.error;
    planCache[activePlanId] = plan;
    // Option L: one outcome row per accepted swap, captures the full
    // exchange so retries and suggestion-level exploration collapse
    // cleanly. Format:
    //   "Accepted swap: <from> → <to> (reason: <reason>). Coach's
    //   rationale: <≤20 word note>"
    // Failures fall through to the catch below and revert in-memory
    // state; the log doesn't fire so we don't persist a swap that
    // didn't actually happen.
    var reasonText = (swapState.reason && swapState.reason.trim()) || 'no reason given';
    var rationale = (repl.note && repl.note.trim()) ? repl.note.trim() : '';
    var swapLog = 'Accepted swap: ' + oldName + ' → ' + repl.name +
      ' (reason: ' + reasonText + ')';
    if (rationale) swapLog += ". Coach's rationale: " + rationale;
    logCoachMessage('user', swapLog, 'swap', oldName);
    closeSwapModal();
    buildTabs();
    buildDay(currentDay);
    showToast('Swapped ' + oldName + ' → ' + repl.name + ' for the rest of the week. Plan updated.', null);
  } catch(err) {
    console.error('acceptSwap error:', err);
    // Revert in-memory mutation to the exact original so UI doesn't drift
    // from DB. originalExercise is a deep clone captured at modal-open time.
    plan.days[di].exercises[ei] = swapState.originalExercise;
    showToast("Couldn't save swap: " + (err.message || 'unknown error'), null);
    if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = 'Accept'; }
  }
}

// ---- Templates: save / manage / use ----
// saveTemplateContext drives the modal. It carries both potential scopes
// (plan + day) when available, plus the active selection. The modal's
// scope picker flips `activeScope`; submit reads the corresponding blob.
var saveTemplateContext = null;     // { planBlob, dayBlob, dayName, activeScope, canSaveDay }
var templatesList = [];              // management-modal list
var templatesLoading = false;
var startScreenTemplatesList = [];   // start-screen picker list

// Open the save-template modal. Caller supplies:
//   planBlob   - full plan blob (required)
//   dayBlob    - single-day blob (optional; enables the "Just [day]" scope)
//   dayName    - label for the day scope button (required if dayBlob present)
// If no dayBlob is supplied, the modal hides the scope picker entirely —
// the Plans-modal row button uses this single-scope path.
function openSaveTemplate(planBlob, dayBlob, dayName) {
  if (!planBlob || !Array.isArray(planBlob.days) || !planBlob.days.length) {
    showToast('Nothing to save as template', null);
    return;
  }
  var canSaveDay = !!(dayBlob && Array.isArray(dayBlob.days) && dayBlob.days.length === 1);
  saveTemplateContext = {
    planBlob: planBlob,
    dayBlob: canSaveDay ? dayBlob : null,
    dayName: dayName || '',
    activeScope: 'plan',
    canSaveDay: canSaveDay,
  };

  var scopeRow = document.getElementById('saveTemplateScopeRow');
  var planBtn = document.getElementById('saveTemplateScopePlan');
  var dayBtn = document.getElementById('saveTemplateScopeDay');
  var dayCount = planBlob.days.length;
  planBtn.textContent = 'Whole plan (' + dayCount + ' day' + (dayCount === 1 ? '' : 's') + ')';
  if (canSaveDay) {
    dayBtn.textContent = 'Just "' + (dayName || 'this day') + '"';
    dayBtn.disabled = false;
    scopeRow.style.display = '';
  } else {
    // No day context (e.g., Plans-modal historical save, or ad-hoc focus).
    // Hide the scope picker entirely; save is implicitly "whole plan".
    scopeRow.style.display = 'none';
  }
  planBtn.classList.add('active');
  dayBtn.classList.remove('active');

  applySaveTemplateDefaults();

  document.getElementById('saveTemplateOverlay').classList.add('show');
  var input = document.getElementById('saveTemplateNameInput');
  setTimeout(function() { input.focus(); input.select(); }, 0);
}

function applySaveTemplateDefaults() {
  if (!saveTemplateContext) return;
  var ctx = saveTemplateContext;
  var defaultName, hint;
  if (ctx.activeScope === 'day' && ctx.canSaveDay) {
    defaultName = ctx.dayName || '';
    hint = 'Single-day template. Use it later as a starting point for an ad-hoc session.';
  } else {
    defaultName = ctx.planBlob.title || '';
    var n = ctx.planBlob.days.length;
    hint = n + '-day template. All days, exercises, and set prescriptions are preserved.';
  }
  document.getElementById('saveTemplateNameInput').value = defaultName;
  document.getElementById('saveTemplateHint').textContent = hint;
}

function setSaveTemplateScope(scope) {
  if (!saveTemplateContext) return;
  if (scope === 'day' && !saveTemplateContext.canSaveDay) return;
  saveTemplateContext.activeScope = scope;
  document.getElementById('saveTemplateScopePlan').classList.toggle('active', scope === 'plan');
  document.getElementById('saveTemplateScopeDay').classList.toggle('active', scope === 'day');
  applySaveTemplateDefaults();
  var input = document.getElementById('saveTemplateNameInput');
  setTimeout(function() { input.focus(); input.select(); }, 0);
}

function closeSaveTemplate() {
  document.getElementById('saveTemplateOverlay').classList.remove('show');
  saveTemplateContext = null;
}

async function submitSaveTemplate() {
  if (!saveTemplateContext) return;
  var input = document.getElementById('saveTemplateNameInput');
  var name = (input.value || '').trim();
  if (!name) { showToast('Template name required', null); input.focus(); return; }
  var blob = (saveTemplateContext.activeScope === 'day' && saveTemplateContext.canSaveDay)
    ? saveTemplateContext.dayBlob
    : saveTemplateContext.planBlob;
  var btn = document.getElementById('btnSaveTemplateSubmit');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await saveAsTemplate(name, blob);
    closeSaveTemplate();
    showToast('Template saved: ' + name, null);
    // If the Templates modal is open beneath this one, refresh its list.
    var templatesOverlay = document.getElementById('templatesOverlay');
    if (templatesOverlay && templatesOverlay.classList.contains('show')) {
      loadTemplatesIntoState().then(renderTemplates);
    }
  } catch(err) {
    console.error('submitSaveTemplate error:', err);
    showToast("Couldn't save template: " + (err.message || 'unknown error'), null);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

// Single hamburger entry: "Save as template". If focused on a plan day,
// the modal offers both scopes; otherwise it hides the day scope and
// defaults to whole-plan save.
function openSaveAsTemplateFromMenu() {
  if (!plan || !Array.isArray(plan.days) || !plan.days.length) {
    showToast('No active plan to save', null);
    return;
  }
  var dayBlob = null;
  var dayName = '';
  if (typeof currentDay === 'number' && currentDay >= 0 && currentDay < plan.days.length) {
    dayBlob = extractSingleDayPlan(plan, currentDay);
    dayName = (plan.days[currentDay] && plan.days[currentDay].name) || ('Day ' + (currentDay + 1));
  }
  openSaveTemplate(plan, dayBlob, dayName);
}

// Plans-modal entry: save any plan row as a template (covers historical plans).
// No day context on a non-active plan row, so this hits the single-scope path.
async function savePlanRowAsTemplate(planRowId) {
  var row = null;
  for (var i = 0; i < plansList.length; i++) {
    if (plansList[i].id === planRowId) { row = plansList[i]; break; }
  }
  if (!row) return;
  try {
    var r = await sb.from('plans').select('data, title').eq('id', planRowId).single();
    if (r.error) throw r.error;
    var blob = r.data.data || {};
    if (!blob.days || !blob.days.length) { showToast('Plan has no days to save', null); return; }
    if (!blob.title) blob.title = r.data.title || row.title || 'Template';
    openSaveTemplate(blob, null, '');
  } catch(err) {
    console.error('savePlanRowAsTemplate error:', err);
    showToast("Couldn't load plan: " + (err.message || 'unknown error'), null);
  }
}

// ---- Templates management modal ----
async function openTemplates() {
  document.getElementById('templatesOverlay').classList.add('show');
  await loadTemplatesIntoState();
  renderTemplates();
}

function closeTemplates() {
  document.getElementById('templatesOverlay').classList.remove('show');
}

async function loadTemplatesIntoState() {
  templatesLoading = true;
  renderTemplates();
  try {
    templatesList = await loadTemplates();
  } catch(err) {
    console.error('loadTemplatesIntoState error:', err);
    showToast("Couldn't load templates", null);
    templatesList = [];
  } finally {
    templatesLoading = false;
  }
}

function renderTemplates() {
  var body = document.getElementById('templatesBody');
  if (!body) return;
  if (templatesLoading) {
    body.innerHTML = '<div class="history-empty">Loading…</div>';
    return;
  }
  var hasActivePlan = !!(plan && plan.days && plan.days.length);
  var saveHint = hasActivePlan
    ? 'Save your current plan — or just the focused day — as a reusable template.'
    : 'No active plan to save. Import or generate one first.';
  var h = '';
  h += '<div class="templates-save-row">';
  h += '<button type="button" class="generate-btn-secondary" id="btnTemplatesSaveCurrent"' +
       (hasActivePlan ? '' : ' disabled') + '>+ Save current plan as template</button>';
  h += '<button type="button" class="generate-btn-secondary" id="btnTemplatesCreateNew">+ Create new template</button>';
  h += '<div class="templates-save-hint">' + escapeHtml(saveHint) + '</div>';
  h += '</div>';
  if (!templatesList.length) {
    h += '<div class="history-empty">No templates saved yet.</div>';
    body.innerHTML = h;
    return;
  }
  h += '<div class="plans-list">';
  for (var i = 0; i < templatesList.length; i++) {
    var t = templatesList[i];
    var dayLabel = t.day_count + ' day' + (t.day_count === 1 ? '' : 's');
    var dateLabel = 'Created ' + new Date(t.created_at).toLocaleDateString();
    h += '<div class="plans-row">';
    h += '<div class="plans-row-main">';
    h += '<div class="plans-row-title">' + escapeHtml(t.template_name) + '</div>';
    h += '<div class="plans-row-meta">' + dayLabel + ' · ' + escapeHtml(dateLabel) + '</div>';
    h += '</div>';
    h += '<div class="plans-row-actions">';
    h += '<button type="button" class="plans-btn view" data-view-plan-id="' + escapeAttr(t.id) + '">View</button>';
    h += '<button type="button" class="plans-btn rename" data-template-id="' + escapeAttr(t.id) + '">Rename</button>';
    h += '<button type="button" class="plans-btn activate" data-edit-template-id="' + escapeAttr(t.id) + '">Edit</button>';
    h += '<button type="button" class="plans-btn delete" data-template-id="' + escapeAttr(t.id) + '">Delete</button>';
    h += '</div>';
    h += '</div>';
  }
  h += '</div>';
  body.innerHTML = h;
}

async function onRenameTemplate(templateId) {
  var t = null;
  for (var i = 0; i < templatesList.length; i++) {
    if (templatesList[i].id === templateId) { t = templatesList[i]; break; }
  }
  if (!t) return;
  var current = t.template_name || '';
  var next = prompt('Rename template', current);
  if (next === null) return;          // user hit Cancel
  var trimmed = (next || '').trim();
  if (!trimmed) { showToast('Template name required', null); return; }
  if (trimmed === current) return;    // no change
  try {
    await renameTemplate(templateId, trimmed);
    await loadTemplatesIntoState();
    renderTemplates();
    showToast('Template renamed', null);
  } catch(err) {
    console.error('onRenameTemplate error:', err);
    showToast("Couldn't rename: " + (err.message || 'unknown error'), null);
  }
}

// ---- Template editor (Phases 2 + 3) ----
// Open clones the template's data blob into editingTemplateBlob. All
// edits mutate the clone. Save writes back via UPDATE (existing template)
// or INSERT (create-from-scratch when editingTemplateId is null). Cancel
// discards. No autosave. Per-exercise expansion state is UI-only and
// lives outside the blob.
var editingTemplateId = null;
var editingTemplateBlob = null;
var editingTemplateExpanded = {}; // "di:ei" -> true
// When true the editor renders as a static, tap-safe reference — no
// inputs, no action buttons, no drag handles. Used by the Plans and
// Templates modals' View button (mid-workout reference without any
// risk of accidental edits).
var templateEditorReadOnly = false;

async function openTemplateEditor(templateId) {
  try {
    var r = await sb.from('plans').select('data, template_name').eq('id', templateId).single();
    if (r.error) throw r.error;
    editingTemplateId = templateId;
    editingTemplateBlob = JSON.parse(JSON.stringify(r.data.data || {}));
    if (!Array.isArray(editingTemplateBlob.days)) editingTemplateBlob.days = [];
    if (!editingTemplateBlob.title) editingTemplateBlob.title = r.data.template_name || 'Template';
    editingTemplateExpanded = {};
    renderTemplateEditor();
    document.getElementById('templateEditorOverlay').classList.add('show');
  } catch(err) {
    console.error('openTemplateEditor error:', err);
    showToast("Couldn't load template: " + (err.message || 'unknown error'), null);
  }
}

// Create-from-scratch entry. Opens the editor with a blank blob seeded
// with one empty day. Save flow takes the INSERT branch since
// editingTemplateId is null.
function openTemplateEditorEmpty() {
  editingTemplateId = null;
  editingTemplateBlob = {
    title: '',
    days: [{ name: 'Day 1', exercises: [] }]
  };
  editingTemplateExpanded = {};
  renderTemplateEditor();
  document.getElementById('templateEditorOverlay').classList.add('show');
  setTimeout(function() {
    var nameEl = document.getElementById('templateEditorName');
    if (nameEl) { nameEl.focus(); nameEl.select(); }
  }, 50);
}

function closeTemplateEditor() {
  document.getElementById('templateEditorOverlay').classList.remove('show');
  editingTemplateId = null;
  editingTemplateBlob = null;
  editingTemplateExpanded = {};
  templateEditorReadOnly = false;
  applyTemplateEditorChrome();
}

// View-only entry: loads any plans row (template or active/historical
// plan) and paints the editor in readOnly mode. editingTemplateId is
// cleared so the Save path can't mis-fire; the footer hides Save and
// relabels Cancel → Close.
async function openPlanOrTemplateViewer(planRowId) {
  try {
    var r = await sb.from('plans')
      .select('data, template_name, title, is_template')
      .eq('id', planRowId).single();
    if (r.error) throw r.error;
    editingTemplateId = null;
    editingTemplateBlob = JSON.parse(JSON.stringify(r.data.data || {}));
    if (!Array.isArray(editingTemplateBlob.days)) editingTemplateBlob.days = [];
    if (!editingTemplateBlob.title) {
      editingTemplateBlob.title = r.data.template_name || r.data.title || (r.data.is_template ? 'Template' : 'Plan');
    }
    editingTemplateExpanded = {};
    templateEditorReadOnly = true;
    applyTemplateEditorChrome(r.data.is_template ? 'template' : 'plan');
    renderTemplateEditor();
    document.getElementById('templateEditorOverlay').classList.add('show');
  } catch(err) {
    console.error('openPlanOrTemplateViewer error:', err);
    showToast("Couldn't load: " + (err.message || 'unknown error'), null);
  }
}

// Adjust modal header + footer for the current mode. Called on open
// (edit, empty, view) and close. `kind` only matters in view mode
// ('plan' vs 'template') to tune the title wording.
function applyTemplateEditorChrome(kind) {
  var titleEl = document.querySelector('#templateEditorOverlay .history-title');
  var saveBtn = document.getElementById('btnTemplateEditorSave');
  var cancelBtn = document.getElementById('btnTemplateEditorCancel');
  if (templateEditorReadOnly) {
    if (titleEl) titleEl.textContent = kind === 'plan' ? 'View plan' : 'View template';
    if (saveBtn) saveBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.textContent = 'Close';
  } else {
    if (titleEl) titleEl.textContent = 'Edit template';
    if (saveBtn) saveBtn.style.display = '';
    if (cancelBtn) cancelBtn.textContent = 'Cancel';
  }
}

function renderTemplateEditor() {
  var body = document.getElementById('templateEditorBody');
  if (!body || !editingTemplateBlob) return;
  var blob = editingTemplateBlob;
  var ro = templateEditorReadOnly;
  var h = '';
  h += '<div class="template-editor-name">';
  h += '<span class="template-editor-name-label">' + (ro ? 'Name' : 'Template name') + '</span>';
  if (ro) {
    h += '<div class="template-editor-name-static">' + escapeHtml(blob.title || 'Untitled') + '</div>';
  } else {
    h += '<input type="text" id="templateEditorName" value="' + escapeAttr(blob.title || '') + '" placeholder="Template name">';
  }
  h += '</div>';
  var days = Array.isArray(blob.days) ? blob.days : [];
  for (var di = 0; di < days.length; di++) {
    var d = days[di];
    var exs = Array.isArray(d.exercises) ? d.exercises : [];
    h += '<div class="template-editor-day">';
    h += '<div class="template-editor-day-header">';
    if (ro) {
      h += '<div class="template-editor-day-name">' + escapeHtml(d.name || 'Day ' + (di + 1)) + '</div>';
    } else {
      h += '<button type="button" class="template-editor-day-name-btn" data-rename-day="' + di + '">' +
           escapeHtml(d.name || 'Day ' + (di + 1)) + '</button>';
    }
    h += '<div class="template-editor-day-right">';
    h += '<div class="template-editor-day-meta">' + exs.length + ' ex</div>';
    if (!ro) {
      h += '<button type="button" class="template-editor-day-remove" data-remove-day="' + di + '" aria-label="Remove day">✕</button>';
    }
    h += '</div>';
    h += '</div>';
    h += '<div class="template-editor-ex-list" data-day-idx="' + di + '">';
    for (var ei = 0; ei < exs.length; ei++) {
      h += renderTemplateEditorExercise(exs[ei], di, ei);
    }
    h += '</div>';
    if (!ro) {
      h += '<div class="template-editor-add-row">';
      h += '<button type="button" class="template-editor-add-btn" data-add-day="' + di + '">+ Add exercise</button>';
      h += '</div>';
    }
    h += '</div>';
  }
  if (!ro) {
    h += '<div class="template-editor-adddays-row">';
    h += '<button type="button" class="template-editor-add-btn" id="btnTemplateEditorAddDay">+ Add day</button>';
    h += '</div>';
  }
  body.innerHTML = h;
  if (!ro) initTemplateEditorDrag();
}

function renderTemplateEditorExercise(ex, di, ei) {
  var sets = Array.isArray(ex.sets) ? ex.sets : [];
  var setCount = sets.length;
  var first = sets[0] || {};
  var repsStr = first.reps_range || (first.reps_target != null ? String(first.reps_target) : '?');
  var weightPart = (first.weight != null && first.weight !== 0) ? ' @' + first.weight : '';
  var meta = setCount + ' × ' + repsStr + weightPart;
  var ro = templateEditorReadOnly;
  // In view mode every exercise is always expanded — this is a reference
  // surface. No chevron to collapse.
  var expanded = ro ? true : !!editingTemplateExpanded[di + ':' + ei];
  var h = '';
  h += '<div class="template-editor-ex' + (ro ? ' readonly' : '') + '" data-di="' + di + '" data-ei="' + ei + '">';
  h += '<div class="template-editor-ex-row">';
  h += '<div class="template-editor-ex-main">';
  h += '<div class="template-editor-ex-name">' + escapeHtml(ex.name || '—') + '</div>';
  h += '<div class="template-editor-ex-meta">' + escapeHtml(meta) + '</div>';
  h += '</div>';
  if (!ro) {
    h += '<div class="template-editor-ex-actions">';
    h += '<button type="button" class="template-editor-ex-btn expand" data-expand-di="' + di + '" data-expand-ei="' + ei + '" aria-label="' + (expanded ? 'Collapse' : 'Expand') + '">' + (expanded ? '▴' : '▾') + '</button>';
    h += '<button type="button" class="template-editor-ex-btn swap" data-swap-di="' + di + '" data-swap-ei="' + ei + '">Swap</button>';
    h += '<button type="button" class="template-editor-ex-btn remove" data-remove-di="' + di + '" data-remove-ei="' + ei + '" aria-label="Remove">✕</button>';
    h += '</div>';
  }
  h += '</div>';
  if (expanded) {
    h += ro
      ? renderTemplateEditorExerciseReadOnly(ex, sets)
      : renderTemplateEditorExerciseExpanded(ex, di, ei, sets);
  }
  h += '</div>';
  return h;
}

function renderTemplateEditorExerciseReadOnly(ex, sets) {
  var h = '<div class="template-editor-ex-form template-editor-ex-view">';
  if (ex.rest != null && ex.rest !== '') {
    h += '<div class="template-editor-view-meta"><span class="template-editor-view-label">Rest</span><span>' + escapeHtml(String(ex.rest)) + 's</span></div>';
  }
  if (ex.note) {
    h += '<div class="template-editor-view-meta"><span class="template-editor-view-label">Note</span><span>' + escapeHtml(ex.note) + '</span></div>';
  }
  h += '<div class="template-editor-view-sets">';
  h += '<div class="template-editor-view-sets-header"><span></span><span>Weight</span><span>Reps</span><span>Range</span></div>';
  for (var si = 0; si < sets.length; si++) {
    var s = sets[si];
    var w = (s.weight != null && s.weight !== 0) ? String(s.weight) : '—';
    var rt = s.reps_target != null ? String(s.reps_target) : '—';
    var rr = s.reps_range || '—';
    h += '<div class="template-editor-view-set-row">';
    h += '<span class="template-editor-set-label">S' + (si + 1) + '</span>';
    h += '<span>' + escapeHtml(w) + '</span>';
    h += '<span>' + escapeHtml(rt) + '</span>';
    h += '<span>' + escapeHtml(rr) + '</span>';
    h += '</div>';
  }
  h += '</div>';
  h += '</div>';
  return h;
}

function renderTemplateEditorExerciseExpanded(ex, di, ei, sets) {
  var rest = ex.rest != null ? ex.rest : '';
  var note = ex.note || '';
  var h = '<div class="template-editor-ex-form">';
  h += '<div class="template-editor-ex-field">';
  h += '<label>Rest (sec)</label>';
  h += '<input type="number" inputmode="numeric" min="0" step="5" value="' + escapeAttr(String(rest)) +
       '" data-field="rest" data-di="' + di + '" data-ei="' + ei + '">';
  h += '</div>';
  h += '<div class="template-editor-ex-field">';
  h += '<label>Note (optional)</label>';
  h += '<input type="text" value="' + escapeAttr(note) + '" placeholder="e.g. slow eccentric, grip close"' +
       ' data-field="note" data-di="' + di + '" data-ei="' + ei + '">';
  h += '</div>';
  h += '<div class="template-editor-sets">';
  h += '<div class="template-editor-sets-header"><span></span><span>Weight</span><span>Reps</span><span>Range</span><span></span></div>';
  for (var si = 0; si < sets.length; si++) {
    var s = sets[si];
    h += '<div class="template-editor-set-row">';
    h += '<span class="template-editor-set-label">S' + (si + 1) + '</span>';
    h += '<input type="number" inputmode="decimal" step="0.5" min="0" value="' +
         escapeAttr(s.weight != null ? String(s.weight) : '') + '" placeholder="0"' +
         ' data-set-field="weight" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '">';
    h += '<input type="number" inputmode="numeric" step="1" min="0" value="' +
         escapeAttr(s.reps_target != null ? String(s.reps_target) : '') + '" placeholder="—"' +
         ' data-set-field="reps_target" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '">';
    h += '<input type="text" value="' + escapeAttr(s.reps_range || '') + '" placeholder="8-12"' +
         ' data-set-field="reps_range" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '">';
    h += '<button type="button" class="template-editor-set-remove"' +
         ' data-remove-set-di="' + di + '" data-remove-set-ei="' + ei + '" data-remove-set-si="' + si + '"' +
         ' aria-label="Remove set">×</button>';
    h += '</div>';
  }
  h += '<button type="button" class="template-editor-addset-btn"' +
       ' data-add-set-di="' + di + '" data-add-set-ei="' + ei + '">+ Add set</button>';
  h += '</div>';
  h += '</div>';
  return h;
}

function initTemplateEditorDrag() {
  if (typeof Sortable === 'undefined') return;
  var lists = document.querySelectorAll('#templateEditorBody .template-editor-ex-list');
  for (var i = 0; i < lists.length; i++) {
    Sortable.create(lists[i], {
      animation: 150,
      delay: 200,
      delayOnTouchOnly: true,
      filter: 'button, input',
      preventOnFilter: false,
      onEnd: function(evt) {
        if (evt.oldIndex === evt.newIndex) return;
        var di = parseInt(evt.to.getAttribute('data-day-idx'), 10);
        if (isNaN(di) || !editingTemplateBlob || !editingTemplateBlob.days[di]) return;
        syncTemplateEditorNameInput();
        var exs = editingTemplateBlob.days[di].exercises;
        var moved = exs.splice(evt.oldIndex, 1)[0];
        exs.splice(evt.newIndex, 0, moved);
        renderTemplateEditor();
      },
    });
  }
}

function onTemplateEditorRemove(di, ei) {
  if (!editingTemplateBlob || !editingTemplateBlob.days[di]) return;
  var exs = editingTemplateBlob.days[di].exercises;
  if (!exs || !exs[ei]) return;
  // Capture the current name field before re-render so the user's in-
  // progress rename isn't silently reverted to the stored title.
  syncTemplateEditorNameInput();
  exs.splice(ei, 1);
  renderTemplateEditor();
}

function onTemplateEditorSwap(di, ei) {
  if (!editingTemplateBlob || !editingTemplateBlob.days[di]) return;
  var exs = editingTemplateBlob.days[di].exercises;
  if (!exs || !exs[ei]) return;
  syncTemplateEditorNameInput();
  openPicker(function(libRow) {
    if (!libRow) return;
    exs[ei].name = libRow.name;
    closePicker();
    renderTemplateEditor();
  });
}

function onTemplateEditorAdd(di) {
  if (!editingTemplateBlob || !editingTemplateBlob.days[di]) return;
  syncTemplateEditorNameInput();
  openPicker(function(libRow) {
    if (!libRow) return;
    var newEx = {
      name: libRow.name,
      rest: 120,
      sets: [
        { weight: 0, reps_target: 10, reps_range: '8-12' },
        { weight: 0, reps_target: 10, reps_range: '8-12' },
        { weight: 0, reps_target: 10, reps_range: '8-12' }
      ]
    };
    editingTemplateBlob.days[di].exercises.push(newEx);
    closePicker();
    renderTemplateEditor();
  });
}

// Pull the current value out of the name input into editingTemplateBlob
// before a re-render. Re-render blows away the input element and would
// otherwise lose in-progress typing.
function syncTemplateEditorNameInput() {
  var el = document.getElementById('templateEditorName');
  if (el && editingTemplateBlob) editingTemplateBlob.title = el.value || '';
}

// ---- Day operations ----
function onTemplateEditorAddDay() {
  if (!editingTemplateBlob) return;
  syncTemplateEditorNameInput();
  if (!Array.isArray(editingTemplateBlob.days)) editingTemplateBlob.days = [];
  var n = editingTemplateBlob.days.length + 1;
  editingTemplateBlob.days.push({ name: 'Day ' + n, exercises: [] });
  renderTemplateEditor();
}

function onTemplateEditorRemoveDay(di) {
  if (!editingTemplateBlob || !editingTemplateBlob.days[di]) return;
  var dayName = editingTemplateBlob.days[di].name || ('Day ' + (di + 1));
  if (!confirm('Remove "' + dayName + '" and all its exercises?')) return;
  syncTemplateEditorNameInput();
  editingTemplateBlob.days.splice(di, 1);
  // Indices shift after a splice; drop all expansion state rather than
  // try to rekey. Minor UX cost (re-expand what you were viewing).
  editingTemplateExpanded = {};
  renderTemplateEditor();
}

function onTemplateEditorRenameDay(di) {
  if (!editingTemplateBlob || !editingTemplateBlob.days[di]) return;
  var current = editingTemplateBlob.days[di].name || '';
  var next = prompt('Rename day', current);
  if (next === null) return;
  var trimmed = (next || '').trim();
  if (!trimmed) { showToast('Day name required', null); return; }
  if (trimmed === current) return;
  syncTemplateEditorNameInput();
  editingTemplateBlob.days[di].name = trimmed;
  renderTemplateEditor();
}

// ---- Set operations ----
function onTemplateEditorToggleExpand(di, ei) {
  var key = di + ':' + ei;
  if (editingTemplateExpanded[key]) delete editingTemplateExpanded[key];
  else editingTemplateExpanded[key] = true;
  renderTemplateEditor();
}

function onTemplateEditorAddSet(di, ei) {
  if (!editingTemplateBlob || !editingTemplateBlob.days[di]) return;
  var ex = editingTemplateBlob.days[di].exercises[ei];
  if (!ex) return;
  if (!Array.isArray(ex.sets)) ex.sets = [];
  // Duplicate the last set when present so progressive add is quick; else
  // fall back to a neutral default that matches the add-exercise path.
  var last = ex.sets[ex.sets.length - 1];
  var newSet = last
    ? { weight: last.weight, reps_target: last.reps_target, reps_range: last.reps_range }
    : { weight: 0, reps_target: 10, reps_range: '8-12' };
  ex.sets.push(newSet);
  renderTemplateEditor();
}

function onTemplateEditorRemoveSet(di, ei, si) {
  if (!editingTemplateBlob || !editingTemplateBlob.days[di]) return;
  var ex = editingTemplateBlob.days[di].exercises[ei];
  if (!ex || !Array.isArray(ex.sets) || !ex.sets[si]) return;
  if (ex.sets.length <= 1) {
    showToast('Each exercise needs at least one set', null);
    return;
  }
  ex.sets.splice(si, 1);
  renderTemplateEditor();
}

// Centralized change handler for inline inputs (rest, note, per-set
// weight/reps/range). Keeps the render function idempotent — edits flow
// to the blob on blur/enter, no re-render required.
function onTemplateEditorInputChange(target) {
  if (!target || !editingTemplateBlob) return;
  var field = target.getAttribute('data-field');
  if (field) {
    var di = parseInt(target.getAttribute('data-di'), 10);
    var ei = parseInt(target.getAttribute('data-ei'), 10);
    if (isNaN(di) || isNaN(ei)) return;
    var ex = editingTemplateBlob.days[di] && editingTemplateBlob.days[di].exercises[ei];
    if (!ex) return;
    if (field === 'rest') {
      var r = parseInt(target.value, 10);
      ex.rest = isNaN(r) ? null : r;
    } else if (field === 'note') {
      var n = (target.value || '').trim();
      if (n) ex.note = n; else delete ex.note;
    }
    return;
  }
  var setField = target.getAttribute('data-set-field');
  if (setField) {
    var sdi = parseInt(target.getAttribute('data-di'), 10);
    var sei = parseInt(target.getAttribute('data-ei'), 10);
    var ssi = parseInt(target.getAttribute('data-si'), 10);
    if (isNaN(sdi) || isNaN(sei) || isNaN(ssi)) return;
    var sets = editingTemplateBlob.days[sdi] &&
               editingTemplateBlob.days[sdi].exercises[sei] &&
               editingTemplateBlob.days[sdi].exercises[sei].sets;
    if (!sets || !sets[ssi]) return;
    var s = sets[ssi];
    if (setField === 'weight') {
      var w = parseFloat(target.value);
      s.weight = isNaN(w) ? 0 : w;
    } else if (setField === 'reps_target') {
      var rt = parseInt(target.value, 10);
      s.reps_target = isNaN(rt) ? null : rt;
    } else if (setField === 'reps_range') {
      var rr = (target.value || '').trim();
      if (rr) s.reps_range = rr; else delete s.reps_range;
    }
  }
}

async function saveTemplateEdits() {
  if (!editingTemplateBlob) return;
  syncTemplateEditorNameInput();
  var name = (editingTemplateBlob.title || '').trim();
  if (!name) {
    showToast('Template name required', null);
    var el = document.getElementById('templateEditorName'); if (el) el.focus();
    return;
  }
  // Shape validation: prevent saving a malformed template that would
  // misbehave on later use (createAdHocFromTemplate + start-screen
  // picker both assume non-empty days).
  var days = Array.isArray(editingTemplateBlob.days) ? editingTemplateBlob.days : [];
  if (!days.length) {
    showToast('Template needs at least one day', null);
    return;
  }
  for (var di = 0; di < days.length; di++) {
    var exs = Array.isArray(days[di].exercises) ? days[di].exercises : [];
    if (!exs.length) {
      showToast((days[di].name || 'Day ' + (di + 1)) + ' is empty — add an exercise or remove the day', null);
      return;
    }
  }
  editingTemplateBlob.title = name;
  var btn = document.getElementById('btnTemplateEditorSave');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    if (editingTemplateId) {
      // Existing template → update in place.
      var r = await sb.from('plans').update({
        template_name: name,
        title: name,
        data: editingTemplateBlob
      }).eq('id', editingTemplateId);
      if (r.error) throw new Error(r.error.message);
    } else {
      // Create-from-scratch → new plans row.
      await saveAsTemplate(name, editingTemplateBlob);
    }
    closeTemplateEditor();
    await loadTemplatesIntoState();
    renderTemplates();
    showToast('Template saved', null);
  } catch(err) {
    console.error('saveTemplateEdits error:', err);
    showToast("Couldn't save: " + (err.message || 'unknown error'), null);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
  }
}

// ---- Add-from-template picker ----
// Mid-session flow: pick exercises from a saved template and add them
// to the current session as extras. Each selected exercise comes in
// with its template set schemes preserved (count + weight pre-filled;
// reps left empty for in-session logging). Only callable when the
// current session view is editable.
var atfTemplates = [];             // loaded template list (reuses loadTemplates result)
var atfSelectedTemplateId = null;  // currently-chosen template row id
var atfSelectedDayIdx = 0;         // currently-chosen day within that template
var atfCheckedIdx = {};            // { exerciseIndexInDay: true } within the current day

async function openAddFromTemplate() {
  if (viewModeFor(currentDay) !== 'editable') {
    showToast('Current session is read-only', null);
    return;
  }
  // Reset state. Load templates fresh each time so new templates saved
  // earlier this session show up.
  atfTemplates = [];
  atfSelectedTemplateId = null;
  atfSelectedDayIdx = 0;
  atfCheckedIdx = {};
  document.getElementById('addFromTemplateOverlay').classList.add('show');
  var body = document.getElementById('addFromTemplateBody');
  body.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    atfTemplates = await loadTemplates();
  } catch(err) {
    console.error('openAddFromTemplate load error:', err);
    atfTemplates = [];
  }
  if (!atfTemplates.length) {
    body.innerHTML = '<div class="history-empty">No templates saved yet.<br>Create one via Templates in the hamburger menu.</div>';
    document.getElementById('btnAddFromTemplateSubmit').disabled = true;
    return;
  }
  atfSelectedTemplateId = atfTemplates[0].id;
  atfSelectedDayIdx = 0;
  renderAddFromTemplate();
}

function closeAddFromTemplate() {
  document.getElementById('addFromTemplateOverlay').classList.remove('show');
  atfTemplates = [];
  atfSelectedTemplateId = null;
  atfCheckedIdx = {};
  var submitBtn = document.getElementById('btnAddFromTemplateSubmit');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add selected'; }
}

function atfCurrentTemplate() {
  for (var i = 0; i < atfTemplates.length; i++) {
    if (atfTemplates[i].id === atfSelectedTemplateId) return atfTemplates[i];
  }
  return null;
}

function atfCurrentDay() {
  var t = atfCurrentTemplate();
  if (!t) return null;
  var days = (t.data && Array.isArray(t.data.days)) ? t.data.days : [];
  return days[atfSelectedDayIdx] || null;
}

function renderAddFromTemplate() {
  var body = document.getElementById('addFromTemplateBody');
  if (!body) return;
  var t = atfCurrentTemplate();
  if (!t) return;
  var days = (t.data && Array.isArray(t.data.days)) ? t.data.days : [];
  var day = days[atfSelectedDayIdx];
  var exs = day && Array.isArray(day.exercises) ? day.exercises : [];

  var h = '';
  // Selectors
  h += '<div class="atf-picker-selectors">';
  h += '<div class="atf-picker-field">';
  h += '<label>Template</label>';
  h += '<select id="atfTemplateSelect">';
  for (var i = 0; i < atfTemplates.length; i++) {
    var tt = atfTemplates[i];
    h += '<option value="' + escapeAttr(tt.id) + '"' + (tt.id === atfSelectedTemplateId ? ' selected' : '') + '>' +
         escapeHtml(tt.template_name || tt.title || 'Untitled') + '</option>';
  }
  h += '</select>';
  h += '</div>';
  // Day selector (only if multi-day)
  if (days.length > 1) {
    h += '<div class="atf-picker-field">';
    h += '<label>Day</label>';
    h += '<select id="atfDaySelect">';
    for (var di = 0; di < days.length; di++) {
      var dn = days[di].name || ('Day ' + (di + 1));
      h += '<option value="' + di + '"' + (di === atfSelectedDayIdx ? ' selected' : '') + '>' +
           escapeHtml(dn) + '</option>';
    }
    h += '</select>';
    h += '</div>';
  }
  h += '</div>';

  // Select-all row + count
  var resolvedCount = 0;
  for (var c = 0; c < exs.length; c++) {
    if (exs[c] && exs[c].name && resolveLibraryRow(exs[c].name)) resolvedCount++;
  }
  var checkedCount = 0;
  for (var k in atfCheckedIdx) { if (atfCheckedIdx[k]) checkedCount++; }
  h += '<div class="atf-select-all-row">';
  h += '<span>' + exs.length + ' exercise' + (exs.length === 1 ? '' : 's') +
       (resolvedCount < exs.length ? ' (' + (exs.length - resolvedCount) + ' unavailable)' : '') +
       '</span>';
  h += '<button type="button" class="atf-select-all-btn" id="atfSelectAllBtn">' +
       (checkedCount === resolvedCount && resolvedCount > 0 ? 'Clear all' : 'Select all') + '</button>';
  h += '</div>';

  // Exercise list
  h += '<div class="atf-ex-list">';
  if (!exs.length) {
    h += '<div class="history-empty">This day has no exercises.</div>';
  } else {
    for (var ei = 0; ei < exs.length; ei++) {
      var ex = exs[ei];
      var resolvable = !!(ex && ex.name && resolveLibraryRow(ex.name));
      var checked = !!atfCheckedIdx[ei];
      var sets = Array.isArray(ex.sets) ? ex.sets : [];
      var first = sets[0] || {};
      var reps = first.reps_range || (first.reps_target != null ? String(first.reps_target) : '?');
      var weight = (first.weight != null && first.weight !== 0) ? ' @' + first.weight : '';
      var meta = sets.length + ' × ' + reps + weight;
      h += '<div class="atf-ex-row' + (checked ? ' checked' : '') + (resolvable ? '' : ' unresolved') +
           '" data-atf-idx="' + ei + '">';
      h += '<div class="atf-ex-check"></div>';
      h += '<div class="atf-ex-main">';
      h += '<div class="atf-ex-name">' + escapeHtml(ex.name || '—') +
           (resolvable ? '' : '<span class="atf-ex-unresolved-tag">not in library</span>') + '</div>';
      h += '<div class="atf-ex-meta">' + escapeHtml(meta) + '</div>';
      h += '</div>';
      h += '</div>';
    }
  }
  h += '</div>';

  body.innerHTML = h;

  // Update submit button state + label
  var submitBtn = document.getElementById('btnAddFromTemplateSubmit');
  if (submitBtn) {
    submitBtn.disabled = checkedCount === 0;
    submitBtn.textContent = checkedCount
      ? 'Add ' + checkedCount + ' exercise' + (checkedCount === 1 ? '' : 's')
      : 'Add selected';
  }
}

function onAtfTemplateChange(newId) {
  atfSelectedTemplateId = newId;
  atfSelectedDayIdx = 0;
  atfCheckedIdx = {};
  renderAddFromTemplate();
}

function onAtfDayChange(newIdx) {
  atfSelectedDayIdx = parseInt(newIdx, 10) || 0;
  atfCheckedIdx = {};
  renderAddFromTemplate();
}

function onAtfToggle(idx) {
  var day = atfCurrentDay();
  if (!day) return;
  var exs = Array.isArray(day.exercises) ? day.exercises : [];
  var ex = exs[idx];
  if (!ex || !resolveLibraryRow(ex.name)) return;  // unresolved rows don't toggle
  if (atfCheckedIdx[idx]) delete atfCheckedIdx[idx];
  else atfCheckedIdx[idx] = true;
  renderAddFromTemplate();
}

function onAtfSelectAll() {
  var day = atfCurrentDay();
  if (!day) return;
  var exs = Array.isArray(day.exercises) ? day.exercises : [];
  // Count resolvable + currently-checked resolvables to decide toggle direction.
  var resolvableIdx = [];
  for (var i = 0; i < exs.length; i++) {
    if (exs[i] && exs[i].name && resolveLibraryRow(exs[i].name)) resolvableIdx.push(i);
  }
  var allChecked = resolvableIdx.every(function(i) { return atfCheckedIdx[i]; });
  atfCheckedIdx = {};
  if (!allChecked) {
    resolvableIdx.forEach(function(i) { atfCheckedIdx[i] = true; });
  }
  renderAddFromTemplate();
}

function onAtfSubmit() {
  var day = atfCurrentDay();
  if (!day) return;
  var exs = Array.isArray(day.exercises) ? day.exercises : [];
  var toAdd = [];
  for (var i = 0; i < exs.length; i++) {
    if (atfCheckedIdx[i]) toAdd.push(exs[i]);
  }
  if (!toAdd.length) return;
  var added = 0, skipped = 0;
  for (var j = 0; j < toAdd.length; j++) {
    var ex = toAdd[j];
    var libRow = resolveLibraryRow(ex.name);
    if (!libRow) { skipped++; continue; }
    addTemplateExerciseToSession(libRow, ex);
    added++;
  }
  closeAddFromTemplate();
  var msg = 'Added ' + added + ' exercise' + (added === 1 ? '' : 's');
  if (skipped) msg += ' · ' + skipped + ' skipped (not in library)';
  showToast(msg, null);
}

async function onDeleteTemplate(templateId) {
  var t = null;
  for (var i = 0; i < templatesList.length; i++) {
    if (templatesList[i].id === templateId) { t = templatesList[i]; break; }
  }
  if (!t) return;
  if (!confirm('Delete template "' + t.template_name + '"? This cannot be undone.')) return;
  try {
    await deleteTemplate(templateId);
    await loadTemplatesIntoState();
    renderTemplates();
    showToast('Template deleted', null);
  } catch(err) {
    console.error('onDeleteTemplate error:', err);
    showToast("Couldn't delete template: " + (err.message || 'unknown error'), null);
  }
}

// ---- Start-screen template picker (4th card in the start-session modal) ----
async function loadStartScreenTemplates() {
  var list = document.getElementById('startPathTemplateList');
  list.innerHTML = '<div class="start-template-empty">Loading…</div>';
  try {
    startScreenTemplatesList = await loadTemplates();
  } catch(err) {
    console.error('loadStartScreenTemplates error:', err);
    startScreenTemplatesList = [];
    showToast("Couldn't load templates", null);
  }
  renderStartScreenTemplates();
}

function renderStartScreenTemplates() {
  var list = document.getElementById('startPathTemplateList');
  list.innerHTML = '';
  if (!startScreenTemplatesList.length) {
    var empty = document.createElement('div');
    empty.className = 'start-template-empty';
    empty.textContent = 'No templates saved yet. Use the hamburger menu to save one.';
    list.appendChild(empty);
    return;
  }
  for (var i = 0; i < startScreenTemplatesList.length; i++) {
    var t = startScreenTemplatesList[i];
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'start-day-row';
    row.setAttribute('data-template-id', t.id);
    row.innerHTML =
      '<span>' + escapeHtml(t.template_name) + '</span>' +
      '<span class="start-day-row-meta">' + t.day_count + ' day' + (t.day_count === 1 ? '' : 's') + '</span>';
    list.appendChild(row);
  }
}

function renderStartScreenTemplateDays(template, container) {
  container.innerHTML = '';
  var days = template.days || [];
  for (var i = 0; i < days.length; i++) {
    var d = days[i] || {};
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'start-day-row';
    row.setAttribute('data-template-id', template.id);
    row.setAttribute('data-day-index', String(i));
    row.textContent = d.name || ('Day ' + (i + 1));
    container.appendChild(row);
  }
}

async function onPickStartScreenTemplate(templateId, dayIndexAttr) {
  var t = null;
  for (var i = 0; i < startScreenTemplatesList.length; i++) {
    if (startScreenTemplatesList[i].id === templateId) { t = startScreenTemplatesList[i]; break; }
  }
  if (!t) return;

  // Explicit day pick (multi-day template, user tapped a specific day).
  if (dayIndexAttr != null) {
    var di = parseInt(dayIndexAttr, 10);
    closeStartScreen();
    await createAdHocFromTemplate(t, isNaN(di) ? 0 : di);
    return;
  }

  // Single-day templates skip the day-sub-list.
  if (t.day_count === 1) {
    closeStartScreen();
    await createAdHocFromTemplate(t, 0);
    return;
  }

  // Multi-day templates expand to show day sub-list inline. Toggle if already open.
  var list = document.getElementById('startPathTemplateList');
  var row = list.querySelector('.start-day-row[data-template-id="' + templateId + '"]:not([data-day-index])');
  if (!row) return;
  var sibling = row.nextElementSibling;
  if (sibling && sibling.classList && sibling.classList.contains('start-template-days')) {
    sibling.remove();
    return;
  }
  var container = document.createElement('div');
  container.className = 'start-template-days';
  renderStartScreenTemplateDays(t, container);
  row.parentNode.insertBefore(container, row.nextSibling);
}

// ---- Resume-session prompt ----
// When the user attempts to log more work (add set, add exercise, check a
// set done) on a session that's already been completed (endedAt set), this
// modal asks whether to resume the session timer first. Reuses the same
// gap-into-paused_ms math as the manual Resume button by delegating to
// resumeSession(). The "Just log it" choice sets a per-session in-memory
// suppress flag so the prompt doesn't re-fire for the same workoutId — a
// natural ad-hoc decision that resets on next app load. An explicit Resume
// (modal or session-bar button) clears the flag — if the user later
// completes again and adds more, they'll be prompted again.
var __resumePromptAction = null;
function promptResumeIfEnded(actionFn) {
  var st = todayState;
  if (!st || !st.workoutId || !st.endedAt || st.suppressResumePrompt) {
    actionFn();
    return;
  }
  __resumePromptAction = actionFn;
  var endedTime = new Date(st.endedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  document.getElementById('resumePromptEndedAt').textContent = endedTime;
  document.getElementById('resumePromptOverlay').classList.add('show');
}
function closeResumePrompt() {
  document.getElementById('resumePromptOverlay').classList.remove('show');
  __resumePromptAction = null;
}
async function onResumePromptResume() {
  document.getElementById('resumePromptOverlay').classList.remove('show');
  var fn = __resumePromptAction;
  __resumePromptAction = null;
  // resumeSession() flips endedAt → null and rolls the gap into paused_ms.
  // It also clears suppressResumePrompt so a later Complete + add cycle re-prompts.
  await resumeSession();
  if (fn) fn();
}
function onResumePromptJustLog() {
  document.getElementById('resumePromptOverlay').classList.remove('show');
  if (todayState) todayState.suppressResumePrompt = true;
  var fn = __resumePromptAction;
  __resumePromptAction = null;
  if (fn) fn();
}
function onResumePromptCancel() {
  closeResumePrompt();
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
  // Explicit close affordance. stopPropagation so tapping × on a retry
  // toast dismisses without firing the retry callback — the body remains
  // tappable for the retry action itself.
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    dismissToast(id);
  });
  el.appendChild(closeBtn);
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
      .select('*, sets(*, exercises!exercise_id(name, equipment, muscle_group, weight_mode))')
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
document.getElementById('menuCoachingProfile').addEventListener('click', function() {
  closeMenu();
  openCoachingProfile();
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
document.getElementById('menuTemplates').addEventListener('click', function() {
  closeMenu();
  openTemplates();
});

// Templates management modal.
document.getElementById('btnTemplatesClose').addEventListener('click', closeTemplates);
document.getElementById('templatesOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeTemplates();
});
document.getElementById('templatesBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  var saveBtn = e.target.closest('#btnTemplatesSaveCurrent');
  if (saveBtn && !saveBtn.disabled) {
    openSaveAsTemplateFromMenu();
    return;
  }
  var createBtn = e.target.closest('#btnTemplatesCreateNew');
  if (createBtn && !createBtn.disabled) {
    openTemplateEditorEmpty();
    return;
  }
  var viewBtn = e.target.closest('.plans-btn[data-view-plan-id]');
  if (viewBtn && !viewBtn.disabled) {
    var vid = viewBtn.getAttribute('data-view-plan-id');
    if (vid) openPlanOrTemplateViewer(vid);
    return;
  }
  var renameBtn = e.target.closest('.plans-btn.rename');
  if (renameBtn && !renameBtn.disabled) {
    var rid = renameBtn.getAttribute('data-template-id');
    if (rid) onRenameTemplate(rid);
    return;
  }
  var editBtn = e.target.closest('.plans-btn[data-edit-template-id]');
  if (editBtn && !editBtn.disabled) {
    var eid = editBtn.getAttribute('data-edit-template-id');
    if (eid) openTemplateEditor(eid);
    return;
  }
  var deleteBtn = e.target.closest('.plans-btn.delete');
  if (!deleteBtn || deleteBtn.disabled) return;
  var tid = deleteBtn.getAttribute('data-template-id');
  if (tid) onDeleteTemplate(tid);
});

// Save-template modal (used for plan, day, and historical-plan saves).
document.getElementById('btnSaveTemplateClose').addEventListener('click', closeSaveTemplate);
document.getElementById('btnSaveTemplateCancel').addEventListener('click', closeSaveTemplate);
document.getElementById('btnSaveTemplateSubmit').addEventListener('click', submitSaveTemplate);

// Add-from-template picker (mid-session exercise import from a template).
document.getElementById('btnAddFromTemplateClose').addEventListener('click', closeAddFromTemplate);
document.getElementById('btnAddFromTemplateCancel').addEventListener('click', closeAddFromTemplate);
document.getElementById('btnAddFromTemplateSubmit').addEventListener('click', onAtfSubmit);
document.getElementById('addFromTemplateOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeAddFromTemplate();
});
document.getElementById('addFromTemplateBody').addEventListener('change', function(e) {
  if (!e.target) return;
  if (e.target.id === 'atfTemplateSelect') { onAtfTemplateChange(e.target.value); return; }
  if (e.target.id === 'atfDaySelect') { onAtfDayChange(e.target.value); return; }
});
document.getElementById('addFromTemplateBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest('#atfSelectAllBtn')) { onAtfSelectAll(); return; }
  var row = e.target.closest('.atf-ex-row');
  if (row) {
    var idx = parseInt(row.getAttribute('data-atf-idx'), 10);
    if (!isNaN(idx)) onAtfToggle(idx);
  }
});

// Template editor (Phase 2): inline rename + exercise-level edits.
document.getElementById('btnTemplateEditorClose').addEventListener('click', closeTemplateEditor);
document.getElementById('btnTemplateEditorCancel').addEventListener('click', closeTemplateEditor);
document.getElementById('btnTemplateEditorSave').addEventListener('click', saveTemplateEdits);
document.getElementById('templateEditorOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeTemplateEditor();
});
document.getElementById('templateEditorBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  // Add-day footer button (bottom of all days)
  if (e.target.closest('#btnTemplateEditorAddDay')) {
    onTemplateEditorAddDay();
    return;
  }
  // Day-level: rename / remove
  var renameDayBtn = e.target.closest('[data-rename-day]');
  if (renameDayBtn) {
    var rdn = parseInt(renameDayBtn.getAttribute('data-rename-day'), 10);
    if (!isNaN(rdn)) onTemplateEditorRenameDay(rdn);
    return;
  }
  var removeDayBtn = e.target.closest('[data-remove-day]');
  if (removeDayBtn) {
    var rdd = parseInt(removeDayBtn.getAttribute('data-remove-day'), 10);
    if (!isNaN(rdd)) onTemplateEditorRemoveDay(rdd);
    return;
  }
  // Exercise-level: expand / swap / remove
  var expandBtn = e.target.closest('[data-expand-ei]');
  if (expandBtn) {
    var xdi = parseInt(expandBtn.getAttribute('data-expand-di'), 10);
    var xei = parseInt(expandBtn.getAttribute('data-expand-ei'), 10);
    if (!isNaN(xdi) && !isNaN(xei)) onTemplateEditorToggleExpand(xdi, xei);
    return;
  }
  var addBtn = e.target.closest('[data-add-day]');
  if (addBtn) {
    var adi = parseInt(addBtn.getAttribute('data-add-day'), 10);
    if (!isNaN(adi)) onTemplateEditorAdd(adi);
    return;
  }
  var swapBtn = e.target.closest('[data-swap-ei]');
  if (swapBtn) {
    var sdi = parseInt(swapBtn.getAttribute('data-swap-di'), 10);
    var sei = parseInt(swapBtn.getAttribute('data-swap-ei'), 10);
    if (!isNaN(sdi) && !isNaN(sei)) onTemplateEditorSwap(sdi, sei);
    return;
  }
  var removeBtn = e.target.closest('[data-remove-ei]');
  if (removeBtn) {
    var rdi = parseInt(removeBtn.getAttribute('data-remove-di'), 10);
    var rei = parseInt(removeBtn.getAttribute('data-remove-ei'), 10);
    if (!isNaN(rdi) && !isNaN(rei)) onTemplateEditorRemove(rdi, rei);
    return;
  }
  // Set-level: add / remove
  var addSetBtn = e.target.closest('[data-add-set-ei]');
  if (addSetBtn) {
    var asdi = parseInt(addSetBtn.getAttribute('data-add-set-di'), 10);
    var asei = parseInt(addSetBtn.getAttribute('data-add-set-ei'), 10);
    if (!isNaN(asdi) && !isNaN(asei)) onTemplateEditorAddSet(asdi, asei);
    return;
  }
  var removeSetBtn = e.target.closest('[data-remove-set-si]');
  if (removeSetBtn) {
    var rsdi = parseInt(removeSetBtn.getAttribute('data-remove-set-di'), 10);
    var rsei = parseInt(removeSetBtn.getAttribute('data-remove-set-ei'), 10);
    var rssi = parseInt(removeSetBtn.getAttribute('data-remove-set-si'), 10);
    if (!isNaN(rsdi) && !isNaN(rsei) && !isNaN(rssi)) onTemplateEditorRemoveSet(rsdi, rsei, rssi);
    return;
  }
});
// Input listener for inline inputs (rest, note, per-set weight/reps/range).
// Fires per-keystroke so that tapping another action (add set, swap,
// remove) mid-typing doesn't drop unsaved characters — `change` only
// fires on blur, which tap-to-button doesn't always trigger.
document.getElementById('templateEditorBody').addEventListener('input', function(e) {
  onTemplateEditorInputChange(e.target);
});
document.getElementById('saveTemplateOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeSaveTemplate();
});
document.getElementById('saveTemplateNameInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); submitSaveTemplate(); }
});
document.getElementById('saveTemplateScopePlan').addEventListener('click', function() {
  setSaveTemplateScope('plan');
});
document.getElementById('saveTemplateScopeDay').addEventListener('click', function() {
  if (this.disabled) return;
  setSaveTemplateScope('day');
});

document.getElementById('btnPlansClose').addEventListener('click', closePlans);
document.getElementById('plansOverlay').addEventListener('click', function(e) {
  if (e.target === this) closePlans();
});

document.getElementById('btnResumePromptResume').addEventListener('click', onResumePromptResume);
document.getElementById('btnResumePromptJustLog').addEventListener('click', onResumePromptJustLog);
document.getElementById('btnResumePromptCancel').addEventListener('click', onResumePromptCancel);
document.getElementById('btnResumePromptClose').addEventListener('click', onResumePromptCancel);
document.getElementById('resumePromptOverlay').addEventListener('click', function(e) {
  if (e.target === this) onResumePromptCancel();
});
document.getElementById('plansBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  var btn = e.target.closest('.plans-btn');
  if (!btn || btn.disabled) return;
  // View + Rename buttons carry their own attributes so they're not
  // confused with the action-id (activate/template/delete) attribute.
  var viewId = btn.getAttribute('data-view-plan-id');
  if (viewId) { openPlanOrTemplateViewer(viewId); return; }
  var renameId = btn.getAttribute('data-rename-plan-id');
  if (renameId) { onRenamePlan(renameId); return; }
  var planId = btn.getAttribute('data-plan-id');
  if (!planId) return;
  if (btn.classList.contains('activate')) onActivatePlan(planId);
  else if (btn.classList.contains('template')) savePlanRowAsTemplate(planId);
  else if (btn.classList.contains('delete')) onDeletePlan(planId);
});
document.getElementById('btnGenerateClose').addEventListener('click', closeGenerate);
document.getElementById('generateOverlay').addEventListener('click', function(e) {
  // Don't dismiss mid-generation — only allow overlay click to close on the review screen.
  if (e.target === this && generateView === 'review') closeGenerate();
});
document.getElementById('generateBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest('#btnGenerateInputSubmit')) { submitGenerateInputs('plan'); return; }
  if (e.target.closest('#btnGenerateInputAnalyze')) { submitGenerateInputs('analyze'); return; }
  if (e.target.closest('#btnGenerateInputCancel')) { closeGenerate(); return; }
  if (e.target.closest('#btnGenerateAccept')) { onAcceptGeneratedPlan(); return; }
  if (e.target.closest('#btnGenerateSaveTemplate')) { onSaveGeneratedPlanAsTemplate(); return; }
  if (e.target.closest('#btnAnalyzeUseForPlan')) { useAnalysisForNextPlan(); return; }
  if (e.target.closest('#btnAnalyzeApplyProfile')) { onAnalyzeApplyProfileUpdates(); return; }
  if (e.target.closest('#btnGenerateCancel')) { closeGenerate(); return; }
  if (e.target.closest('#btnGenerateAbort')) { cancelGenerate(); return; }
});
document.getElementById('menuWeightUnit').addEventListener('click', function() {
  setWeightUnit(getWeightUnit() === 'lbs' ? 'kg' : 'lbs');
  closeMenu();
  buildDay(currentDay);
});
document.getElementById('menuRestTimerAuto').addEventListener('click', function() {
  setRestTimerAuto(!getRestTimerAuto());
  closeMenu();
  showToast('Auto rest timer ' + (getRestTimerAuto() ? 'on' : 'off'), null);
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
document.getElementById('startPathTemplate').addEventListener('click', async function() {
  var list = document.getElementById('startPathTemplateList');
  if (list.classList.contains('hidden')) {
    list.classList.remove('hidden');
    await loadStartScreenTemplates();
  } else {
    list.classList.add('hidden');
    list.innerHTML = '';
  }
});
document.getElementById('startPathTemplateList').addEventListener('click', function(e) {
  var row = e.target.closest('.start-day-row');
  if (!row) return;
  var tid = row.getAttribute('data-template-id');
  if (!tid) return;
  var dayIdx = row.getAttribute('data-day-index');
  onPickStartScreenTemplate(tid, dayIdx);
});
document.getElementById('startPathBlank').addEventListener('click', function() {
  closeStartScreen();
  createAdHocSession();
});
document.getElementById('startPathImportLink').addEventListener('click', function() {
  closeStartScreen();
  document.getElementById('fileInput').click();
});

// Coach chat wiring.
document.getElementById('btnCoachOpen').addEventListener('click', openCoachChat);
document.getElementById('btnCoachClose').addEventListener('click', closeCoachChat);
document.getElementById('coachOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeCoachChat();
});
document.getElementById('coachInputForm').addEventListener('submit', function(e) {
  e.preventDefault();
  sendCoachMessage();
});
// Enter to send, Shift+Enter for newline. Auto-grow the textarea as the
// user types so multi-line questions stay visible up to the CSS max-height.
document.getElementById('coachInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCoachMessage();
  }
});
document.getElementById('coachInput').addEventListener('input', function(e) {
  var el = e.target;
  el.style.height = 'auto';
  el.style.height = Math.min(120, el.scrollHeight) + 'px';
});

// Swap modal wiring. The swap button on each plan exercise card uses the
// standard workoutContainer click delegator below (see early-dispatch block).
document.getElementById('btnSwapExerciseClose').addEventListener('click', closeSwapModal);
document.getElementById('swapExerciseOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeSwapModal();
});
document.getElementById('swapExerciseBody').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest('#btnSwapSubmit')) { submitSwapRequest(); return; }
  if (e.target.closest('#btnSwapRetry')) { retrySwapRequest(); return; }
  if (e.target.closest('#btnSwapAccept')) { acceptSwap(); return; }
  if (e.target.closest('#btnSwapCancel')) { closeSwapModal(); return; }
  if (e.target.closest('#btnSwapAbort')) { closeSwapModal(); return; }
});

// Coaching Profile modal wiring.
document.getElementById('btnCoachingProfileClose').addEventListener('click', closeCoachingProfile);
document.getElementById('btnCoachingProfileCancel').addEventListener('click', closeCoachingProfile);
document.getElementById('btnCoachingProfileSave').addEventListener('click', saveCoachingProfileFromForm);
document.getElementById('coachingProfileOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeCoachingProfile();
});
document.getElementById('btnCpAddInjury').addEventListener('click', addInjuryRow);
document.getElementById('cpInjuriesList').addEventListener('click', function(e) {
  var btn = e.target && e.target.closest ? e.target.closest('[data-cp-remove-injury]') : null;
  if (!btn) return;
  var idx = parseInt(btn.getAttribute('data-cp-remove-injury'), 10);
  if (Number.isFinite(idx)) removeInjuryRow(idx);
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
  // Duration edit inside history detail — route to history context.
  var durEditHist = e.target.closest ? e.target.closest('.duration-edit-btn') : null;
  if (durEditHist) {
    var histWid = durEditHist.getAttribute('data-workout-id');
    var histMin = parseInt(durEditHist.getAttribute('data-current-min'), 10) || 0;
    var histEndedAt = durEditHist.getAttribute('data-ended-at') || null;
    promptAdjustDuration(histWid, histMin, histEndedAt, 'history');
    return;
  }
  // Reactivate / discard actions must be checked BEFORE the row-open handler
  // since they're rendered inside the detail view which isn't a .history-row.
  var reactivateBtn = e.target.closest ? e.target.closest('.history-action-btn.reactivate') : null;
  if (reactivateBtn) {
    var widR = reactivateBtn.getAttribute('data-workout-id');
    if (widR) onReactivateWorkout(widR);
    return;
  }
  var discardBtn = e.target.closest ? e.target.closest('.history-action-btn.discard') : null;
  if (discardBtn) {
    var widD = discardBtn.getAttribute('data-workout-id');
    var completed = parseInt(discardBtn.getAttribute('data-completed'), 10) || 0;
    var title = discardBtn.getAttribute('data-title') || 'this session';
    if (widD) onDiscardWorkout(widD, completed, title);
    return;
  }
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
  // Swap icon on plan exercise cards. Only rendered in editable mode and
  // never on ad-hoc / extras cards (see buildDay prescribed loop).
  var swapBtnEarly = target.closest ? target.closest('.card-swap') : null;
  if (swapBtnEarly) {
    openSwapModal(
      parseInt(swapBtnEarly.getAttribute('data-swap-di'), 10),
      parseInt(swapBtnEarly.getAttribute('data-swap-ei'), 10)
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
  // Add from template (opens the template-exercise picker)
  var addTplBtn = target.closest ? target.closest('#btnAddFromTemplate') : null;
  if (addTplBtn) {
    if (addTplBtn.disabled) return;
    openAddFromTemplate();
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
  var cancelSessionBtn = target.closest ? target.closest('#btnCancelSession') : null;
  if (cancelSessionBtn) {
    if (cancelSessionBtn.disabled) return;
    onCancelTodaySession(cancelSessionBtn.getAttribute('data-workout-id'));
    return;
  }
  // Manual duration edit on today/ad-hoc session bars.
  var durEditBtn = target.closest ? target.closest('.duration-edit-btn') : null;
  if (durEditBtn) {
    if (durEditBtn.disabled) return;
    var wid = durEditBtn.getAttribute('data-workout-id');
    var curMin = parseInt(durEditBtn.getAttribute('data-current-min'), 10) || 0;
    var endedAt = durEditBtn.getAttribute('data-ended-at') || null;
    promptAdjustDuration(wid, curMin, endedAt, 'today');
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
  // Substitution: open the exercise picker (pick) or clear.
  var subPick = target.closest ? target.closest('.sub-picker-btn') : null;
  if (subPick) {
    var diPick = parseInt(subPick.getAttribute('data-di'), 10);
    var eiPick = parseInt(subPick.getAttribute('data-ei'), 10);
    var prescribedName = (plan && plan.days[diPick] && plan.days[diPick].exercises[eiPick])
      ? plan.days[diPick].exercises[eiPick].name : '';
    openPicker(async function(libRow) {
      await logSubstitute(diPick, eiPick, libRow);
      // Scope toast — pair to the swap review warning. Makes the
      // session-only semantics explicit so the user doesn't assume
      // the plan has changed permanently.
      showToast(
        'Subbed ' + (prescribedName ? prescribedName : 'exercise') + ' → ' + libRow.name +
        ' for today only. Plan unchanged — use the ⇄ Swap icon to change the week.',
        null
      );
    });
    return;
  }
  var subClear = target.closest ? target.closest('.sub-clear-btn') : null;
  if (subClear) {
    var diClear = parseInt(subClear.getAttribute('data-di'), 10);
    var eiClear = parseInt(subClear.getAttribute('data-ei'), 10);
    logSubstitute(diClear, eiClear, null).then(function() {
      showToast('Substitution cleared', null);
    });
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
  // .sub-input was removed in v2.2.1 — substitution now uses the exercise
  // picker via .sub-picker-btn (click-handled, not change-handled). The
  // legacy handler is intentionally gone; no fallback to logSub needed.
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
