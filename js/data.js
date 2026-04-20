// data.js — Supabase client, cross-cutting state, queries, and persistence.
//
// Loads after resolver.js. UI and auth files reference the state variables and
// functions declared here by name; because these are plain-script <script> tags
// (no imports), every top-level declaration ends up on the shared global and is
// visible to later-loaded files at call time.

// ---- Supabase config ----
// -----------------------------------------------------------------------------
// Supabase config.
//
// The anon key below is PUBLIC BY DESIGN. Supabase issues it for browser use,
// and data access is protected by Row-Level Security policies (see
// supabase/migrations/). Shipping this key in a static HTML file is the
// intended pattern.
//
// NEVER add the `service_role` key here — it bypasses RLS and would give any
// visitor full admin access to the database. The service_role key belongs only
// in server-side environments, never in any file served to a browser.
// -----------------------------------------------------------------------------
var SUPABASE_URL = 'https://kgrmlgrzaxbwpkmziwxp.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_Yh8YMh9yq0gQ77OD-oiQ1A_9MHS_6rB';
var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- State ----
var activePlanId = null;
var plan = null;              // active plan's data blob
var currentDay = 0;

// sessionTodayStart: snapshot of "today's midnight" taken once per hydrate.
// Reused everywhere that needs to determine the today/historical boundary,
// so a session that straddles midnight doesn't silently slip the boundary
// underfoot and relabel already-logged sets as a new day. Reset on sign-out
// and re-taken on the next hydrate (sign-in or reload).
var sessionTodayStart = null;

// todayPlanStates: map of plan-based workouts for today, keyed by day_index.
// Each plan-day tab independently tracks its own today-workout, so a user
// can log Monday and Tuesday back-to-back on the same calendar date. Each
// entry is lazy-created on first set-done for that day_index. Shape:
// { [dayIndex]: { workoutId, planId, dayIndex, startedAt, endedAt,
//                 exercises: { ex_<ei>: { rpe, note, sub, sets: [...],
//                                         isExtra?, exerciseId?, exerciseMeta? } } } }
var todayPlanStates = {};

// todayAdHocs: ad-hoc workouts started today (plan_id = NULL, day_index = NULL).
// Each entry has the same exercises shape as a plan state plus isAdHoc: true
// and an optional title.
var todayAdHocs = [];

// todayState: pointer to whichever workout state is currently focused in the
// UI (updated by focusTab). Mutating handlers (toggleSet / logSet / logRPE /
// logNote / logSub / completeSession) operate on todayState so they work
// identically for plan-based and ad-hoc sessions.
var todayState = null;

// suggestedDayIndex: rotation-based "next day to train" hint for the active
// plan, computed once per hydrate from the most recent completed workout.
// null means "no plan active OR no completed workouts yet" — the start modal
// treats both as "suggest Day 0" for a fresh plan.
var suggestedDayIndex = null;

var historicalCache = {};     // dayIndex -> state (read-only past workouts)
var planCache = {};           // planId -> plan blob
var exerciseIdCache = {};     // normName -> uuid

// Exercise library (seed + user custom). Loaded once per session.
var exerciseLibrary = [];        // array of exercise rows
var exerciseLibraryByName = {};  // normName -> row
var exerciseLibraryById = {};    // uuid -> row
var recentExercises = [];        // most-recently-logged first, up to 10

// Gym profiles (user-defined training locations). Loaded once per session.
// recentLocationId is computed at hydrate time from the most recent workout
// whose location_id is not null; used as the default for fresh sessions.
var locations = [];              // array of location rows, created_at desc
var locationById = {};           // uuid -> row
var recentLocationId = null;     // uuid of the most recently used gym, or null

// ---- State helpers ----
function _planForState(state) {
  if (state && state.planId && planCache[state.planId]) return planCache[state.planId];
  return plan;
}

function isAdHocKey(di) {
  return typeof di === 'string' && di.indexOf('ah_') === 0;
}

function findAdHoc(di) {
  if (!isAdHocKey(di)) return null;
  var id = di.slice(3);
  for (var i = 0; i < todayAdHocs.length; i++) {
    if (todayAdHocs[i].workoutId === id) return todayAdHocs[i];
  }
  return null;
}

function focusTab(di) {
  currentDay = di;
  if (isAdHocKey(di)) {
    todayState = findAdHoc(di) || null;
  } else {
    // Plan-day tab: todayState follows the plan-state for that day (may be
    // null until first set-done creates it lazily).
    todayState = todayPlanStates[di] || null;
  }
}

// ---- Time helpers ----
function dayBounds(date) {
  var start = new Date(date); start.setHours(0,0,0,0);
  var end = new Date(start); end.setDate(end.getDate() + 1);
  return { start: start, end: end };
}

// Session-stable today window. sessionTodayStart is snapshotted at the top
// of hydrate; any caller that needs the today/past boundary uses this helper
// so mid-session midnight crossings don't change the answer.
function sessionBounds() {
  var start = sessionTodayStart || dayBounds(new Date()).start;
  var end = new Date(start); end.setDate(end.getDate() + 1);
  return { start: start, end: end };
}

function localDateString(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1); if (m.length < 2) m = '0' + m;
  var d = String(date.getDate()); if (d.length < 2) d = '0' + d;
  return y + '-' + m + '-' + d;
}

// Canonical "today" date string (YYYY-MM-DD in the user's local timezone)
// for writing to workouts.performed_on. Matches the sessionBounds snapshot
// so the DB uniqueness key lines up with what hydrate treats as today.
function sessionTodayDateString() {
  return localDateString(sessionTodayStart || dayBounds(new Date()).start);
}

// ---- Hydration helpers ----
function stateFromWorkout(row) {
  var state = {
    workoutId: row.id, planId: row.plan_id, dayIndex: row.day_index,
    startedAt: row.started_at, endedAt: row.ended_at,
    pausedMs: row.paused_ms || 0,
    notes: row.notes || '',
    notesExpanded: !!(row.notes && row.notes.trim()),
    locationId: row.location_id || null,
    exercises: {}
  };
  var isAdHocWorkout = row.plan_id === null;
  // Plan length at that workout's pinned plan (may be 0 if plan not yet cached).
  var pinnedPlan = row.plan_id && planCache[row.plan_id];
  var planLen = (pinnedPlan && pinnedPlan.days && pinnedPlan.days[row.day_index])
    ? pinnedPlan.days[row.day_index].exercises.length : 0;
  var sets = row.sets || [];
  for (var i = 0; i < sets.length; i++) {
    var s = sets[i];
    var ek = 'ex_' + s.exercise_order;
    if (!state.exercises[ek]) {
      state.exercises[ek] = { rpe: null, note: '', sub: '', sets: [] };
      // For ad-hoc workouts, every exercise has no prescription — attach meta
      // but don't flag isExtra (the "added" badge only applies on plan days).
      // For plan-based workouts, sets past plan length are extras.
      var isExtraOnPlan = !isAdHocWorkout && planLen && s.exercise_order >= planLen;
      if (isAdHocWorkout || isExtraOnPlan) {
        state.exercises[ek].exerciseId = s.exercise_id;
        state.exercises[ek].exerciseMeta = exerciseLibraryById[s.exercise_id] || null;
      }
      if (isExtraOnPlan) state.exercises[ek].isExtra = true;
    }
    var isExtraOnPlanExercise = false;
    if (!isAdHocWorkout && planLen && s.exercise_order < planLen) {
      var presc = pinnedPlan.days[row.day_index].exercises[s.exercise_order];
      var prescSetCount = (presc && presc.sets) ? presc.sets.length : 0;
      if (prescSetCount > 0 && s.set_order >= prescSetCount) {
        isExtraOnPlanExercise = true;
      }
    }
    var setIsExtra = isAdHocWorkout || isExtraOnPlan || isExtraOnPlanExercise;
    state.exercises[ek].sets[s.set_order] = {
      setId: s.id, weight: s.weight, reps: s.reps, done: !!s.done,
      exerciseId: s.exercise_id,
      startedAt: s.started_at, completedAt: s.completed_at,
    };
    if (setIsExtra) state.exercises[ek].sets[s.set_order].isExtra = true;
    if (s.rpe != null) state.exercises[ek].rpe = s.rpe;
    if (s.note) state.exercises[ek].note = s.note;
    if (s.substitution) state.exercises[ek].sub = s.substitution;
  }
  return state;
}

function seedExerciseIdCache(state) {
  if (!state) return;
  var planBlob = _planForState(state);
  if (!planBlob || !planBlob.days[state.dayIndex]) return;
  var exs = planBlob.days[state.dayIndex].exercises;
  for (var ek in state.exercises) {
    var ei = parseInt(ek.slice(3), 10);
    var arr = state.exercises[ek].sets;
    for (var si = 0; si < arr.length; si++) {
      if (arr[si] && arr[si].exerciseId && exs[ei]) {
        exerciseIdCache[normName(exs[ei].name)] = arr[si].exerciseId;
      }
    }
  }
}

// ---- Queries ----
async function loadHistorical(di) {
  if (historicalCache[di]) return historicalCache[di];
  try {
    var bounds = sessionBounds();
    var res = await sb.from('workouts').select('*, sets(*)')
      .eq('user_id', userId).eq('day_index', di)
      .lt('performed_at', bounds.start.toISOString())
      .order('performed_at', { ascending: false }).limit(1);
    if (res.error) { showToast('Failed to load history for this day', null); return null; }
    if (!res.data || !res.data.length) return null;
    var row = res.data[0];
    if (row.plan_id && !planCache[row.plan_id]) {
      var pr = await sb.from('plans').select('data').eq('id', row.plan_id).maybeSingle();
      if (pr.data) planCache[row.plan_id] = pr.data.data;
    }
    var state = stateFromWorkout(row);
    historicalCache[di] = state;
    return state;
  } catch(err) {
    console.error('loadHistorical error:', err);
    return null;
  }
}

async function loadExerciseLibrary() {
  var res = await sb.from('exercises').select('*').order('name');
  if (res.error) { showToast('Failed to load exercise library', null); return; }
  exerciseLibrary = res.data || [];
  exerciseLibraryByName = {};
  exerciseLibraryById = {};
  for (var i = 0; i < exerciseLibrary.length; i++) {
    var row = exerciseLibrary[i];
    var key = normName(row.name);
    exerciseLibraryByName[key] = row;
    exerciseLibraryById[row.id] = row;
    exerciseIdCache[key] = row.id;
    // Secondary index: also key by the dehyphenated form so lookups like
    // "Pull Up" (no hyphen) resolve the seed "pull-up" (hyphenated).
    var dh = key.replace(/-/g, ' ');
    if (dh !== key && !exerciseLibraryByName[dh]) exerciseLibraryByName[dh] = row;
  }
}

async function loadRecentExercises() {
  var res = await sb.from('sets')
    .select('exercise_id, completed_at')
    .eq('user_id', userId).eq('done', true)
    .order('completed_at', { ascending: false })
    .limit(100);
  if (res.error) return;
  var seen = {};
  var out = [];
  var rows = res.data || [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.exercise_id || seen[r.exercise_id]) continue;
    seen[r.exercise_id] = true;
    var meta = exerciseLibraryById[r.exercise_id];
    if (meta) out.push(meta);
    if (out.length >= 10) break;
  }
  recentExercises = out;
}

// Find the most recent completed workout for the active plan and compute the
// next-in-rotation day_index. Run once per hydrate. No-op when there is no
// active plan; leaves suggestedDayIndex at null (start modal treats that as
// "suggest Day 0" for a fresh plan).
async function loadSuggestedDayIndex() {
  if (!activePlanId || !plan || !plan.days || !plan.days.length) {
    suggestedDayIndex = null;
    return;
  }
  var res = await sb.from('workouts')
    .select('day_index')
    .eq('user_id', userId)
    .eq('plan_id', activePlanId)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1);
  if (res.error) {
    // Non-fatal — the modal will just default to Day 0 as the suggestion.
    console.error('loadSuggestedDayIndex error:', res.error);
    suggestedDayIndex = 0;
    return;
  }
  if (!res.data || !res.data.length || res.data[0].day_index == null) {
    suggestedDayIndex = 0;
    return;
  }
  suggestedDayIndex = (res.data[0].day_index + 1) % plan.days.length;
}

// ---- Week summary (shared: History browser UI + AI planner Edge Function) ----
//
// Fetches one week of training data and returns a structured summary with
// per-workout detail plus week-level aggregates. Contract is stable so a
// Node-side variant in api/generate-plan.js can mirror the same shape.
//
// weekStartDate / weekEndDate are inclusive 'YYYY-MM-DD' calendar dates.
// Uses workouts.performed_on (a NOT NULL date column) so the window is
// purely calendar-based — no timezone math on the client.
//
// Volume respects weight_mode:
//   - 'total'       → weight × reps
//   - 'per_side'    → weight × 2 × reps    (weight is per-hand)
//   - 'bodyweight'  → weight × reps        (weight = ADDED load only;
//                                           we never estimate body weight)
//   - 'none'        → 0
// Only done=true sets contribute to volume, completion counts, and RPE avgs.
// Extras (exercise_order past plan length, or set_order past prescribed
// count) count toward volume but NOT toward completion ratios, so
// completionRate measures plan adherence rather than effort.
async function fetchWeekSummary(userId, weekStartDate, weekEndDate) {
  var wRes = await sb.from('workouts')
    .select('*, sets(*, exercises(name, equipment, muscle_group, weight_mode))')
    .eq('user_id', userId)
    .gte('performed_on', weekStartDate)
    .lte('performed_on', weekEndDate)
    .order('performed_on', { ascending: true })
    .order('started_at', { ascending: true, nullsFirst: true });
  if (wRes.error) throw wRes.error;
  var rows = wRes.data || [];

  // Pre-fetch any plan blobs not already cached (mirrors runExport).
  var uncached = {};
  for (var i = 0; i < rows.length; i++) {
    var pid = rows[i].plan_id;
    if (pid && !planCache[pid]) uncached[pid] = true;
  }
  var pending = Object.keys(uncached);
  if (pending.length) {
    var pRes = await sb.from('plans').select('id, title, data').in('id', pending);
    if (pRes.error) throw pRes.error;
    var planRows = pRes.data || [];
    for (var p = 0; p < planRows.length; p++) {
      planCache[planRows[p].id] = planRows[p].data;
      planCache[planRows[p].id]._title = planRows[p].title;
    }
  }

  var workouts = rows.map(_summarizeWorkoutRow);

  // Week-level rollup.
  var trainedPlanDays = {};
  var skippedAcross = {};
  var adHocCount = 0;
  var volSum = 0;
  var rpeSum = 0, rpeSetCount = 0;
  var planForWeek = null;

  for (var j = 0; j < workouts.length; j++) {
    var w = workouts[j];
    volSum += w.totalVolume;
    if (w.avgRpe != null && w.completedSets > 0) {
      rpeSum += w.avgRpe * w.completedSets;
      rpeSetCount += w.completedSets;
    }
    if (w.isAdHoc) {
      adHocCount++;
    } else {
      if (w._dayIndex != null && w.completedSets > 0) trainedPlanDays[w._dayIndex] = true;
      for (var s = 0; s < w.skippedExercises.length; s++) {
        skippedAcross[w.skippedExercises[s]] = true;
      }
      if (!planForWeek && w._planBlob) planForWeek = w._planBlob;
    }
    delete w._dayIndex;
    delete w._planBlob;
  }

  var daysPlanned = planForWeek && planForWeek.days ? planForWeek.days.length : null;
  var daysTrained = Object.keys(trainedPlanDays).length;

  return {
    weekStart: weekStartDate,
    weekEnd: weekEndDate,
    workouts: workouts,
    daysPlanned: daysPlanned,
    daysTrained: daysTrained,
    weekCompletionRate: daysPlanned ? Math.round((daysTrained / daysPlanned) * 100) / 100 : null,
    weekAvgRpe: rpeSetCount ? Math.round((rpeSum / rpeSetCount) * 10) / 10 : null,
    weekTotalVolume: Math.round(volSum),
    exercisesSkippedAcrossWeek: Object.keys(skippedAcross).sort(),
    adHocSessions: adHocCount,
  };
}

// Map one workouts row (with sets + exercises joined) into the per-workout
// summary shape. Uses _dayIndex / _planBlob as transient fields the
// week-level rollup strips before returning.
function _summarizeWorkoutRow(row) {
  var isAdHoc = row.plan_id === null;
  var planBlob = row.plan_id ? planCache[row.plan_id] : null;
  var dayPlan = (planBlob && planBlob.days && planBlob.days[row.day_index]) || null;
  var planTitle = planBlob ? (planBlob.title || planBlob._title || null) : null;
  var dayName = isAdHoc
    ? ((row.title && row.title.trim()) ? row.title.trim() : 'Ad-hoc session')
    : (dayPlan ? dayPlan.name : 'Day ' + ((row.day_index || 0) + 1));

  // durationMs <= 0 covers historical imports that set started_at === ended_at
  // (instant-inserted rows have no real duration); return null so consumers
  // can distinguish "unknown" from "very short."
  var durationMs = (row.started_at && row.ended_at)
    ? (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime() - (row.paused_ms || 0))
    : null;
  var duration = (durationMs != null && durationMs > 0) ? Math.round(durationMs / 60000) : null;

  var sorted = (row.sets || []).slice().sort(function(a, b) {
    if (a.exercise_order !== b.exercise_order) return a.exercise_order - b.exercise_order;
    return a.set_order - b.set_order;
  });

  var planLen = (dayPlan && dayPlan.exercises) ? dayPlan.exercises.length : 0;
  var byOrder = {};
  var totalVolume = 0;
  var loggedSets = 0, loggedDone = 0;
  var rpeSum = 0, rpeCount = 0;
  var completedPrescribed = 0;

  for (var i = 0; i < sorted.length; i++) {
    var s = sorted[i];
    var ex = s.exercises || {};
    var mode = ex.weight_mode || 'total';
    var eo = s.exercise_order;

    if (!byOrder[eo]) {
      byOrder[eo] = {
        name: ex.name || null,
        equipment: ex.equipment || null,
        muscleGroup: ex.muscle_group || null,
        weightMode: mode,
        sets: [],
      };
    }
    byOrder[eo].sets.push({
      weight: s.weight,
      reps: s.reps,
      rpe: s.rpe,
      prescribedWeight: s.prescribed_weight,
      prescribedReps: s.prescribed_reps,
      done: !!s.done,
      completedAt: s.completed_at,
    });

    loggedSets++;
    if (s.done) {
      loggedDone++;
      totalVolume += _volumeForSet(s.weight, s.reps, mode);
      if (s.rpe != null) { rpeSum += s.rpe; rpeCount++; }
      // Count toward prescribed completion only if this set lands in a
      // prescribed slot (not an extras-exercise, not an extra set past the
      // prescribed count for that exercise).
      if (!isAdHoc && planLen && eo < planLen) {
        var prescEx = dayPlan.exercises[eo];
        var prescSetCount = (prescEx && prescEx.sets) ? prescEx.sets.length : 0;
        if (prescSetCount && s.set_order < prescSetCount) completedPrescribed++;
      }
    }
  }

  var exercises = Object.keys(byOrder)
    .map(function(k) { return { order: parseInt(k, 10), data: byOrder[k] }; })
    .sort(function(a, b) { return a.order - b.order; })
    .map(function(e) { return e.data; });

  var skipped = [];
  var prescribedTotal = 0;
  if (!isAdHoc && dayPlan && dayPlan.exercises) {
    for (var p = 0; p < dayPlan.exercises.length; p++) {
      var pe = dayPlan.exercises[p];
      prescribedTotal += (pe && pe.sets) ? pe.sets.length : 0;
      if (!byOrder[p]) skipped.push(pe.name);
    }
  }

  var totalSets, completedSets;
  if (isAdHoc) {
    totalSets = loggedSets;
    completedSets = loggedDone;
  } else {
    totalSets = prescribedTotal;
    completedSets = completedPrescribed;
  }

  return {
    id: row.id,
    date: row.performed_on,
    dayName: dayName,
    isAdHoc: isAdHoc,
    planTitle: planTitle,
    duration: duration,
    exercises: exercises,
    totalSets: totalSets,
    completedSets: completedSets,
    completionRate: totalSets ? Math.round((completedSets / totalSets) * 100) / 100 : 0,
    skippedExercises: skipped,
    avgRpe: rpeCount ? Math.round((rpeSum / rpeCount) * 10) / 10 : null,
    totalVolume: Math.round(totalVolume),
    notes: row.notes || '',
    _dayIndex: row.day_index,
    _planBlob: planBlob,
  };
}

function _volumeForSet(weight, reps, mode) {
  if (!reps || reps <= 0) return 0;
  if (mode === 'none') return 0;
  if (weight == null) return 0;
  if (mode === 'per_side') return weight * 2 * reps;
  return weight * reps;
}

// ---- Weight unit conversion (kg / lbs) ----
// Canonical storage for sets.weight is always lbs. Conversion happens at the
// display/input boundary based on the user's localStorage preference. See
// docs/superpowers/specs/2026-04-19-kg-lbs-toggle-design.md.
var LBS_PER_KG = 2.20462;

function getWeightUnit() {
  var v = localStorage.getItem('weightUnit');
  return v === 'kg' ? 'kg' : 'lbs';
}

function setWeightUnit(unit) {
  localStorage.setItem('weightUnit', unit === 'kg' ? 'kg' : 'lbs');
}

function lbsToKg(lbs) {
  if (lbs == null) return null;
  return Math.round((lbs / LBS_PER_KG) * 10) / 10;
}

function kgToLbs(kg) {
  if (kg == null) return null;
  return Math.round(kg * LBS_PER_KG * 100) / 100;
}

// Render a canonical lbs value as a display string in the requested unit.
// lbs: up to 2 decimal places, trailing zeros stripped ("90", "88.18").
// kg: 1 decimal place ("40.0", "39.9").
function displayWeight(lbsValue, unit) {
  if (lbsValue == null || lbsValue === '') return '';
  if (unit === 'kg') {
    var kg = lbsToKg(lbsValue);
    return kg.toFixed(1);
  }
  var n = Math.round(lbsValue * 100) / 100;
  if (n === Math.floor(n)) return String(Math.floor(n));
  return String(n).replace(/\.?0+$/, '');
}

// Parse a raw input string in the given unit and return the canonical
// lbs value (number) or null for empty/invalid input.
function parseWeightInput(rawStr, unit) {
  if (rawStr === '' || rawStr == null) return null;
  var parsed = parseFloat(rawStr);
  if (isNaN(parsed)) return null;
  if (unit === 'kg') return kgToLbs(parsed);
  return Math.round(parsed * 100) / 100;
}

// Normalize a prescribed-set object's weight to canonical lbs, regardless of
// the plan JSON's declared unit. Plans that omit `unit` or use 'lbs' pass
// through; 'kg' converts. Used by fmtP and placeholder rendering.
function normalizePrescribedLbs(prescribedSet) {
  if (!prescribedSet || prescribedSet.weight == null) return null;
  if (prescribedSet.unit === 'kg') return kgToLbs(prescribedSet.weight);
  return prescribedSet.weight;
}

function bumpRecent(exerciseRow) {
  if (!exerciseRow) return;
  var filtered = recentExercises.filter(function(e) { return e.id !== exerciseRow.id; });
  recentExercises = [exerciseRow].concat(filtered).slice(0, 10);
}

// ---- Gym profiles ----
async function loadLocations() {
  var res = await sb.from('locations').select('*').order('created_at', { ascending: false });
  if (res.error) { showToast('Failed to load gym profiles', null); return; }
  locations = res.data || [];
  locationById = {};
  for (var i = 0; i < locations.length; i++) {
    locationById[locations[i].id] = locations[i];
  }
  // Compute the most-recently-used location so fresh sessions can default to it.
  var recent = await sb.from('workouts')
    .select('location_id')
    .eq('user_id', userId)
    .not('location_id', 'is', null)
    .order('performed_at', { ascending: false })
    .limit(1);
  if (recent.error) { recentLocationId = null; return; }
  recentLocationId = (recent.data && recent.data[0]) ? recent.data[0].location_id : null;
}

// ---- Mode / state selection ----
function viewModeFor(di) {
  if (isAdHocKey(di)) {
    return findAdHoc(di) ? 'editable' : 'template';
  }
  // Each plan day tracks its own today-workout independently now: any tab
  // without a historical past workout is editable (fresh if no today state yet).
  if (todayPlanStates[di]) return 'editable';
  if (historicalCache[di]) return 'historical';
  return 'editable';
}

function stateForDay(di) {
  if (isAdHocKey(di)) return findAdHoc(di);
  if (todayPlanStates[di]) return todayPlanStates[di];
  if (historicalCache[di]) return historicalCache[di];
  return null;
}

// ---- Local state factories ----
// ---- Local state helpers ----
// Returns the state object to mutate for a given tab key. For ad-hoc tabs,
// returns the existing ad-hoc state (must already exist — created via
// createAdHocSession). For plan-day tabs, lazy-creates the todayPlanStates
// entry for that dayIndex if needed and keeps todayState pointed at it.
function getOrInitToday(di) {
  if (isAdHocKey(di)) {
    return findAdHoc(di);
  }
  if (!todayPlanStates[di]) {
    todayPlanStates[di] = { workoutId: null, planId: null, dayIndex: di, notes: '', notesExpanded: false, locationId: null, exercises: {} };
  }
  todayState = todayPlanStates[di];
  return todayPlanStates[di];
}
function getOrInitExercise(state, ei) {
  var ek = 'ex_' + ei;
  if (!state.exercises[ek]) state.exercises[ek] = { rpe: null, note: '', sub: '', sets: [] };
  return state.exercises[ek];
}
function getOrInitSet(exState, si) {
  if (!exState.sets[si]) exState.sets[si] = {};
  return exState.sets[si];
}

// ---- Exercise identity ----
// ---- Write helpers ----
// Exercise identity is normalized (lowercase-trimmed) so that "Bench Press" and
// "bench press" resolve to the same exercises row. Display uses the original
// plan text; the normalized form is purely a canonical key.
// normName lives in resolver.js (loaded earlier).

async function ensureExerciseId(name) {
  // Try to resolve to an existing library row first (seed or user-custom).
  // If a match exists, reuse its id instead of creating a divergent custom
  // row — keeps plan-logged sets on the same exercise_id as ad-hoc/imported
  // history for the same movement.
  var resolved = resolveLibraryRow(name);
  if (resolved) {
    exerciseIdCache[normName(name)] = resolved.id;
    return resolved.id;
  }
  // Fallback: no library match — upsert a custom row under the normalized
  // plan name. These are inspected during periodic data audits.
  var key = normName(name);
  if (exerciseIdCache[key]) return exerciseIdCache[key];
  var res = await sb.from('exercises')
    .upsert({ user_id: userId, name: key, is_custom: true }, { onConflict: 'user_id,name' })
    .select('id').single();
  if (res.error) throw res.error;
  exerciseIdCache[key] = res.data.id;
  return res.data.id;
}

// Weight mode lookup for a prescribed exercise by name (falls back to 'total').
function weightModeForName(name) {
  var row = exerciseLibraryByName[normName(name)];
  return row && row.weight_mode ? row.weight_mode : 'total';
}

// ---- Gym profile mutations ----
async function persistLocationAdd(name) {
  var trimmed = (name || '').trim();
  if (!trimmed) return;
  // Case-insensitive dedup against the already-loaded list so we catch the
  // common case without a round-trip; the DB-level unique index still
  // defends against the race.
  var lower = trimmed.toLowerCase();
  for (var i = 0; i < locations.length; i++) {
    if (locations[i].name.toLowerCase() === lower) {
      showToast('A gym named "' + locations[i].name + '" already exists', null);
      return;
    }
  }
  try {
    var res = await sb.from('locations')
      .insert({ user_id: userId, name: trimmed })
      .select().single();
    if (res.error) throw res.error;
    locations = [res.data].concat(locations);
    locationById[res.data.id] = res.data;
    if (!recentLocationId) recentLocationId = res.data.id;
    renderGymProfiles();
    // Re-render the session view so a zero-gym prompt becomes the real
    // dropdown, or the new gym appears in the existing dropdown.
    buildDay(currentDay);
  } catch(err) {
    console.error('persistLocationAdd error:', err);
    showToast("Couldn't add gym: " + err.message, null);
  }
}

async function persistLocationRename(id, name) {
  var trimmed = (name || '').trim();
  if (!trimmed) return;
  var existing = locationById[id];
  if (!existing || existing.name === trimmed) return;
  // Client-side dedup against other rows.
  var lower = trimmed.toLowerCase();
  for (var i = 0; i < locations.length; i++) {
    if (locations[i].id !== id && locations[i].name.toLowerCase() === lower) {
      showToast('A gym named "' + locations[i].name + '" already exists', null);
      renderGymProfiles();
      return;
    }
  }
  try {
    var res = await sb.from('locations')
      .update({ name: trimmed })
      .eq('id', id)
      .select().single();
    if (res.error) throw res.error;
    existing.name = res.data.name;
    renderGymProfiles();
    buildDay(currentDay);
  } catch(err) {
    console.error('persistLocationRename error:', err);
    showToast("Couldn't rename gym: " + err.message, null);
    renderGymProfiles();
  }
}

async function persistLocationDelete(id) {
  var existing = locationById[id];
  if (!existing) return;
  // Count workouts that currently reference this gym across the hydrated
  // caches; fall back to a server-side count for anything not cached.
  var cachedCount = 0;
  function scan(state) {
    if (state && state.locationId === id) cachedCount++;
  }
  Object.keys(todayPlanStates).forEach(function(k) { scan(todayPlanStates[k]); });
  for (var i = 0; i < todayAdHocs.length; i++) scan(todayAdHocs[i]);
  Object.keys(historicalCache).forEach(function(k) { scan(historicalCache[k]); });
  var countRes = await sb.from('workouts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('location_id', id);
  var serverCount = (!countRes.error && typeof countRes.count === 'number') ? countRes.count : cachedCount;
  var hint = serverCount > 0
    ? ' ' + serverCount + ' workout' + (serverCount === 1 ? '' : 's') + ' will lose the gym tag.'
    : '';
  if (!confirm('Delete "' + existing.name + '"?' + hint)) return;
  try {
    var res = await sb.from('locations').delete().eq('id', id);
    if (res.error) throw res.error;
    locations = locations.filter(function(r) { return r.id !== id; });
    delete locationById[id];
    // Clear the cached location_id on any in-memory state that referenced
    // the deleted row. ON DELETE SET NULL handles the server side.
    function clearLoc(state) { if (state && state.locationId === id) state.locationId = null; }
    Object.keys(todayPlanStates).forEach(function(k) { clearLoc(todayPlanStates[k]); });
    for (var j = 0; j < todayAdHocs.length; j++) clearLoc(todayAdHocs[j]);
    Object.keys(historicalCache).forEach(function(k) { clearLoc(historicalCache[k]); });
    if (recentLocationId === id) recentLocationId = locations.length ? locations[0].id : null;
    renderGymProfiles();
    buildDay(currentDay);
  } catch(err) {
    console.error('persistLocationDelete error:', err);
    showToast("Couldn't delete gym: " + err.message, null);
  }
}

async function persistWorkoutLocation(di, locationId) {
  if (viewModeFor(di) !== 'editable') return;
  var state;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
    if (!state) return;
  } else {
    state = getOrInitToday(di);
  }
  // Dirty-check against the currently-saved value.
  if ((state.locationId || null) === (locationId || null)) return;
  if (state.workoutId) {
    try {
      var res = await sb.from('workouts').update({ location_id: locationId || null }).eq('id', state.workoutId);
      if (res.error) throw res.error;
      state.locationId = locationId || null;
    } catch(err) {
      console.error('persistWorkoutLocation error:', err);
      showToast("Couldn't save gym selection", function() { persistWorkoutLocation(di, locationId); });
    }
  } else {
    // No workout row yet — stash for the lazy-create path. Explicit null is
    // meaningful (user picked "— No gym"); distinguish via the pending field
    // living on the state object as-is (undefined = untouched).
    state.pendingLocationId = locationId || null;
  }
}

// ---- Workout creation & set persistence ----
async function ensureWorkout(di) {
  var st = getOrInitToday(di);
  if (st.workoutId) return st.workoutId;
  var now = new Date().toISOString();
  var performedOn = sessionTodayDateString();
  // Location precedence: explicit pending pick (including null = "no gym")
  // wins over the recent default. undefined = user hasn't touched it.
  var effectiveLocationId = st.pendingLocationId !== undefined ? st.pendingLocationId : (recentLocationId || null);
  var res = await sb.from('workouts').insert({
    user_id: userId, plan_id: activePlanId, day_index: di,
    performed_at: now, started_at: now,
    performed_on: performedOn,
    location_id: effectiveLocationId,
  }).select().single();
  // 23505 = unique_violation. Means another tab or a retried insert already
  // created the row for (user_id, plan_id, day_index, performed_on) — the
  // partial unique index is defending against exactly this. Re-query the
  // existing row and adopt it instead of creating a duplicate.
  if (res.error && res.error.code === '23505') {
    var lookup = await sb.from('workouts').select('*')
      .eq('user_id', userId)
      .eq('plan_id', activePlanId)
      .eq('day_index', di)
      .eq('performed_on', performedOn)
      .maybeSingle();
    if (lookup.error || !lookup.data) throw res.error;
    st.workoutId = lookup.data.id;
    st.planId = activePlanId;
    st.dayIndex = di;
    st.startedAt = lookup.data.started_at || now;
    st.locationId = lookup.data.location_id || null;
    delete st.pendingLocationId;
    return st.workoutId;
  }
  if (res.error) throw res.error;
  st.workoutId = res.data.id;
  st.planId = activePlanId;
  st.dayIndex = di;
  st.startedAt = now;
  st.locationId = res.data.location_id || null;
  delete st.pendingLocationId;
  return st.workoutId;
}

function buildSetPayload(di, ei, si) {
  var exState = todayState.exercises['ex_' + ei] || { rpe: null, note: '', sub: '', sets: [] };
  var sl = exState.sets[si] || {};
  var isExtraSet = todayState.isAdHoc || exState.isExtra || sl.isExtra;
  var exerciseId, prescribedWeight, prescribedReps;
  // Ad-hoc sessions, "extras" exercises on plan days, and extra sets on
  // prescribed exercises all skip prescription. Prescribed sets look up
  // the prescription from the plan JSON.
  if (isExtraSet) {
    if (todayState.isAdHoc || exState.isExtra) {
      exerciseId = exState.exerciseId;
    } else {
      // Extra set on a prescribed exercise — reuse the prescribed exercise's id.
      exerciseId = exerciseIdCache[normName(plan.days[di].exercises[ei].name)];
    }
    prescribedWeight = null;
    prescribedReps = null;
  } else {
    var ex = plan.days[di].exercises[ei];
    var set = ex.sets[si];
    exerciseId = exerciseIdCache[normName(ex.name)];
    prescribedWeight = set.weight != null ? set.weight : null;
    prescribedReps = set.reps_target != null ? set.reps_target : null;
  }
  return {
    user_id: userId,
    workout_id: todayState.workoutId,
    exercise_id: exerciseId,
    exercise_order: ei,
    set_order: si,
    weight: sl.weight != null ? sl.weight : null,
    reps: sl.reps != null ? sl.reps : null,
    rpe: exState.rpe != null ? exState.rpe : null,
    prescribed_weight: prescribedWeight,
    prescribed_reps: prescribedReps,
    substitution: exState.sub || null,
    note: exState.note || null,
    done: !!sl.done,
    started_at: sl.startedAt || null,
    completed_at: sl.done ? (sl.completedAt || new Date().toISOString()) : null,
  };
}

async function persistSet(di, ei, si) {
  try {
    await ensureWorkout(di);
    var exState = todayState.exercises['ex_' + ei];
    var displayName;
    if (todayState.isAdHoc || exState.isExtra) {
      // Ad-hoc sessions and extras on plan days both carry exerciseId in
      // state (resolved via the picker / custom-create); nothing to upsert.
      displayName = (exState.exerciseMeta && exState.exerciseMeta.name) || 'exercise';
    } else {
      var ex = plan.days[di].exercises[ei];
      await ensureExerciseId(ex.name);
      displayName = ex.name;
    }
    var payload = buildSetPayload(di, ei, si);
    var sl = exState.sets[si];
    if (sl.setId) {
      var r = await sb.from('sets').update(payload).eq('id', sl.setId);
      if (r.error) throw r.error;
    } else {
      var r2 = await sb.from('sets').insert(payload).select('id').single();
      if (r2.error) throw r2.error;
      sl.setId = r2.data.id;
      if (sl.done && !sl.completedAt) sl.completedAt = payload.completed_at;
    }
    // On successful done, promote this exercise to the top of recents.
    if (sl.done) {
      var row = exState.isExtra ? exState.exerciseMeta : exerciseLibraryById[payload.exercise_id];
      bumpRecent(row);
    }
  } catch(err) {
    console.error('persistSet error:', err);
    var extra = todayState && todayState.exercises['ex_' + ei];
    var fallback = extra && (extra.isExtra || (todayState && todayState.isAdHoc)) && extra.exerciseMeta
      ? extra.exerciseMeta.name
      : (((plan && plan.days[di]) || {}).exercises || [])[ei] ? plan.days[di].exercises[ei].name : 'exercise';
    showToast('Set ' + (si+1) + ' of ' + fallback + " didn't save", function() { persistSet(di, ei, si); });
  }
}

// Fan out exercise-level fields (rpe/note/sub) to all persisted sets in this exercise.
async function updateExerciseFanOut(di, ei) {
  if (!todayState || !todayState.workoutId) return; // nothing persisted yet — memory-only
  var exState = todayState.exercises['ex_' + ei];
  if (!exState) return;
  var hasPersisted = exState.sets.some(function(s){ return s && s.setId; });
  if (!hasPersisted) return;
  try {
    var patch = {
      rpe: exState.rpe != null ? exState.rpe : null,
      substitution: exState.sub || null,
      note: exState.note || null,
    };
    var r = await sb.from('sets').update(patch)
      .eq('workout_id', todayState.workoutId).eq('exercise_order', ei);
    if (r.error) throw r.error;
  } catch(err) {
    console.error('updateExerciseFanOut error:', err);
    showToast("Exercise details didn't save", function() { updateExerciseFanOut(di, ei); });
  }
}

// ---- User-action handlers (called by event listeners in ui.js) ----
async function logSet(di, ei, si, field, val) {
  if (viewModeFor(di) !== 'editable') return;
  var st = getOrInitToday(di);
  if (!st) return;
  var exState = getOrInitExercise(st, ei);
  var sl = getOrInitSet(exState, si);
  var parsed;
  if (val === '' || val == null) {
    parsed = null;
  } else if (field === 'weight') {
    parsed = parseWeightInput(val, getWeightUnit());
  } else {
    parsed = parseFloat(val);
    if (isNaN(parsed)) parsed = null;
  }
  sl[field] = parsed;
  if (!sl.startedAt) sl.startedAt = new Date().toISOString();
  // Edit-after-done: if the row exists, push the update; else memory only.
  if (sl.setId) await persistSet(di, ei, si);
  buildDay(di);
}

async function toggleSet(di, ei, si) {
  if (viewModeFor(di) !== 'editable') return;
  var st = getOrInitToday(di);
  if (!st) return;
  // Plan-day state pins its dayIndex to the integer di. Ad-hoc state has
  // dayIndex = null and is keyed by workoutId; never overwrite either here.
  if (!st.isAdHoc && st.dayIndex == null) st.dayIndex = di;
  var exState = getOrInitExercise(st, ei);
  var sl = getOrInitSet(exState, si);
  var wasDone = !!sl.done;
  sl.done = !wasDone;
  if (sl.done) {
    sl.completedAt = new Date().toISOString();
    if (!sl.startedAt) sl.startedAt = sl.completedAt;
    // Auto-fill empty fields from prescribed values; never overwrite user input.
    var prescribed = plan.days[di] && plan.days[di].exercises[ei] && plan.days[di].exercises[ei].sets[si];
    if (prescribed) {
      if (sl.weight == null && prescribed.weight != null) sl.weight = prescribed.weight;
      if (sl.reps == null && prescribed.reps_target != null) sl.reps = prescribed.reps_target;
    }
  }
  await persistSet(di, ei, si);
  buildTabs();
  buildDay(di);
  if (sl.done && plan.days[di] && plan.days[di].exercises[ei]) {
    startRestTimer(plan.days[di].exercises[ei].rest || 60);
  }
}

async function logRPE(di, ei, rpe) {
  if (viewModeFor(di) !== 'editable') return;
  var st = getOrInitToday(di);
  var exState = getOrInitExercise(st, ei);
  exState.rpe = (exState.rpe === rpe) ? null : rpe;
  await updateExerciseFanOut(di, ei);
  buildDay(di);
}

function toggleNotes(di) {
  var state;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
  } else {
    state = todayPlanStates[di] || historicalCache[di];
    if (!state) {
      // No state yet on a plan-day tab (no sets logged, no history). Seed
      // a minimal today-state so notesExpanded has a place to live; the
      // workout row itself is still lazy-created on focus via persistNotes.
      state = getOrInitToday(di);
    }
  }
  if (!state) return;
  state.notesExpanded = !state.notesExpanded;
  buildDay(di);
}

async function persistNotes(di, value) {
  if (viewModeFor(di) !== 'editable') return;
  var state;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
    if (!state) return;
  } else {
    state = getOrInitToday(di);
    await ensureWorkout(di);
  }
  var next = value == null ? '' : String(value);
  if ((state.notes || '') === next) return; // dirty-check
  state.notes = next;
  try {
    var res = await sb.from('workouts').update({ notes: next }).eq('id', state.workoutId);
    if (res.error) throw res.error;
  } catch(err) {
    console.error('persistNotes error:', err);
    showToast("Couldn't save session notes", function() { persistNotes(di, next); });
  }
}

async function logNote(di, ei, n) {
  if (viewModeFor(di) !== 'editable') return;
  var st = getOrInitToday(di);
  var exState = getOrInitExercise(st, ei);
  exState.note = n;
  await updateExerciseFanOut(di, ei);
}

async function logSub(di, ei, s) {
  if (viewModeFor(di) !== 'editable') return;
  var st = getOrInitToday(di);
  var exState = getOrInitExercise(st, ei);
  exState.sub = s;
  await updateExerciseFanOut(di, ei);
}

// ---- Add Exercise / Add Set (plan extras + ad-hoc sessions) ----
// For plan-day focus: next index = plan.days[currentDay].exercises.length + extras count.
// For ad-hoc focus: next index = count of exercises already in the session.
function nextExerciseIndex() {
  if (!todayState) return 0;
  if (todayState.isAdHoc) {
    var max = -1;
    for (var k in todayState.exercises) {
      var n = parseInt(k.slice(3), 10);
      if (n > max) max = n;
    }
    return max + 1;
  }
  var base = plan && plan.days[currentDay] ? plan.days[currentDay].exercises.length : 0;
  var max2 = base - 1;
  for (var k2 in todayState.exercises) {
    if (todayState.exercises[k2].isExtra) {
      var n2 = parseInt(k2.slice(3), 10);
      if (n2 > max2) max2 = n2;
    }
  }
  return max2 + 1;
}

function addExerciseToSession(exerciseRow) {
  if (!exerciseRow) return;
  if (viewModeFor(currentDay) !== 'editable') return;
  var st = getOrInitToday(currentDay);
  if (!st) return;
  var ei = nextExerciseIndex();
  var ek = 'ex_' + ei;
  st.exercises[ek] = {
    rpe: null, note: '', sub: '', sets: [{ isExtra: true }],
    // Mark isExtra only on plan days (drives the "added" badge + divider).
    // Ad-hoc sessions render every exercise uniformly with no badge.
    isExtra: !st.isAdHoc,
    exerciseId: exerciseRow.id,
    exerciseMeta: exerciseRow,
  };
  exerciseIdCache[exerciseRow.name] = exerciseRow.id;
  buildDay(currentDay);
}

function addExtraSet(ei) {
  if (viewModeFor(currentDay) !== 'editable') return;
  if (!todayState || !todayState.exercises['ex_' + ei]) return;
  todayState.exercises['ex_' + ei].sets.push({ isExtra: true });
  buildDay(currentDay);
}

// Delete a single set from an extras-on-plan-day exercise or an ad-hoc
// exercise. Never fires on prescribed sets (no delete button rendered).
// If the set was persisted, remove the row and renumber higher set_orders
// so the (workout_id, exercise_order, set_order) sequence stays contiguous.
async function deleteSet(di, ei, si) {
  if (viewModeFor(di) !== 'editable') return;
  if (!todayState) return;
  var exState = todayState.exercises['ex_' + ei];
  if (!exState) return;
  var sl = exState.sets[si];
  if (!sl) return;
  if (!sl.isExtra && !exState.isExtra && !todayState.isAdHoc) return;  // safety: only user-added
  var persisted = !!sl.setId;
  if (persisted && !confirm('Delete this set?')) return;
  try {
    if (persisted) {
      var r = await sb.from('sets').delete().eq('id', sl.setId);
      if (r.error) throw r.error;
      // Decrement set_order on any persisted higher-indexed sets for this
      // exercise. Parallel .update() calls — small N in practice.
      var updates = [];
      for (var k = si + 1; k < exState.sets.length; k++) {
        var row = exState.sets[k];
        if (row && row.setId) {
          updates.push(sb.from('sets').update({ set_order: k - 1 }).eq('id', row.setId));
        }
      }
      if (updates.length) {
        var results = await Promise.all(updates);
        for (var u = 0; u < results.length; u++) {
          if (results[u].error) throw results[u].error;
        }
      }
    }
  } catch(err) {
    console.error('deleteSet error:', err);
    showToast("Couldn't delete set: " + err.message, null);
    return;
  }
  exState.sets.splice(si, 1);
  buildTabs();
  buildDay(currentDay);
}

// Delete an entire extras-on-plan-day or ad-hoc exercise along with any
// logged sets. Confirms because it's multi-row destructive.
async function deleteExerciseCard(di, ei) {
  if (viewModeFor(di) !== 'editable') return;
  if (!todayState) return;
  var ek = 'ex_' + ei;
  var exState = todayState.exercises[ek];
  if (!exState) return;
  if (!exState.isExtra && !todayState.isAdHoc) return;  // safety
  var name = (exState.exerciseMeta && exState.exerciseMeta.name) || 'this exercise';
  if (!confirm('Delete ' + name + ' and any logged sets?')) return;
  try {
    if (todayState.workoutId) {
      var r = await sb.from('sets').delete()
        .eq('workout_id', todayState.workoutId)
        .eq('exercise_order', ei);
      if (r.error) throw r.error;
    }
  } catch(err) {
    console.error('deleteExerciseCard error:', err);
    showToast("Couldn't delete exercise: " + err.message, null);
    return;
  }
  delete todayState.exercises[ek];
  buildTabs();
  buildDay(currentDay);
}

// ---- Ad-hoc session management ----
async function createAdHocSession() {
  if (!userId) return;
  var now = new Date().toISOString();
  try {
    // title is omitted from the insert so this works even if the title
    // column migration hasn't been applied yet. Postgres defaults unspecified
    // nullable columns to NULL, which matches the intended initial state.
    // performed_on uses the user-local date so the row's calendar date
    // lines up with what the app considers "today" for hydration.
    var res = await sb.from('workouts').insert({
      user_id: userId, plan_id: null, day_index: null,
      performed_at: now, started_at: now,
      performed_on: sessionTodayDateString(),
      location_id: recentLocationId || null,
    }).select().single();
    if (res.error) throw res.error;
    var adState = {
      workoutId: res.data.id, planId: null, dayIndex: null,
      startedAt: now, endedAt: null,
      title: null, isAdHoc: true,
      notes: '', notesExpanded: false,
      locationId: res.data.location_id || null,
      exercises: {},
    };
    todayAdHocs.push(adState);
    focusTab('ah_' + res.data.id);
    buildTabs();
    buildDay(currentDay);
  } catch(err) {
    console.error('createAdHocSession error:', err);
    showToast("Couldn't start ad-hoc session: " + err.message, null);
  }
}

// Delete the currently-focused ad-hoc session along with all its sets
// (sets cascade via the workout_id FK). Confirms because the action is
// destructive and irreversible. Silent no-op for plan workouts — they
// have per-card delete for their extras and aren't full-session-deletable.
async function deleteAdHocSession() {
  if (!isAdHocKey(currentDay)) return;
  var state = findAdHoc(currentDay);
  if (!state) return;
  var label = (state.title && state.title.trim()) || 'this session';
  if (!confirm('Delete ' + label + ' and all logged sets? This cannot be undone.')) return;
  try {
    var r = await sb.from('workouts').delete().eq('id', state.workoutId);
    if (r.error) throw r.error;
  } catch(err) {
    console.error('deleteAdHocSession error:', err);
    showToast("Couldn't delete session: " + err.message, null);
    return;
  }
  todayAdHocs = todayAdHocs.filter(function(ah) { return ah.workoutId !== state.workoutId; });
  // Focus plan day 0 if a plan exists, else first remaining ad-hoc, else 0.
  if (plan) {
    focusTab(0);
  } else if (todayAdHocs.length) {
    focusTab('ah_' + todayAdHocs[0].workoutId);
  } else {
    currentDay = 0;
    todayState = null;
  }
  invalidateHistoryCache();
  buildTabs();
  buildDay(currentDay);
}

async function updateAdHocTitle(workoutId, title) {
  var trimmed = (title || '').trim();
  var state = null;
  for (var i = 0; i < todayAdHocs.length; i++) {
    if (todayAdHocs[i].workoutId === workoutId) { state = todayAdHocs[i]; break; }
  }
  if (state) state.title = trimmed || null;
  try {
    var r = await sb.from('workouts').update({ title: trimmed || null }).eq('id', workoutId);
    if (r.error) throw r.error;
    buildTabs();
  } catch(err) {
    console.error('updateAdHocTitle error:', err);
    showToast("Title didn't save", function() { updateAdHocTitle(workoutId, title); });
  }
}

// ---- Session timing ----
// Effective elapsed ms for a session: wall-clock from started_at to either
// ended_at or now, minus any accumulated pause time. Works for both active
// and completed sessions.
function sessionElapsedMs(state, nowMs) {
  if (!state || !state.startedAt) return 0;
  var start = new Date(state.startedAt).getTime();
  var end = state.endedAt ? new Date(state.endedAt).getTime() : (nowMs || Date.now());
  var paused = state.pausedMs || 0;
  return Math.max(0, end - start - paused);
}

// ---- Session lifecycle (start / complete / resume) ----
async function startSession(di) {
  if (viewModeFor(di) !== 'editable') return;
  var st = getOrInitToday(di);
  if (!st) return;
  try {
    await ensureWorkout(di);
  } catch(err) {
    console.error('startSession error:', err);
    showToast("Couldn't start session", function() { startSession(di); });
    return;
  }
  buildTabs();
  buildDay(di);
}

async function completeSession() {
  if (!todayState || !todayState.workoutId) return;
  var now = new Date().toISOString();
  try {
    var r = await sb.from('workouts').update({ ended_at: now }).eq('id', todayState.workoutId);
    if (r.error) throw r.error;
  } catch(err) {
    console.error('completeSession error:', err);
    showToast("Couldn't complete session", function() { completeSession(); });
    return;
  }
  todayState.endedAt = now;
  stopTimerTick();
  buildDay(currentDay);
  invalidateHistoryCache();
}

// Un-complete a session — primarily for accidental "Complete Session" taps,
// but also handles genuine pause/resume cycles (bathroom breaks, waiting for
// equipment). started_at is preserved as the literal first-touch moment;
// the gap between ended_at and now is added to paused_ms, which every timer
// display subtracts. Multiple Complete/Resume cycles accumulate into the
// same paused_ms field.
async function resumeSession() {
  if (!todayState || !todayState.workoutId) return;
  if (!todayState.endedAt) return;  // already running
  var endedAtMs = new Date(todayState.endedAt).getTime();
  var gapMs = Math.max(0, Date.now() - endedAtMs);
  var newPausedMs = (todayState.pausedMs || 0) + gapMs;
  try {
    var r = await sb.from('workouts').update({
      ended_at: null,
      paused_ms: newPausedMs,
    }).eq('id', todayState.workoutId);
    if (r.error) throw r.error;
  } catch(err) {
    console.error('resumeSession error:', err);
    showToast("Couldn't resume session", function() { resumeSession(); });
    return;
  }
  todayState.endedAt = null;
  todayState.pausedMs = newPausedMs;
  buildDay(currentDay);
  invalidateHistoryCache();
}

// ---- Import ----
// ---- Import ----
// Historical workouts and sets rows are NEVER modified on import.
// See DECISIONS.md → "No more log wipes".
function handleImport(event) {
  var file = event.target.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = async function(e) {
    try {
      var data = JSON.parse(e.target.result);
      var newPlan;
      if (data.plan) newPlan = data.plan;
      else if (data.days) newPlan = data;
      else { showToast('Invalid plan file format', null); return; }

      var r1 = await sb.from('plans').update({ is_active: false })
        .eq('user_id', userId).eq('is_active', true);
      if (r1.error) { showToast('Import failed: ' + r1.error.message, null); return; }

      var r2 = await sb.from('plans').insert({
        user_id: userId,
        title: newPlan.title || null,
        week: newPlan.week || null,
        data: newPlan,
        is_active: true,
      }).select().single();
      if (r2.error) { showToast('Import failed: ' + r2.error.message, null); return; }

      activePlanId = r2.data.id;
      plan = newPlan;
      planCache[activePlanId] = plan;
      // Reset plan-related in-memory view only; past workouts/sets remain
      // untouched in the DB. Ad-hoc sessions are plan-agnostic and stay.
      todayState = null;
      todayPlanStates = {};
      historicalCache = {};
      exerciseIdCache = {};
      currentDay = 0;

      document.getElementById('emptyState').style.display = 'none';
      document.getElementById('summaryBar').style.display = 'flex';
      document.getElementById('planTitle').textContent = plan.title || 'Workout Tracker';
      document.getElementById('planWeek').textContent = plan.week || '';
      buildTabs(); buildDay(0);
      document.getElementById('importModal').classList.remove('show');
    } catch(err) {
      console.error(err);
      showToast('Import error: ' + err.message, null);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}
