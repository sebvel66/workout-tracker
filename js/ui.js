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
// History edit mode (v2.5.13): when true, the detail view renders inputs
// without the disabled attribute so the user can correct missed values
// or add notes after the fact. Auto-saves on change directly to DB
// (bypasses the todayState-coupled persistSet path); the local
// historyDetails cache mirrors writes so the view stays in sync without
// a refetch. Reset to false on detail close / week back / sign-out.
var historyEditMode = false;

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

// Empty-state recent workouts cache — lazily populated by renderEmptyState;
// null = not yet fetched.
var recentWorkoutsCache = null;
var generatedPlan = null;           // the full plan JSON returned by /api/generate-plan
var generatedAnalysis = null;       // the analysis object from mode=analyze
var generatedMeta = null;           // { model, usage, generated_at, elapsed_s }
var generatedInputs = null;         // { start_date, target_duration, notes } from the form
var generateStartedAt = 0;          // ms timestamp when the API call started
var generateInFlight = false;       // prevents double-fire of the generate button
var generateAbortController = null; // wired to the in-flight fetch so Cancel can abort
var generateAttempt = 0;            // 1 on first try, 2 on the silent retry (for loading-message swap)
// Conversational follow-ups on the analyze review (v3.5.3). [{role, content}, …]
// Reset on every fresh analyze submit + on modal close. Folds into the
// "Use for next plan" carry alongside the four-section analysis.
var analyzeChatHistory = [];
var analyzeChatPending = false;     // disables Ask button while a follow-up is in flight

// Bottom tab navigation (v3.6.0). Three primary destinations: workout,
// body (per-muscle volume + targets), log (history + trends launchpad).
// Switching tabs sets body[data-view] which CSS rules hide/show via.
var activeView = 'workout';

// Refine-mode state (v2.5.3): when the user iterates on a freshly-generated
// plan via the "What would you change?" input on the review screen.
//   iterationHistory: [{ plan, feedback }] — prior plans with the feedback
//     that led to the next iteration. Empty after initial generate; one
//     entry appended per refine call. Server reconstructs assistant turns
//     from this and replays the multi-turn conversation each call.
//   generatedChangeNotes: 2-4 sentence string returned alongside the
//     revised plan explaining what changed. Null until the first refine.
//   refineInFlight: gates double-fire of the Refine button; mirrors
//     generateInFlight for the refine path.
var iterationHistory = [];
var generatedChangeNotes = null;
var refineInFlight = false;

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

// Render the per-workout weight-mode chip for an exercise card (v3.1.0).
// `mode` is the effective mode (output of effectiveWeightMode).
// `meta` is the exerciseMeta — used to decide visibility (skip for
// bodyweight/none/cardio rows). `ctx` is one of:
//   - 'editable' — today plan day or ad-hoc; clickable, fires
//                  data-toggle-weight-mode-ei.
//   - 'history-edit' — historical edit mode; clickable, fires
//                      data-history-toggle-weight-mode with workout id.
//   - 'history-readonly' — no click, static label.
// Returns '' (chip hidden) when the exercise is bodyweight/none/cardio.
function renderWeightModeChip(ei, mode, meta, ctx, workoutId) {
  if (!meta) return '';
  var lib = meta.weight_mode || 'total';
  if (lib === 'bodyweight' || lib === 'none') return '';
  if (meta.muscle_group === 'cardio') return '';
  var isPerSide = mode === 'per_side';
  var label = isPerSide ? 'Per side' : 'Total';
  var classes = 'weight-mode-chip' + (isPerSide ? ' is-per-side' : '');
  if (ctx === 'history-readonly') {
    return '<span class="' + classes + ' is-readonly">' + label + '</span>';
  }
  var attrs = '';
  if (ctx === 'editable') {
    attrs = ' type="button" data-toggle-weight-mode-ei="' + ei + '"';
  } else if (ctx === 'history-edit') {
    attrs = ' type="button" data-history-toggle-weight-mode="1"' +
            ' data-history-ex-order="' + ei + '"' +
            ' data-history-workout-id="' + escapeAttr(workoutId || '') + '"';
  }
  return '<button class="' + classes + '"' + attrs + '>' + label + '</button>';
}

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

  var BLOCK_FILTER = ', .superset-block, .superset-block-header, .superset-members-zone, .superset-add-round';

  if (isAdHoc) {
    var adhocEl = document.querySelector('#workoutContainer [data-sort-zone="adhoc"]');
    if (adhocEl) {
      Sortable.create(adhocEl, {
        group: 'exercise-adhoc-session',
        filter: DRAG_FILTER + BLOCK_FILTER,
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

    // Per-block sort zones (v3.4.0). Each block container has its own
    // unique data-sort-zone="superset-<groupKey>" so SortableJS treats
    // them as independent -- drops from outside are rejected by the
    // unique group key.
    var supersetZonesAdHoc = document.querySelectorAll('#workoutContainer [data-sort-zone^="superset-"]');
    for (var za = 0; za < supersetZonesAdHoc.length; za++) {
      var zoneA = supersetZonesAdHoc[za];
      var groupKeyForZoneA = zoneA.getAttribute('data-sort-zone').replace(/^superset-/, '');
      Sortable.create(zoneA, {
        group: 'exercise-superset-' + groupKeyForZoneA,
        filter: DRAG_FILTER,
        preventOnFilter: false,
        delay: LONG_PRESS_MS,
        delayOnTouchOnly: true,
        animation: ANIM_MS,
        onEnd: (function(zoneEl) {
          return function(evt) {
            if (evt.oldIndex === evt.newIndex) return;
            onMemberReordered(zoneEl);
          };
        })(zoneA)
      });
    }
    return;
  }

  var planEl = document.querySelector('#workoutContainer [data-sort-zone="plan"]');
  if (planEl) {
    Sortable.create(planEl, {
      group: 'exercise-plan-zone',
      filter: DRAG_FILTER + BLOCK_FILTER,
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
      filter: DRAG_FILTER + BLOCK_FILTER,
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

  // Per-block sort zones (v3.4.0). Each block container has its own
  // unique data-sort-zone="superset-<groupKey>" so SortableJS treats
  // them as independent -- drops from outside are rejected by the
  // unique group key.
  var supersetZones = document.querySelectorAll('#workoutContainer [data-sort-zone^="superset-"]');
  for (var z = 0; z < supersetZones.length; z++) {
    var zone = supersetZones[z];
    var groupKeyForZone = zone.getAttribute('data-sort-zone').replace(/^superset-/, '');
    Sortable.create(zone, {
      group: 'exercise-superset-' + groupKeyForZone,
      filter: DRAG_FILTER,
      preventOnFilter: false,
      delay: LONG_PRESS_MS,
      delayOnTouchOnly: true,
      animation: ANIM_MS,
      onEnd: (function(zoneEl) {
        return function(evt) {
          if (evt.oldIndex === evt.newIndex) return;
          onMemberReordered(zoneEl);
        };
      })(zone)
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
function renderSetRow(di, ei, si, sl, prescribedSet, weightMode, disabledAttr, prText, deletable, isCardio, displaySetNum) {
  var currentUnit = getWeightUnit();
  var isDropChild = sl && sl.setType === 'drop';

  var out = '';
  var extraCls = sl && sl.isExtra ? ' set-extra' : '';
  var dropCls = isDropChild ? ' set-drop' : '';
  out += '<div class="set-row' + (deletable ? ' deletable' : '') + extraCls + dropCls + '">';
  // Drop segments use → as the label instead of S#. displaySetNum is
  // computed by the caller as a running count of standard sets only,
  // so a chain of drops doesn't shift downstream numbering. Falls
  // back to si+1 for legacy callers that don't pass it.
  if (isDropChild) {
    out += '<div class="set-label set-label-drop">→</div>';
  } else {
    var labelNum = (displaySetNum != null) ? displaySetNum : (si + 1);
    out += '<div class="set-label">S' + labelNum + '</div>';
  }
  out += '<div class="set-prescribed">' + (prText || '—') + '</div>';
  out += '<div class="set-actual">';

  if (isCardio) {
    // Cardio (v2.5 Phase 1, lean): duration + distance, no weight/reps.
    // Detection per Q2: muscle_group === 'cardio' from the library.
    // Duration field accepts mm:ss OR bare minutes (parseDurationMSS),
    // formats display as mm:ss. Distance is miles (distance_unit
    // defaults to 'mi' globally for v1; per-row unit toggle deferred
    // to Phase 1.5).
    var durValue = formatDurationMSS(sl.duration_seconds);
    var durPlaceholder = (prescribedSet && prescribedSet.duration_seconds != null)
      ? formatDurationMSS(prescribedSet.duration_seconds) : 'mm:ss';
    out += '<div class="input-group"><label class="input-label">DURATION</label>';
    out += '<input type="text" inputmode="text" class="set-input" value="' + escapeAttr(durValue) +
      '" placeholder="' + escapeAttr(durPlaceholder) +
      '" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '" data-field="duration_seconds" onfocus="this.select()"' + disabledAttr + '>';
    out += '</div>';
    var distValue = (sl.distance != null) ? sl.distance : '';
    var distPlaceholder = (prescribedSet && prescribedSet.distance != null)
      ? prescribedSet.distance : '—';
    out += '<div class="input-group"><label class="input-label">DIST</label>';
    out += '<input type="number" inputmode="decimal" step="0.01" class="set-input" value="' + escapeAttr(distValue) +
      '" placeholder="' + escapeAttr(distPlaceholder) +
      '" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '" data-field="distance" onfocus="this.select()"' + disabledAttr + '>';
    out += '<div class="weight-mode-hint">mi</div>';
    out += '</div>';
  } else {
    // Resistance path (unchanged from pre-cardio behavior).
    var prescribedLbs = normalizePrescribedLbs(prescribedSet);
    var weightCls = prescribedLbs != null ? inputCls(sl.weight, prescribedLbs) : '';
    var repsCls = prescribedSet ? inputCls(sl.reps, prescribedSet.reps_target) : '';
    var weightPlaceholder = prescribedLbs != null ? displayWeight(prescribedLbs, currentUnit) : '—';
    var repsPlaceholder = prescribedSet && prescribedSet.reps_target ? prescribedSet.reps_target : '—';

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
  }

  out += '</div>';
  out += '<button class="set-check ' + (sl.done ? 'done' : '') + '" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '"' + disabledAttr + '>' + (sl.done ? '✓' : '·') + '</button>';
  if (deletable) {
    out += '<button class="set-delete" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '"' + disabledAttr + ' aria-label="Delete set" type="button">×</button>';
  }
  out += '</div>';
  return out;
}

function fmtP(s) {
  if (s == null) return '—';
  // Cardio prescription: duration-first format, drops weight + reps.
  // Detection by field presence (duration_seconds populated) rather
  // than library lookup — we don't always have the exercise name in
  // scope here. Plan-emitted cardio sets always carry duration_seconds.
  if (s.duration_seconds != null) {
    var parts = [formatDurationMSS(s.duration_seconds)];
    if (s.distance != null) parts.push(s.distance + 'mi');
    return parts.join(', ');
  }
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
  // When neither plan-days nor ad-hocs are available, render a single
  // disabled placeholder so the dropdown isn't an empty box. Keeps the
  // chrome present for visual consistency rather than collapsing it.
  if (h === '') {
    h = '<option disabled selected>No active plan or session</option>';
  }
  sel.innerHTML = h;

  // Wrapper is always visible now — the placeholder option above
  // ensures the dropdown always has at least one entry.
  var wrap = sel.closest('.day-picker-row');
  if (wrap) {
    wrap.style.display = '';
  }
}

function countDoneSets(exState) {
  if (!exState || !Array.isArray(exState.sets)) return 0;
  var n = 0;
  for (var i = 0; i < exState.sets.length; i++) {
    if (exState.sets[i] && exState.sets[i].done) n++;
  }
  return n;
}

// Group consecutive same-supersetGroup exercises together for block
// rendering. Returns an array of runs:
//   { kind: 'standalone', ei, planEx, exState }   // planEx may be null for ad-hoc
//   { kind: 'block', groupKey, rest, items: [{ei, planEx, exState}, ...] }
//
// planDayExercises is the plan day's exercises array (plan.days[di].exercises)
//   -- pass null for ad-hoc; the function falls into a state-only walk.
// stateExercises is state.exercises (the in-memory per-exercise map).
function groupRunsForRender(planDayExercises, stateExercises) {
  var runs = [];
  if (!Array.isArray(planDayExercises)) {
    // Ad-hoc / state-only path: walk stateExercises sorted by ei,
    // grouping by supersetGroup.
    var keys = Object.keys(stateExercises || {}).sort(function(a, b) {
      return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
    });
    var current = null;
    for (var ki = 0; ki < keys.length; ki++) {
      var ek = keys[ki];
      var ei = parseInt(ek.slice(3), 10);
      var ex = stateExercises[ek];
      var group = ex && ex.supersetGroup;
      if (group) {
        if (current && current.kind === 'block' && current.groupKey === group) {
          current.items.push({ei: ei, planEx: null, exState: ex});
        } else {
          if (current) runs.push(current);
          current = { kind: 'block', groupKey: group, rest: ex.supersetRest || 60, items: [{ei: ei, planEx: null, exState: ex}] };
        }
      } else {
        if (current) { runs.push(current); current = null; }
        runs.push({ kind: 'standalone', ei: ei, planEx: null, exState: ex });
      }
    }
    if (current) runs.push(current);
    return runs;
  }
  // Plan-day path: walk plan.days[di].exercises[] and detect blocks.
  var flatEi = 0;
  for (var i = 0; i < planDayExercises.length; i++) {
    var entry = planDayExercises[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      var items = [];
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        var ek2 = 'ex_' + flatEi;
        items.push({ei: flatEi, planEx: entry.exercises[ci], exState: stateExercises[ek2] || null});
        flatEi++;
      }
      runs.push({ kind: 'block', groupKey: 'p' + i, rest: Number.isInteger(entry.rest) ? entry.rest : 60, items: items });
    } else {
      var ek3 = 'ex_' + flatEi;
      runs.push({ kind: 'standalone', ei: flatEi, planEx: entry, exState: stateExercises[ek3] || null });
      flatEi++;
    }
  }
  return runs;
}

// Render one superset block. members is an array of pre-rendered
// member entries: [{ei, cardHtml}, ...]. blockMeta carries
// {key, rest, currentRound, totalRounds}. di is needed for the rest-
// edit and add-round buttons (null for read-only history use).
// readOnly suppresses the rest-edit and add-round affordances.
function renderSupersetBlock(di, members, blockMeta, readOnly) {
  if (!members || !members.length) return '';
  var h = '';
  var diAttr = (di === null || di === undefined) ? '' : ' data-di="' + escapeAttr(String(di)) + '"';
  h += '<div class="superset-block" data-superset-group="' + escapeAttr(blockMeta.key) + '">';
  h += '<div class="superset-block-header">';
  var roundLabel;
  if (blockMeta.totalRounds <= 0) {
    roundLabel = 'Round 0';
  } else if (blockMeta.currentRound >= blockMeta.totalRounds) {
    roundLabel = blockMeta.totalRounds + ' / ' + blockMeta.totalRounds + ' ✓';
  } else {
    roundLabel = 'Round ' + blockMeta.currentRound + ' of ' + blockMeta.totalRounds;
  }
  h += '<span>⟷ Superset \xb7 ' + roundLabel + '</span>';
  h += '<span class="superset-block-header-meta">';
  h += '<span>' + (blockMeta.rest || 60) + 's rest</span>';
  if (!readOnly) {
    h += '<button class="superset-block-header-rest-edit" type="button" data-edit-superset-rest="' + escapeAttr(blockMeta.key) + '"' + diAttr + ' aria-label="Edit block rest">✎</button>';
  }
  h += '</span>';
  h += '</div>';
  h += '<div class="superset-members-zone" data-sort-zone="superset-' + escapeAttr(blockMeta.key) + '"' + diAttr + '>';
  for (var mi = 0; mi < members.length; mi++) {
    var m = members[mi];
    h += '<div class="superset-member" data-member-ei="' + m.ei + '">';
    h += m.cardHtml;
    h += '</div>';
  }
  h += '</div>';
  if (!readOnly) {
    h += '<button class="superset-add-round" type="button" data-add-round="' + escapeAttr(blockMeta.key) + '"' + diAttr + '>+ Add round</button>';
  }
  h += '</div>';
  return h;
}

// Returns {html, totalSets, doneSets} for one prescribed plan-day exercise card.
// Outer caller accumulates totalSets/doneSets for the summary bar.
// badgeLabel (e.g., 'A1') is prepended to the .exercise-name span when set;
// null = standalone card with no badge.
function renderPlanDayExerciseCard(di, ei, planEx, exState, mode, readOnly, badgeLabel) {
  var ex = planEx;
  var ek = 'ex_' + ei;
  var h = '';
  var exTotal = Math.max(ex.sets.length, exState.sets.length);
  var totalSets = exTotal;
  var dn = 0;
  for (var s = 0; s < exState.sets.length; s++) { if (exState.sets[s] && exState.sets[s].done) dn++; }
  var doneSets = dn;
  var ad = dn === exTotal, sd = dn > 0 && !ad;
  var sc = ad ? 'complete' : sd ? 'partial' : 'pending';
  var stat = ad ? dn + '/' + exTotal + ' ✓' : dn + '/' + exTotal;
  var cc = ad ? ' complete' : sd ? ' partial' : '';
  var dis = readOnly ? ' disabled' : '';
  // Weight mode + display name track the substitute when one is set —
  // a per_side substitute for a total prescribed exercise needs the
  // right label ("LBS/ea") and its own name visible on the card.
  // Substitute's mode wins when present; otherwise resolve from the
  // prescribed exercise's library row by name. Per-set override (v3.1.0)
  // wins over both at the per-row render below.
  var libDefault = (exState.subExercise && exState.subExercise.weight_mode)
    ? exState.subExercise.weight_mode
    : weightModeForName(ex.name);
  // v3.6.15: prefer exState.weight_mode_override (pre-session chip toggle)
  // before falling back to the first persisted set's stamp, then library
  // default. Lets the chip reflect a pre-session toggle without needing
  // any sets to exist yet.
  var weightMode = (exState && exState.weight_mode_override)
    || (exState.sets[0] && exState.sets[0].weight_mode)
    || libDefault;
  // Cardio detection follows the displayed exercise name — substitutes
  // can flip a resistance prescription into a cardio one (e.g., user
  // subs incline treadmill walk for a stalled accessory).
  var displayNameForCardio = exState.subExercise ? exState.subExercise.name : ex.name;
  var isCardioRow = isCardioExerciseName(displayNameForCardio);
  var displayName = exState.subExercise ? exState.subExercise.name : ex.name;
  var prescribedBadge = exState.subExercise
    ? '<span class="exercise-sub-origin">was: ' + escapeHtml(ex.name) + '</span>'
    : '';

  h += '<div class="exercise-card' + cc + '">';
  var swapBtn = readOnly ? '' : '<button class="card-swap" data-swap-di="' + di + '" data-swap-ei="' + ei + '" aria-label="Swap exercise" type="button">⇄</button>';
  // badgeLabel is the canonical "this card is a member of a block" signal —
  // set by the buildDay caller when emitting a block run, null for
  // standalones. Reliable pre-session too, where exState.supersetGroup
  // isn't populated yet (state lazy-creates on session start).
  var inBlock = badgeLabel != null || !!(exState && exState.supersetGroup);
  var supersetBtn = readOnly ? '' :
    '<button class="ex-superset-btn' + (inBlock ? ' in-block' : '') +
    '" type="button" data-di="' + escapeAttr(String(di)) + '" data-ei="' + ei +
    '" aria-label="' + (inBlock ? 'Remove from superset' : 'Pair as superset') +
    '" title="' + (inBlock ? 'Remove from superset' : 'Pair as superset') + '">⟷</button>';
  // chipMeta visibility check: substitute's library row when subbed,
  // else the prescribed exercise's library row. (Lookup mirrors what
  // weightModeForName does internally.)
  var chipMeta = exState.subExercise || exerciseLibraryByName[normName(ex.name)] || null;
  var chipHtml = renderWeightModeChip(ei, weightMode, chipMeta, readOnly ? 'history-readonly' : 'editable', null);
  var badgeHtml = badgeLabel ? '<span class="superset-badge">' + escapeHtml(badgeLabel) + '</span>' : '';
  h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + badgeHtml + escapeHtml(displayName) + prescribedBadge + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(displayName) + '">view recent</button>' + chipHtml + '</div><div class="exercise-status ' + sc + '">' + stat + '</div>' + swapBtn + supersetBtn + '</div>';
  if (ex.note) h += '<div class="exercise-note">' + escapeHtml(ex.note) + '</div>';
  h += renderInlineFormNotes(resolveCardExerciseId(ex, exState), ei, readOnly);
  h += '<div class="sets-container">';

  // Running count of standard (non-drop) sets so the S# label stays
  // sequential across the prescribed → extras boundary even when
  // drops are interspersed at the end of the array.
  var stdSetNum = 0;
  for (var si = 0; si < ex.sets.length; si++) {
    var set = ex.sets[si];
    var setIsDrop = !!(set && set.set_type === 'drop');
    // Seed prescribed drops in the in-memory state so cascade-on-done
    // can find them via setType + parentSetIdx (parentSetIdx is the
    // index of the most recent non-drop set in this exercise's
    // prescribed sets array). Lazy: only seed if the user hasn't
    // touched this set yet. Once seeded, the entry behaves like a
    // manually-added drop for cascade / persist purposes.
    if (setIsDrop && !exState.sets[si]) {
      var prescribedParentIdx = si - 1;
      while (prescribedParentIdx >= 0
             && ex.sets[prescribedParentIdx]
             && ex.sets[prescribedParentIdx].set_type === 'drop') {
        prescribedParentIdx--;
      }
      exState.sets[si] = {
        setType: 'drop',
        parentSetIdx: prescribedParentIdx >= 0 ? prescribedParentIdx : null,
      };
    }
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
    // Drops use → label; standard sets get the next S#.
    var pSetLabel;
    if (!setIsDrop) {
      stdSetNum++;
      pSetLabel = stdSetNum;
    }
    h += renderSetRow(di, ei, si, sl, effectiveSet, (sl.weight_mode || weightMode), dis, pr, false, isCardioRow, pSetLabel);
  }

  // Extras on this prescribed exercise: sets past the plan-defined count.
  // sl.isExtra is set on these by addExtraSet / stateFromWorkout. Delete
  // button is rendered via the deletable flag; prescribed rows above stay
  // immutable.
  for (var siExtra = ex.sets.length; siExtra < exState.sets.length; siExtra++) {
    var slExtra = exState.sets[siExtra] || {};
    // Drops use → label; standard extras get the next sequential S#.
    var slExtraNum;
    if (slExtra && slExtra.setType !== 'drop') {
      stdSetNum++;
      slExtraNum = stdSetNum;
    }
    h += renderSetRow(di, ei, siExtra, slExtra, null, (slExtra.weight_mode || weightMode), dis, '—', !readOnly, isCardioRow, slExtraNum);
  }
  if (mode === 'editable') {
    h += '<button class="add-set-btn" data-add-set-ei="' + ei + '">+ Add Set</button>';
    // Drop Set affordance — only when there's a populated set to chain
    // off of and the exercise isn't cardio. Length alone is misleading
    // (sparse arrays after delete-extra still report length > 0 from
    // prescribed-range holes); .some() skips holes and only visits
    // populated entries.
    var hasParentForDrop = (exState.sets || []).some(function(s) { return s != null; });
    if (!isCardioRow && hasParentForDrop) {
      h += '<button class="add-set-btn add-drop-btn" data-add-drop-ei="' + ei + '">+ Drop Set</button>';
    }
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

  return { html: h, totalSets: totalSets, doneSets: doneSets };
}

// Returns {html, totalSets, doneSets} for one extra (ad-hoc added) card on a
// plan day. mode and readOnly match the parent day's values.
// badgeLabel is always null for extras in v1 (extras never superset).
function renderPlanDayExtraCard(di, xei, xState, mode, readOnly, badgeLabel) {
  var h = '';
  var xMeta = xState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
  // Card-level effective mode (v3.1.0): per-set override on sets[0] wins
  // over the library default. Every set in a placement carries the same
  // value (the toggle fan-out keeps them in sync). v3.6.15 adds the
  // exState.weight_mode_override path so pre-session chip toggles render
  // before any sets exist.
  var xWeightMode = (xState && xState.weight_mode_override)
    || effectiveWeightMode(xState.sets[0], xMeta);
  var xIsCardio = xMeta.muscle_group === 'cardio';
  var xSetCount = xState.sets.length || 1;
  var totalSets = xSetCount;
  var xdn = 0;
  for (var xsi = 0; xsi < xState.sets.length; xsi++) {
    if (xState.sets[xsi] && xState.sets[xsi].done) xdn++;
  }
  var doneSets = xdn;
  var xad = xdn === xSetCount, xsd = xdn > 0 && !xad;
  var xsc = xad ? 'complete' : xsd ? 'partial' : 'pending';
  var xstat = xad ? xdn + '/' + xSetCount + ' ✓' : xdn + '/' + xSetCount;
  var xcc = xad ? ' complete' : xsd ? ' partial' : '';
  var dis = readOnly ? ' disabled' : '';

  var xBadgeHtml = badgeLabel ? '<span class="superset-badge">' + escapeHtml(badgeLabel) + '</span>' : '';
  h += '<div class="exercise-card' + xcc + '">';
  var xChipHtml = renderWeightModeChip(xei, xWeightMode, xMeta, readOnly ? 'history-readonly' : 'editable', null);
  var xInBlock = !!(xState && xState.supersetGroup);
  var xSupersetBtn = readOnly ? '' :
    '<button class="ex-superset-btn' + (xInBlock ? ' in-block' : '') +
    '" type="button" data-di="' + escapeAttr(String(di)) + '" data-ei="' + xei +
    '" aria-label="' + (xInBlock ? 'Remove from superset' : 'Pair as superset') +
    '" title="' + (xInBlock ? 'Remove from superset' : 'Pair as superset') + '">⟷</button>';
  h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + xBadgeHtml + escapeHtml(xMeta.name) + '<span class="extras-badge">added</span></div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(xMeta.name) + '">view recent</button>' + xChipHtml + '</div><div class="exercise-status ' + xsc + '">' + xstat + '</div>' + (readOnly ? '' : xSupersetBtn + '<button class="card-delete" data-di="' + di + '" data-ei="' + xei + '" aria-label="Delete exercise" type="button">×</button>') + '</div>';
  h += renderInlineFormNotes(resolveCardExerciseId(null, xState), xei, readOnly);
  h += '<div class="sets-container">';
  var xStdSetNum = 0;
  for (var xsi2 = 0; xsi2 < xSetCount; xsi2++) {
    var xsl = xState.sets[xsi2] || {};
    var xLabelNum;
    if (!xsl || xsl.setType !== 'drop') {
      xStdSetNum++;
      xLabelNum = xStdSetNum;
    }
    h += renderSetRow(di, xei, xsi2, xsl, null, (xsl.weight_mode || xWeightMode), dis, '—', !readOnly, xIsCardio, xLabelNum);
  }
  if (mode === 'editable') {
    h += '<button class="add-set-btn" data-add-set-ei="' + xei + '">+ Add Set</button>';
    var xHasParentForDrop = (xState.sets || []).some(function(s) { return s != null; });
    if (!xIsCardio && xHasParentForDrop) {
      h += '<button class="add-set-btn add-drop-btn" data-add-drop-ei="' + xei + '">+ Drop Set</button>';
    }
  }
  h += '</div>';
  h += '<div class="rpe-row"><div class="rpe-label">RPE</div><div class="rpe-buttons">';
  var xrv = [6,7,8,9,10];
  for (var xr = 0; xr < xrv.length; xr++) {
    h += '<button class="rpe-btn' + (xState.rpe === xrv[xr] ? ' selected' : '') + '" data-di="' + di + '" data-ei="' + xei + '" data-rpe="' + xrv[xr] + '"' + dis + '>' + xrv[xr] + '</button>';
  }
  h += '</div></div>';
  h += '<div style="padding:0 14px 14px"><textarea class="exercise-note-input" rows="1" placeholder="Notes" data-di="' + di + '" data-ei="' + xei + '"' + dis + '>' + escapeHtml(xState.note || '') + '</textarea></div>';
  h += '</div>';

  return { html: h, totalSets: totalSets, doneSets: doneSets };
}

// Returns {html, totalSets, doneSets} for one ad-hoc session exercise card.
// badgeLabel is prepended to .exercise-name when non-null.
function renderAdHocExerciseCard(di, ei, exState, badgeLabel) {
  var h = '';
  var meta = exState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
  // v3.6.15: exState.weight_mode_override takes precedence so pre-set-creation
  // chip toggles render correctly.
  var weightMode = (exState && exState.weight_mode_override)
    || effectiveWeightMode(exState.sets[0], meta);
  var isCardioRow = meta.muscle_group === 'cardio';
  var setCount = exState.sets.length || 1;
  var totalSets = setCount;
  var dn = 0;
  for (var s = 0; s < exState.sets.length; s++) {
    if (exState.sets[s] && exState.sets[s].done) dn++;
  }
  var doneSets = dn;
  var ad = dn === setCount, sd = dn > 0 && !ad;
  var sc = ad ? 'complete' : sd ? 'partial' : 'pending';
  var stat = ad ? dn + '/' + setCount + ' ✓' : dn + '/' + setCount;
  var cc = ad ? ' complete' : sd ? ' partial' : '';
  var dis = '';

  var badgeHtml = badgeLabel ? '<span class="superset-badge">' + escapeHtml(badgeLabel) + '</span>' : '';
  h += '<div class="exercise-card' + cc + '">';
  var adChipHtml = renderWeightModeChip(ei, weightMode, meta, 'editable', null);
  var inBlockAd = !!(exState && exState.supersetGroup);
  var supersetBtnAd = '<button class="ex-superset-btn' + (inBlockAd ? ' in-block' : '') +
    '" type="button" data-di="' + escapeAttr(String(di)) + '" data-ei="' + ei +
    '" aria-label="' + (inBlockAd ? 'Remove from superset' : 'Pair as superset') +
    '" title="' + (inBlockAd ? 'Remove from superset' : 'Pair as superset') + '">⟷</button>';
  h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + badgeHtml + escapeHtml(meta.name) + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(meta.name) + '">view recent</button>' + adChipHtml + '</div><div class="exercise-status ' + sc + '">' + stat + '</div>' + supersetBtnAd + '<button class="card-delete" data-di="' + di + '" data-ei="' + ei + '" aria-label="Delete exercise" type="button">×</button></div>';
  h += renderInlineFormNotes(resolveCardExerciseId(null, exState), ei, false);
  h += '<div class="sets-container">';
  var adStdSetNum = 0;
  for (var si = 0; si < setCount; si++) {
    var sl = exState.sets[si] || {};
    var adLabelNum;
    if (!sl || sl.setType !== 'drop') {
      adStdSetNum++;
      adLabelNum = adStdSetNum;
    }
    h += renderSetRow(di, ei, si, sl, null, (sl.weight_mode || weightMode), dis, '—', true, isCardioRow, adLabelNum);
  }
  h += '<button class="add-set-btn" data-add-set-ei="' + ei + '">+ Add Set</button>';
  var adHasParentForDrop = (exState.sets || []).some(function(s) { return s != null; });
  if (!isCardioRow && adHasParentForDrop) {
    h += '<button class="add-set-btn add-drop-btn" data-add-drop-ei="' + ei + '">+ Drop Set</button>';
  }
  h += '</div>';
  h += '<div class="rpe-row"><div class="rpe-label">RPE</div><div class="rpe-buttons">';
  var rv = [6,7,8,9,10];
  for (var r = 0; r < rv.length; r++) {
    h += '<button class="rpe-btn' + (exState.rpe === rv[r] ? ' selected' : '') + '" data-di="' + di + '" data-ei="' + ei + '" data-rpe="' + rv[r] + '"' + dis + '>' + rv[r] + '</button>';
  }
  h += '</div></div>';
  h += '<div style="padding:0 14px 14px"><textarea class="exercise-note-input" rows="1" placeholder="Notes" data-di="' + di + '" data-ei="' + ei + '"' + dis + '>' + escapeHtml(exState.note || '') + '</textarea></div>';
  h += '</div>';

  return { html: h, totalSets: totalSets, doneSets: doneSets };
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
  var runs = groupRunsForRender(dayPlan.exercises, state ? state.exercises : {});
  for (var ri = 0; ri < runs.length; ri++) {
    var run = runs[ri];
    if (run.kind === 'standalone') {
      var card = renderPlanDayExerciseCard(di, run.ei, run.planEx, run.exState || { sets: [], rpe: null, note: '', sub: '' }, mode, readOnly, null);
      ts += card.totalSets; cs += card.doneSets;
      h += card.html;
    } else {
      var members = [];
      var minDone = Infinity, maxSets = 0;
      for (var mi = 0; mi < run.items.length; mi++) {
        var item = run.items[mi];
        var memBadge = String.fromCharCode(65) + (mi + 1);
        var memCard = renderPlanDayExerciseCard(di, item.ei, item.planEx, item.exState || { sets: [], rpe: null, note: '', sub: '' }, mode, readOnly, memBadge);
        members.push({ ei: item.ei, cardHtml: memCard.html });
        ts += memCard.totalSets; cs += memCard.doneSets;
        var doneCount = countDoneSets(item.exState);
        var totalCount = (item.planEx && Array.isArray(item.planEx.sets)) ? item.planEx.sets.length
                       : (item.exState && Array.isArray(item.exState.sets) ? item.exState.sets.length : 0);
        if (doneCount < minDone) minDone = doneCount;
        if (totalCount > maxSets) maxSets = totalCount;
      }
      var currentRound = (minDone === Infinity ? 1 : Math.min(minDone + 1, maxSets || 1));
      var roundComplete = (minDone >= maxSets && maxSets > 0);
      h += renderSupersetBlock(di, members, {
        key: run.groupKey,
        rest: run.rest,
        currentRound: roundComplete ? maxSets : currentRound,
        totalRounds: maxSets
      }, readOnly);
    }
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
    var xCard = renderPlanDayExtraCard(di, xei, xState, mode, readOnly, null);
    ts += xCard.totalSets; cs += xCard.doneSets;
    h += xCard.html;
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

  // Form notes (v3.6.10): clear per-card expansion state when switching
  // days so a new day always opens collapsed. Then kick off the batch
  // hydrate in the background — it'll re-paint this day once data lands
  // if anything actually changed.
  if (_formNotesExpandedDay !== di) {
    formNotesExpanded = {};
    _formNotesExpandedDay = di;
  }
  hydrateFormNotesForDay(di);
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
  var keys = Object.keys(state.exercises || {});
  var hasExercises = keys.length > 0;

  // Ad-hoc session has a single sort zone — all exercises are ad-hoc.
  // Reorder within remaps sets for the current workout only (no plan).
  if (hasExercises) h += '<div class="sort-zone" data-sort-zone="adhoc" data-di="' + di + '">';
  var adRuns = groupRunsForRender(null, state.exercises || {});
  for (var ri = 0; ri < adRuns.length; ri++) {
    var run = adRuns[ri];
    if (run.kind === 'standalone') {
      var adCard = renderAdHocExerciseCard(di, run.ei, run.exState, null);
      ts += adCard.totalSets; cs += adCard.doneSets;
      h += adCard.html;
    } else {
      var adMembers = [];
      var adMinDone = Infinity, adMaxSets = 0;
      for (var mi = 0; mi < run.items.length; mi++) {
        var item = run.items[mi];
        var memBadge = String.fromCharCode(65) + (mi + 1);
        var memCard = renderAdHocExerciseCard(di, item.ei, item.exState, memBadge);
        adMembers.push({ ei: item.ei, cardHtml: memCard.html });
        ts += memCard.totalSets; cs += memCard.doneSets;
        var doneCount = countDoneSets(item.exState);
        var totalCount = item.exState && Array.isArray(item.exState.sets) ? item.exState.sets.length : 0;
        if (doneCount < adMinDone) adMinDone = doneCount;
        if (totalCount > adMaxSets) adMaxSets = totalCount;
      }
      var adCurrentRound = (adMinDone === Infinity ? 1 : Math.min(adMinDone + 1, adMaxSets || 1));
      var adRoundComplete = (adMinDone >= adMaxSets && adMaxSets > 0);
      h += renderSupersetBlock(di, adMembers, {
        key: run.groupKey,
        rest: run.rest,
        currentRound: adRoundComplete ? adMaxSets : adCurrentRound,
        totalRounds: adMaxSets
      }, false);
    }
  }
  if (hasExercises) h += '</div>';  // close ad-hoc sort-zone

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

  // Form notes: same day-switch + hydrate pattern as buildDay.
  if (_formNotesExpandedDay !== di) {
    formNotesExpanded = {};
    _formNotesExpandedDay = di;
  }
  hydrateFormNotesForDay(di);
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
  var soundRow = document.getElementById('menuRestTimerSound');
  if (soundRow) {
    soundRow.textContent = 'Rest timer sound (' + (getRestTimerSound() ? 'on' : 'off') + ')';
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

// Populate the three model <select>s from AVAILABLE_MODELS. Run before
// setVal'ing them so the saved option exists to be selected.
function populateModelSelects() {
  var ids = ['cpModelCoach', 'cpModelPlan', 'cpModelAnalyze'];
  for (var i = 0; i < ids.length; i++) {
    var sel = document.getElementById(ids[i]);
    if (!sel) continue;
    sel.innerHTML = '';
    for (var j = 0; j < AVAILABLE_MODELS.length; j++) {
      var m = AVAILABLE_MODELS[j];
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label + ' (' + m.tier + ')';
      sel.appendChild(opt);
    }
  }
}

// Fill every form control with the saved profile. Missing keys leave the
// control at its default empty state.
function populateCoachingProfileForm(p) {
  var setVal = function(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = (val == null) ? '' : String(val);
  };
  // Populate the model <select> options before setVal'ing — the saved
  // value's <option> must exist for the assignment to take effect.
  populateModelSelects();
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
  setVal('cpCoachContextWeeks', p.coach_context_weeks);
  setVal('cpModelCoach',   resolveModel(p.model_coach,   'coach'));
  setVal('cpModelPlan',    resolveModel(p.model_plan,    'plan'));
  setVal('cpModelAnalyze', resolveModel(p.model_analyze, 'analyze'));
  renderInjuryList(Array.isArray(p.injuries) ? p.injuries : []);
  renderMuscleBandsEditor(p.muscle_bands || {});
}

// Volume-targets editor (v3.6.14). One row per muscle from MUSCLE_BAND_ORDER,
// each row carries two mode-sections (primary, fractional) with 4 number
// inputs (MEV / MAV low / MAV high / MRV). Prefilled with the override OR
// the seed default; reading back compares to the seed so we only persist
// actual overrides (keeps coaching_profile.data lean).
function renderMuscleBandsEditor(overrides) {
  var host = document.getElementById('cpMuscleBandsList');
  if (!host) return;
  var h = '';
  for (var i = 0; i < MUSCLE_BAND_ORDER.length; i++) {
    var m = MUSCLE_BAND_ORDER[i];
    var seed = DEFAULT_MUSCLE_BANDS[m] || {};
    var ov = overrides[m] || {};
    var primary = ov.primary || seed.primary || null;
    var fractional = ov.fractional || seed.fractional || null;
    var hasFractionalSeed = !!seed.fractional;
    h += '<div class="cp-muscle-band-row" data-muscle="' + escapeAttr(m) + '">';
    h += '<div class="cp-muscle-band-name">' + escapeHtml(m) + '</div>';
    h += _muscleBandModeBlock(m, 'primary', primary, true);
    h += _muscleBandModeBlock(m, 'fractional', fractional, hasFractionalSeed);
    h += '</div>';
  }
  host.innerHTML = h;
}

function _muscleBandModeBlock(muscle, mode, band, hasSeed) {
  var label = mode === 'primary' ? 'Primary' : 'Fractional';
  var b = band || {};
  var hint = hasSeed ? '' : ' <span class="cp-muscle-band-hint">no seed</span>';
  var disabled = '';
  function inp(field, val) {
    var v = (val == null) ? '' : String(val);
    return '<input type="number" min="0" max="60" step="0.5" ' +
      'data-muscle="' + escapeAttr(muscle) + '" ' +
      'data-mode="' + mode + '" ' +
      'data-field="' + field + '" ' +
      'value="' + escapeAttr(v) + '" placeholder="—"' + disabled + '>';
  }
  var h = '<div class="cp-muscle-band-mode">';
  h += '<div class="cp-muscle-band-mode-label">' + label + hint + '</div>';
  h += '<div class="cp-muscle-band-inputs">';
  h += '<label>MEV' + inp('mev', b.mev) + '</label>';
  h += '<label>MAV lo' + inp('mavLow', b.mavLow) + '</label>';
  h += '<label>MAV hi' + inp('mavHigh', b.mavHigh) + '</label>';
  h += '<label>MRV' + inp('mrv', b.mrv) + '</label>';
  h += '</div>';
  h += '</div>';
  return h;
}

// Read current overrides off the DOM. For each (muscle, mode), if all
// four fields match the seed exactly OR are all blank, skip — keeps
// the persisted overrides map lean. Returns null when no overrides at
// all so the upsert clears the column rather than writing '{}'.
function readMuscleBandsFromDom() {
  var rows = document.querySelectorAll('#cpMuscleBandsList .cp-muscle-band-row');
  if (!rows.length) return null;
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var muscle = rows[i].getAttribute('data-muscle');
    if (!muscle) continue;
    var seed = DEFAULT_MUSCLE_BANDS[muscle] || {};
    var modes = ['primary', 'fractional'];
    var muscleOverrides = {};
    for (var mi = 0; mi < modes.length; mi++) {
      var mode = modes[mi];
      var fields = ['mev', 'mavLow', 'mavHigh', 'mrv'];
      var values = {};
      var allBlank = true;
      var anyInvalid = false;
      for (var fi = 0; fi < fields.length; fi++) {
        var field = fields[fi];
        var el = rows[i].querySelector('input[data-mode="' + mode + '"][data-field="' + field + '"]');
        var raw = el ? String(el.value).trim() : '';
        if (raw === '') {
          values[field] = null;
        } else {
          allBlank = false;
          var n = parseFloat(raw);
          if (!Number.isFinite(n)) {
            anyInvalid = true;
            values[field] = null;
          } else {
            values[field] = n;
          }
        }
      }
      if (allBlank || anyInvalid) continue;
      // All four present + finite — compare to seed.
      var seedMode = seed[mode];
      var sameAsSeed = !!(seedMode
        && seedMode.mev === values.mev
        && seedMode.mavLow === values.mavLow
        && seedMode.mavHigh === values.mavHigh
        && seedMode.mrv === values.mrv);
      if (sameAsSeed) continue;
      muscleOverrides[mode] = values;
    }
    if (Object.keys(muscleOverrides).length) out[muscle] = muscleOverrides;
  }
  return Object.keys(out).length ? out : null;
}

function resetAllMuscleBands() {
  if (!confirm('Reset every volume target back to defaults? Your overrides will be cleared on save.')) return;
  renderMuscleBandsEditor({});
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
    // v3.5.2 context-window override. Applies to coach chat + swap;
    // plan-gen / analyze / refine keep their per-call form input. Null
    // means "use default" (2 weeks); a number is clamped to 1-12 by both
    // the consumer (data.js) and the server (api/generate-plan.js swap)
    // so a manual edit in localStorage / Supabase can't push beyond the
    // sensible range.
    coach_context_weeks: (function() {
      var n = parseIntOrNull(getVal('cpCoachContextWeeks'));
      if (n == null) return null;
      if (n < 1) n = 1;
      if (n > 12) n = 12;
      return n;
    })(),
    // v3.2.0 model selections. Stored as plain strings; resolveModel on
    // read time handles invalid / retired IDs by falling back to default.
    model_coach:   trimOrNull(getVal('cpModelCoach'))   || null,
    model_plan:    trimOrNull(getVal('cpModelPlan'))    || null,
    model_analyze: trimOrNull(getVal('cpModelAnalyze')) || null,
    // v3.6.14 per-muscle MEV/MAV/MRV overrides. Sparse map keyed by
    // muscle then mode (primary | fractional); missing entries fall back
    // to DEFAULT_MUSCLE_BANDS at read time via muscleVolumeBand.
    muscle_bands: readMuscleBandsFromDom(),
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

// ---- Empty state (no active plan) ----

// Render the empty-state tracker view (no active plan). Three CTAs
// (Generate / Use a template / Blank session), a View full History
// link, and a Recent workouts list (5 most recent, tappable to open
// in the History detail modal).
//
// Called whenever the no-plan empty state needs to refresh — after
// endActivePlan, on hydrate's no-plan branch, and on sign-in when
// the user has no active plan.
function renderEmptyState() {
  var el = document.getElementById('emptyState');
  if (!el) return;

  var h = '';
  h += '<div class="empty-state-icon">🏋️</div>';
  h += '<h3>No active plan</h3>';
  h += '<p class="empty-state-hint">Pick something to work on, or generate a new plan.</p>';

  h += '<div class="empty-state-actions">';
  h += '<button type="button" class="empty-cta primary" id="emptyCtaGenerate">Generate a plan</button>';
  h += '<button type="button" class="empty-cta" id="emptyCtaTemplate">Use a template</button>';
  h += '<button type="button" class="empty-cta" id="emptyCtaBlank">Blank session</button>';
  h += '<button type="button" class="empty-cta link" id="emptyCtaHistory">View full History</button>';
  h += '</div>';

  h += '<div class="empty-state-recent" id="emptyStateRecent">';
  h += '<div class="empty-state-recent-label">Recent workouts</div>';
  h += '<div class="empty-state-recent-body">Loading…</div>';
  h += '</div>';

  el.innerHTML = h;

  // Wire button clicks. These reuse existing handlers — no new flows.
  var btnGen = document.getElementById('emptyCtaGenerate');
  if (btnGen) btnGen.addEventListener('click', function() { openGenerate(); });
  var btnTpl = document.getElementById('emptyCtaTemplate');
  if (btnTpl) btnTpl.addEventListener('click', function() {
    // The Templates flow lives inside the start screen as an inline
    // expanding card. Open the start screen — user clicks "Use a
    // template" there. One extra tap, but reuses the existing UX
    // without introducing a separate templates-picker modal.
    openStartScreen();
  });
  var btnBlank = document.getElementById('emptyCtaBlank');
  if (btnBlank) btnBlank.addEventListener('click', function() { createAdHocSession(); });
  var btnHist = document.getElementById('emptyCtaHistory');
  if (btnHist) btnHist.addEventListener('click', function() { openHistory(); });

  // Async-fill the Recent workouts list. Render immediately above so
  // the buttons show at 0ms; the list fades in when the query lands.
  fetchRecentWorkouts(userId, 5).then(function(rows) {
    recentWorkoutsCache = rows;
    renderEmptyStateRecent();
  });
}

function renderEmptyStateRecent() {
  var body = document.querySelector('#emptyStateRecent .empty-state-recent-body');
  if (!body) return;
  var rows = recentWorkoutsCache;
  if (!rows) { body.textContent = 'Loading…'; return; }
  if (!rows.length) {
    body.innerHTML = '<div class="empty-state-recent-empty">No prior workouts logged.</div>';
    return;
  }
  var h = '<div class="empty-state-recent-list">';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var d = new Date(r.performed_at);
    var dateLabel = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    var nameLabel;
    if (r.day_name) nameLabel = r.day_name;
    else if (r.title) nameLabel = r.title;
    else nameLabel = 'Ad-hoc session';
    var locTag = r.location_name ? ' · @' + escapeHtml(r.location_name) : '';
    var setLabel = r.set_count + ' set' + (r.set_count === 1 ? '' : 's');
    h += '<button type="button" class="empty-recent-row" data-recent-workout-id="' + escapeAttr(r.id) + '">';
    h += '<span class="empty-recent-date">' + escapeHtml(dateLabel) + '</span>';
    h += '<span class="empty-recent-name">' + escapeHtml(nameLabel) + '</span>';
    h += '<span class="empty-recent-meta">' + escapeHtml(setLabel) + locTag + '</span>';
    h += '</button>';
  }
  h += '</div>';
  body.innerHTML = h;

  // Click delegate: tap a row to open in the History detail modal.
  // openHistoryDetail writes to elements inside the History overlay
  // and assumes the overlay is already showing. Pre-fix we called
  // openHistory() then openHistoryDetail() — but those are both
  // async, and on the path where openHistory awaits loadEarliestWorkout
  // Date AND the detail fetch resolves first, openHistory resumed
  // afterward and clobbered the detail render with renderHistoryWeek.
  // Fix: mount the overlay synchronously, ensure historyWeekStart is
  // set so the back-button path is sensible, and call openHistoryDetail
  // directly with no parallel race.
  body.addEventListener('click', function(e) {
    var row = e.target.closest('[data-recent-workout-id]');
    if (!row) return;
    var wid = row.getAttribute('data-recent-workout-id');
    document.getElementById('historyOverlay').classList.add('show');
    if (!historyWeekStart) {
      historyWeekStart = weekStartForLocalDate(new Date(sessionTodayDateString() + 'T00:00:00'));
    }
    openHistoryDetail(wid);
  });
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
  // Generate path. Promoted to primary styling when there's no active
  // plan (the typical first-time-ever path), demoted to the standard
  // de-emphasized card otherwise (generation is rare vs. starting
  // today's session). Title text flips so the no-plan state reads as
  // "this is what you should do next".
  var generateBtn = document.getElementById('startPathGenerate');
  var generateTitle = document.getElementById('startPathGenerateTitle');
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
    generateBtn.classList.remove('primary');
    generateTitle.textContent = 'Generate a new plan';
  } else {
    suggestedBtn.style.display = 'none';
    pickDayBtn.style.display = 'none';
    emptyHint.classList.remove('hidden');
    generateBtn.classList.add('primary');
    generateTitle.textContent = 'Generate a plan';
  }

  // Close button is always available — the empty state is the no-plan
  // UI now (Generate / Template / Blank / View History + Recent
  // workouts), so dismissing this overlay always lands on a usable
  // surface. Pre-v3 we hid close when there was nothing to fall back to.
  closeBtn.classList.remove('hidden');

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
// Per-exercise modal with two tabs: Recent (prior sessions) and Form
// (AI coach notes + user's own notes, persisted in exercise_form_notes).
// State is module-scoped so tab switches don't trigger re-fetches.
var exModalState = { tab: 'recent', exerciseRow: null, exerciseName: null, sessionsHtml: '', formNotes: null, formGenerating: false };

// ---- Inline form notes on live cards (v3.6.10) ----
// formNotesCache mirrors the exercise_form_notes table for ids the user
// has touched recently. Hydrated batch-style by hydrateFormNotesForDay
// on every buildDay; mutated in place by the inline regen + blur paths
// AND by the modal save paths so all three surfaces share one source
// of truth. Never cleared between days — same exercise across days
// reuses its entry.
var formNotesCache = {};
// Per-card expansion state (collapsed by default). Keyed by ex_<ei> so
// re-rendering the same card (e.g. after a set toggle) keeps the panel
// open. Reset whenever buildDay paints a different day (currentDay flip).
var formNotesExpanded = {};
var _formNotesExpandedDay = null;
// Per-card AI generation in-flight flag. Disables the regen button +
// flips its label to "Generating…" until the API call resolves.
var formNotesGenerating = {};

async function openExerciseHistory(exerciseName) {
  var title = exerciseName || 'Recent';
  document.getElementById('exHistoryTitle').textContent = title;
  var body = document.getElementById('exHistoryBody');
  body.innerHTML = '<div class="history-empty">Loading…</div>';
  document.getElementById('exHistoryOverlay').classList.add('show');
  exModalState = { tab: 'recent', exerciseRow: null, exerciseName: exerciseName, sessionsHtml: '', formNotes: null, formGenerating: false };

  var row = resolveLibraryRow(exerciseName);
  if (!row) {
    body.innerHTML = '<div class="history-empty">No library entry for this exercise — form notes and history unavailable.</div>';
    return;
  }
  exModalState.exerciseRow = row;

  try {
    // Parallel: prior sessions (the existing query) + form notes for this
    // exercise. Form notes are usually a single row or null.
    var parallelRes = await Promise.all([
      sb.from('sets')
        // v3.6.18: pull weight_mode so each session can render its
        // effective mode tag ("Per side" / "Total"). Pre-v3.1.0 rows
        // have weight_mode = null — the session falls back to the
        // library default (row.weight_mode) for those.
        .select('id, weight, reps, rpe, set_order, done, note, duration_seconds, distance, weight_mode, workout_id, workouts(performed_at, plan_id, day_index, title, location_id)')
        .eq('user_id', userId)
        .eq('exercise_id', row.id)
        .eq('done', true)
        .limit(200),
      loadFormNotes(row.id),
    ]);
    var res = parallelRes[0];
    exModalState.formNotes = parallelRes[1];
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
      exModalState.sessionsHtml = '<div class="history-empty">No prior sessions logged for this exercise.</div>';
      renderExerciseModal();
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
      // Per-session effective weight mode (v3.6.18). Per-set override wins;
      // legacy null rows fall back to the library default (row.weight_mode).
      // Only the "per_side" case gets a tag in the rendered context line —
      // "Total" is the default-of-defaults and would be noisy to show on
      // every row. Bodyweight / none / cardio rows get no mode tag.
      var libDefaultMode = row && row.weight_mode ? row.weight_mode : 'total';
      var sessionMode = libDefaultMode;
      for (var smi = 0; smi < sess.sets.length; smi++) {
        var smRow = sess.sets[smi];
        if (smRow && smRow.weight_mode) { sessionMode = smRow.weight_mode; break; }
      }
      var modeRelevant = libDefaultMode !== 'bodyweight'
        && libDefaultMode !== 'none'
        && !isCardioExerciseName(exerciseName);
      if (modeRelevant && sessionMode === 'per_side') {
        contextText += ' · Per side';
      }
      var recentUnit = getWeightUnit();
      // Cardio rows render as "30:00 / 0.5mi" instead of weight × reps.
      // Detection by exercise (resolved via library) — historical pre-
      // cardio rows stay on the resistance format because library
      // wasn't yet 'cardio' when those sets were logged.
      var rowIsCardio = isCardioExerciseName(exerciseName);
      var setStrs = sess.sets.map(function(s) {
        if (rowIsCardio || s.duration_seconds != null) {
          var dur = s.duration_seconds != null ? formatDurationMSS(s.duration_seconds) : '—';
          if (s.distance != null) return dur + ' · ' + s.distance + 'mi';
          return dur;
        }
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
    exModalState.sessionsHtml = h;
    renderExerciseModal();
  } catch(err) {
    console.error('openExerciseHistory error:', err);
    exModalState.sessionsHtml = '<div class="history-empty">Couldn\'t load history for this exercise.</div>';
    renderExerciseModal();
  }
}

// Tab-aware render: tab strip + active section. Recent uses the
// pre-rendered sessions HTML built in openExerciseHistory; Form
// renders the AI Coach Notes + My Notes sections from
// exModalState.formNotes (loaded in parallel on open).
function renderExerciseModal() {
  var body = document.getElementById('exHistoryBody');
  if (!body) return;
  var tab = exModalState.tab || 'recent';
  var h = '<div class="ex-modal-tabs">';
  h += '<button type="button" class="ex-modal-tab' + (tab === 'recent' ? ' active' : '') + '" data-ex-tab="recent">Recent</button>';
  h += '<button type="button" class="ex-modal-tab' + (tab === 'form' ? ' active' : '') + '" data-ex-tab="form">Form</button>';
  h += '</div>';
  if (tab === 'recent') {
    h += '<div class="ex-modal-pane">' + (exModalState.sessionsHtml || '<div class="history-empty">No prior sessions logged for this exercise.</div>') + '</div>';
  } else {
    h += '<div class="ex-modal-pane">' + renderFormNotesPane() + '</div>';
  }
  body.innerHTML = h;
}

function renderFormNotesPane() {
  var fn = exModalState.formNotes || {};
  var aiNote = fn.ai_note || '';
  var aiAt = fn.ai_generated_at || '';
  var userNote = fn.user_note || '';
  var generating = !!exModalState.formGenerating;

  var aiTimestamp = '';
  if (aiAt) {
    try {
      var d = new Date(aiAt);
      aiTimestamp = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch(_) { aiTimestamp = ''; }
  }

  var h = '';
  // AI Coach Notes section
  h += '<div class="form-notes-section">';
  h += '<div class="form-notes-section-header">';
  h += '<span class="form-notes-section-label">AI Coach Notes</span>';
  h += '<button type="button" class="form-notes-regen-btn" id="btnFormNotesRegen"' + (generating ? ' disabled' : '') + '>' +
       (generating ? 'Generating…' : (aiNote ? 'Regenerate' : 'Ask the coach')) + '</button>';
  h += '</div>';
  if (aiNote) {
    h += '<div class="form-notes-text">' + escapeHtml(aiNote) + '</div>';
    if (aiTimestamp) {
      h += '<div class="form-notes-meta">Last generated: ' + escapeHtml(aiTimestamp) + '</div>';
    }
  } else if (generating) {
    h += '<div class="form-notes-text" style="opacity:0.6">…</div>';
  } else {
    h += '<div class="form-notes-empty">No AI notes yet — tap "Ask the coach" for 3-4 sentences of form cues. Saved per exercise so you can come back to them anytime.</div>';
  }
  h += '</div>';
  // User notes section
  h += '<div class="form-notes-section">';
  h += '<div class="form-notes-section-header">';
  h += '<span class="form-notes-section-label">My Notes</span>';
  h += '</div>';
  h += '<textarea class="form-notes-input" id="formNotesUserInput" rows="4" placeholder="Cues that work for you, weight progression notes, equipment quirks at this gym, anything you want to remember next time">' + escapeHtml(userNote) + '</textarea>';
  h += '<div class="form-notes-meta" id="formNotesUserSaveStatus" style="visibility:hidden;">Saved</div>';
  h += '</div>';
  return h;
}

async function onFormNotesRegen() {
  if (exModalState.formGenerating || !exModalState.exerciseRow) return;
  exModalState.formGenerating = true;
  renderExerciseModal();
  try {
    // Pass the current user note as additional context so the AI weaves
    // form-relevant cues from it into the description. Falls back to
    // the inline cache when the modal state was opened without a saved
    // row yet.
    var userNoteForModal = (exModalState.formNotes && exModalState.formNotes.user_note)
      || (formNotesCache[exModalState.exerciseRow.id] && formNotesCache[exModalState.exerciseRow.id].user_note)
      || '';
    var reply = await generateAiFormNote(exModalState.exerciseRow, userNoteForModal);
    await saveAiFormNote(exModalState.exerciseRow.id, reply);
    exModalState.formNotes = exModalState.formNotes || {};
    exModalState.formNotes.ai_note = reply;
    exModalState.formNotes.ai_generated_at = new Date().toISOString();
    // Mirror into the inline cache so the live card reflects the new
    // note without a roundtrip (the modal + card share one cache).
    formNotesCache[exModalState.exerciseRow.id] = Object.assign(
      {}, formNotesCache[exModalState.exerciseRow.id] || {}, {
        ai_note: reply,
        ai_generated_at: exModalState.formNotes.ai_generated_at,
      }
    );
  } catch (err) {
    console.error('onFormNotesRegen error:', err);
    showToast('Couldn\'t generate notes: ' + (err.message || 'unknown'), null);
  } finally {
    exModalState.formGenerating = false;
    renderExerciseModal();
  }
}

// Inline form-notes regen (v3.6.10). Same Claude flow as the modal,
// triggered from the inline pill's "Get form cue" / "Refresh" button.
// Resolves the exercise library row by id so the AI prompt has
// equipment + muscle_group + weight_mode (mirrors the modal path).
async function onInlineFormNotesRegen(ei, exerciseId) {
  var key = 'ex_' + ei;
  if (formNotesGenerating[key]) return;
  var row = exerciseLibraryById && exerciseLibraryById[exerciseId];
  if (!row) {
    showToast('Exercise not found in library — cannot generate.', null);
    return;
  }
  formNotesGenerating[key] = true;
  formNotesExpanded[key] = true;
  buildDay(currentDay);
  try {
    // Inline cache holds the current user_note (kept in sync by the
    // textarea blur handler + the modal save). Pass it through so the
    // AI factors any form-relevant cues into the regen.
    var userNoteForInline = (formNotesCache[exerciseId] && formNotesCache[exerciseId].user_note) || '';
    var reply = await generateAiFormNote(row, userNoteForInline);
    await saveAiFormNote(exerciseId, reply);
    formNotesCache[exerciseId] = Object.assign({}, formNotesCache[exerciseId] || {}, {
      ai_note: reply,
      ai_generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('onInlineFormNotesRegen error:', err);
    showToast("Couldn't generate notes: " + (err.message || 'unknown'), null);
  } finally {
    formNotesGenerating[key] = false;
    buildDay(currentDay);
  }
}

// Inline form-notes user-note save (v3.6.10). Fires on blur via the
// workoutContainer 'change' handler. Same upsert path as the modal;
// mirrors into formNotesCache so a re-render shows the saved text
// without re-fetching. Trims; empty string IS saved (user clearing).
async function onInlineFormNotesUserBlur(exerciseId, value) {
  if (!exerciseId) return;
  var text = String(value || '').trim();
  var prev = (formNotesCache[exerciseId] && formNotesCache[exerciseId].user_note) || '';
  if (text === prev) return;
  try {
    await saveUserFormNote(exerciseId, text);
    formNotesCache[exerciseId] = Object.assign({}, formNotesCache[exerciseId] || {}, {
      user_note: text,
    });
  } catch (err) {
    console.error('onInlineFormNotesUserBlur error:', err);
    showToast("Couldn't save note: " + (err.message || 'unknown'), null);
  }
}

async function onFormNotesUserBlur(textarea) {
  if (!exModalState.exerciseRow || !textarea) return;
  var text = String(textarea.value || '').trim();
  // No-op if value unchanged from what's already in state.
  var currentValue = (exModalState.formNotes && exModalState.formNotes.user_note) || '';
  if (text === currentValue) return;
  var status = document.getElementById('formNotesUserSaveStatus');
  if (status) { status.style.visibility = 'visible'; status.textContent = 'Saving…'; }
  try {
    await saveUserFormNote(exModalState.exerciseRow.id, text);
    exModalState.formNotes = exModalState.formNotes || {};
    exModalState.formNotes.user_note = text;
    // Mirror into the inline cache so the next live-card render
    // reflects the modal-side edit.
    formNotesCache[exModalState.exerciseRow.id] = Object.assign(
      {}, formNotesCache[exModalState.exerciseRow.id] || {}, { user_note: text }
    );
    if (status) {
      status.textContent = 'Saved';
      setTimeout(function() {
        var s2 = document.getElementById('formNotesUserSaveStatus');
        if (s2) s2.style.visibility = 'hidden';
      }, 1500);
    }
  } catch (err) {
    console.error('onFormNotesUserBlur error:', err);
    if (status) status.textContent = 'Save failed';
    showToast('Couldn\'t save note: ' + (err.message || 'unknown'), null);
  }
}

function closeExerciseHistory() {
  document.getElementById('exHistoryOverlay').classList.remove('show');
}

// Resolve the exercise_id for a live card. Substitution wins over the
// prescribed name so form notes track the actually-performed move
// (mirrors how persistSet picks exercise_id). Extras + ad-hoc carry
// exerciseId on exState directly. For prescribed plan exercises that
// haven't been logged yet, exerciseIdCache may not be seeded — fall
// back to the library by name so the inline pill renders pre-session
// too. Returns null only when nothing resolves.
function resolveCardExerciseId(planEx, exState) {
  if (exState && exState.subExercise && exState.subExercise.id) return exState.subExercise.id;
  if (exState && exState.exerciseId) return exState.exerciseId;
  if (planEx && planEx.name) {
    var normed = normName(planEx.name);
    var cached = exerciseIdCache[normed];
    if (cached) return cached;
    var lib = exerciseLibraryByName && exerciseLibraryByName[normed];
    if (lib && lib.id) return lib.id;
  }
  return null;
}

// Inline form-notes pill renderer (v3.6.10). Collapsed by default;
// expands inline to show the AI Coach Notes + My Notes content the
// modal exposes. Same data, no modal-open required. The "Get form
// cue" / "Refresh" button fires the existing generateAiFormNote flow
// so this surface stays a thin client of the modal's logic.
function renderInlineFormNotes(exerciseId, ei, readOnly) {
  if (!exerciseId) return '';
  var fn = formNotesCache[exerciseId] || {};
  var aiNote = fn.ai_note || '';
  var userNote = fn.user_note || '';
  var expanded = !!formNotesExpanded['ex_' + ei];
  var generating = !!formNotesGenerating['ex_' + ei];
  var label;
  if (aiNote && userNote) label = 'Form notes — AI + yours';
  else if (aiNote) label = 'Form notes — AI';
  else if (userNote) label = 'Form notes — yours';
  else label = 'Form notes';
  var caret = expanded ? '▾' : '▸';
  var exidAttr = escapeAttr(exerciseId);
  var h = '<div class="form-notes-inline' + (expanded ? ' expanded' : '') + '">';
  h += '<button type="button" class="form-notes-toggle" data-toggle-form-notes="1" data-ei="' + ei + '">' +
       '<span class="form-notes-caret">' + caret + '</span><span class="form-notes-toggle-label">' + escapeHtml(label) + '</span></button>';
  if (expanded) {
    h += '<div class="form-notes-body">';
    h += '<div class="form-notes-row">';
    h += '<div class="form-notes-row-header"><span class="form-notes-row-label">AI Coach Notes</span>';
    h += '<button type="button" class="form-notes-row-btn" data-regen-form-notes="1" data-ei="' + ei + '" data-exid="' + exidAttr + '"' +
         (generating ? ' disabled' : '') + '>' +
         (generating ? 'Generating…' : (aiNote ? 'Refresh' : 'Get form cue')) + '</button>';
    h += '</div>';
    if (aiNote) {
      h += '<div class="form-notes-text">' + escapeHtml(aiNote) + '</div>';
    } else if (generating) {
      h += '<div class="form-notes-text" style="opacity:.55">…</div>';
    } else {
      h += '<div class="form-notes-empty">Tap "Get form cue" for 3-4 sentences of cues you can come back to.</div>';
    }
    h += '</div>';
    h += '<div class="form-notes-row">';
    h += '<div class="form-notes-row-header"><span class="form-notes-row-label">My Notes</span></div>';
    h += '<textarea class="form-notes-inline-input" data-user-form-notes="1" data-exid="' + exidAttr + '" data-ei="' + ei + '" rows="2" placeholder="Cues, equipment quirks, anything to remember"' +
         (readOnly ? ' disabled' : '') + '>' + escapeHtml(userNote) + '</textarea>';
    h += '</div>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}

// Batch-hydrate formNotesCache for every exercise_id on `di`. Fires
// async after buildDay paints; re-renders the day only if the fresh
// load mutated any cached entry (so subsequent day switches with no
// new data don't double-paint). Pulls ids from todayState first
// (covers substitutions + extras + ad-hoc), falls back to the plan-
// day's prescribed names via exerciseIdCache for cards that aren't
// in state yet (pre-session view).
async function hydrateFormNotesForDay(di) {
  if (!userId) return;
  var ids = [];
  if (todayState && todayState.exercises) {
    for (var k in todayState.exercises) {
      var ex = todayState.exercises[k];
      if (!ex) continue;
      if (ex.subExercise && ex.subExercise.id) ids.push(ex.subExercise.id);
      else if (ex.exerciseId) ids.push(ex.exerciseId);
    }
  }
  function _hfnResolve(name) {
    if (!name) return null;
    var normed = normName(name);
    var cached = exerciseIdCache[normed];
    if (cached) return cached;
    var lib = exerciseLibraryByName && exerciseLibraryByName[normed];
    return (lib && lib.id) || null;
  }
  if (plan && plan.days && plan.days[di] && Array.isArray(plan.days[di].exercises)) {
    var dayPlan = plan.days[di];
    for (var ei = 0; ei < dayPlan.exercises.length; ei++) {
      var entry = dayPlan.exercises[ei];
      if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
        for (var mi = 0; mi < entry.exercises.length; mi++) {
          var m = entry.exercises[mi];
          var mid = _hfnResolve(m && m.name);
          if (mid) ids.push(mid);
        }
      } else if (entry) {
        var pid = _hfnResolve(entry.name);
        if (pid) ids.push(pid);
      }
    }
  }
  if (!ids.length) return;
  var fresh = await loadFormNotesBatch(ids);
  var changed = false;
  for (var fid in fresh) {
    var prev = formNotesCache[fid];
    var nxt = fresh[fid];
    if (!prev
        || prev.user_note !== nxt.user_note
        || prev.ai_note !== nxt.ai_note
        || prev.ai_generated_at !== nxt.ai_generated_at) {
      changed = true;
    }
    formNotesCache[fid] = nxt;
  }
  if (changed && currentDay === di) buildDay(di);
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

  // Default to the current week (Sun-anchored). v3.6.5: was previously
  // "current - 7" so mid-week opens didn't show a partial view, but
  // showing this week is more intuitive — the user just logged here.
  // If the user's first workout is in a future week (essentially never,
  // but defensive), fall back to the earliest-workout week.
  if (!historyWeekStart) {
    var currentStart = weekStartForLocalDate(new Date(sessionTodayDateString() + 'T00:00:00'));
    if (earliestWorkoutDate && addDaysToDateString(currentStart, 6) < earliestWorkoutDate) {
      historyWeekStart = weekStartForLocalDate(new Date(earliestWorkoutDate + 'T00:00:00'));
    } else {
      historyWeekStart = currentStart;
    }
  }

  renderHistoryWeek();
  if (!historyWeekCache[historyWeekStart]) {
    loadHistoryWeek(historyWeekStart);
  }
}

function closeHistory() {
  document.getElementById('historyOverlay').classList.remove('show');
  // Always exit history edit mode when leaving — re-entering a detail
  // should default back to read-only review.
  historyEditMode = false;
}

// Volume trends dashboard (v3.5.4). Hamburger entry → modal table with
// muscle groups as rows, last N weeks as columns, inline-SVG sparklines
// per muscle. Default 8 weeks; selectable 4/8/12. Fetches via
// fetchVolumeTrends which uses the same primary 1.0 + secondary 0.5
// counting as the History summary + analyze prompt — numbers match
// across surfaces.
var volumeTrendsState = { weeks: 8, inFlight: false, data: null };
async function openVolumeTrends() {
  var overlay = document.getElementById('volumeTrendsOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  await loadAndRenderVolumeTrends(volumeTrendsState.weeks);
}
function closeVolumeTrends() {
  document.getElementById('volumeTrendsOverlay').classList.remove('show');
}
async function loadAndRenderVolumeTrends(weeks) {
  if (volumeTrendsState.inFlight) return;
  volumeTrendsState.inFlight = true;
  volumeTrendsState.weeks = weeks;
  var body = document.getElementById('volumeTrendsBody');
  if (body) {
    body.innerHTML = renderVolumeTrendsControls(weeks) +
      '<div class="vt-loading">Loading…</div>';
  }
  try {
    if (!userId) throw new Error('Not signed in');
    var data = await fetchVolumeTrends(userId, weeks);
    volumeTrendsState.data = data;
    renderVolumeTrends(data, weeks);
  } catch (err) {
    console.error('loadAndRenderVolumeTrends error:', err);
    if (body) {
      body.innerHTML = renderVolumeTrendsControls(weeks) +
        '<div class="vt-empty">Couldn\'t load volume data: ' + escapeHtml(err.message || 'unknown error') + '</div>';
    }
  } finally {
    volumeTrendsState.inFlight = false;
  }
}
function renderVolumeTrendsControls(weeks) {
  var btns = [4, 8, 12].map(function(n) {
    var active = n === weeks ? ' active' : '';
    return '<button type="button" class="' + (active ? 'active' : '') + '" data-vt-weeks="' + n + '">' + n + 'w</button>';
  }).join('');
  var html = '<div class="vt-controls">' + btns + '</div>';
  html += '<div class="vt-banner">Sets/week target — accumulation: 10-20 · maintain/pre-cut: 8-12 · cut maintenance: 5-8. Counting: primary 1.0 + each secondary 0.5 (Schoenfeld).</div>';
  return html;
}
function renderVolumeTrends(data, weeks) {
  var body = document.getElementById('volumeTrendsBody');
  if (!body) return;
  var html = renderVolumeTrendsControls(weeks);
  if (!data.muscles.length) {
    html += '<div class="vt-empty">No completed sets in the last ' + weeks + ' weeks.</div>';
    body.innerHTML = html;
    return;
  }
  html += '<div class="vt-table-wrap"><table class="vt-table">';
  // Header: muscle | sparkline | week labels (oldest → newest) | avg
  html += '<thead><tr>';
  html += '<th style="text-align:left">Muscle</th>';
  html += '<th>Trend</th>';
  for (var wi = 0; wi < data.weeks.length; wi++) {
    html += '<th>' + escapeHtml(data.weeks[wi].label) + '</th>';
  }
  html += '<th>Avg</th>';
  html += '</tr></thead><tbody>';
  for (var mi = 0; mi < data.muscles.length; mi++) {
    var m = data.muscles[mi];
    var arr = data.byMuscle[m];
    html += '<tr>';
    html += '<td class="vt-muscle">' + escapeHtml(m) + '</td>';
    html += '<td>' + _vtSparklineSvg(arr) + '</td>';
    for (var ci = 0; ci < arr.length; ci++) {
      var v = arr[ci];
      var label = (v === Math.floor(v)) ? String(v) : v.toFixed(1);
      var zeroClass = v === 0 ? ' vt-zero' : '';
      html += '<td class="vt-week' + zeroClass + '">' + label + '</td>';
    }
    var avg = data.averages[m];
    var avgLabel = (avg === Math.floor(avg)) ? String(avg) : avg.toFixed(1);
    html += '<td class="vt-avg">' + avgLabel + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  body.innerHTML = html;
}
// Inline-SVG sparkline. Per-row scaling — each muscle uses its own y-axis
// max so the trend reads regardless of absolute volume. No chart library;
// ~30 lines of polyline + dots.
function _vtSparklineSvg(values) {
  var n = values.length;
  if (!n) return '';
  var w = 80, h = 24;
  var pad = 2;
  var maxV = 0;
  for (var i = 0; i < n; i++) if (values[i] > maxV) maxV = values[i];
  if (maxV <= 0) {
    return '<svg class="vt-spark" viewBox="0 0 ' + w + ' ' + h + '"><line x1="' + pad + '" y1="' + (h - pad) + '" x2="' + (w - pad) + '" y2="' + (h - pad) + '" stroke="currentColor" stroke-width="1" opacity="0.2"/></svg>';
  }
  var pts = [];
  var dots = '';
  for (var j = 0; j < n; j++) {
    var x = n === 1 ? w / 2 : pad + (j * (w - 2 * pad)) / (n - 1);
    var y = h - pad - ((values[j] / maxV) * (h - 2 * pad));
    pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="1.5" fill="currentColor"/>';
  }
  return '<svg class="vt-spark" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<polyline points="' + pts.join(' ') + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
    dots + '</svg>';
}

// ---- Bottom tab navigation (v3.6.0) ----
// Three primary destinations: Workout (existing tracker), Body (per-muscle
// weekly volume + targets), Log (launchpad to History + Volume Trends).
// Hamburger menu stays for less-frequent items; Coach FAB stays as the
// always-on layer (not a tab — it's a companion, not a destination).
async function setActiveView(name) {
  if (name !== 'workout' && name !== 'body' && name !== 'log') name = 'workout';
  activeView = name;
  document.body.setAttribute('data-view', name);
  // Update active class on tab buttons.
  var tabs = document.querySelectorAll('.bottom-tab');
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    t.classList.toggle('active', t.getAttribute('data-tab') === name);
  }
  if (name === 'body') {
    await renderBodyView();
  } else if (name === 'log') {
    renderLogView();
  }
}

// Body view: phase header + two chip blocks (this week's actual sets per
// muscle, projected weekly sets per muscle from the active plan). Each
// block renders TWO rows — primary-only and Schoenfeld fractional —
// color-coded against the per-muscle MEV/MAV/MRV bands (v3.6.14, was
// the single phase band pre-v3.6.14).
async function renderBodyView() {
  var body = document.getElementById('bodyViewBody');
  if (!body) return;

  var phase = (coachingProfile && coachingProfile.phase) || null;
  var goal = (coachingProfile && coachingProfile.goal_type) || null;

  var phaseLabel = phase ? (phase + ' phase') : 'phase not set in Coaching Profile';
  var goalLabel = goal ? (' · goal: ' + goal) : '';

  var h = '';
  h += '<div class="body-view-header">';
  h += '<div class="body-view-title">Sets per muscle this week</div>';
  h += '<div class="body-view-subtitle">' + escapeHtml(phaseLabel) + escapeHtml(goalLabel) + '</div>';
  h += '<div class="body-view-band">Each muscle has its own MEV / MAV / MRV band (edit in Coaching Profile → Volume targets). Primary = exercise\'s primary muscle only. Fractional = Schoenfeld (primary 1.0 + each secondary 0.5). Colors: green in MAV, yellow below MAV, red below MEV / over MRV, orange between MAV and MRV.</div>';
  h += '</div>';

  // Section 1: this week's actuals (live count from completed sets).
  h += '<div class="body-view-section">';
  h += '<div class="body-view-section-label">This week so far</div>';
  h += '<div id="bodyViewActualsSlot"><div class="body-view-section-empty">Loading…</div></div>';
  h += '</div>';

  // Section 2: projected from the active plan, if any.
  h += '<div class="body-view-section">';
  h += '<div class="body-view-section-label">Planned (active plan, full week)</div>';
  if (plan && Array.isArray(plan.days) && plan.days.length) {
    var projectedF = computePlanVolumeByMuscle(plan);
    var projectedP = computePlanVolumeByMusclePrimary(plan);
    h += _dualChipRowsHtml(projectedP, projectedF);
  } else {
    h += '<div class="body-view-section-empty">No active plan — generate or activate a template to see projected volume.</div>';
  }
  h += '</div>';

  body.innerHTML = h;

  // Async-load the actuals so the projected section paints immediately.
  if (!userId) {
    var slot = document.getElementById('bodyViewActualsSlot');
    if (slot) slot.innerHTML = '<div class="body-view-section-empty">Sign in to see this week\'s volume.</div>';
    return;
  }
  try {
    var todayStr = sessionTodayDateString();
    var weekStart = weekStartForLocalDate(new Date(todayStr + 'T00:00:00'));
    var weekEnd = addDaysToDateString(weekStart, 6);
    var summary = await fetchWeekSummary(userId, weekStart, weekEnd);
    var slot2 = document.getElementById('bodyViewActualsSlot');
    if (!slot2) return;
    var actualsF = (summary && summary.volumeByMuscleGroup) || {};
    var actualsP = (summary && summary.volumeByMuscleGroupPrimary) || {};
    if (!Object.keys(actualsF).length && !Object.keys(actualsP).length) {
      slot2.innerHTML = '<div class="body-view-section-empty">No completed sets this week yet.</div>';
      return;
    }
    slot2.innerHTML = _dualChipRowsHtml(actualsP, actualsF);
  } catch (err) {
    console.error('renderBodyView actuals error:', err);
    var slotE = document.getElementById('bodyViewActualsSlot');
    if (slotE) slotE.innerHTML = '<div class="body-view-section-empty">Couldn\'t load this week\'s data.</div>';
  }
}

// Render two parallel chip rows — Primary and Fractional — over the
// same muscle ordering. Each chip carries its own status (computed
// against the per-(muscle, mode) MEV/MAV/MRV band) so the same muscle
// can light up different colors under the two methods (the whole
// point: rear delts ~ MEV under primary, in-MAV under fractional).
// Muscles sorted by fractional count desc so the row order matches at
// a glance.
function _dualChipRowsHtml(primaryCounts, fractionalCounts) {
  var primary = primaryCounts || {};
  var fractional = fractionalCounts || {};
  var seen = {};
  var muscles = [];
  function add(m) { if (m && !seen[m]) { seen[m] = true; muscles.push(m); } }
  Object.keys(fractional).forEach(add);
  Object.keys(primary).forEach(add);
  if (!muscles.length) return '<div class="body-view-section-empty">No data.</div>';
  muscles.sort(function(a, b) {
    var fa = fractional[a] != null ? fractional[a] : (primary[a] || 0);
    var fb = fractional[b] != null ? fractional[b] : (primary[b] || 0);
    return fb - fa;
  });
  function chipFor(m, mode, counts) {
    var raw = counts[m];
    var v = (raw == null) ? 0 : raw;
    var label = (v === Math.floor(v)) ? String(v) : v.toFixed(1);
    // Zero stays grey regardless of band (signal: "no data in this mode").
    if (v === 0) {
      return '<span class="pv-chip pv-empty" title="0 sets in this mode">' +
        escapeHtml(m) + ' 0</span>';
    }
    // Non-zero: prefer this mode's band; fall back to the other mode's
    // band as a proxy when this mode is unconfigured (v3.6.17). Forearms'
    // fractional band is the trigger case — the user's reference table
    // marked it "not standardized," but the primary band is a reasonable
    // proxy and the user expects 10.5 sets to render with a band color,
    // not as a grey empty chip.
    var band = muscleVolumeBand(m, mode);
    var bandSource = mode;
    if (!band) {
      var otherMode = mode === 'primary' ? 'fractional' : 'primary';
      var fallback = muscleVolumeBand(m, otherMode);
      if (fallback) {
        band = fallback;
        bandSource = otherMode + ' (fallback)';
      }
    }
    if (!band) {
      // No band in either mode — render with a neutral "unknown" treatment
      // (still distinct from zero grey). Value is real; we just have no
      // ruler to grade it against.
      return '<span class="pv-chip pv-empty" title="No band configured for ' + escapeAttr(m) + '">' +
        escapeHtml(m) + ' ' + label + '</span>';
    }
    var status = muscleBandStatus(v, band);
    var cls = muscleBandStatusCssClass(status);
    var title = 'MEV ' + band.mev + ' · MAV ' + band.mavLow + '-' + band.mavHigh +
                ' · MRV ' + band.mrv + ' (' + bandSource + ')';
    return '<span class="pv-chip ' + cls + '" title="' + escapeAttr(title) + '">' +
      escapeHtml(m) + ' ' + label + '</span>';
  }
  function row(label, mode, counts) {
    var chips = muscles.map(function(m) { return chipFor(m, mode, counts); }).join('');
    return '<div class="dual-chip-row">' +
      '<div class="dual-chip-row-label">' + label + '</div>' +
      '<div class="plan-volume-chips">' + chips + '</div></div>';
  }
  return '<div class="dual-chip-rows">' +
    row('Primary', 'primary', primary) +
    row('Fractional', 'fractional', fractional) +
    '</div>';
}

// Log view: launchpad to existing History modal + Volume Trends modal.
// Two big cards. Lighter v1 — inlining the full History/Trends content
// would mean refactoring those modals' click handlers, deferred for v2.
function renderLogView() {
  var body = document.getElementById('logViewBody');
  if (!body) return;
  var h = '';
  h += '<button class="log-card" type="button" data-log-card="history">';
  h += '<div class="log-card-title">History</div>';
  h += '<div class="log-card-desc">Week-by-week sessions. Tap a workout to see set-level detail or edit retroactively.</div>';
  h += '</button>';
  h += '<button class="log-card" type="button" data-log-card="trends">';
  h += '<div class="log-card-title">Volume trends</div>';
  h += '<div class="log-card-desc">Sets per muscle group over the last 4-12 weeks with sparklines, against Schoenfeld bands.</div>';
  h += '</button>';
  body.innerHTML = h;
}

function backToHistoryWeek() {
  historyView = 'week';
  historyEditMode = false;
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
  // Per-plan breakdown footer — only when the week spans more than one
  // plan (e.g., user ended Plan A mid-week and started Plan B). With a
  // single plan, the headline "Days N / M" + "Plan complete %" stats
  // already tell the full story.
  var pb = Array.isArray(summary.plansBreakdown) ? summary.plansBreakdown : [];
  if (pb.length > 1) {
    var parts = pb.map(function(p) {
      var title = p.planTitle || 'Plan';
      var line = title + ': ' + p.daysTrained + '/' + (p.daysPlanned != null ? p.daysPlanned : '?');
      if (p.completionRate != null) {
        line += ' (' + Math.round(p.completionRate * 100) + '%)';
      }
      return line;
    });
    h += '<div class="history-week-plans">' + escapeHtml(parts.join(' · ')) + '</div>';
  }
  // Per-muscle-group set count for the week (Schoenfeld-style fractional
  // counting: primary 1.0 + each secondary 0.5). Sorted high-to-low so
  // the deficit / excess pattern reads at a glance. Halves render with
  // one decimal (e.g., "12.5"); whole numbers render as integers.
  var vbm = summary.volumeByMuscleGroup || {};
  var muscles = Object.keys(vbm);
  if (muscles.length) {
    muscles.sort(function(a, b) { return vbm[b] - vbm[a]; });
    var muscleParts = muscles.map(function(m) {
      var v = Math.round(vbm[m] * 10) / 10;
      var label = (v === Math.floor(v)) ? String(v) : v.toFixed(1);
      return m + ' ' + label;
    });
    h += '<div class="history-week-volume">Sets by muscle: ' +
         escapeHtml(muscleParts.join(' · ')) + '</div>';
  }
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
  var h = '<div class="history-detail' + (historyEditMode ? ' history-edit-on' : '') + '">';
  h += '<div class="history-detail-header">';
  h += '<div class="history-detail-meta">' + escapeHtml(dateText) + (isAdHoc ? ' · ad-hoc' : '') + escapeHtml(gymText) + '</div>';
  if (state.startedAt && state.endedAt) {
    var ms = sessionElapsedMs(state);
    h += '<div class="session-bar done" style="margin-top:12px"><div class="session-duration">Session: ' + fmtDuration(ms) + '</div>' +
         renderDurationEditBtn(workout.id, ms, state.endedAt, 'history') + '</div>';
  }
  // Edit toggle (v2.5.13) — flip the whole detail into editable mode for
  // post-hoc corrections (forgot a weight, missed an RPE, want to add
  // a note). Auto-saves to DB on every change; no Save button.
  h += '<button type="button" class="history-edit-toggle' + (historyEditMode ? ' on' : '') + '" id="btnHistoryEditToggle" data-workout-id="' + escapeAttr(workout.id) + '">' +
       (historyEditMode ? 'Done editing' : 'Edit') +
       '</button>';
  h += '</div>';

  // Workout-level notes — always visible (was previously hidden in
  // history detail). When edit mode is on, the textarea is editable
  // and saves on blur via historyUpdateWorkoutNotes.
  var workoutNotes = (state.notes || workout.notes || '').trim();
  if (historyEditMode || workoutNotes) {
    h += '<div class="history-workout-notes">';
    h += '<div class="history-notes-label">SESSION NOTES</div>';
    if (historyEditMode) {
      h += '<textarea class="exercise-note-input history-notes-input" rows="2" ' +
           'data-history-workout-notes="' + escapeAttr(workout.id) + '" ' +
           'placeholder="How did the session go? Anything to remember for next time?">' +
           escapeHtml(workoutNotes) + '</textarea>';
    } else {
      h += '<div class="history-notes-display">' + escapeHtml(workoutNotes) + '</div>';
    }
    h += '</div>';
  }

  if (isAdHoc) {
    var ahRuns = groupRunsForRender(null, state.exercises);
    for (var ari = 0; ari < ahRuns.length; ari++) {
      var ahRun = ahRuns[ari];
      if (ahRun.kind === 'standalone') {
        var ahMeta = (ahRun.exState && ahRun.exState.exerciseMeta) || { name: 'Exercise', weight_mode: 'total' };
        h += renderHistoryExerciseCard(ahRun.ei, ahRun.exState, ahMeta.name,
          effectiveWeightMode(ahRun.exState.sets[0], ahMeta), null, workout.id, null);
      } else {
        // Block: each member is read-only; block structure read-only too.
        var ahMembers = [];
        var ahMinDone = Infinity, ahMaxSets = 0;
        for (var ami = 0; ami < ahRun.items.length; ami++) {
          var ahItem = ahRun.items[ami];
          var ahMemMeta = (ahItem.exState && ahItem.exState.exerciseMeta) || { name: 'Exercise', weight_mode: 'total' };
          var ahBadge = String.fromCharCode(65) + (ami + 1);
          var ahCardHtml = renderHistoryExerciseCard(ahItem.ei, ahItem.exState, ahMemMeta.name,
            effectiveWeightMode(ahItem.exState.sets[0], ahMemMeta), null, workout.id, ahBadge);
          ahMembers.push({ ei: ahItem.ei, cardHtml: ahCardHtml });
          var ahDone = countDoneSets(ahItem.exState);
          var ahTotal = (ahItem.exState && Array.isArray(ahItem.exState.sets)) ? ahItem.exState.sets.length : 0;
          if (ahDone < ahMinDone) ahMinDone = ahDone;
          if (ahTotal > ahMaxSets) ahMaxSets = ahTotal;
        }
        var ahCurrentRound = (ahMinDone === Infinity ? 1 : Math.min(ahMinDone + 1, ahMaxSets || 1));
        var ahRoundComplete = (ahMinDone >= ahMaxSets && ahMaxSets > 0);
        h += renderSupersetBlock(null, ahMembers, {
          key: ahRun.groupKey,
          rest: ahRun.rest,
          currentRound: ahRoundComplete ? ahMaxSets : ahCurrentRound,
          totalRounds: ahMaxSets
        }, true);
      }
    }
  } else if (dayPlan) {
    // Walk via state runs (workouts.superset_groups is the truth for
    // historical structure, not the possibly-mutated plan.data). Prescribed
    // sets lookup falls back to dayPlan.exercises by member name when the
    // member's name matches an entry — best-effort because plan.data may
    // have been mutated since the workout was logged.
    var pdRuns = groupRunsForRender(null, state.exercises);
    // Track the member-eis we render via runs; anything beyond that flat
    // range is an "extra" (added exercise on a plan day).
    var renderedEis = {};
    function pdResolveMemberMeta(item) {
      var meta = (item.exState && item.exState.exerciseMeta) || null;
      var nameFromMeta = meta && meta.name;
      var planLenLocal = dayPlan.exercises.length;
      // For plan-day prescribed members: when the workout's exercise_order
      // is within plan length AND plan still has a regular exercise at that
      // flat slot, pull the prescribed sets and library-default weight_mode.
      var exLocal = (item.ei < planLenLocal) ? dayPlan.exercises[item.ei] : null;
      var isPlanRegular = exLocal && !exLocal.superset && exLocal.name;
      if (isPlanRegular) {
        return {
          name: exLocal.name,
          weightMode: (item.exState.sets[0] && item.exState.sets[0].weight_mode) || weightModeForName(exLocal.name),
          prescribedSets: exLocal.sets || null
        };
      }
      // Fallback: use exerciseMeta (works for ad-hoc-style extras and for
      // members that don't align with current plan structure — common when
      // plan.data has been mutated since the workout was logged).
      return {
        name: nameFromMeta || ('Exercise ' + (item.ei + 1)),
        weightMode: effectiveWeightMode(item.exState.sets[0], meta || { weight_mode: 'total' }),
        prescribedSets: null
      };
    }
    for (var pri = 0; pri < pdRuns.length; pri++) {
      var pdRun = pdRuns[pri];
      if (pdRun.kind === 'standalone') {
        var pdMeta = pdResolveMemberMeta({ ei: pdRun.ei, exState: pdRun.exState });
        h += renderHistoryExerciseCard(pdRun.ei, pdRun.exState, pdMeta.name,
          pdMeta.weightMode, pdMeta.prescribedSets, workout.id, null);
        renderedEis[pdRun.ei] = true;
      } else {
        var pdMembers = [];
        var pdMinDone = Infinity, pdMaxSets = 0;
        for (var pmi = 0; pmi < pdRun.items.length; pmi++) {
          var pdItem = pdRun.items[pmi];
          var pdMemMeta = pdResolveMemberMeta(pdItem);
          var pdBadge = String.fromCharCode(65) + (pmi + 1);
          var pdCardHtml = renderHistoryExerciseCard(pdItem.ei, pdItem.exState, pdMemMeta.name,
            pdMemMeta.weightMode, pdMemMeta.prescribedSets, workout.id, pdBadge);
          pdMembers.push({ ei: pdItem.ei, cardHtml: pdCardHtml });
          renderedEis[pdItem.ei] = true;
          var pdDone = countDoneSets(pdItem.exState);
          var pdTotal = (pdItem.exState && Array.isArray(pdItem.exState.sets)) ? pdItem.exState.sets.length : 0;
          if (pdDone < pdMinDone) pdMinDone = pdDone;
          if (pdTotal > pdMaxSets) pdMaxSets = pdTotal;
        }
        var pdCurrentRound = (pdMinDone === Infinity ? 1 : Math.min(pdMinDone + 1, pdMaxSets || 1));
        var pdRoundComplete = (pdMinDone >= pdMaxSets && pdMaxSets > 0);
        h += renderSupersetBlock(null, pdMembers, {
          key: pdRun.groupKey,
          rest: pdRun.rest,
          currentRound: pdRoundComplete ? pdMaxSets : pdCurrentRound,
          totalRounds: pdMaxSets
        }, true);
      }
    }
    // Extras: state.exercises entries with ei beyond the runs walker
    // already rendered via renderedEis (ad-hoc cards added on a plan day).
    // Pre-task this was filtered by `>= planLen` based on dayPlan length;
    // we now use the runs walker's accounting so blocks correctly mark
    // their own members as rendered.
    var extraEis = [];
    for (var ekX in state.exercises) {
      if (!state.exercises.hasOwnProperty(ekX)) continue;
      var eiX = parseInt(ekX.slice(3), 10);
      if (!renderedEis[eiX]) extraEis.push(eiX);
    }
    extraEis.sort(function(a, b) { return a - b; });
    if (extraEis.length) h += '<div class="extras-divider">Added exercises</div>';
    for (var ex_i = 0; ex_i < extraEis.length; ex_i++) {
      var eiE = extraEis[ex_i];
      var ekE = 'ex_' + eiE;
      var stE = state.exercises[ekE];
      var metaE = stE.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
      h += renderHistoryExerciseCard(eiE, stE, metaE.name,
        effectiveWeightMode(stE.sets[0], metaE), null, workout.id, null);
    }
  } else {
    h += '<div class="history-empty">Plan data for this workout isn\'t available; showing raw sets instead.</div>';
    var fbRuns = groupRunsForRender(null, state.exercises);
    for (var fri = 0; fri < fbRuns.length; fri++) {
      var fbRun = fbRuns[fri];
      if (fbRun.kind === 'standalone') {
        var fbMeta = (fbRun.exState && fbRun.exState.exerciseMeta) || { name: 'Exercise ' + (fbRun.ei + 1), weight_mode: 'total' };
        h += renderHistoryExerciseCard(fbRun.ei, fbRun.exState, fbMeta.name,
          effectiveWeightMode(fbRun.exState.sets[0], fbMeta), null, workout.id, null);
      } else {
        var fbMembers = [];
        var fbMinDone = Infinity, fbMaxSets = 0;
        for (var fmi = 0; fmi < fbRun.items.length; fmi++) {
          var fbItem = fbRun.items[fmi];
          var fbMemMeta = (fbItem.exState && fbItem.exState.exerciseMeta) || { name: 'Exercise ' + (fbItem.ei + 1), weight_mode: 'total' };
          var fbBadge = String.fromCharCode(65) + (fmi + 1);
          var fbCardHtml = renderHistoryExerciseCard(fbItem.ei, fbItem.exState, fbMemMeta.name,
            effectiveWeightMode(fbItem.exState.sets[0], fbMemMeta), null, workout.id, fbBadge);
          fbMembers.push({ ei: fbItem.ei, cardHtml: fbCardHtml });
          var fbDone = countDoneSets(fbItem.exState);
          var fbTotal = (fbItem.exState && Array.isArray(fbItem.exState.sets)) ? fbItem.exState.sets.length : 0;
          if (fbDone < fbMinDone) fbMinDone = fbDone;
          if (fbTotal > fbMaxSets) fbMaxSets = fbTotal;
        }
        var fbCurrentRound = (fbMinDone === Infinity ? 1 : Math.min(fbMinDone + 1, fbMaxSets || 1));
        var fbRoundComplete = (fbMinDone >= fbMaxSets && fbMaxSets > 0);
        h += renderSupersetBlock(null, fbMembers, {
          key: fbRun.groupKey,
          rest: fbRun.rest,
          currentRound: fbRoundComplete ? fbMaxSets : fbCurrentRound,
          totalRounds: fbMaxSets
        }, true);
      }
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

// ---- History edit mode handlers (v2.5.13) ----
// Each handler resolves the edited target via data attributes, calls the
// matching historyUpdate* helper in data.js, mirrors the change into the
// in-memory historyDetails cache so the next render reflects it, and
// re-renders the detail (only when the change might affect derived UI
// like exercise status / completion counts; pure-value edits skip the
// re-render to avoid losing focus while typing).

// Find the history detail's workoutId from the detail container; fallback
// to the modal title if needed. The detail's data-history-detail attr
// would be more robust, but the existing render doesn't add one — using
// historyDetails as source of truth: the modal only opens one workout
// at a time, so whichever is in cache and active is the one we're
// editing. We pick it via the dedicated open-detail handler that sets
// it (see openHistoryDetail).
function _historyDetailWorkoutId() {
  // The Edit toggle button carries the workout id — read that.
  var t = document.getElementById('btnHistoryEditToggle');
  return t ? t.getAttribute('data-workout-id') : null;
}

// History edit: + Add Set (v3.6.3). Resolves the exercise_id from the
// most recent populated set in the exercise (handles substitution mid-
// workout — inherits the substitute's id). Carries forward weight/reps
// (or duration_seconds/distance for cardio) from the same source row.
// Inserts via historyAddSet, then patches historyDetails state so the
// re-render shows the new row immediately.
async function onHistoryAddSet(workoutId, ei) {
  var detail = historyDetails && historyDetails[workoutId];
  if (!detail || !detail.state) return;
  var ek = 'ex_' + ei;
  var exState = detail.state.exercises[ek];
  if (!exState || !Array.isArray(exState.sets)) return;
  var exerciseId = null;
  var hint = {};
  for (var i = exState.sets.length - 1; i >= 0; i--) {
    var prev = exState.sets[i];
    if (!prev) continue;
    if (!exerciseId && prev.exerciseId) exerciseId = prev.exerciseId;
    if (Object.keys(hint).length === 0) {
      if (prev.duration_seconds != null) {
        hint.duration_seconds = prev.duration_seconds;
        if (prev.distance != null) hint.distance = prev.distance;
      } else if (prev.weight != null || prev.reps != null) {
        if (prev.weight != null) hint.weight = prev.weight;
        if (prev.reps != null) hint.reps = prev.reps;
      }
    }
    if (exerciseId && Object.keys(hint).length > 0) break;
  }
  if (!exerciseId) {
    showToast('Cannot add set — no prior set on this exercise to inherit from', null);
    return;
  }
  try {
    var newRow = await historyAddSet(workoutId, ei, exerciseId, hint);
    // Patch in-memory: index the new set at its new set_order. Mark
    // isExtra:true so the × delete affordance renders on this row only
    // (prescribed rows stay protected).
    exState.sets[newRow.set_order] = {
      setId: newRow.id,
      weight: newRow.weight,
      reps: newRow.reps,
      duration_seconds: newRow.duration_seconds != null ? newRow.duration_seconds : null,
      distance: newRow.distance != null ? newRow.distance : null,
      done: false,
      isExtra: true,
      exerciseId: exerciseId,
      setType: newRow.set_type || 'standard',
      parentSetIdx: null,
    };
    invalidateHistoryWeekCache();
    renderHistoryDetail(detail);
  } catch (err) {
    console.error('onHistoryAddSet error:', err);
    showToast("Couldn't add set: " + (err.message || 'unknown'), null);
  }
}

// History edit: × delete on user-added sets (v3.6.3). Splices the row
// from in-memory state and DELETEs the DB row. No confirm dialog —
// matches the live-session behavior on extras (delete is reversible
// only by re-adding; the historical context already implies caution).
async function onHistoryDeleteSet(workoutId, ei, si) {
  var detail = historyDetails && historyDetails[workoutId];
  if (!detail || !detail.state) return;
  var ek = 'ex_' + ei;
  var exState = detail.state.exercises[ek];
  if (!exState || !Array.isArray(exState.sets)) return;
  var sl = exState.sets[si];
  if (!sl || !sl.setId) return;
  if (!sl.isExtra) return;  // safety: prescribed rows are not deletable
  try {
    await historyDeleteSet(sl.setId);
    exState.sets.splice(si, 1);
    invalidateHistoryWeekCache();
    renderHistoryDetail(detail);
  } catch (err) {
    console.error('onHistoryDeleteSet error:', err);
    showToast("Couldn't delete set: " + (err.message || 'unknown'), null);
  }
}

function onHistorySetCheckClick(btnEl) {
  var widCheck = _historyDetailWorkoutId();
  var ei = parseInt(btnEl.getAttribute('data-ei'), 10);
  var si = parseInt(btnEl.getAttribute('data-si'), 10);
  var detail = widCheck && historyDetails[widCheck];
  if (!detail) return;
  var sl = detail.state.exercises['ex_' + ei] && detail.state.exercises['ex_' + ei].sets[si];
  if (!sl || !sl.setId) {
    // Set not yet persisted -- shouldn't happen for historical workouts,
    // but bail out safely.
    showToast("Can't toggle this set", null);
    return;
  }
  var newDone = !sl.done;
  historyUpdateSetDone(sl.setId, newDone, detail.workout && detail.workout.started_at).then(function() {
    sl.done = newDone;
    if (newDone) {
      sl.completedAt = detail.workout && detail.workout.started_at
        ? detail.workout.started_at
        : new Date().toISOString();
    } else {
      sl.completedAt = null;
    }
    invalidateHistoryWeekCache();
    renderHistoryDetail(detail);
  }).catch(function(err) {
    console.error('history set toggle failed:', err);
    showToast("Couldn't update set: " + (err.message || ''), null);
  });
}

function onHistorySetInputChange(input) {
  var widIn = _historyDetailWorkoutId();
  var ei = parseInt(input.getAttribute('data-ei'), 10);
  var si = parseInt(input.getAttribute('data-si'), 10);
  var field = input.getAttribute('data-field');
  var detail = widIn && historyDetails[widIn];
  if (!detail || !field) return;
  var sl = detail.state.exercises['ex_' + ei] && detail.state.exercises['ex_' + ei].sets[si];
  if (!sl || !sl.setId) return;
  // Parse value per field type — same rules as logSet's input handler.
  var val = input.value;
  var parsed;
  if (val === '' || val == null) {
    parsed = null;
  } else if (field === 'weight') {
    parsed = parseWeightInput(val, getWeightUnit());
  } else if (field === 'duration_seconds') {
    parsed = parseDurationMSS(val);
  } else {
    parsed = parseFloat(val);
    if (isNaN(parsed)) parsed = null;
  }
  historyUpdateSetField(sl.setId, field, parsed).then(function() {
    sl[field] = parsed;
    invalidateHistoryWeekCache();
    // Don't re-render -- the user is mid-edit and we don't want to
    // steal focus. The exercise-card status badge is now slightly
    // stale until the next interaction triggers a re-render, which
    // is acceptable for plain value edits.
  }).catch(function(err) {
    console.error('history set field update failed:', err);
    showToast("Couldn't save: " + (err.message || ''), null);
  });
}

function onHistoryRpeClick(btnEl) {
  var widR = _historyDetailWorkoutId();
  var ei = parseInt(btnEl.getAttribute('data-history-ex-order'), 10);
  var rpe = parseInt(btnEl.getAttribute('data-history-rpe'), 10);
  var detail = widR && historyDetails[widR];
  if (!detail || !Number.isFinite(rpe)) return;
  var exState = detail.state.exercises['ex_' + ei];
  if (!exState) return;
  // Toggle: if the user taps the currently-selected RPE, clear it.
  var newRpe = exState.rpe === rpe ? null : rpe;
  historyUpdateExerciseRpe(widR, ei, newRpe).then(function() {
    exState.rpe = newRpe;
    invalidateHistoryWeekCache();
    renderHistoryDetail(detail);  // re-render so the .selected class flips
  }).catch(function(err) {
    console.error('history rpe update failed:', err);
    showToast("Couldn't save RPE: " + (err.message || ''), null);
  });
}

function onHistoryExerciseNoteChange(input) {
  var widN = _historyDetailWorkoutId();
  var ei = parseInt(input.getAttribute('data-history-ex-order'), 10);
  var detail = widN && historyDetails[widN];
  if (!detail) return;
  var exState = detail.state.exercises['ex_' + ei];
  if (!exState) return;
  var newNote = (input.value || '').trim() || null;
  historyUpdateExerciseNote(widN, ei, newNote).then(function() {
    exState.note = newNote || '';
    invalidateHistoryWeekCache();
    // No re-render — keep focus.
  }).catch(function(err) {
    console.error('history exercise note update failed:', err);
    showToast("Couldn't save note: " + (err.message || ''), null);
  });
}

function onHistoryWorkoutNotesChange(input) {
  var widW = input.getAttribute('data-history-workout-notes');
  var detail = widW && historyDetails[widW];
  if (!detail) return;
  var newNotes = (input.value || '').trim() || null;
  historyUpdateWorkoutNotes(widW, newNotes).then(function() {
    detail.workout.notes = newNotes;
    detail.state.notes = newNotes || '';
    invalidateHistoryWeekCache();
    // No re-render — keep focus.
  }).catch(function(err) {
    console.error('history workout notes update failed:', err);
    showToast("Couldn't save session notes: " + (err.message || ''), null);
  });
}

function renderHistoryExerciseCard(ei, exState, name, weightMode, prescribedSets, histWorkoutId, badgeLabel) {
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
  // Cardio detection for history rows: look the name up in the library.
  // Exercises imported pre-cardio-feature have weight/reps logged with
  // duration_seconds null, so the history row falls back to the
  // resistance render even when name says "treadmill walk" — accurate.
  var isCardioRow = isCardioExerciseName(name);
  // disabledAttr is the lever for history-edit mode (v2.5.13). When
  // historyEditMode is on, all set inputs / RPE buttons / note textareas
  // render WITHOUT the disabled attribute, so the existing event
  // delegation on historyBody can pick up changes and route them to the
  // history-update helpers (instead of the today-state-coupled persistSet).
  var disabledAttr = historyEditMode ? '' : ' disabled';

  var h = '';
  h += '<div class="exercise-card' + cc + '" data-history-ex-order="' + ei + '">';
  // Wrap name in .exercise-name-block so the chip can stack beneath the
  // name, matching the live cards' layout. chipMeta falls back to a
  // name-based library lookup for prescribed plan-day rows where
  // exState.exerciseMeta is null.
  var histChipCtx = historyEditMode ? 'history-edit' : 'history-readonly';
  var histChipMeta = exState.exerciseMeta || exerciseLibraryByName[normName(name)] || null;
  var histChipHtml = renderWeightModeChip(ei, weightMode, histChipMeta, histChipCtx, histWorkoutId);
  var histBadgeHtml = badgeLabel ? '<span class="superset-badge">' + escapeHtml(badgeLabel) + '</span>' : '';
  h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + histBadgeHtml + escapeHtml(name) + '</div>' + histChipHtml + '</div><div class="exercise-status ' + sc + '">' + stat + '</div></div>';
  h += '<div class="sets-container">';
  var histStdSetNum = 0;
  for (var si = 0; si < setCount; si++) {
    var sl = exState.sets[si] || {};
    var prescribed = prescribedSets ? prescribedSets[si] : null;
    var prText = prescribed ? fmtP(prescribed) : '—';
    var histLabelNum;
    if (!sl || sl.setType !== 'drop') {
      histStdSetNum++;
      histLabelNum = histStdSetNum;
    }
    // History-edit (v3.6.3): user-added isExtra rows get the × delete
    // affordance so accidentally-added missing sets can be removed.
    // Prescribed (non-extra) rows stay non-deletable — protects the
    // historical record from accidental clicks.
    var histDeletable = historyEditMode && !!sl.isExtra;
    h += renderSetRow('history', ei, si, sl, prescribed, (sl.weight_mode || weightMode), disabledAttr, prText, histDeletable, isCardioRow, histLabelNum);
  }
  // History-edit "+ Add Set" affordance (v3.6.3). Inserts a new set at
  // the next set_order for this exercise. Skipped on cardio to avoid
  // confusion — cardio rows have a different shape; can be revisited.
  if (historyEditMode && !isCardioRow) {
    h += '<button class="add-set-btn" type="button" data-history-add-set-ei="' + ei + '">+ Add Set</button>';
  }
  h += '</div>';
  // RPE row — in edit mode, render even when null so the user can pick
  // an RPE retroactively. Buttons get the same data-ei / data-rpe attrs
  // the live-session row uses; the historyBody click listener routes
  // to historyUpdateExerciseRpe.
  if (exState.rpe != null || historyEditMode) {
    h += '<div class="rpe-row"><div class="rpe-label">RPE</div><div class="rpe-buttons">';
    var rv = [6,7,8,9,10];
    for (var r = 0; r < rv.length; r++) {
      var rpeAttrs = historyEditMode
        ? ' data-history-ex-order="' + ei + '" data-history-rpe="' + rv[r] + '"'
        : ' disabled';
      h += '<button class="rpe-btn' + (exState.rpe === rv[r] ? ' selected' : '') + '"' + rpeAttrs + '>' + rv[r] + '</button>';
    }
    h += '</div></div>';
  }
  if (exState.subExercise || exState.sub) {
    // subExercise is the structured v2.2.1 field (library row); sub is the
    // legacy free-text fallback. Prefer structured when both are present.
    var histSubLabel = exState.subExercise ? exState.subExercise.name : exState.sub;
    h += '<div class="sub-row"><div class="sub-label">SUB:</div><div style="font-size:12px;color:var(--text2);flex:1">' + escapeHtml(histSubLabel) + '</div></div>';
  }
  // Per-exercise note. Edit mode: editable textarea (saves on blur).
  // Read-only mode: pre-formatted display when there's a note.
  if (historyEditMode) {
    h += '<div style="padding:10px 14px 14px"><textarea class="exercise-note-input" rows="1" placeholder="Notes" data-history-ex-order="' + ei + '" data-history-ex-note="1">' + escapeHtml(exState.note || '') + '</textarea></div>';
  } else if (exState.note) {
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
  analyzeChatHistory = [];
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
      model: modelForAnalyze(),
      history_weeks: historyWeeks,
      include_photos: includePhotos,
      notes: notes,
    };
  } else {
    payload = {
      model: modelForPlan(),
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
  // Iteration state also resets here — every fresh Generate / Analyze
  // call starts a new refinement session.
  generatedPlan = null;
  generatedAnalysis = null;
  iterationHistory = [];
  generatedChangeNotes = null;
  analyzeChatHistory = [];
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
  iterationHistory = [];
  generatedChangeNotes = null;
  analyzeChatHistory = [];
  refineInFlight = false;
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

  // Restore prior selections when generatedInputs is set — chained from
  // analyze → "Use for next plan" or any future re-render of the inputs
  // view after a submit. Fresh open clears generatedInputs (openGenerate),
  // so we fall through to first-open defaults in that case.
  var prev = generatedInputs || {};
  var startVal = prev.start_date || defaultStart;
  var durVal = (prev.target_duration != null) ? prev.target_duration : 60;
  var daysVal = (prev.training_days != null) ? prev.training_days : 5;
  var weeksVal = (prev.history_weeks != null) ? prev.history_weeks : 4;
  var photosAttr = prev.include_photos ? ' checked' : '';
  var notesVal = prev.notes || '';

  var h = '<div class="generate-inputs">';
  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Start date</span>';
  h += '<input type="date" id="genFormStartDate" class="generate-form-input" value="' + escapeAttr(startVal) + '">';
  h += '<span class="generate-form-hint">When does this plan take effect. Typically the upcoming Sunday.</span>';
  h += '</label>';

  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Target session duration</span>';
  h += '<input type="number" id="genFormDuration" class="generate-form-input" value="' + durVal + '" min="30" max="120" step="5">';
  h += '<span class="generate-form-hint">Minutes per session. Claude will program toward this.</span>';
  h += '</label>';

  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Training days</span>';
  h += '<input type="number" id="genFormTrainingDays" class="generate-form-input" value="' + daysVal + '" min="1" max="6" step="1">';
  h += '<span class="generate-form-hint">Sessions per week (1-6). Claude adapts the split to the count.</span>';
  h += '</label>';

  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">History context</span>';
  h += '<input type="number" id="genFormHistoryWeeks" class="generate-form-input" value="' + weeksVal + '" min="1" max="12" step="1">';
  h += '<span class="generate-form-hint">Weeks of past training to feed the AI (1-12). More = broader context, slightly longer prompts.</span>';
  h += '</label>';

  h += '<label class="generate-form-row generate-form-row-inline">';
  h += '<input type="checkbox" id="genFormIncludePhotos" class="generate-form-checkbox"' + photosAttr + '>';
  h += '<span class="generate-form-label">Include physique photos in analysis</span>';
  h += '<span class="generate-form-hint">Off by default. Turn on when you\'ve updated a progress photo or want visual-driven recommendations. Adds ~1-2s to generation.</span>';
  h += '</label>';

  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">Notes to coach (optional)</span>';
  h += '<textarea id="genFormNotes" class="generate-form-textarea" rows="3" placeholder="e.g., knee acting up this week, traveling Mon-Wed (dumbbells only)">' + escapeHtml(notesVal) + '</textarea>';
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
  var revisionNum = iterationHistory.length;  // 0 on initial; increments per refine

  var h = '<div class="generate-review">';

  h += '<div class="generate-meta">' +
    escapeHtml(p.title || 'New plan') +
    (p.week ? ' · ' + escapeHtml(p.week) : '') +
    (revisionNum > 0 ? ' · revision ' + revisionNum : '') +
    (meta.model ? ' · ' + escapeHtml(meta.model) : '') +
    (meta.elapsed_s ? ' · ' + meta.elapsed_s + 's' : '') +
    '</div>';

  // Change-notes banner — only renders after at least one refinement.
  // Plain-text label + Claude's 2-4 sentence explanation of the latest
  // changes so the user knows what was modified relative to the prior
  // iteration without having to diff visually.
  if (generatedChangeNotes) {
    h += '<div class="refine-change-notes">';
    h += '<div class="refine-change-label">WHAT CHANGED</div>';
    h += '<div class="refine-change-text">' + escapeHtml(generatedChangeNotes) + '</div>';
    h += '</div>';
  }

  // Per-muscle weekly volume summary, color-coded against the phase
  // target band (Schoenfeld). Surfaces deficits / excesses BEFORE the
  // user reads through day cards so refine feedback can be specific
  // (e.g., "chest is at 6, bump to ~12-14"). Uses the same Schoenfeld
  // fractional counting (primary 1.0 + each secondary 0.5) as the
  // History summary, analyze prompt, and Volume Trends dashboard so
  // numbers match across surfaces.
  h += renderPlanVolumeSummary(p);

  var days = Array.isArray(p.days) ? p.days : [];
  for (var di = 0; di < days.length; di++) {
    var day = days[di];
    var entries = Array.isArray(day.exercises) ? day.exercises : [];
    // Count members + sets (block entries expand into N members; their
    // sets sum across members for the day-meta total).
    var memberCount = 0, setCount = 0;
    for (var ci = 0; ci < entries.length; ci++) {
      var e = entries[ci];
      if (e && e.superset === true && Array.isArray(e.exercises)) {
        for (var ki = 0; ki < e.exercises.length; ki++) {
          memberCount++;
          setCount += Array.isArray(e.exercises[ki].sets) ? e.exercises[ki].sets.length : 0;
        }
      } else {
        memberCount++;
        setCount += Array.isArray(e && e.sets) ? e.sets.length : 0;
      }
    }
    h += '<div class="generate-day-card">';
    h += '<div class="generate-day-header">';
    h += '<div class="generate-day-name">' + escapeHtml(day.name || 'Day ' + (di + 1)) + '</div>';
    h += '<div class="generate-day-meta">' + memberCount + ' exercise' + (memberCount === 1 ? '' : 's') +
         ' · ' + setCount + ' set' + (setCount === 1 ? '' : 's') + '</div>';
    h += '</div>';
    // Walk entries with a flat-ei counter so block members get the right
    // ei when wired into the review-state swap handler.
    var flatEi = 0;
    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
        var rest = Number.isInteger(entry.rest) ? entry.rest : 60;
        h += '<div class="generate-superset-block">';
        h += '<div class="generate-superset-header">⟷ Superset · ' + entry.exercises.length + ' exercises · ' + rest + 's rest</div>';
        for (var mi = 0; mi < entry.exercises.length; mi++) {
          var badge = String.fromCharCode(65) + (mi + 1);
          h += renderGenerateExercise(entry.exercises[mi], di, flatEi, badge);
          flatEi++;
        }
        h += '</div>';
      } else {
        h += renderGenerateExercise(entry, di, flatEi, null);
        flatEi++;
      }
    }
    h += '</div>';
  }

  // Refine input: textarea below the day cards. User types one or more
  // requested changes; Refine button fires the refine API call. Hard cap
  // matches MAX_REFINE_FEEDBACK_LENGTH on the server (2000 chars).
  h += '<div class="refine-input-block">';
  h += '<label class="generate-form-row">';
  h += '<span class="generate-form-label">What would you change?</span>';
  h += '<textarea id="refineFeedbackInput" class="generate-form-textarea" rows="3" maxlength="2000" ' +
       'placeholder="e.g., move pull-ups to Day 3, less quad volume, swap cable row for machine row, add rear delt work to Day 1"></textarea>';
  h += '<span class="generate-form-hint">Keep iterating until happy. Each refinement takes ~20-30s. Iterations cache against prior turns so cost stays low.</span>';
  h += '</label>';
  h += '<button class="generate-btn-secondary" id="btnRefinePlan" type="button" style="width:100%; padding:12px;">Refine plan</button>';
  h += '</div>';

  h += '<div class="generate-actions">';
  h += '<button class="generate-btn-cancel" id="btnGenerateCancel" type="button">Cancel</button>';
  h += '<button class="generate-btn-secondary" id="btnGenerateSaveTemplate" type="button">Save as template</button>';
  h += '<button class="generate-btn-accept" id="btnGenerateAccept" type="button">Accept plan</button>';
  h += '</div>';
  h += '</div>';
  body.innerHTML = h;
}

// Iterative plan refinement (v2.5.3). Reads the textarea, fires
// /api/generate-plan with mode=refine, replaces the displayed plan
// with the revised one + change_notes banner. Server caches against
// the prior turns so per-iteration cost stays low; on success we
// append the (now-prior) plan + feedback into iterationHistory so
// the next refine call replays the full conversation.
async function submitRefinePlan() {
  if (refineInFlight) return;
  if (!generatedPlan) {
    showToast('No plan to refine', null);
    return;
  }
  var input = document.getElementById('refineFeedbackInput');
  var feedback = (input && input.value || '').trim();
  if (!feedback) {
    showToast('Type what you would change', null);
    if (input) input.focus();
    return;
  }

  refineInFlight = true;
  // Disable the button and swap loading copy. Don't tear down the review
  // view -- the user keeps seeing the current plan while the refine call
  // is in flight, which makes the typical 20-30s wait feel less jarring.
  var btn = document.getElementById('btnRefinePlan');
  if (btn) { btn.disabled = true; btn.textContent = 'Refining…'; }

  // Capture the plan that's about to become "previous" for the iteration
  // history. We push it after the call succeeds so a failed refine leaves
  // history intact.
  var planBeforeThisRefine = generatedPlan;

  try {
    var sessionRes = await sb.auth.getSession();
    var token = sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
    if (!token) throw new Error('Not signed in');

    var inputs = generatedInputs || {};
    var payload = {
      mode: 'refine',
      model: modelForPlan(),
      current_plan: generatedPlan,
      iteration_history: iterationHistory,
      new_feedback: feedback,
      // Echo the original inputs so the server reconstructs the exact
      // first-user-message from the initial generate (cache hit).
      start_date: inputs.start_date || null,
      target_duration: inputs.target_duration || null,
      training_days: inputs.training_days,
      history_weeks: inputs.history_weeks,
      include_photos: inputs.include_photos,
      notes: inputs.notes || null,
    };

    var startedAt = Date.now();
    var res = await fetch('/api/generate-plan', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    var body = await res.json().catch(function() { return null; });

    if (res.status !== 200 || !body || !body.plan) {
      var msg = (body && body.error) || ('HTTP ' + res.status);
      showToast('Refine failed: ' + msg, null);
      if (btn) { btn.disabled = false; btn.textContent = 'Refine plan'; }
      return;
    }

    // Success: append (previous plan + feedback) to iterationHistory,
    // then swap in the revised plan + notes and re-render.
    iterationHistory.push({ plan: planBeforeThisRefine, feedback: feedback });
    generatedPlan = body.plan;
    generatedChangeNotes = body.change_notes || '';
    generatedMeta = {
      model: body.model || 'unknown',
      generated_at: body.generated_at,
      elapsed_s: Math.round((Date.now() - startedAt) / 1000),
    };
    renderGenerate();
    if (input) input.value = '';
  } catch (err) {
    console.error('submitRefinePlan error:', err);
    showToast('Refine failed: ' + (err.message || 'network error'), null);
    if (btn) { btn.disabled = false; btn.textContent = 'Refine plan'; }
  } finally {
    refineInFlight = false;
  }
}

// Per-muscle weekly volume chips for the plan review (v3.5.5; dual-row
// v3.6.14). Two rows: primary-only and Schoenfeld fractional. Each
// chip is color-coded against the per-(muscle, mode) MEV/MAV/MRV band
// from DEFAULT_MUSCLE_BANDS + the user's Coaching Profile overrides.
// Same muscle can carry different status colors under the two methods
// — the value of seeing both at once. Returns '' when the plan has
// no exercises that resolve against the library.
function renderPlanVolumeSummary(plan) {
  var fractional = computePlanVolumeByMuscle(plan);
  var primary = computePlanVolumeByMusclePrimary(plan);
  if (!Object.keys(fractional).length && !Object.keys(primary).length) return '';

  var h = '<div class="plan-volume-summary">';
  h += '<div class="plan-volume-header">';
  h += '<span class="plan-volume-label">Sets/week per muscle</span>';
  h += '<span class="plan-volume-band">vs per-muscle MEV / MAV / MRV bands (Coaching Profile → Volume targets)</span>';
  h += '</div>';
  h += _dualChipRowsHtml(primary, fractional);
  h += '</div>';
  return h;
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

  // Conversational Q&A on the analysis (v3.5.3). Rides the analyze prompt
  // cache via /api/generate-plan mode=analyze_chat. Each turn appends to
  // analyzeChatHistory and folds into the "Use for next plan" carry below.
  h += '<div class="analyze-chat-section">';
  h += '<div class="analyze-section-label">FOLLOW-UP QUESTIONS</div>';
  if (analyzeChatHistory.length) {
    h += '<div class="analyze-chat-thread">';
    for (var ci = 0; ci < analyzeChatHistory.length; ci++) {
      var m = analyzeChatHistory[ci];
      var roleClass = m.role === 'user' ? 'analyze-chat-user' : 'analyze-chat-coach';
      var roleLabel = m.role === 'user' ? 'You' : 'Coach';
      h += '<div class="analyze-chat-msg ' + roleClass + '">';
      h += '<div class="analyze-chat-role">' + roleLabel + '</div>';
      h += '<div class="analyze-chat-text">' + escapeHtml(m.content) + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }
  if (analyzeChatPending) {
    h += '<div class="analyze-chat-msg analyze-chat-coach"><div class="analyze-chat-role">Coach</div><div class="analyze-chat-text" style="opacity:0.6;">…</div></div>';
  }
  var disabled = analyzeChatPending ? ' disabled' : '';
  h += '<div class="analyze-chat-input">';
  h += '<textarea id="analyzeChatInput" rows="2" placeholder="Ask a follow-up — clarify a section, expand on a recommendation, or ask what it means for you"' + disabled + '></textarea>';
  h += '<button class="generate-btn-secondary" id="btnAnalyzeChatSend" type="button"' + disabled + '>' + (analyzeChatPending ? 'Asking…' : 'Ask') + '</button>';
  h += '</div>';
  h += '<div class="analyze-chat-hint">Sonnet, ~5-8s/turn — rides the warm analyze cache. Each Q&amp;A folds into "Use for next plan" below.</div>';
  h += '</div>';

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

async function submitAnalyzeChat() {
  if (analyzeChatPending) return;
  if (!generatedAnalysis) return;
  var input = document.getElementById('analyzeChatInput');
  var question = (input && input.value || '').trim();
  if (!question) {
    if (input) input.focus();
    return;
  }
  // Optimistically push the user's question; re-render shows it + a
  // pending "…" placeholder for the coach reply.
  analyzeChatHistory.push({ role: 'user', content: question });
  analyzeChatPending = true;
  renderGenerate();
  try {
    var sessionRes = await sb.auth.getSession();
    var token = sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
    if (!token) throw new Error('Not signed in');
    // Send all prior turns EXCEPT the user message we just optimistically
    // pushed — server treats that one as the new question, not history.
    var qaForServer = analyzeChatHistory.slice(0, -1);
    var payload = {
      mode: 'analyze_chat',
      model: modelForAnalyze(),
      original_analysis: {
        trends: generatedAnalysis.trends || '',
        progressing: generatedAnalysis.progressing || '',
        concerns: generatedAnalysis.concerns || '',
        next_week: generatedAnalysis.next_week || '',
      },
      qa_history: qaForServer,
      question: question,
      // Same window the original analyze used so the volume-by-muscle
      // block in the cached prefix matches up.
      history_weeks: (generatedMeta && generatedMeta.weeks_analyzed) || (generatedInputs && generatedInputs.history_weeks) || 4,
    };
    var res = await fetch('/api/generate-plan', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var body = await res.json().catch(function() { return null; });
    if (res.status !== 200 || !body || !body.reply) {
      var msg = (body && body.error) || ('HTTP ' + res.status);
      // Roll back the optimistic user push so the user can retry without
      // a duplicate sitting in the transcript.
      analyzeChatHistory.pop();
      showToast('Follow-up failed: ' + msg, null);
      return;
    }
    analyzeChatHistory.push({ role: 'assistant', content: String(body.reply).trim() });
    if (input) input.value = '';
  } catch (err) {
    console.error('submitAnalyzeChat error:', err);
    analyzeChatHistory.pop();
    showToast('Follow-up failed: ' + (err.message || 'network error'), null);
  } finally {
    analyzeChatPending = false;
    renderGenerate();
    // Re-focus the input after the re-render mounts a fresh node.
    setTimeout(function() {
      var ta = document.getElementById('analyzeChatInput');
      if (ta) ta.focus();
    }, 0);
  }
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
  // Append the in-modal Q&A transcript so plan-gen sees both the four
  // sections AND the clarifications the user discussed before hitting
  // "Use for next plan". Each pair renders as You: / Coach: lines.
  if (analyzeChatHistory.length) {
    var qaLines = ['FOLLOW-UP DISCUSSION:'];
    for (var qi = 0; qi < analyzeChatHistory.length; qi++) {
      var m = analyzeChatHistory[qi];
      var who = m.role === 'user' ? 'You' : 'Coach';
      qaLines.push(who + ': ' + m.content);
    }
    bits.push(qaLines.join('\n'));
  }
  var carry = bits.join('\n\n');
  // Switch back to the inputs view, re-render, then overwrite the textarea
  // with the carry text after DOM is ready. The form's other fields
  // (start_date, duration, training_days, history_weeks, photos) are
  // restored from generatedInputs by renderGenerateInputs.
  generatedAnalysis = null;
  analyzeChatHistory = [];
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

function renderGenerateExercise(ex, di, flatEi, badgeLabel) {
  if (!ex) return '';
  var name = ex.name || 'exercise';
  var mode = weightModeForName(name);
  var sets = Array.isArray(ex.sets) ? ex.sets : [];
  var setsLine = formatGenerateSets(sets, mode);
  var swapBtn = (di != null && flatEi != null)
    ? '<button class="card-swap generate-exercise-swap" data-swap-review-di="' + di + '" data-swap-review-ei="' + flatEi + '" aria-label="Swap exercise" title="Swap exercise" type="button">⇄</button>'
    : '';
  var badgeHtml = badgeLabel
    ? '<span class="superset-badge">' + escapeHtml(badgeLabel) + '</span>'
    : '';
  var h = '<div class="generate-exercise">';
  h += '<div class="generate-exercise-name">' + badgeHtml + escapeHtml(name) + swapBtn + '</div>';
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
    if (p.is_active) {
      h += '<button type="button" class="plans-btn end" data-end-plan-id="' + escapeAttr(p.id) + '">End plan</button>';
    }
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

async function onEndPlan(planId) {
  var p = null;
  for (var i = 0; i < plansList.length; i++) {
    if (plansList[i].id === planId) { p = plansList[i]; break; }
  }
  if (!p || !p.is_active) return;
  if (!confirm('End "' + (p.title || 'Untitled') + '"? You can re-activate it from this list anytime.')) return;
  try {
    await endActivePlan();
    closePlans();
    showToast('Plan ended. Activate again from Plans anytime.', null);

    // Mirror the hydrate no-plan focus hierarchy: in-progress ad-hoc
    // wins, else first ad-hoc of any state, else empty state. End just
    // flipped is_active=false; todayAdHocs (plan-agnostic) is preserved
    // so a session in progress at end-time stays focused.
    var focusedAdHocKey = null;
    for (var ai = 0; ai < todayAdHocs.length; ai++) {
      var as = todayAdHocs[ai];
      if (as && as.workoutId && as.startedAt && !as.endedAt) {
        focusedAdHocKey = 'ah_' + as.workoutId;
        break;
      }
    }
    if (!focusedAdHocKey && todayAdHocs.length) {
      focusedAdHocKey = 'ah_' + todayAdHocs[0].workoutId;
    }

    if (focusedAdHocKey) {
      document.getElementById('emptyState').style.display = 'none';
      document.getElementById('summaryBar').style.display = 'flex';
      currentDay = focusedAdHocKey;
      focusTab(currentDay);
      buildTabs();
      buildDay(currentDay);
      // Auto-open the start-screen so the no-plan options are surfaced
      // alongside the focused ad-hoc. Close button is always visible.
      openStartScreen();
    } else {
      // No ad-hoc to focus — fall fully back into the no-plan empty state.
      // The Plans modal entry path means #emptyState was hidden before this
      // call; renderEmptyState repopulates innerHTML but doesn't toggle
      // display, so do that explicitly here (matches the hydrate path in
      // app.js:199-201).
      document.getElementById('workoutContainer').innerHTML = '';
      document.getElementById('emptyState').style.display = 'block';
      document.getElementById('summaryBar').style.display = 'none';
      if (typeof renderEmptyState === 'function') renderEmptyState();
      buildTabs();
    }
  } catch(err) {
    console.error('onEndPlan error:', err);
    showToast("Couldn't end plan: " + (err.message || 'unknown error'), null);
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
  // Capture the active-plan status BEFORE the DB delete so the post-
  // delete branch can decide whether to hard-reload. Compare both
  // is_active and id against activePlanId — the row's is_active flag
  // is the source of truth, the activePlanId check is defense in depth.
  var wasActive = !!(p.is_active || (activePlanId && p.id === activePlanId));
  try {
    // Defensive: scope delete to non-template rows. Pre-v2.4.11 the
    // Plans list could include template rows; if a stale client still
    // has one in plansList, this prevents the delete from landing on
    // the template by id.
    var dr = await sb.from('plans').delete()
      .eq('id', planId)
      .eq('is_template', false);
    if (dr.error) throw dr.error;
    // Active-plan delete (v3.6.13): the user just removed the plan
    // they were tracking. In-memory `plan`, `activePlanId`,
    // `todayPlanStates`, the tracker view, coachContext, AND the
    // hydration snapshot all still reference the deleted plan — a
    // partial in-place reset would risk a stale state somewhere. Drop
    // the hydration snapshot so the reload paints from a clean no-plan
    // state instead of replaying the cached pre-delete view.
    if (wasActive) {
      if (typeof clearHydrationSnapshot === 'function') clearHydrationSnapshot();
      window.location.reload();
      return;
    }
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
  // Stamp the user message at the moment they sent it — before the API
  // call. The assistant message gets stamped after the reply arrives
  // (~1-2s later). Passing explicit created_at to logCoachMessage keeps
  // the persisted ordering stable across the two concurrent INSERTs that
  // would otherwise race for `default now()` server-side.
  var userMsgAt = new Date().toISOString();
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
    var assistantMsgAt = new Date().toISOString();
    logCoachMessage('user', userMsg, 'chat', null, userMsgAt);
    logCoachMessage('assistant', reply, 'chat', null, assistantMsgAt);
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
      body: JSON.stringify({ messages: messages, model: modelForCoach() }),
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
    context: 'live',
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

// Swap a single exercise inside the in-review generated plan (post-Generate,
// pre-Accept). Mutates generatedPlan instead of plan; no DB persist on
// accept (the whole plan persists on the user's Accept tap). flatEi is
// the flat exercise_order across the day (block members occupy contiguous
// flat slots), resolved through plan structure via _flatEiToPlanMember.
function openSwapModalForReview(di, flatEi) {
  if (!generatedPlan || !generatedPlan.days || !generatedPlan.days[di]) return;
  var dayPlan = generatedPlan.days[di];
  var ex = (typeof _flatEiToPlanMember === 'function')
    ? _flatEiToPlanMember(dayPlan, flatEi)
    : null;
  if (!ex || !ex.name) return;
  var meta = exerciseLibraryByName ? exerciseLibraryByName[normName(ex.name)] : null;
  swapState = {
    context: 'review',
    di: di,
    ei: flatEi,
    originalExercise: JSON.parse(JSON.stringify(ex)),
    snapshot: {
      name: ex.name,
      sets: Array.isArray(ex.sets) ? ex.sets.slice() : [],
      muscle_group: meta ? (meta.muscle_group || null) : null,
      movement_pattern: meta ? (meta.movement_pattern || null) : null,
      equipment: meta ? (meta.equipment || null) : null,
      weight_mode: meta ? (meta.weight_mode || 'total') : 'total',
    },
    dayName: dayPlan.name || ('Day ' + (di + 1)),
    view: 'input',
    replacement: null,
    reason: '',
  };
  document.getElementById('swapExerciseOverlay').classList.add('show');
  renderSwapModal();
}

// Build the "other_today" name list for a swap source in the in-review
// plan: every member on the same day except the source. Walks block
// entries so block members are included. Used by fireSwapFetch when
// swapState.context === 'review'.
function _otherTodayForReview(di, sourceFlatEi) {
  var out = [];
  if (!generatedPlan || !generatedPlan.days || !generatedPlan.days[di]) return out;
  var entries = generatedPlan.days[di].exercises;
  if (!Array.isArray(entries)) return out;
  var flatI = 0;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        if (flatI !== sourceFlatEi && entry.exercises[ci] && entry.exercises[ci].name) {
          out.push(entry.exercises[ci].name);
        }
        flatI++;
      }
    } else {
      if (flatI !== sourceFlatEi && entry && entry.name) {
        out.push(entry.name);
      }
      flatI++;
    }
  }
  return out;
}

// Open the merge picker for the chain-link icon on a standalone card. Lists other
// items on this day: standalone exercises (each pickable individually) and
// existing supersets (pickable as join targets). Excludes the source.
function openSupersetPicker(di, ei) {
  var state, exercisesArr;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
    exercisesArr = null;
    if (!state) return;
  } else {
    // Plan-day path: state is null until the user starts a session, but
    // pairing pre-session is supported (mutates plan.data only). Walk the
    // plan structure for block detection and pass {} for stateExercises.
    state = stateForDay(di);
    var planBlob = (typeof _planForState === 'function' ? _planForState(state) : null) || plan;
    exercisesArr = (planBlob && planBlob.days && planBlob.days[di]) ? planBlob.days[di].exercises : null;
    if (!exercisesArr) return;
  }

  var runs = groupRunsForRender(exercisesArr, (state && state.exercises) || {});

  var options = [];
  for (var ri = 0; ri < runs.length; ri++) {
    var run = runs[ri];
    if (run.kind === 'standalone') {
      if (run.ei === ei) continue;
      var name = (run.planEx && run.planEx.name)
        || (run.exState && run.exState.exerciseMeta && run.exState.exerciseMeta.name)
        || ('Exercise ' + (run.ei + 1));
      options.push({ label: name, type: 'standalone', targetEi: run.ei });
    } else {
      var sourceInBlock = false;
      for (var sii = 0; sii < run.items.length; sii++) {
        if (run.items[sii].ei === ei) { sourceInBlock = true; break; }
      }
      if (sourceInBlock) continue;
      var firstMember = run.items[0];
      var firstName = (firstMember.planEx && firstMember.planEx.name)
        || (firstMember.exState && firstMember.exState.exerciseMeta && firstMember.exState.exerciseMeta.name)
        || 'Block';
      options.push({ label: 'Superset: ' + firstName + ' + others', type: 'block', targetEi: run.items[0].ei });
    }
  }

  if (!options.length) {
    showToast('Nothing else on this day to pair with', null);
    return;
  }

  // Render in a programmatic modal (reuse the existing modal-overlay pattern).
  var modal = document.getElementById('supersetPickerOverlay');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'supersetPickerOverlay';
    modal.className = 'modal-overlay';
    modal.innerHTML = '<div class="modal" style="max-width:420px"><h3 style="margin-top:0">Pair with…</h3><div id="supersetPickerBody"></div><div class="modal-actions"><button class="modal-btn" id="btnSupersetPickerCancel" type="button">Cancel</button></div></div>';
    document.body.appendChild(modal);
    document.getElementById('btnSupersetPickerCancel').addEventListener('click', function() {
      modal.classList.remove('show');
    });
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.classList.remove('show');
    });
    document.getElementById('supersetPickerBody').addEventListener('click', function(e) {
      var t = e.target.closest && e.target.closest('[data-target-ei]');
      if (!t) return;
      modal.classList.remove('show');
      var savedDi = modal.getAttribute('data-source-di');
      var savedSrcEi = parseInt(modal.getAttribute('data-source-ei'), 10);
      var tgtEi = parseInt(t.getAttribute('data-target-ei'), 10);
      var diVal = (savedDi && savedDi.indexOf('ah_') === 0) ? savedDi : parseInt(savedDi, 10);
      onMergeIntoSuperset(diVal, savedSrcEi, tgtEi);
    });
  }
  // Stash the source for the click handler above.
  modal.setAttribute('data-source-di', String(di));
  modal.setAttribute('data-source-ei', String(ei));
  var body = document.getElementById('supersetPickerBody');
  body.innerHTML = options.map(function(o) {
    return '<button class="modal-btn" type="button" style="display:block;width:100%;margin-bottom:8px;text-align:left" data-target-ei="' + escapeAttr(String(o.targetEi)) + '">' + escapeHtml(o.label) + '</button>';
  }).join('');
  modal.classList.add('show');
}

async function onMergeIntoSuperset(di, eiA, eiB) {
  try {
    await applySupersetMerge(di, eiA, eiB);
    if (isAdHocKey(di)) {
      buildAdHocDay(di);
    } else {
      buildDay(di);
    }
    showToast('Superset created.', null);
    if (typeof saveHydrationSnapshot === 'function') saveHydrationSnapshot();
  } catch (err) {
    console.error('onMergeIntoSuperset error:', err);
    showToast("Couldn't create superset: " + (err.message || 'unknown'), null);
  }
}

async function onRemoveFromSuperset(di, ei) {
  try {
    await applySupersetSeparate(di, ei);
    if (isAdHocKey(di)) {
      buildAdHocDay(di);
    } else {
      buildDay(di);
    }
    showToast('Removed from superset.', null);
    if (typeof saveHydrationSnapshot === 'function') saveHydrationSnapshot();
  } catch (err) {
    console.error('onRemoveFromSuperset error:', err);
    showToast("Couldn't remove: " + (err.message || 'unknown'), null);
  }
}

async function onMemberReordered(zoneEl) {
  if (!zoneEl) return;
  var groupKey = zoneEl.getAttribute('data-sort-zone').replace(/^superset-/, '');
  var diAttr = zoneEl.getAttribute('data-di');
  var di = isAdHocKey(diAttr) ? diAttr : parseInt(diAttr, 10);
  var memberEls = zoneEl.querySelectorAll('[data-member-ei]');
  var newMemberEis = [];
  for (var i = 0; i < memberEls.length; i++) {
    newMemberEis.push(parseInt(memberEls[i].getAttribute('data-member-ei'), 10));
  }
  if (newMemberEis.length < 2) return;
  try {
    await applySupersetReorderMembers(di, groupKey, newMemberEis);
    if (isAdHocKey(di)) {
      buildAdHocDay(di);
    } else {
      buildDay(di);
    }
    if (typeof saveHydrationSnapshot === 'function') saveHydrationSnapshot();
  } catch (err) {
    console.error('onMemberReordered error:', err);
    showToast("Couldn't reorder superset members: " + (err.message || 'unknown'), null);
    if (isAdHocKey(di)) {
      buildAdHocDay(di);
    } else {
      buildDay(di);
    }
  }
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
      model: modelForPlan(),
      exercise: exercise,
      reason: swapState.reason || '',
      day_name: swapState.dayName,
    };
    // Coach-chat-and-swap context window override (v3.5.2). Server
    // clamps 1-12 and falls back to SWAP_HISTORY_WEEKS when omitted.
    if (coachingProfile && Number.isFinite(coachingProfile.coach_context_weeks)) {
      payload.coach_context_weeks = coachingProfile.coach_context_weeks;
    }
    // Review-context swap: the source plan only exists in the frontend
    // (post-Generate, pre-Accept). The server's DB lookup for "other
    // exercises on this day" would miss or pull from a stale active
    // plan — send the names list explicitly instead.
    if (swapState.context === 'review') {
      payload.other_today = _otherTodayForReview(swapState.di, swapState.ei);
    }
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

// Write a replacement exercise object into a plan day at a flat
// exercise_order slot. Walks block entries (block.exercises[]) so block
// members can be overwritten in place while preserving the block
// container around them. Returns true on success, false if the flat ei
// is out of range. Used by the review-context branch in acceptSwap.
function _writeFlatEiInPlanDay(dayPlan, flatEi, replacement) {
  if (!dayPlan || !Array.isArray(dayPlan.exercises)) return false;
  var flatI = 0;
  for (var i = 0; i < dayPlan.exercises.length; i++) {
    var entry = dayPlan.exercises[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        if (flatI === flatEi) {
          // Members never carry their own rest; the block holds it.
          var memberRepl = {
            name: replacement.name,
            note: replacement.note || '',
            sets: Array.isArray(replacement.sets) ? replacement.sets.slice() : [],
          };
          dayPlan.exercises[i].exercises[ci] = memberRepl;
          return true;
        }
        flatI++;
      }
    } else {
      if (flatI === flatEi) {
        dayPlan.exercises[i] = {
          name: replacement.name,
          note: replacement.note || '',
          rest: replacement.rest,
          sets: Array.isArray(replacement.sets) ? replacement.sets.slice() : [],
        };
        return true;
      }
      flatI++;
    }
  }
  return false;
}

async function acceptSwap() {
  if (!swapState || !swapState.replacement) return;
  var di = swapState.di, ei = swapState.ei;
  // Review-context branch: source is generatedPlan; mutate it in
  // place at the flat-ei slot (resolves through block.exercises[] for
  // members) and re-render the review. No DB persist — generatedPlan
  // only persists when the user taps Accept on the whole plan. No
  // coach log either; logging happens once at plan acceptance.
  if (swapState.context === 'review') {
    if (!generatedPlan || !generatedPlan.days || !generatedPlan.days[di]) {
      showToast('Plan no longer in review', null);
      closeSwapModal();
      return;
    }
    var ok = _writeFlatEiInPlanDay(generatedPlan.days[di], ei, swapState.replacement);
    if (!ok) {
      showToast('Exercise no longer in plan', null);
      closeSwapModal();
      return;
    }
    var swappedFrom = swapState.snapshot.name;
    var swappedTo = swapState.replacement.name;
    closeSwapModal();
    var generateBody = document.getElementById('generateBody');
    if (generateBody) renderGenerateReview(generateBody);
    showToast('Swapped ' + swappedFrom + ' → ' + swappedTo + ' in the review.', null);
    return;
  }
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
    h += '<button type="button" class="plans-btn activate" data-use-template-id="' + escapeAttr(t.id) + '">Use as plan</button>';
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

// Activate a template as the active plan (v3.5.9). Multi-day templates
// previously could only be used to seed an ad-hoc session one day at a
// time — there was no path to make a multi-day template the active week-
// long plan. Deep-clones the template's data blob (so future edits to
// plan.data don't write back to the template), passes it through
// savePlanAsActive which stamps start_date = today, normalizes the week
// label, deactivates any prior active plan, and inserts as a NEW plans
// row with is_active=true. Template row is untouched and stays a
// reusable template.
async function onUseTemplateAsPlan(templateId) {
  var t = null;
  for (var i = 0; i < templatesList.length; i++) {
    if (templatesList[i].id === templateId) { t = templatesList[i]; break; }
  }
  if (!t) return;
  if (!t.data || !Array.isArray(t.data.days) || !t.data.days.length) {
    showToast('Template has no days to activate', null);
    return;
  }
  var msg = 'Activate "' + t.template_name + '" as your active plan?';
  if (plan && plan.title) {
    msg += '\n\nThis will replace your current active plan ("' + plan.title + '"). Past workouts and sets stay intact.';
  }
  if (!confirm(msg)) return;
  try {
    var blob = JSON.parse(JSON.stringify(t.data));
    blob.title = blob.title || t.template_name;
    // Strip any inherited start_date / week so savePlanAsActive stamps
    // them fresh from today's date (templates don't carry a calendar
    // anchor; saveAsTemplate already strips these, but defense in depth
    // for hand-edited / imported templates).
    delete blob.start_date;
    delete blob.week;
    await savePlanAsActive(blob);
    closeTemplates();
    showToast('Activated: ' + (blob.title || t.template_name), null);
  } catch(err) {
    console.error('onUseTemplateAsPlan error:', err);
    showToast("Couldn't activate template: " + (err.message || 'unknown'), null);
  }
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

// Narrower variant for in-modal history-edit handlers (v3.6.6). The full
// invalidateHistoryCache wipes historyDetails too, which silently breaks
// the open detail modal: subsequent click handlers all bail on
// `if (!detail) return` because historyDetails[wid] is now undefined,
// and from the user's POV clicks "do nothing" / "hang up". For in-place
// edits the cached detail is in-sync with DB (we mutated it before
// calling the helper), so we only need to invalidate the week summary
// so the History list view reflects fresh totals on next open.
function invalidateHistoryWeekCache() {
  historyWeekCache = {};
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
  // Floating pill (v2.5.9) — only the pill itself shows. The backdrop
  // overlay is intentionally NOT toggled so the app stays interactive
  // while the user rests; CSS keeps .rest-timer-overlay { display: none }
  // unconditionally regardless of any .show class.
  var pill = document.getElementById('restTimer');
  pill.classList.add('show');
  // Drag (v3.6.2): clear any inline transform so the new rest spawns at
  // the default position, even if the previous rest was dragged. Also
  // strips dragging class in case stopRestTimer didn't run cleanly.
  // v3.6.8: also reset the persisted drag offset so the next drag in
  // this fresh rest starts composing from (0, 0), not from the prior
  // rest's last landing spot.
  pill.style.transform = '';
  pill.classList.remove('dragging');
  resetRestTimerDragOffset();
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
  // Backdrop overlay no longer toggled (kept hidden via CSS) — see
  // startRestTimer for the rationale. Removing the class is a no-op
  // visually but keeps state hygienic if some future change re-enables
  // the overlay style.
  document.getElementById('restOverlay').classList.remove('show');
}

function restComplete() {
  if (restCompleted) return;
  restCompleted = true;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  restBeep();
  stopRestTimer();
}

// iOS Web Audio unlock (v3.6.20). On iOS Safari + PWAs, the AudioContext
// starts in 'suspended' state and only becomes playable when audio output
// is initiated FROM a user-gesture handler. restBeep runs from setInterval
// (no gesture), so a fresh page-load that never had a gesture-triggered
// audio event silently dropped the chime — the user reported this as
// "I had not historically been hearing it." Listens for the first touch /
// click, creates the AudioContext, resumes it, and plays a 1ms zero-gain
// tone to flip iOS's unlock state. Listener auto-removes after one fire.
// Cheap (couple of nodes), idempotent (the `unlocked` guard).
(function wireAudioUnlock() {
  var unlocked = false;
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try {
      if (!restAudioCtx) restAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = restAudioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.001);
    } catch(_) {}
  }
  document.addEventListener('touchstart', unlock, { once: true, passive: true });
  document.addEventListener('click', unlock, { once: true });
})();

// Single 880Hz sine chime, ~¼ second, with a smooth attack/release envelope
// so there's no click. AudioContext is lazy-created and reused across rest
// periods (browsers cap pages at ~6 contexts). The starting gesture that
// opened the timer has already unlocked autoplay on iOS/Chrome via
// wireAudioUnlock above.
// Gated on getRestTimerSound() (v3.6.19) — user can mute via hamburger.
function restBeep() {
  if (!getRestTimerSound()) return;
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
                  // Effective weight_mode (v3.1.0): per-set override wins over
                  // exercise's library default. NULL means "inherit library default."
                  weight_mode: s.weight_mode || ex.weight_mode || null,
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
            // Effective mode (v3.1.0): per-set override wins.
            s.weight_mode || ex.weight_mode || '',
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

// Export the coaching profile blob as JSON for pasting into external tools
// (e.g. a separate Claude project). Lazy-loads the profile if the user hasn't
// opened the editor yet this session. Empty profiles still export (with an
// empty object) so the user can confirm the feature works before filling out.
async function exportCoachingProfile() {
  if (coachingProfile === null) {
    await loadCoachingProfile();
  }
  var profile = coachingProfile || {};
  var payload = {
    exported_at: new Date().toISOString(),
    app_version: (typeof APP_VERSION === 'string') ? APP_VERSION : null,
    coaching_profile: profile,
  };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    'coaching-profile-' + localDateString(new Date()) + '.json'
  );
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
document.getElementById('menuImportTemplate').addEventListener('click', function() {
  closeMenu();
  document.getElementById('importTemplateModal').classList.add('show');
});
document.getElementById('menuExport').addEventListener('click', function() {
  closeMenu();
  openExportModal();
});
document.getElementById('menuExportProfile').addEventListener('click', function() {
  closeMenu();
  exportCoachingProfile();
});
document.getElementById('menuStartAnother').addEventListener('click', function() {
  closeMenu();
  openStartScreen();
});
document.getElementById('menuHistory').addEventListener('click', function() {
  closeMenu();
  openHistory();
});
document.getElementById('menuVolumeTrends').addEventListener('click', function() {
  closeMenu();
  openVolumeTrends();
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
  var useBtn = e.target.closest('.plans-btn[data-use-template-id]');
  if (useBtn && !useBtn.disabled) {
    var uid = useBtn.getAttribute('data-use-template-id');
    if (uid) onUseTemplateAsPlan(uid);
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
  var endId = btn.getAttribute('data-end-plan-id');
  if (endId) { onEndPlan(endId); return; }
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
  if (e.target.closest('#btnRefinePlan')) { submitRefinePlan(); return; }
  if (e.target.closest('#btnAnalyzeUseForPlan')) { useAnalysisForNextPlan(); return; }
  if (e.target.closest('#btnAnalyzeApplyProfile')) { onAnalyzeApplyProfileUpdates(); return; }
  if (e.target.closest('#btnAnalyzeChatSend')) { submitAnalyzeChat(); return; }
  if (e.target.closest('#btnGenerateCancel')) { closeGenerate(); return; }
  if (e.target.closest('#btnGenerateAbort')) { cancelGenerate(); return; }
  // Per-exercise swap inside the in-review plan (post-Generate, pre-Accept).
  // Mutates generatedPlan in place; the whole plan persists on Accept.
  var reviewSwapBtn = e.target.closest('[data-swap-review-di]');
  if (reviewSwapBtn) {
    var rsdi = parseInt(reviewSwapBtn.getAttribute('data-swap-review-di'), 10);
    var rsei = parseInt(reviewSwapBtn.getAttribute('data-swap-review-ei'), 10);
    if (!isNaN(rsdi) && !isNaN(rsei)) openSwapModalForReview(rsdi, rsei);
    return;
  }
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
document.getElementById('menuRestTimerSound').addEventListener('click', function() {
  var next = !getRestTimerSound();
  setRestTimerSound(next);
  closeMenu();
  // Preview the chime on flip-to-on so the user hears what they just enabled.
  if (next) restBeep();
  showToast('Rest timer sound ' + (next ? 'on' : 'off'), null);
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
document.getElementById('startPathGenerate').addEventListener('click', function() {
  closeStartScreen();
  openGenerate();
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
(function wireMuscleBandsReset() {
  var btn = document.getElementById('btnCpMuscleBandsReset');
  if (btn) btn.addEventListener('click', resetAllMuscleBands);
})();
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
// Bottom tab nav (v3.6.0). Single delegator across the tab bar; no
// per-tab listeners needed.
document.getElementById('bottomTabBar').addEventListener('click', function(e) {
  var btn = e.target.closest && e.target.closest('.bottom-tab[data-tab]');
  if (!btn) return;
  var name = btn.getAttribute('data-tab');
  setActiveView(name);
});
// Log view launchpad cards open the existing modals.
document.getElementById('logViewBody').addEventListener('click', function(e) {
  var card = e.target.closest && e.target.closest('[data-log-card]');
  if (!card) return;
  var which = card.getAttribute('data-log-card');
  if (which === 'history') openHistory();
  else if (which === 'trends') openVolumeTrends();
});
document.getElementById('btnHistoryClose').addEventListener('click', closeHistory);
document.getElementById('btnVolumeTrendsClose').addEventListener('click', closeVolumeTrends);
document.getElementById('volumeTrendsOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeVolumeTrends();
});
document.getElementById('volumeTrendsBody').addEventListener('click', function(e) {
  var btn = e.target.closest && e.target.closest('[data-vt-weeks]');
  if (!btn) return;
  var w = parseInt(btn.getAttribute('data-vt-weeks'), 10);
  if (Number.isFinite(w) && w !== volumeTrendsState.weeks) {
    loadAndRenderVolumeTrends(w);
  }
});
document.getElementById('btnExHistoryClose').addEventListener('click', closeExerciseHistory);
document.getElementById('exHistoryOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeExerciseHistory();
});
// Tab + form-notes interactions inside the exercise modal. Single
// delegator on the body since the contents re-render frequently.
document.getElementById('exHistoryBody').addEventListener('click', function(e) {
  var tabBtn = e.target.closest && e.target.closest('[data-ex-tab]');
  if (tabBtn) {
    var t = tabBtn.getAttribute('data-ex-tab');
    if (t && t !== exModalState.tab) {
      exModalState.tab = t;
      renderExerciseModal();
    }
    return;
  }
  if (e.target.closest && e.target.closest('#btnFormNotesRegen')) {
    onFormNotesRegen();
    return;
  }
});
// Autosave user notes on blur (textarea is re-mounted on each render so
// listeners attach via delegation, not directly).
document.getElementById('exHistoryBody').addEventListener('blur', function(e) {
  if (e.target && e.target.id === 'formNotesUserInput') {
    onFormNotesUserBlur(e.target);
  }
}, true);  // useCapture: blur doesn't bubble in older specs
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
  // History edit-mode toggle (v2.5.13). Flip the flag and re-render the
  // detail so all inputs / RPE / notes flip between disabled and active.
  var editToggle = e.target.closest ? e.target.closest('#btnHistoryEditToggle') : null;
  if (editToggle) {
    var editWid = editToggle.getAttribute('data-workout-id');
    historyEditMode = !historyEditMode;
    if (editWid && historyDetails[editWid]) {
      renderHistoryDetail(historyDetails[editWid]);
    }
    return;
  }
  // History edit: set check (toggle done). Routes through historyUpdateSetDone
  // which writes done + completed_at; cache + re-render after success.
  if (historyEditMode) {
    var setCheck = e.target.closest ? e.target.closest('.set-check') : null;
    if (setCheck && !setCheck.disabled) {
      onHistorySetCheckClick(setCheck);
      return;
    }
    // History edit: + Add Set (v3.6.3). INSERT a new sets row at the
    // next set_order for this exercise; patch in-memory state.
    var addSetHist = e.target.closest ? e.target.closest('[data-history-add-set-ei]') : null;
    if (addSetHist) {
      var widASH = _historyDetailWorkoutId();
      var eiASH = parseInt(addSetHist.getAttribute('data-history-add-set-ei'), 10);
      if (widASH && Number.isFinite(eiASH)) onHistoryAddSet(widASH, eiASH);
      return;
    }
    // History edit: × delete on user-added sets (v3.6.3). Renders only on
    // sl.isExtra rows so prescribed sets stay protected.
    var delSetHist = e.target.closest ? e.target.closest('.set-delete') : null;
    if (delSetHist && !delSetHist.disabled) {
      var diDSH = delSetHist.getAttribute('data-di');
      // History rows render with data-di='history' — gate so the live-
      // session deleteSet doesn't fire on the same click.
      if (diDSH === 'history') {
        var widDSH = _historyDetailWorkoutId();
        var eiDSH = parseInt(delSetHist.getAttribute('data-ei'), 10);
        var siDSH = parseInt(delSetHist.getAttribute('data-si'), 10);
        if (widDSH && Number.isFinite(eiDSH) && Number.isFinite(siDSH)) {
          onHistoryDeleteSet(widDSH, eiDSH, siDSH);
        }
        return;
      }
    }
    // History edit: RPE button. The data-history-rpe + data-history-ex-order
    // attrs are added at render time only when in edit mode.
    var histRpeBtn = e.target.closest ? e.target.closest('[data-history-rpe]') : null;
    if (histRpeBtn) {
      onHistoryRpeClick(histRpeBtn);
      return;
    }
    // Per-workout weight-mode chip in history-edit mode (v3.1.0).
    var histWmChip = e.target.closest ? e.target.closest('[data-history-toggle-weight-mode]') : null;
    if (histWmChip) {
      var histWmEi = parseInt(histWmChip.getAttribute('data-history-ex-order'), 10);
      var histWmWid = histWmChip.getAttribute('data-history-workout-id');
      var histWmDetails = historyDetails[histWmWid];
      if (!histWmDetails) return;
      var histWmEx = histWmDetails.state.exercises['ex_' + histWmEi];
      if (!histWmEx) return;
      // Resolve meta the same way renderHistoryExerciseCard's chipMeta
      // does — exerciseMeta is null on plan-day prescribed history rows;
      // fall back to a library lookup by the persisted set's exercise_id
      // so first-tap correctly inverts the displayed state. Without this
      // a per_side-default plan-day historical exercise would silently
      // no-op on the first tap (issue from final v3.1.0 review).
      var histMeta = histWmEx.exerciseMeta
        || (histWmEx.sets[0] && histWmEx.sets[0].exerciseId
            ? (exerciseLibraryById[histWmEx.sets[0].exerciseId] || null)
            : null);
      var histWmCur = effectiveWeightMode(histWmEx.sets[0], histMeta);
      var histWmNext = histWmCur === 'per_side' ? 'total' : 'per_side';
      // Wrap in a named local so the failure toast can re-invoke the same
      // write — matches the retry pattern used by setExerciseWeightMode.
      function retryHistWeightMode() {
        historyUpdateExerciseWeightMode(histWmWid, histWmEi, histWmNext).then(function() {
          for (var hi = 0; hi < histWmEx.sets.length; hi++) {
            if (histWmEx.sets[hi]) histWmEx.sets[hi].weight_mode = histWmNext;
          }
          renderHistoryDetail(histWmDetails);
        }).catch(function(err) {
          console.error('history weight-mode toggle failed:', err);
          showToast("Weight mode didn't save", retryHistWeightMode);
        });
      }
      retryHistWeightMode();
      return;
    }
  }
  var row = e.target.closest ? e.target.closest('.history-row') : null;
  if (row) {
    openHistoryDetail(row.getAttribute('data-workout-id'));
    return;
  }
});

// History detail change handler (v2.5.13). Catches set-input edits, per-
// exercise note blur, and workout-notes blur. All three route to the
// historyUpdate* helpers in data.js, then update the local
// historyDetails cache + re-render the detail.
document.getElementById('historyBody').addEventListener('change', function(e) {
  if (!historyEditMode) return;
  var t = e.target;
  if (!t || t.disabled) return;
  // Set inputs (weight, reps, duration_seconds, distance) — catch on
  // change rather than blur so the value persists even if the user
  // closes the modal mid-edit.
  if (t.classList && t.classList.contains('set-input')) {
    onHistorySetInputChange(t);
    return;
  }
  // Per-exercise note textarea — saves on change/blur.
  if (t.hasAttribute && t.hasAttribute('data-history-ex-note')) {
    onHistoryExerciseNoteChange(t);
    return;
  }
  // Workout-level notes textarea.
  if (t.hasAttribute && t.hasAttribute('data-history-workout-notes')) {
    onHistoryWorkoutNotesChange(t);
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
document.getElementById('importTemplateZone').addEventListener('click', function() {
  document.getElementById('templateFileInput').click();
});
document.getElementById('templateFileInput').addEventListener('change', handleImportTemplate);
document.getElementById('btnCancelImportTemplate').addEventListener('click', function() {
  document.getElementById('importTemplateModal').classList.remove('show');
});
document.getElementById('importTemplateModal').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('show');
});
document.getElementById('btnRest').addEventListener('click', function() { startRestTimer(90); });
document.getElementById('btnStopRest').addEventListener('click', stopRestTimer);
document.getElementById('restOverlay').addEventListener('click', stopRestTimer);

// Rest timer drag-to-move (v3.6.2; v3.6.8 fix: drags compose). Pointer-
// events for unified mobile + desktop. Drag only initiates on pointerdown
// to non-button regions of the pill so the buttons (-15s / +15s / Skip)
// stay clickable. 5px threshold before entering drag mode means short
// taps near the time display don't shift the pill. Position resets to
// default on every new rest period (startRestTimer clears inline
// transform AND resets the persisted offset via resetRestTimerDragOffset).
//
// v3.6.8: each pointerdown now captures the pill's CURRENT offset as the
// drag base. Without this, the second drag would teleport the pill back
// toward the default centered position — the bug described as "moves
// another direction or overshoots."
var _restPillOffsetX = 0;
var _restPillOffsetY = 0;
function resetRestTimerDragOffset() {
  _restPillOffsetX = 0;
  _restPillOffsetY = 0;
}
(function wireRestTimerDrag() {
  var pill = document.getElementById('restTimer');
  if (!pill) return;
  var dragState = null;  // { startX, startY, baseX, baseY, dragging } | null
  var DRAG_THRESHOLD = 5;

  pill.addEventListener('pointerdown', function(e) {
    if (e.target.closest && e.target.closest('button')) return;
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: _restPillOffsetX,
      baseY: _restPillOffsetY,
      pointerId: e.pointerId,
      dragging: false,
    };
  });

  pill.addEventListener('pointermove', function(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;
    if (!dragState.dragging) {
      var moved = Math.abs(dx) + Math.abs(dy);
      if (moved < DRAG_THRESHOLD) return;
      dragState.dragging = true;
      pill.classList.add('dragging');
      try { pill.setPointerCapture(e.pointerId); } catch (_) {}
    }
    e.preventDefault();
    dragState.lastX = dragState.baseX + dx;
    dragState.lastY = dragState.baseY + dy;
    // Compose with the centering offset (-50%) so X moves relative to
    // the pill's default-centered baseline, while Y is a plain offset.
    pill.style.transform = 'translate(calc(-50% + ' + dragState.lastX + 'px), ' + dragState.lastY + 'px)';
  });

  function endDrag(e) {
    if (!dragState) return;
    if (e && dragState.pointerId !== e.pointerId) return;
    if (dragState.dragging) {
      // Persist the last applied offset so the next drag composes on top
      // of it. Read from dragState (set on pointermove) rather than re-
      // deriving from e — pointercancel may fire with stale coords.
      _restPillOffsetX = dragState.lastX;
      _restPillOffsetY = dragState.lastY;
      try { pill.releasePointerCapture(dragState.pointerId); } catch (_) {}
      pill.classList.remove('dragging');
    }
    dragState = null;
  }
  pill.addEventListener('pointerup', endDrag);
  pill.addEventListener('pointercancel', endDrag);
})();
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
  // Inline form notes (v3.6.10): expand/collapse pill.
  var fnToggle = target.closest ? target.closest('[data-toggle-form-notes]') : null;
  if (fnToggle) {
    var fnEi = fnToggle.getAttribute('data-ei');
    if (fnEi != null) {
      var fnKey = 'ex_' + fnEi;
      formNotesExpanded[fnKey] = !formNotesExpanded[fnKey];
      buildDay(currentDay);
    }
    return;
  }
  // Inline form notes: regen / "Get form cue" button.
  var fnRegen = target.closest ? target.closest('[data-regen-form-notes]') : null;
  if (fnRegen) {
    if (fnRegen.disabled) return;
    var rEi = fnRegen.getAttribute('data-ei');
    var rExid = fnRegen.getAttribute('data-exid');
    if (rEi != null && rExid) onInlineFormNotesRegen(parseInt(rEi, 10), rExid);
    return;
  }
  // Superset pair / unpair (v3.4.0). On standalone cards opens the merge
  // picker. On cards inside a block, removes from the superset (Task 10
  // wires the unpair branch; here a no-op stub).
  var supBtn = target.closest && target.closest('.ex-superset-btn');
  if (supBtn) {
    var supDi = supBtn.getAttribute('data-di');
    if (!isAdHocKey(supDi)) supDi = parseInt(supDi, 10);
    var supEi = parseInt(supBtn.getAttribute('data-ei'), 10);
    if (supBtn.classList.contains('in-block')) {
      onRemoveFromSuperset(supDi, supEi);
      return;
    }
    openSupersetPicker(supDi, supEi);
    return;
  }
  var addRoundBtn = target.closest && target.closest('[data-add-round]');
  if (addRoundBtn) {
    var addRoundDi = addRoundBtn.getAttribute('data-di');
    if (!isAdHocKey(addRoundDi)) addRoundDi = parseInt(addRoundDi, 10);
    var addRoundGroupKey = addRoundBtn.getAttribute('data-add-round');
    (async function() {
      try {
        await addRoundToBlockMembers(addRoundDi, addRoundGroupKey);
        if (isAdHocKey(addRoundDi)) {
          buildAdHocDay(addRoundDi);
        } else {
          buildDay(addRoundDi);
        }
      } catch (err) {
        console.error('addRoundToBlockMembers error:', err);
        showToast("Couldn't add round: " + (err.message || 'unknown'), null);
      }
    })();
    return;
  }
  // Per-exercise recent history — handled before header-expand because this
  // button lives inside .exercise-header.
  var histBtn = target.closest ? target.closest('.ex-history-btn') : null;
  if (histBtn) {
    openExerciseHistory(histBtn.getAttribute('data-exercise-name'));
    return;
  }
  // Per-workout weight-mode chip toggle (v3.1.0). Editable today + ad-hoc.
  // Stamps the same value on every set in the placement, then re-renders
  // the day so chip + per-side hint + volume math all reflect the change.
  // Handled before .exercise-header expand — chip lives inside that header.
  var wmChip = target.closest ? target.closest('[data-toggle-weight-mode-ei]') : null;
  if (wmChip) {
    if (wmChip.disabled) return;
    var wmEi = parseInt(wmChip.getAttribute('data-toggle-weight-mode-ei'), 10);
    if (isNaN(wmEi)) return;
    var wmDi = currentDay;
    // v3.6.15: lazy-init state so the chip works pre-session (was bailing
    // when todayState was null on plan-day cards before Start Session).
    // getOrInitToday creates the in-memory shell without inserting a DB
    // row; setExerciseWeightMode does the same lazy-init internally.
    var wmSt = isAdHocKey(wmDi) ? findAdHoc(wmDi) : getOrInitToday(wmDi);
    if (!wmSt) return;
    var wmExState = getOrInitExercise(wmSt, wmEi);
    // Resolve meta the same way the chip render does. exerciseMeta is
    // only attached in stateFromWorkout for ad-hoc / extras-on-plan rows;
    // for plan-day prescribed exercises we fall back to the library row
    // by name. Without this fallback, the first tap on a per_side-default
    // plan-day exercise computes current='total' and silently stamps the
    // same value the chip already displays.
    var wmCurMeta = wmExState.subExercise || wmExState.exerciseMeta;
    if (!wmCurMeta && !wmSt.isAdHoc && plan && plan.days && plan.days[wmDi] && plan.days[wmDi].exercises && plan.days[wmDi].exercises[wmEi]) {
      wmCurMeta = exerciseLibraryByName[normName(plan.days[wmDi].exercises[wmEi].name)] || null;
    }
    // Override field is the most-recent source of truth (pre-session chip
    // toggle landed there); fall through to set stamp then library default.
    var wmCurMode = wmExState.weight_mode_override
      || effectiveWeightMode(wmExState.sets[0], wmCurMeta);
    var wmNext = wmCurMode === 'per_side' ? 'total' : 'per_side';
    setExerciseWeightMode(wmDi, wmEi, wmNext).then(function() {
      buildDay(wmDi);
    });
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
  // Add Set / Add Drop Set on an exercise. Drop Set has a distinct
  // data attribute so it doesn't accidentally fall through to addExtraSet.
  var addDropBtn = target.closest ? target.closest('[data-add-drop-ei]') : null;
  if (addDropBtn) {
    if (addDropBtn.disabled) return;
    addDropSet(parseInt(addDropBtn.getAttribute('data-add-drop-ei'), 10));
    return;
  }
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
  // Inline form notes (v3.6.10) — user note saves on blur via the
  // `change` event (fires when the textarea loses focus). Same upsert
  // path the modal uses (saveUserFormNote); also patches the in-memory
  // formNotesCache so the next render reflects it.
  if (t.hasAttribute && t.hasAttribute('data-user-form-notes')) {
    var ufnExid = t.getAttribute('data-exid');
    if (ufnExid) onInlineFormNotesUserBlur(ufnExid, t.value);
  }
});
