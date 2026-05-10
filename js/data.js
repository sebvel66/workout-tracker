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
// Which plan-day indexes have any workout in history (today or past) for
// the active plan. Populated once at hydrate via a single cheap query so
// the dropdown completion dot renders correctly on first paint — previously
// it required selecting a day to lazy-load historicalCache[i], leaving
// non-focused days undotted on hard reload.
var daysWithHistory = {};     // { [dayIndex]: true }
var planCache = {};           // planId -> plan blob
var exerciseIdCache = {};     // normName -> uuid

// Exercise library (seed + user custom). Loaded once per session.
var exerciseLibrary = [];        // array of exercise rows
var exerciseLibraryByName = {};  // normName -> row
var exerciseLibraryById = {};    // uuid -> row
var recentExercises = [];        // most-recently-logged first, up to 10

// Coaching profile (v2.5): per-user adaptive client profile replacing the
// hardcoded CLIENT PROFILE / Injury-aware programming / Phase awareness
// blocks in system-prompt-core.md. Read on every Claude call; editable via
// the Coaching Profile modal (hamburger → Coaching Profile). Null until
// load attempted; {} means load attempted but no row (pre-seed install).
var coachingProfile = null;

// Gym profiles (user-defined training locations). Loaded once per session.
// recentLocationId is computed at hydrate time from the most recent workout
// whose location_id is not null; used as the default for fresh sessions.
var locations = [];              // array of location rows, created_at desc
var locationById = {};           // uuid -> row
var recentLocationId = null;     // uuid of the most recently used gym, or null

// Earliest workout date across the user's history, as a YYYY-MM-DD string.
// Lazy-loaded by the History browser so "Previous week" navigation can be
// disabled past the user's first-ever workout. null = not loaded yet,
// '' = no workouts, 'YYYY-MM-DD' = loaded.
var earliestWorkoutDate = null;

// Physique photos — goal (latest only displayed) and progress (chronological).
// photosLoaded gates re-fetch; photosSignedUrls caches short-lived signed URLs
// keyed by storage_path so we don't re-sign on every re-render.
var photosGoal = null;           // row | null
var photosProgress = [];         // rows, newest first
var photosLoaded = false;
var photosSignedUrls = {};       // storage_path → { url, expiresAtMs }

// ---- Hydration cache ----
// localStorage-backed snapshot of the last-painted tracker state.
// Painted synchronously on boot (see paintFromCache in app.js) before any
// network call, then reconciled by hydrate(). Full design:
// docs/superpowers/specs/2026-04-21-hydration-cache-design.md
var HYDRATION_CACHE_KEY = 'wt.hydration.v1';
var HYDRATION_SCHEMA_VERSION = 1;
var HYDRATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readHydrationSnapshot() {
  try {
    var raw = localStorage.getItem(HYDRATION_CACHE_KEY);
    if (!raw) return null;
    var blob = JSON.parse(raw);
    if (!blob || blob.schemaVersion !== HYDRATION_SCHEMA_VERSION) return null;
    if (!blob.userId || !blob.savedAt) return null;
    var age = Date.now() - new Date(blob.savedAt).getTime();
    if (!isFinite(age) || age > HYDRATION_MAX_AGE_MS) return null;
    return blob;
  } catch (_) {
    return null;
  }
}

function saveHydrationSnapshot() {
  // Guard: only snapshot when hydrate has fully populated in-memory state
  // for the current user. Prevents capturing half-loaded state from a
  // visibilitychange that fires mid-hydrate or right after sign-out.
  if (!userId || hydratedForUser !== userId) return;
  if (!activePlanId || !plan) return;
  try {
    // todayPlanStates + todayAdHocs are intentionally cached alongside the
    // plan structure even though a strict reading of "cache plan only,
    // workout state always from Supabase" might suggest stripping them.
    // The reason: a user mid-workout closing/reopening the app needs the
    // running session timer + logged sets visible at 0ms — not blank-then-
    // populated ~1s later when hydrate completes. Cross-midnight stale
    // entries are filtered on restore (see paintFromCache in app.js, the
    // savedAt-vs-today-midnight gate from v2.4.17). Hydrate also reconciles
    // by clearing todayPlanStates = {} before re-populating from DB rows,
    // so any stale entries that slip through are corrected within the
    // hydrate window.
    var blob = {
      schemaVersion: HYDRATION_SCHEMA_VERSION,
      userId: userId,
      appVersion: (typeof APP_VERSION === 'string') ? APP_VERSION : null,
      savedAt: new Date().toISOString(),
      activePlanId: activePlanId,
      plan: plan,
      planTitle: plan.title || 'Workout Tracker',
      planWeek: planWeekLabel(plan) || plan.week || '',
      currentDay: currentDay,
      daysWithHistory: daysWithHistory || {},
      todayPlanStates: todayPlanStates || {},
      todayAdHocs: todayAdHocs || []
    };
    localStorage.setItem(HYDRATION_CACHE_KEY, JSON.stringify(blob));
  } catch (_) {
    // Quota exceeded or serialization failure — not fatal. Cache just
    // won't paint next boot; normal hydrate handles it.
  }
}

function clearHydrationSnapshot() {
  try { localStorage.removeItem(HYDRATION_CACHE_KEY); } catch (_) {}
}

// Snapshot on hide/unload. These fire reliably on iOS when the user
// swipes the PWA away or switches apps, and on desktop tab close.
document.addEventListener('visibilitychange', function() {
  if (document.hidden) saveHydrationSnapshot();
});
window.addEventListener('beforeunload', function() {
  saveHydrationSnapshot();
});

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

// ---- Week helpers (Sunday → Saturday) ----
// Slicing unit for the History browser and the AI planner. All helpers
// operate on YYYY-MM-DD strings aligned with workouts.performed_on.

function weekStartForLocalDate(date) {
  var d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());  // getDay: 0 = Sunday
  return localDateString(d);
}

function addDaysToDateString(ymd, n) {
  var d = new Date(ymd + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDateString(d);
}

// Derive a Sun-Sat week label for a plan blob from its start_date,
// matching the History browser's formatting. Self-heals plans saved
// before the savePlanAsActive normalization landed. Returns null if
// there's no usable start_date — caller should fall back to
// plan.week or an empty string.
function planWeekLabel(planBlob) {
  if (!planBlob || !planBlob.start_date) return null;
  try {
    var ws = weekStartForLocalDate(new Date(planBlob.start_date + 'T00:00:00'));
    var we = addDaysToDateString(ws, 6);
    return formatWeekLabel(ws, we);
  } catch (e) {
    return null;
  }
}

// If the plan blob was saved before start_date stamping, inject the
// DB row's created_at as a client-side fallback so week labels and
// phase-aware rendering work without a DB migration. The blob keeps
// the injected value in memory only; it'll be persisted the next
// time the plan is re-saved via savePlanAsActive.
function ensureStartDate(planBlob, dbRow) {
  if (!planBlob) return planBlob;
  if (planBlob.start_date) return planBlob;
  if (dbRow && dbRow.created_at) {
    planBlob.start_date = String(dbRow.created_at).slice(0, 10);
  }
  return planBlob;
}

// Format a week range for the navigator label, e.g. "Apr 12 – 18, 2026"
// when the week doesn't cross a month boundary, "Nov 29 – Dec 5, 2026"
// when it does.
function formatWeekLabel(startStr, endStr) {
  var s = new Date(startStr + 'T00:00:00');
  var e = new Date(endStr + 'T00:00:00');
  var sameMonth = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth();
  if (sameMonth) {
    return s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
           ' – ' + e.getDate() + ', ' + e.getFullYear();
  }
  return s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
         ' – ' + e.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
         ', ' + e.getFullYear();
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
      // subExercise: structured substitution (library row). Populated below
      // when any set for this exercise has prescribed_exercise_id != exercise_id.
      // `sub` retained as a legacy free-text fallback for pre-v2.2.1 sets
      // (read-only; new writes don't populate it).
      state.exercises[ek] = { rpe: null, note: '', sub: '', subExercise: null, sets: [] };
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
      // exerciseId = what actually happened (substitute if subbed).
      // prescribedExerciseId (optional) = what the plan asked for when this
      // set was a plan-day set. Null for ad-hoc/extras; also null on legacy
      // rows inserted before the v2.2.1 migration backfill.
      exerciseId: s.exercise_id,
      prescribedExerciseId: s.prescribed_exercise_id || null,
      // Cardio columns (v2.5 Phase 1). Null on resistance rows.
      duration_seconds: s.duration_seconds != null ? s.duration_seconds : null,
      distance: s.distance != null ? s.distance : null,
      // Drop set chains (v2.5 Phase 1). setType='drop' rows link to a
      // parent via parent_set_id (UUID); we resolve to parentSetIdx
      // (array index in this exercise's sets[]) below after the loop.
      setType: s.set_type || 'standard',
      parentSetId: s.parent_set_id || null,
      // Per-set weight_mode override (v3.1.0). Null = inherit from the
      // exercise's library default. effectiveWeightMode(set, meta) is the
      // single read site.
      weight_mode: s.weight_mode || null,
      startedAt: s.started_at, completedAt: s.completed_at,
    };
    if (setIsExtra) state.exercises[ek].sets[s.set_order].isExtra = true;
    if (s.rpe != null) state.exercises[ek].rpe = s.rpe;
    if (s.note) state.exercises[ek].note = s.note;
    // Legacy free-text substitution (pre-v2.2.1). Kept for display fallback
    // on old rows; new writes use the structured prescribed_exercise_id path.
    if (s.substitution) state.exercises[ek].sub = s.substitution;
    // Structured substitution detection: set was logged with a non-null
    // prescribed_exercise_id that differs from the actual exercise_id.
    // exercise_id is the substitute; prescribed_exercise_id is the plan's
    // original. Load the substitute's library row so the UI and coach
    // context can render its name and weight_mode.
    if (s.prescribed_exercise_id && s.prescribed_exercise_id !== s.exercise_id
        && !state.exercises[ek].subExercise) {
      var subRow = exerciseLibraryById && exerciseLibraryById[s.exercise_id];
      if (subRow) state.exercises[ek].subExercise = subRow;
    }
  }
  // Drop set linkage: walk each exercise's sets array and resolve
  // parentSetId (UUID, persistent) -> parentSetIdx (array index, used
  // by in-memory ops like "find this drop's parent for cascade-done").
  for (var ekResolve in state.exercises) {
    var setsArr = state.exercises[ekResolve].sets || [];
    var idxBySetId = {};
    for (var ix = 0; ix < setsArr.length; ix++) {
      if (setsArr[ix] && setsArr[ix].setId) idxBySetId[setsArr[ix].setId] = ix;
    }
    for (var iy = 0; iy < setsArr.length; iy++) {
      var srow = setsArr[iy];
      if (srow && srow.parentSetId && idxBySetId[srow.parentSetId] != null) {
        srow.parentSetIdx = idxBySetId[srow.parentSetId];
      }
    }
  }

  // Stamp supersetGroup on members based on row.superset_groups
  // (v3.4.0 column). Format: row.superset_groups = [{exercise_orders:
  // [int,...], rest: int}, ...]. Group key 'g0', 'g1', ... is assigned
  // in array order so members in the same group sort-stable to the
  // same key. Standalone exercises stay at supersetGroup: null.
  var groups = Array.isArray(row.superset_groups) ? row.superset_groups : [];
  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    if (!g || !Array.isArray(g.exercise_orders)) continue;
    var groupKey = 'g' + gi;
    for (var oi = 0; oi < g.exercise_orders.length; oi++) {
      var order = g.exercise_orders[oi];
      var ek = 'ex_' + order;
      if (state.exercises[ek]) {
        state.exercises[ek].supersetGroup = groupKey;
        state.exercises[ek].supersetRest = Number.isInteger(g.rest) ? g.rest : 60;
      }
    }
  }
  // Initialize null on any entry that was not grouped.
  for (var sek in state.exercises) {
    if (state.exercises.hasOwnProperty(sek) && state.exercises[sek].supersetGroup === undefined) {
      state.exercises[sek].supersetGroup = null;
      state.exercises[sek].supersetRest = null;
    }
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
      var slot = arr[si];
      if (!slot || !exs[ei]) continue;
      // Prefer prescribedExerciseId for the cache mapping — that's the id
      // for the plan exercise's name. When the set was substituted,
      // slot.exerciseId points to the substitute (wrong target for this cache).
      var cacheTarget = slot.prescribedExerciseId || slot.exerciseId;
      if (cacheTarget) {
        exerciseIdCache[normName(exs[ei].name)] = cacheTarget;
      }
    }
  }
}

// ---- Queries ----
async function loadHistorical(di) {
  if (historicalCache[di]) return historicalCache[di];
  // Scope to the active plan so a brand-new plan's Day N doesn't pull in
  // the most recent Day N from a previous plan as "historical". Mirrors
  // the plan_id filter in loadDaysWithHistory.
  if (!activePlanId) return null;
  try {
    var bounds = sessionBounds();
    var res = await sb.from('workouts').select('*, sets(*)')
      .eq('user_id', userId).eq('plan_id', activePlanId).eq('day_index', di)
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

// Populate daysWithHistory (used by buildTabs for the completion dot)
// with one cheap query: every distinct day_index that has a workout row
// on the currently active plan. Payload is a few ints. Runs once per
// hydrate so the dropdown dots render correctly on first paint —
// historicalCache is still lazy-loaded on tab selection for the full
// state, but the dot check no longer depends on it.
async function loadDaysWithHistory() {
  daysWithHistory = {};
  if (!activePlanId || !userId) return;
  var res = await sb.from('workouts')
    .select('day_index')
    .eq('user_id', userId)
    .eq('plan_id', activePlanId)
    .not('day_index', 'is', null);
  if (res.error) {
    // Non-fatal — dots just won't show for non-focused days, matching the
    // pre-fix behavior. Log so we notice in dev.
    console.error('loadDaysWithHistory error:', res.error);
    return;
  }
  var rows = res.data || [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].day_index != null) daysWithHistory[rows[i].day_index] = true;
  }
}

// Lazy-load the earliest workout date once per session. Returns '' if the
// user has no workouts at all. Cached in earliestWorkoutDate so the
// History browser doesn't re-query on every week-navigator tick.
async function loadEarliestWorkoutDate() {
  if (earliestWorkoutDate !== null) return earliestWorkoutDate;
  var res = await sb.from('workouts')
    .select('performed_on')
    .eq('user_id', userId)
    .order('performed_on', { ascending: true })
    .limit(1);
  if (res.error) return null;
  earliestWorkoutDate = (res.data && res.data[0]) ? res.data[0].performed_on : '';
  return earliestWorkoutDate;
}

// Fetch the N most recent workouts for the empty-state Recent list,
// ordered newest first. Embeds plan metadata + location name + set count.
//
// Used only by the no-plan empty state, so we don't need full set rows
// or summary stats — just enough to render a clickable row that opens
// in the History detail modal.
async function fetchRecentWorkouts(userId, limit) {
  if (!userId) return [];
  limit = limit || 5;

  try {
    var r = await sb.from('workouts')
      .select('id, performed_at, day_index, title, plan_id, location_id, ' +
              'plans(title, data), locations(name)')
      .eq('user_id', userId)
      .order('performed_at', { ascending: false })
      .limit(limit);
    if (r.error) throw r.error;
    var workouts = r.data || [];
    if (!workouts.length) return [];

    // Set counts via a separate query so we don't depend on PostgREST
    // aggregate embeds (which require a relationship hint and are noisier
    // to debug). Cheap — workouts.length is at most `limit`.
    var workoutIds = workouts.map(function(w) { return w.id; });
    var sr = await sb.from('sets')
      .select('workout_id')
      .eq('user_id', userId)
      .in('workout_id', workoutIds)
      .eq('done', true);
    var counts = {};
    if (!sr.error && sr.data) {
      for (var i = 0; i < sr.data.length; i++) {
        var wid = sr.data[i].workout_id;
        counts[wid] = (counts[wid] || 0) + 1;
      }
    }

    return workouts.map(function(w) {
      var planTitle = (w.plans && w.plans.title) || null;
      var planDays = (w.plans && w.plans.data && w.plans.data.days) || null;
      var dayName = null;
      if (w.day_index != null && Array.isArray(planDays) && planDays[w.day_index]) {
        dayName = planDays[w.day_index].name || ('Day ' + (w.day_index + 1));
      }
      return {
        id: w.id,
        performed_at: w.performed_at,
        plan_id: w.plan_id,
        plan_title: planTitle,
        day_index: w.day_index,
        day_name: dayName,
        title: w.title,
        location_name: w.locations ? w.locations.name : null,
        set_count: counts[w.id] || 0,
      };
    });
  } catch (err) {
    console.error('fetchRecentWorkouts error:', err);
    return [];
  }
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
// Per-muscle prescribed-set count for a generated plan, summed across all
// days of the training week. Same Schoenfeld-style fractional counting as
// the History summary + analyze prompt: each prescribed set = 1.0 to the
// exercise's primary muscle_group + 0.5 to each entry in secondary_muscles.
// Walks superset block containers transparently (members count separately).
// Cardio + mobility filtered out. Returns { muscle: count, ... }.
//
// Drop sets are present in plan.sets[] as flat entries with set_type: 'drop'
// and contribute 1 set just like standards — slightly overstates true
// hypertrophy stimulus on drop chains, but the result is still in the
// right ballpark for sanity-checking against weekly target bands. Refining
// to "drop = 0.5 set" would track sport-science conventions more closely
// but isn't worth the complexity for plan review.
function computePlanVolumeByMuscle(plan) {
  var out = {};
  if (!plan || !Array.isArray(plan.days)) return out;
  for (var di = 0; di < plan.days.length; di++) {
    var day = plan.days[di];
    var entries = Array.isArray(day && day.exercises) ? day.exercises : [];
    for (var ei = 0; ei < entries.length; ei++) {
      var e = entries[ei];
      if (e && e.superset === true && Array.isArray(e.exercises)) {
        for (var mi = 0; mi < e.exercises.length; mi++) {
          _accumulatePlanExercise(e.exercises[mi], out);
        }
      } else {
        _accumulatePlanExercise(e, out);
      }
    }
  }
  // Round to one decimal so floating-point accumulation doesn't surface
  // 14.499999...; the consumer treats halves as exact.
  var keys = Object.keys(out);
  for (var k = 0; k < keys.length; k++) {
    out[keys[k]] = Math.round(out[keys[k]] * 10) / 10;
  }
  return out;
}

function _accumulatePlanExercise(ex, out) {
  if (!ex || !ex.name) return;
  var sets = Array.isArray(ex.sets) ? ex.sets : [];
  if (!sets.length) return;
  var meta = (typeof resolveLibraryRow === 'function')
    ? resolveLibraryRow(ex.name)
    : (exerciseLibraryByName ? exerciseLibraryByName[normName(ex.name)] : null);
  if (!meta) return;  // unresolved exercise — silently skip; refining the plan to use canonical names will surface it
  var primary = meta.muscle_group;
  if (!primary || primary === 'cardio' || primary === 'mobility') return;
  var n = sets.length;
  out[primary] = (out[primary] || 0) + n;
  var sec = Array.isArray(meta.secondary_muscles) ? meta.secondary_muscles : [];
  for (var si = 0; si < sec.length; si++) {
    var mg = sec[si];
    if (!mg || mg === primary || mg === 'cardio' || mg === 'mobility') continue;
    out[mg] = (out[mg] || 0) + n * 0.5;
  }
}

// Phase-aware weekly target band (sets/wk) for the plan-volume summary.
// Bands track standard hypertrophy literature ranges and the system-prompt-
// analyze.md guidance the AI also sees. Defaults to accumulation when phase
// is unset so brand-new users still see a sensible band.
function phaseTargetBand(phase) {
  switch (phase) {
    case 'cut':            return { low: 5, high: 8,  label: 'cut maintenance' };
    case 'pre-cut':        return { low: 8, high: 12, label: 'pre-cut' };
    case 'maintain':       return { low: 8, high: 12, label: 'maintain' };
    case 'reverse':        return { low: 8, high: 12, label: 'reverse' };
    case 'accumulation':
    default:               return { low: 10, high: 20, label: 'accumulation' };
  }
}

// Multi-week per-muscle volume trends. Single query across the full window
// (workouts + sets + exercises) bucketed by Sun-anchored week client-side.
// Same Schoenfeld-style fractional counting as the History week summary
// and analyze prompt: each completed set = 1.0 to primary muscle_group +
// 0.5 to each entry in secondary_muscles. Cardio + mobility filtered out.
//
// Returns:
//   {
//     weeks:    [{ weekStart, label }, ...] // chronological, length = weeksBack
//     muscles:  [muscle_group, ...]         // sorted by total across window, descending
//     byMuscle: { muscle_group: [n, n, n, ...] }  // one entry per week, aligned to `weeks`
//     totals:   { muscle_group: n }         // sum across the window
//     averages: { muscle_group: n }         // total / weeksBack (rounded to 1 decimal)
//   }
async function fetchVolumeTrends(userId, weeksBack) {
  if (!Number.isFinite(weeksBack) || weeksBack < 1) weeksBack = 8;
  if (weeksBack > 52) weeksBack = 52;
  var todayStr = sessionTodayDateString();
  var thisWeekStart = weekStartForLocalDate(new Date(todayStr + 'T00:00:00'));
  var earliestWeekStart = addDaysToDateString(thisWeekStart, -(weeksBack - 1) * 7);
  var endDate = addDaysToDateString(thisWeekStart, 6);

  // Build the chronological week index up front so the result has stable
  // shape even when a week has zero workouts (just contributes 0s).
  var weeks = [];
  var weekIdxByStart = {};
  for (var w = 0; w < weeksBack; w++) {
    var ws = addDaysToDateString(earliestWeekStart, w * 7);
    weeks.push({ weekStart: ws, label: _vtWeekLabel(ws) });
    weekIdxByStart[ws] = w;
  }

  // One query for the full range. Same embed shape as fetchWeekSummary
  // so pull through secondary_muscles.
  var res = await sb.from('workouts')
    .select('plan_id, performed_on, sets(done, exercise_order, exercises!exercise_id(muscle_group, secondary_muscles))')
    .eq('user_id', userId)
    .gte('performed_on', earliestWeekStart)
    .lte('performed_on', endDate);
  if (res.error) throw res.error;

  // byMuscle starts empty; populate lazily as muscles surface in the data.
  var byMuscle = {};
  var rows = res.data || [];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var ws2 = weekStartForLocalDate(new Date(row.performed_on + 'T00:00:00'));
    var widx = weekIdxByStart[ws2];
    if (widx == null) continue;
    var sets = row.sets || [];
    for (var si = 0; si < sets.length; si++) {
      var s = sets[si];
      if (!s || !s.done) continue;
      var ex = s.exercises;
      if (!ex) continue;
      var primary = ex.muscle_group;
      if (!primary || primary === 'cardio' || primary === 'mobility') continue;
      _vtAdd(byMuscle, primary, widx, weeksBack, 1);
      var sec = Array.isArray(ex.secondary_muscles) ? ex.secondary_muscles : [];
      for (var k = 0; k < sec.length; k++) {
        var mg = sec[k];
        if (!mg || mg === primary || mg === 'cardio' || mg === 'mobility') continue;
        _vtAdd(byMuscle, mg, widx, weeksBack, 0.5);
      }
    }
  }

  // Totals + averages per muscle, then sort muscles by total descending.
  var totals = {};
  var averages = {};
  var muscles = Object.keys(byMuscle);
  for (var mi = 0; mi < muscles.length; mi++) {
    var mname = muscles[mi];
    var arr = byMuscle[mname];
    var sum = 0;
    for (var aj = 0; aj < arr.length; aj++) sum += arr[aj] || 0;
    totals[mname] = Math.round(sum * 10) / 10;
    averages[mname] = Math.round((sum / weeksBack) * 10) / 10;
  }
  muscles.sort(function(a, b) { return totals[b] - totals[a]; });

  return { weeks: weeks, muscles: muscles, byMuscle: byMuscle, totals: totals, averages: averages };
}

function _vtAdd(byMuscle, mg, widx, weeksBack, factor) {
  if (!byMuscle[mg]) {
    byMuscle[mg] = [];
    for (var i = 0; i < weeksBack; i++) byMuscle[mg].push(0);
  }
  byMuscle[mg][widx] = Math.round((byMuscle[mg][widx] + factor) * 10) / 10;
}

function _vtWeekLabel(weekStart) {
  // Compact "M/D" label — keeps headers tight in the table even at 12 weeks.
  var d = new Date(weekStart + 'T00:00:00');
  return (d.getMonth() + 1) + '/' + d.getDate();
}

async function fetchWeekSummary(userId, weekStartDate, weekEndDate) {
  // PostgREST FK disambiguation: sets now has TWO FKs to exercises
  // (exercise_id = actual, prescribed_exercise_id = plan's ask, added in
  // v2.2.1). "exercises!exercise_id" tells the planner to join via the
  // exercise_id FK — what was actually performed. Without this hint, the
  // query fails with PGRST201 ambiguous relationship.
  var wRes = await sb.from('workouts')
    .select('*, sets(*, exercises!exercise_id(name, equipment, muscle_group, secondary_muscles, weight_mode))')
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

  // Week-level rollup. Plans are grouped by plan_id so a week with two
  // distinct plans (e.g., user ended Plan A mid-week and started Plan B)
  // produces a correct per-plan completion breakdown — the prior
  // single-plan model deduped trainedPlanDays by day_index alone, which
  // collapsed Plan A Day 0 and Plan B Day 0 into one entry and pinned
  // daysPlanned to whichever plan came first chronologically.
  var perPlan = {};  // planId -> { planTitle, planLen, dayIndices: {} }
  var planOrder = [];
  var skippedAcross = {};
  var adHocCount = 0;
  var volSum = 0;
  var rpeSum = 0, rpeSetCount = 0;
  var volByMuscle = {};  // muscle_group -> total completed sets across the week

  for (var j = 0; j < workouts.length; j++) {
    var w = workouts[j];
    volSum += w.totalVolume;
    if (w.avgRpe != null && w.completedSets > 0) {
      rpeSum += w.avgRpe * w.completedSets;
      rpeSetCount += w.completedSets;
    }
    // Per-muscle weekly volume rolls up across plan-day AND ad-hoc workouts —
    // every completed set contributes regardless of session type.
    if (w.setsByMuscleGroup) {
      var mgKeys = Object.keys(w.setsByMuscleGroup);
      for (var mki = 0; mki < mgKeys.length; mki++) {
        var mgk = mgKeys[mki];
        volByMuscle[mgk] = (volByMuscle[mgk] || 0) + w.setsByMuscleGroup[mgk];
      }
    }
    if (w.isAdHoc) {
      adHocCount++;
    } else {
      var pid = w._planId;
      if (pid) {
        if (!perPlan[pid]) {
          var planLen = (w._planBlob && w._planBlob.days) ? w._planBlob.days.length : null;
          perPlan[pid] = {
            planTitle: w.planTitle || null,
            planLen: planLen,
            dayIndices: {},
          };
          planOrder.push(pid);
        }
        if (w._dayIndex != null && w.completedSets > 0) {
          perPlan[pid].dayIndices[w._dayIndex] = true;
        }
      }
      for (var s = 0; s < w.skippedExercises.length; s++) {
        skippedAcross[w.skippedExercises[s]] = true;
      }
    }
    delete w._dayIndex;
    delete w._planBlob;
    delete w._planId;
  }

  var plansBreakdown = [];
  var totalDaysPlanned = 0;
  var totalDaysTrained = 0;
  var anyPlanned = false;
  for (var po = 0; po < planOrder.length; po++) {
    var ppid = planOrder[po];
    var pp = perPlan[ppid];
    var trained = Object.keys(pp.dayIndices).length;
    var planned = pp.planLen;
    plansBreakdown.push({
      planId: ppid,
      planTitle: pp.planTitle,
      daysPlanned: planned,
      daysTrained: trained,
      completionRate: planned ? Math.round((trained / planned) * 100) / 100 : null,
    });
    totalDaysTrained += trained;
    if (planned != null) {
      totalDaysPlanned += planned;
      anyPlanned = true;
    }
  }

  var daysPlanned = anyPlanned ? totalDaysPlanned : null;
  var daysTrained = totalDaysTrained;

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
    plansBreakdown: plansBreakdown,
    volumeByMuscleGroup: volByMuscle,
  };
}

// Map one workouts row (with sets + exercises joined) into the per-workout
// summary shape. Uses _dayIndex / _planBlob / _planId as transient fields
// the week-level rollup strips before returning.
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
    // Per-set effective mode (v3.1.0): override on the set wins over
    // ex.weight_mode (the exercise's library default). Same math otherwise.
    var mode = effectiveWeightMode(s, ex);
    var eo = s.exercise_order;

    if (!byOrder[eo]) {
      byOrder[eo] = {
        name: ex.name || null,
        equipment: ex.equipment || null,
        muscleGroup: ex.muscle_group || null,
        secondaryMuscles: Array.isArray(ex.secondary_muscles) ? ex.secondary_muscles : [],
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
    setsByMuscleGroup: _setsByMuscleGroup(byOrder),
    _dayIndex: row.day_index,
    _planBlob: planBlob,
    _planId: row.plan_id || null,
  };
}

// Per-workout completed-set count grouped by muscle_group with Schoenfeld-
// style fractional counting: each completed set contributes 1.0 to its
// exercise's primary muscle_group and 0.5 to each entry in secondary_muscles.
// Counts include ad-hoc and extras-on-plan sets. Cardio + mobility groups
// are filtered out (not relevant to hypertrophy volume tracking).
//
// Secondary tags come from exercises.secondary_muscles, populated for seed
// rows by 20260509000000_secondary_muscles.sql. Custom user exercises with
// no secondary tags simply contribute their primary count (no UI to edit
// secondaries yet).
function _setsByMuscleGroup(byOrder) {
  var out = {};
  if (!byOrder) return out;
  var keys = Object.keys(byOrder);
  for (var i = 0; i < keys.length; i++) {
    var ex = byOrder[keys[i]];
    if (!ex || !ex.muscleGroup) continue;
    var primary = ex.muscleGroup;
    if (primary === 'cardio' || primary === 'mobility') continue;
    var done = 0;
    var sets = ex.sets || [];
    for (var s = 0; s < sets.length; s++) {
      if (sets[s] && sets[s].done) done++;
    }
    if (!done) continue;
    out[primary] = (out[primary] || 0) + done;
    var secondaries = Array.isArray(ex.secondaryMuscles) ? ex.secondaryMuscles : [];
    for (var si = 0; si < secondaries.length; si++) {
      var mg2 = secondaries[si];
      if (!mg2 || mg2 === primary || mg2 === 'cardio' || mg2 === 'mobility') continue;
      out[mg2] = (out[mg2] || 0) + done * 0.5;
    }
  }
  return out;
}

function _volumeForSet(weight, reps, mode) {
  if (!reps || reps <= 0) return 0;
  if (mode === 'none') return 0;
  if (weight == null) return 0;
  if (mode === 'per_side') return weight * 2 * reps;
  return weight * reps;
}

// ---- Physique photos ----
// Backed by the private 'physique-photos' storage bucket + the
// physique_photos metadata table. Files are stored under
// '{user_id}/{uuid}.{ext}' so the bucket's path-prefix RLS policies
// scope access to the owner. Rendering uses signed URLs issued on
// demand (public URLs aren't available on a private bucket).

async function loadPhysiquePhotos() {
  var res = await sb.from('physique_photos')
    .select('*')
    .eq('user_id', userId)
    .order('taken_at', { ascending: false });
  if (res.error) { showToast('Failed to load photos', null); return; }
  var rows = res.data || [];
  photosGoal = null;
  photosProgress = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.photo_type === 'goal') {
      // First hit is the most recent (ordered desc). Older goal photos
      // stay in storage for history but only the latest is displayed.
      if (!photosGoal) photosGoal = r;
    } else {
      photosProgress.push(r);
    }
  }
  photosLoaded = true;
}

// Signed URL for a storage path, cached for ~1 hour. Re-signs when the
// cached URL is within 60s of expiry so long-open tabs don't briefly
// render broken thumbnails. Returns null on failure.
async function getPhotoSignedUrl(path) {
  var cached = photosSignedUrls[path];
  if (cached && cached.expiresAtMs > Date.now() + 60000) return cached.url;
  var res = await sb.storage.from('physique-photos').createSignedUrl(path, 3600);
  if (res.error || !res.data) {
    console.error('createSignedUrl error:', res.error);
    return null;
  }
  photosSignedUrls[path] = { url: res.data.signedUrl, expiresAtMs: Date.now() + 3600 * 1000 };
  return res.data.signedUrl;
}

// Upload a file to storage and insert the matching metadata row. On
// insert failure, the uploaded file is removed so we don't leave
// orphans. takenAtYmd is a 'YYYY-MM-DD' string from the date input;
// stored as noon-local to avoid timezone drift at date boundaries.
async function uploadPhysiquePhoto(file, type, takenAtYmd, notes) {
  if (!file || !userId) throw new Error('Missing file or user');
  var extMatch = file.name && file.name.match(/\.([a-zA-Z0-9]+)$/);
  var ext = extMatch ? extMatch[1].toLowerCase()
    : (file.type ? file.type.split('/')[1] : 'jpg');
  if (ext === 'jpeg') ext = 'jpg';
  var uuid = (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : ('p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  var path = userId + '/' + uuid + '.' + ext;
  var takenAtIso = new Date(takenAtYmd + 'T12:00:00').toISOString();

  var up = await sb.storage.from('physique-photos').upload(path, file, {
    contentType: file.type || ('image/' + ext),
    cacheControl: '3600',
    upsert: false,
  });
  if (up.error) throw up.error;

  var ins = await sb.from('physique_photos').insert({
    user_id: userId,
    storage_path: path,
    photo_type: type,
    taken_at: takenAtIso,
    notes: notes || null,
  }).select().single();
  if (ins.error) {
    try { await sb.storage.from('physique-photos').remove([path]); } catch(e) { /* best effort */ }
    throw ins.error;
  }
  return ins.data;
}

async function deletePhysiquePhoto(id, storagePath) {
  // Remove storage first; if the row delete later fails, the file is
  // already gone — fine. If storage fails, the row stays so the user
  // can retry. Orphan-row risk exists if the row delete fails after a
  // successful storage remove, but the render path treats a missing
  // file as a broken thumb (user can delete again).
  var rm = await sb.storage.from('physique-photos').remove([storagePath]);
  if (rm.error) throw rm.error;
  var del = await sb.from('physique_photos').delete().eq('id', id);
  if (del.error) throw del.error;
  delete photosSignedUrls[storagePath];
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

// Auto-start the rest timer on every set-done tap. Default: on. Stored
// device-locally; sync across devices (in user_settings) is a later
// concern. Prescribed sets pull rest duration from plan.days[di].exercises[ei].rest;
// everything else (ad-hoc, plan-day extras, template-imports) falls
// back to 90s — matching the manual Rest Timer button.
function getRestTimerAuto() {
  try { return localStorage.getItem('restTimerAuto') !== 'false'; }
  catch(_) { return true; }
}
function setRestTimerAuto(val) {
  try { localStorage.setItem('restTimerAuto', val ? 'true' : 'false'); } catch(_) {}
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
  if (!state.exercises[ek]) state.exercises[ek] = { rpe: null, note: '', sub: '', subExercise: null, sets: [] };
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

// Cardio detection from the library — single source of truth (per the
// Q2 design decision: derive cardio from muscle_group rather than adding
// a redundant type field on plan JSON). Returns true for treadmill, run,
// bike, rower, etc.; false for resistance work.
function isCardioExerciseName(name) {
  var row = exerciseLibraryByName[normName(name)];
  return !!(row && row.muscle_group === 'cardio');
}

// Duration helpers for cardio set inputs. We persist seconds so any
// downstream analysis (volume/hr/etc.) is uniform; the UI shows mm:ss.
//
// Parser tolerates two shapes:
//   "MM:SS" -> exact (with seconds clamped 0-59)
//   "MM"    -> bare minutes (so iPhone numeric keypad without colon
//              still works for whole-minute entries)
function formatDurationMSS(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  var s = Math.max(0, Math.round(seconds));
  var m = Math.floor(s / 60);
  var sec = s % 60;
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function parseDurationMSS(text) {
  if (text == null) return null;
  var t = String(text).trim();
  if (!t) return null;
  if (t.indexOf(':') > -1) {
    var parts = t.split(':');
    var m = parseInt(parts[0], 10);
    var s = parseInt(parts[1], 10);
    if (!Number.isFinite(m) || m < 0) return null;
    if (!Number.isFinite(s)) s = 0;
    if (s < 0 || s > 59) return null;
    return m * 60 + s;
  }
  var min = parseFloat(t);
  if (!Number.isFinite(min) || min < 0) return null;
  return Math.round(min * 60);
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

// Build the workouts.superset_groups payload from a plan-day's
// exercises array. Walks day.exercises[] and emits one entry per
// {superset:true} block: {exercise_orders: [int,...], rest: int}.
// exercise_orders are the *flat* day.exercises[] index range that
// the block occupies — i.e., if the block is at index 2 with 3
// members, exercise_orders = [2, 3, 4] and the next standalone
// exercise (if any) is at flat index 5.
//
// This mirrors how stateFromWorkout maps sets back to exercise_order:
// each set exercise_order is the flat positional index in the day
// exercises array, with block members occupying contiguous indices.
function supersetGroupsFromPlanDay(dayPlan) {
  var groups = [];
  if (!dayPlan || !Array.isArray(dayPlan.exercises)) return groups;
  var flatOrder = 0;
  for (var i = 0; i < dayPlan.exercises.length; i++) {
    var entry = dayPlan.exercises[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      var orders = [];
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        orders.push(flatOrder);
        flatOrder++;
      }
      groups.push({
        exercise_orders: orders,
        rest: Number.isInteger(entry.rest) ? entry.rest : 60
      });
    } else {
      flatOrder++;
    }
  }
  return groups;
}

async function ensureWorkout(di) {
  var st = getOrInitToday(di);
  if (st.workoutId) return st.workoutId;
  var now = new Date().toISOString();
  var performedOn = sessionTodayDateString();
  // Location precedence: explicit pending pick (including null = "no gym")
  // wins over the recent default. undefined = user hasn't touched it.
  var effectiveLocationId = st.pendingLocationId !== undefined ? st.pendingLocationId : (recentLocationId || null);
  var dayPlan = (plan && plan.days && plan.days[di]) ? plan.days[di] : null;
  var supersetGroupsPayload = supersetGroupsFromPlanDay(dayPlan);
  var res = await sb.from('workouts').insert({
    user_id: userId, plan_id: activePlanId, day_index: di,
    performed_at: now, started_at: now,
    performed_on: performedOn,
    location_id: effectiveLocationId,
    superset_groups: supersetGroupsPayload,
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
  var exState = todayState.exercises['ex_' + ei] || { rpe: null, note: '', sub: '', subExercise: null, sets: [] };
  var sl = exState.sets[si] || {};
  var isExtraSet = todayState.isAdHoc || exState.isExtra || sl.isExtra;
  var exerciseId, prescribedExerciseId, prescribedWeight, prescribedReps;
  // Ad-hoc sessions, "extras" exercises on plan days, and extra sets on
  // prescribed exercises all skip prescription. Prescribed sets look up
  // the prescription from the plan JSON — and now may carry a substitution
  // (state.subExercise) which retargets exercise_id while prescribed_exercise_id
  // still points at the plan's original.
  if (isExtraSet) {
    if (todayState.isAdHoc || exState.isExtra) {
      exerciseId = exState.exerciseId;
    } else {
      // Extra set on a prescribed exercise — reuse the prescribed exercise's id.
      exerciseId = exerciseIdCache[normName(plan.days[di].exercises[ei].name)];
    }
    prescribedExerciseId = null;
    prescribedWeight = null;
    prescribedReps = null;
  } else {
    var ex = plan.days[di].exercises[ei];
    var set = ex.sets[si];
    prescribedExerciseId = exerciseIdCache[normName(ex.name)];
    // Substitution retargets exercise_id to the substitute; prescribed_exercise_id
    // preserves the plan's original so plan-adherence + substitution-pattern
    // queries remain possible.
    exerciseId = (exState.subExercise && exState.subExercise.id)
      ? exState.subExercise.id
      : prescribedExerciseId;
    prescribedWeight = set.weight != null ? set.weight : null;
    prescribedReps = set.reps_target != null ? set.reps_target : null;
  }
  // Drop set linkage: child segments carry set_type='drop' and a
  // parent_set_id pointing at the parent's persisted UUID. Parent's
  // setId must already be set by the time we persist a child (see
  // addDropSet which force-persists the parent first), otherwise
  // the FK insert fails. parentSetIdx in memory resolves to the
  // parent's setId at payload-build time.
  var setType = sl.setType || 'standard';
  var parentSetId = null;
  if (setType === 'drop' && sl.parentSetIdx != null) {
    var parentSet = exState.sets[sl.parentSetIdx];
    if (parentSet && parentSet.setId) parentSetId = parentSet.setId;
  } else if (sl.parentSetId) {
    // Hydrated-from-DB rows already have parentSetId; trust it.
    parentSetId = sl.parentSetId;
  }
  return {
    user_id: userId,
    workout_id: todayState.workoutId,
    exercise_id: exerciseId,
    prescribed_exercise_id: prescribedExerciseId,
    exercise_order: ei,
    set_order: si,
    weight: sl.weight != null ? sl.weight : null,
    reps: sl.reps != null ? sl.reps : null,
    rpe: exState.rpe != null ? exState.rpe : null,
    prescribed_weight: prescribedWeight,
    prescribed_reps: prescribedReps,
    // Cardio columns (v2.5 Phase 1, lean). Null on resistance rows;
    // populated when the set is on a muscle_group='cardio' exercise.
    duration_seconds: sl.duration_seconds != null ? sl.duration_seconds : null,
    distance: sl.distance != null ? sl.distance : null,
    // Drop-set chain columns (v2.5 Phase 1). 'standard' on independent sets.
    set_type: setType,
    parent_set_id: parentSetId,
    // Per-set weight_mode override (v3.1.0). Null = inherit library default.
    // Stamped by setExerciseWeightMode (today/ad-hoc) or
    // historyUpdateExerciseWeightMode; new sets inherit from existing
    // placement sets via the add-set helpers.
    weight_mode: sl.weight_mode || null,
    // Legacy free-text column — we no longer populate it on new writes;
    // substitution is now carried structurally via exercise_id mismatch.
    substitution: null,
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
      // Defensive read-before-insert (v3.6.4). The INSERT branch fires
      // whenever in-memory `sl.setId` is null. If a row at the same
      // (workout, exercise_id, exercise_order, set_order) already exists
      // in DB but the in-memory setId was lost (hydration cache write
      // timing, plan switch resetting state, etc.), a naive INSERT
      // duplicates the row — and the partial unique index (`WHERE done
      // = true`) doesn't catch it when one row is done=true and the
      // duplicate is being inserted as done=false. The duplicate then
      // surfaces in history edit as "duplicate key value violates unique
      // constraint" when the user tries to flip the orphan row to
      // done=true. Look up first and adopt the existing row's id —
      // converts duplicate-prone INSERT into a safe UPDATE.
      var lookup = await sb.from('sets')
        .select('id')
        .eq('workout_id', payload.workout_id)
        .eq('exercise_id', payload.exercise_id)
        .eq('exercise_order', payload.exercise_order)
        .eq('set_order', payload.set_order)
        .maybeSingle();
      if (lookup.error) throw lookup.error;
      if (lookup.data && lookup.data.id) {
        sl.setId = lookup.data.id;
        var ru = await sb.from('sets').update(payload).eq('id', sl.setId);
        if (ru.error) throw ru.error;
        if (sl.done && !sl.completedAt) sl.completedAt = payload.completed_at;
      } else {
        var r2 = await sb.from('sets').insert(payload).select('id').single();
        if (r2.error) throw r2.error;
        sl.setId = r2.data.id;
        if (sl.done && !sl.completedAt) sl.completedAt = payload.completed_at;
      }
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
    // Surface the underlying Supabase error on the toast so it doesn't
    // require DevTools to diagnose field-save failures. Truncate to keep
    // the toast digestible.
    var errMsg = (err && (err.message || err.code)) ? String(err.message || err.code) : '';
    if (errMsg.length > 80) errMsg = errMsg.slice(0, 80) + '…';
    var toast = 'Set ' + (si + 1) + ' of ' + fallback + " didn't save";
    if (errMsg) toast += ' · ' + errMsg;
    showToast(toast, function() { persistSet(di, ei, si); });
  }
}

// Fan out exercise-level fields (rpe/note/sub) to all persisted sets in this exercise.
async function updateExerciseFanOut(di, ei) {
  if (!todayState || !todayState.workoutId) return; // nothing persisted yet — memory-only
  var exState = todayState.exercises['ex_' + ei];
  if (!exState) return;
  var hasPersisted = exState.sets.some(function(s){ return s && s.setId; });
  if (!hasPersisted) return;
  // Only fan out rpe + note. exercise_id / prescribed_exercise_id are
  // deliberately NOT touched here — those are set at insert time by
  // buildSetPayload, and structural changes (substitution flips) are
  // handled in logSubstitute with a precise UPDATE that filters on the
  // current exercise_id. A blanket fan-out here would clobber pre-swap
  // sets that legitimately still belong to the old exercise_id after a
  // plan-level swap (v2.0.29). The legacy substitution text column is
  // left alone too; new writes null it via buildSetPayload.
  try {
    var patch = {
      rpe: exState.rpe != null ? exState.rpe : null,
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

// Stamp a weight_mode override on every set in an exercise placement.
// Mirrors updateExerciseFanOut: single UPDATE keyed on (workout_id,
// exercise_order). Used by the per-card weight-mode chip in editable
// today + ad-hoc contexts.
//
// `mode` is 'total' or 'per_side' verbatim — we deliberately don't store
// NULL when the user toggles back to the library default, because that
// would make the chip's behavior depend on whether the library default
// has changed since the toggle. See spec for the reasoning.
async function setExerciseWeightMode(di, ei, mode) {
  if (!todayState || !todayState.workoutId) {
    // Not yet persisted — update memory only. The first persistSet write
    // will pick up sl.weight_mode via buildSetPayload.
    var exMem = todayState && todayState.exercises['ex_' + ei];
    if (exMem) {
      for (var i = 0; i < exMem.sets.length; i++) {
        if (exMem.sets[i]) exMem.sets[i].weight_mode = mode;
      }
    }
    return;
  }
  var exState = todayState.exercises['ex_' + ei];
  if (!exState) return;
  try {
    var r = await sb.from('sets')
      .update({ weight_mode: mode })
      .eq('user_id', userId)
      .eq('workout_id', todayState.workoutId)
      .eq('exercise_order', ei);
    if (r.error) throw r.error;
    // Mirror to in-memory sets so renders + buildSetPayload (for any
    // subsequent UPDATE) see the new value without a re-fetch.
    for (var j = 0; j < exState.sets.length; j++) {
      if (exState.sets[j]) exState.sets[j].weight_mode = mode;
    }
  } catch(err) {
    console.error('setExerciseWeightMode error:', err);
    showToast("Weight mode didn't save", function() { setExerciseWeightMode(di, ei, mode); });
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
  } else if (field === 'duration_seconds') {
    // Cardio duration accepts "MM:SS" or bare minutes (parseDurationMSS).
    parsed = parseDurationMSS(val);
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
  // Check-ON in an ended session routes through the resume prompt; un-check
  // doesn't (it isn't new work). promptResumeIfEnded runs the action
  // synchronously when the prompt isn't needed (no ended session, or user
  // already chose "Just log it" this session), so the same code path covers
  // running sessions and post-prompt continuations cleanly.
  if (!wasDone) {
    promptResumeIfEnded(function() { _toggleSetCommit(di, ei, si, sl, wasDone); });
    return;
  }
  await _toggleSetCommit(di, ei, si, sl, wasDone);
}

async function _toggleSetCommit(di, ei, si, sl, wasDone) {
  sl.done = !wasDone;
  if (sl.done) {
    sl.completedAt = new Date().toISOString();
    if (!sl.startedAt) sl.startedAt = sl.completedAt;
    // Auto-fill empty fields from prescribed values; never overwrite user input.
    // Resistance fields (weight, reps) and cardio fields (duration_seconds,
    // distance) are mutually-exclusive in practice but the auto-fill is
    // unconditional on field type — a cardio prescribed set just has
    // weight/reps null, so the resistance branches no-op.
    var prescribed = plan.days[di] && plan.days[di].exercises[ei] && plan.days[di].exercises[ei].sets[si];
    if (prescribed) {
      if (sl.weight == null && prescribed.weight != null) sl.weight = prescribed.weight;
      if (sl.reps == null && prescribed.reps_target != null) sl.reps = prescribed.reps_target;
      if (sl.duration_seconds == null && prescribed.duration_seconds != null) sl.duration_seconds = prescribed.duration_seconds;
      if (sl.distance == null && prescribed.distance != null) sl.distance = prescribed.distance;
    }
  }
  await persistSet(di, ei, si);

  // Drop set cascade (v2.5 Phase 1): when marking a parent (non-drop)
  // done, also mark all of its drop children done with the same
  // completedAt. Children are entries in this exercise's sets array
  // with setType='drop' AND parentSetIdx === si. The parent persists
  // first (above) so its setId is available for the child's
  // parent_set_id at buildSetPayload time. Cascade only fires on
  // false→true transitions (un-toggling a parent does NOT cascade-undo
  // children — historical truth wins on edit).
  if (sl.done && sl.setType !== 'drop') {
    var st = todayState && todayState.exercises['ex_' + ei];
    if (st && Array.isArray(st.sets)) {
      for (var ci = 0; ci < st.sets.length; ci++) {
        var child = st.sets[ci];
        if (!child) continue;
        if (child.setType !== 'drop') continue;
        if (child.parentSetIdx !== si) continue;
        if (child.done) continue;
        child.done = true;
        child.completedAt = sl.completedAt;
        if (!child.startedAt) child.startedAt = child.completedAt;
        // Auto-fill from the drop's OWN prescribed values (each drop
        // segment can carry weight + reps_target in the plan blob).
        // For manually-added drops past the prescribed count,
        // plan.sets[ci] is undefined and carry-forward (set in
        // addDropSet) already populated weight/reps.
        var planMemberForCascade = (plan && plan.days) ? _flatEiToPlanMember(plan.days[di], ei) : null;
        var childPrescribed = planMemberForCascade && Array.isArray(planMemberForCascade.sets) ? planMemberForCascade.sets[ci] : null;
        if (childPrescribed) {
          if (child.weight == null && childPrescribed.weight != null) child.weight = childPrescribed.weight;
          if (child.reps == null && childPrescribed.reps_target != null) child.reps = childPrescribed.reps_target;
          if (child.duration_seconds == null && childPrescribed.duration_seconds != null) child.duration_seconds = childPrescribed.duration_seconds;
          if (child.distance == null && childPrescribed.distance != null) child.distance = childPrescribed.distance;
        }
        await persistSet(di, ei, ci);
      }
    }
  }

  buildTabs();
  buildDay(di);
  // Auto-start rest timer on set-done (v2.4.14, v3.4 superset gating):
  // fires for every set regardless of whether the exercise is prescribed,
  // extras, ad-hoc, or template-imported. Prescribed sets use the plan's
  // per-exercise rest; everything else falls back to 90s. User can
  // disable in hamburger → "Auto rest timer".
  //
  // Superset gating (v3.4.0): when the just-toggled set is in a block,
  // only fire the timer when this tap brought min(completed-set-count)
  // across members up by one -- i.e., the round just completed. Block
  // members suppress the timer on intermediate done-taps. Out-of-order
  // taps still resolve correctly because the gate checks state, not tap
  // order.
  //
  // For drop-set chains, the rest timer fires once -- when the parent
  // is marked done, the cascade finishes synchronously above, and we
  // hit this block once for the whole chain.
  if (sl.done && getRestTimerAuto()) {
    var stForRest = (typeof todayState !== 'undefined' && todayState) ? todayState : null;
    var ekForRest = 'ex_' + ei;
    var exStateForRest = stForRest && stForRest.exercises ? stForRest.exercises[ekForRest] : null;
    if (exStateForRest && exStateForRest.supersetGroup) {
      // In a superset -- gate via shouldFireRestForBlockMember.
      if (shouldFireRestForBlockMember(stForRest, ei, si)) {
        startRestTimer(exStateForRest.supersetRest || 60);
      }
      // If not last-of-round: silently suppress (round not yet complete).
    } else {
      var planMemberForRest = (plan && plan.days) ? _flatEiToPlanMember(plan.days[di], ei) : null;
      var prescribedRest = (planMemberForRest && Number.isInteger(planMemberForRest.rest))
        ? planMemberForRest.rest
        : null;
      startRestTimer(prescribedRest || 90);
    }
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

// Structured substitution: accepts a library row (the substitute) or null
// to clear. Updates state and retargets already-persisted sets' exercise_id
// from the old actual to the new actual — but ONLY sets that currently
// match the pre-change exercise_id. This preserves any post-swap legacy
// sets attached to a different exercise_id (v2.0.29 Swap invariant:
// "already-logged sets on the replaced exercise are preserved").
async function logSubstitute(di, ei, libRow) {
  if (viewModeFor(di) !== 'editable') return;
  var st = getOrInitToday(di);
  var exState = getOrInitExercise(st, ei);

  // Capture pre-change state before mutating so we know what to filter on.
  var prescribedId = null;
  if (!st.isAdHoc && !exState.isExtra && plan && plan.days[di] && plan.days[di].exercises[ei]) {
    prescribedId = exerciseIdCache[normName(plan.days[di].exercises[ei].name)] || null;
  }
  var oldActualId = (exState.subExercise && exState.subExercise.id) ? exState.subExercise.id : prescribedId;
  var newActualId = libRow ? libRow.id : prescribedId;

  exState.subExercise = libRow || null;
  exState.sub = '';  // drop any legacy free-text — structured field is source of truth now

  // Retarget persisted sets for this exercise_order ONLY where exercise_id
  // currently matches the pre-change actual. Surgical update — leaves any
  // sets attached to a different exercise_id (post-swap, pre-second-sub)
  // alone so they stay attached to the exercise that was actually done.
  if (st.workoutId && prescribedId && oldActualId && newActualId && oldActualId !== newActualId) {
    var hasPersisted = exState.sets.some(function(s) { return s && s.setId; });
    if (hasPersisted) {
      try {
        var r = await sb.from('sets').update({
          exercise_id: newActualId,
          prescribed_exercise_id: prescribedId,
          substitution: null,
        })
          .eq('workout_id', st.workoutId)
          .eq('exercise_order', ei)
          .eq('exercise_id', oldActualId);
        if (r.error) throw r.error;
        // Sync in-memory slots that were just retargeted so a buildSetPayload
        // call on those sets reads the correct id. Skip slots attached to a
        // different exercise_id (the ones we didn't touch in the DB).
        for (var si = 0; si < exState.sets.length; si++) {
          var slot = exState.sets[si];
          if (slot && slot.setId && slot.exerciseId === oldActualId) {
            slot.exerciseId = newActualId;
            slot.prescribedExerciseId = prescribedId;
          }
        }
      } catch(err) {
        console.error('logSubstitute retarget error:', err);
        showToast("Substitution didn't save", function() { logSubstitute(di, ei, libRow); });
        // Revert in-memory sub state on failure so UI reflects reality.
        exState.subExercise = oldActualId === prescribedId ? null : (exerciseLibraryById && exerciseLibraryById[oldActualId]) || null;
        buildDay(di);
        return;
      }
    }
  }

  // rpe + note fan-out is still useful for cleanliness (clears any legacy
  // non-null values that might linger). Always safe — only writes rpe + note.
  await updateExerciseFanOut(di, ei);
  buildDay(di);
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
  promptResumeIfEnded(function() {
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
  });
}

// Add an exercise to the current session with set schemes preserved
// from a template-exercise blob (template.data.days[i].exercises[j]).
// Creates N extra sets matching the template's count; pre-fills weight
// per set as a suggestion; leaves reps blank so the user logs actual
// reps as they work. Carries the template's exercise note through.
// Used by the add-from-template picker. No-op (except isExtra: true)
// semantics match addExerciseToSession — just with more sets.
function addTemplateExerciseToSession(exerciseRow, templateExerciseBlob) {
  if (!exerciseRow) return;
  if (viewModeFor(currentDay) !== 'editable') return;
  var st = getOrInitToday(currentDay);
  if (!st) return;
  promptResumeIfEnded(function() {
    var templateSets = (templateExerciseBlob && Array.isArray(templateExerciseBlob.sets))
      ? templateExerciseBlob.sets : [];
    var sets = [];
    if (templateSets.length) {
      for (var j = 0; j < templateSets.length; j++) {
        var s = templateSets[j] || {};
        var setEntry = { isExtra: true };
        // Pre-fill weight only when the template actually had one — null /
        // 0 is treated as "no suggestion" so the input placeholder shows —.
        if (s.weight != null && s.weight !== 0) setEntry.weight = Number(s.weight);
        sets.push(setEntry);
      }
    } else {
      sets.push({ isExtra: true });
    }
    var ei = nextExerciseIndex();
    var ek = 'ex_' + ei;
    st.exercises[ek] = {
      rpe: null,
      note: (templateExerciseBlob && templateExerciseBlob.note) || '',
      sub: '',
      sets: sets,
      isExtra: !st.isAdHoc,
      exerciseId: exerciseRow.id,
      exerciseMeta: exerciseRow,
    };
    exerciseIdCache[exerciseRow.name] = exerciseRow.id;
    buildDay(currentDay);
  });
}

function addExtraSet(ei) {
  if (viewModeFor(currentDay) !== 'editable') return;
  // Lazy-init state so +Add Set works pre-session on a plan day. Adds a
  // session-scoped extra (isExtra: true) that renders with a delete
  // affordance and supports drop-set chaining. No DB writes pre-session;
  // the in-memory entry persists when the session is started and the
  // user toggles a set done (existing persistSet path handles it).
  var st = getOrInitToday(currentDay);
  if (!st) return;
  var exState = getOrInitExercise(st, ei);
  if (!exState) return;
  promptResumeIfEnded(function() {
    var newSet = { isExtra: true };
    // Carry forward values from the most-recent populated set in this
    // exercise so the user doesn't have to retype the same weight/reps
    // (or duration/distance for cardio) on stacking sets. Most-recent-
    // first scan; first set with real values wins. The new set still
    // has done=false so the user has to tap done to log it -- carrying
    // values is auto-fill, not auto-completion.
    var sets = exState.sets || [];
    for (var i = sets.length - 1; i >= 0; i--) {
      var prev = sets[i];
      if (!prev) continue;
      // Cardio path: copy duration_seconds + distance.
      if (prev.duration_seconds != null) {
        newSet.duration_seconds = prev.duration_seconds;
        if (prev.distance != null) newSet.distance = prev.distance;
        break;
      }
      // Resistance path: copy weight + reps when either is populated.
      // weight or reps alone is enough -- no requirement that both be
      // present (the user might have omitted weight on a bodyweight
      // exercise, for example).
      if (prev.weight != null || prev.reps != null) {
        if (prev.weight != null) newSet.weight = prev.weight;
        if (prev.reps != null) newSet.reps = prev.reps;
        break;
      }
    }
    // Inherit the placement's current weight_mode (v3.1.0). New sets in a
    // toggled placement should carry the same override so renders + volume
    // math + persistence are consistent.
    newSet.weight_mode = (exState.sets[0] && exState.sets[0].weight_mode) || null;
    // Place extras past the prescribed range so the render's extras loop
    // (siExtra >= ex.sets.length) picks them up. .push() alone is wrong
    // when exState.sets is sparse — e.g., user toggled only set #0 done
    // (length 1) on a 3-set prescription; pushing would land at [1],
    // corrupting prescribed set #1's state. Pre-session this matters
    // even more (length 0 → push would land at [0]).
    var prescribedLen = 0;
    if (!isAdHocKey(currentDay) && plan && plan.days && plan.days[currentDay]) {
      var planEx = _flatEiToPlanMember(plan.days[currentDay], ei);
      if (planEx && Array.isArray(planEx.sets)) prescribedLen = planEx.sets.length;
    }
    var insertIdx = Math.max(prescribedLen, exState.sets.length);
    exState.sets[insertIdx] = newSet;
    buildDay(currentDay);
  });
}

// Drop set: a chained segment of the previous set, performed at a
// reduced weight back-to-back with no full rest. v1 always attaches
// to the LAST set in the array. If the LAST set is itself a drop,
// the new entry becomes a SIBLING drop (same parent) -- chains stack
// arbitrarily deep (double / triple / etc).
//
// Persistence: drops have a parent_set_id FK to sets.id, which means
// the parent must already be persisted before we can insert the child.
// We force-persist the parent here (even if not yet marked done) so
// the child's INSERT has a valid FK target. Parent persists with
// done=false initially; the cascade in toggleSet later UPDATEs it
// to done=true and the child to done=true with the same completed_at.
function addDropSet(ei) {
  if (viewModeFor(currentDay) !== 'editable') return;
  var st = getOrInitToday(currentDay);
  if (!st) return;
  var exState = getOrInitExercise(st, ei);
  if (!exState || !exState.sets) return;
  // Find the actual last populated set. exState.sets may have trailing
  // holes (e.g., after deleting an extra past the prescribed range, where
  // length stays at prescribedLen but no entry lives at length-1) — the
  // raw length-1 lookup would land on a hole and the chain logic would
  // fall back to lastIdx, creating a drop that points at a "static plan"
  // slot.
  var lastIdx = -1;
  for (var li = exState.sets.length - 1; li >= 0; li--) {
    if (exState.sets[li] != null) { lastIdx = li; break; }
  }
  if (lastIdx < 0) return;
  var lastSet = exState.sets[lastIdx];

  // Pre-session on a plan day: stack the drop in-memory only. parentSetIdx
  // is enough to render the chain; the toggleSet cascade later persists
  // both parent and child correctly when the user marks the parent done
  // (parent → persistSet writes parent.setId → child's persistSet picks
  // it up via parentSetIdx → buildSetPayload → parent_set_id FK).
  if (!isAdHocKey(currentDay) && !st.workoutId) {
    var parentIdx = (lastSet.setType === 'drop' && lastSet.parentSetIdx != null)
      ? lastSet.parentSetIdx : lastIdx;
    var dropSet = {
      setType: 'drop',
      parentSetIdx: parentIdx,
      isExtra: true,
    };
    if (lastSet.weight != null) dropSet.weight = lastSet.weight;
    if (lastSet.reps != null) dropSet.reps = lastSet.reps;
    if (lastSet.duration_seconds != null) dropSet.duration_seconds = lastSet.duration_seconds;
    if (lastSet.distance != null) dropSet.distance = lastSet.distance;
    dropSet.weight_mode = (exState.sets[0] && exState.sets[0].weight_mode) || null;
    exState.sets.push(dropSet);
    buildDay(currentDay);
    return;
  }

  promptResumeIfEnded(function() {
    _addDropSetInner(ei).catch(function(err) {
      console.error('addDropSet error:', err);
      showToast("Couldn't add drop set", null);
    });
  });
}

async function _addDropSetInner(ei) {
  var exState = todayState.exercises['ex_' + ei];
  // Scan for the actual last populated set — sparse arrays (post-delete or
  // partial mid-prescription state) can have trailing holes.
  var lastIdx = -1;
  for (var li = exState.sets.length - 1; li >= 0; li--) {
    if (exState.sets[li] != null) { lastIdx = li; break; }
  }
  if (lastIdx < 0) return;
  var lastSet = exState.sets[lastIdx];
  // Determine parent: if last is a drop, link to its parent (sibling
  // drop). If last is a parent (standard), link directly to it.
  var parentIdx = (lastSet.setType === 'drop' && lastSet.parentSetIdx != null)
    ? lastSet.parentSetIdx : lastIdx;
  var parent = exState.sets[parentIdx];
  if (!parent) return;

  // Workout must exist before any sets persist.
  await ensureWorkout(currentDay);

  // Force-persist parent if it's not yet in DB. The child INSERT below
  // needs parent.setId for the parent_set_id FK; otherwise the row
  // can't be inserted. Parent goes in with whatever values it has
  // (likely null weight/reps for an untouched prescribed set);
  // toggleSet's cascade later UPDATEs to done + auto-filled values.
  if (!parent.setId) {
    await persistSet(currentDay, ei, parentIdx);
    if (!parent.setId) {
      // persistSet either succeeded (sets parent.setId) or surfaced its
      // own toast on failure. Bail out without adding the drop.
      return;
    }
  }

  // Carry forward weight + reps (or cardio fields) from the last set
  // in the chain so user doesn't retype. User can edit before tapping
  // done. Drop default IS the parent's weight per Q3 -- we explicitly
  // don't auto-reduce here; reductions are an explicit edit by the
  // user when they actually drop the load on the rack.
  var newSet = {
    setType: 'drop',
    parentSetIdx: parentIdx,
    isExtra: true,  // Render with delete affordance + persist as extra (no prescribed link).
  };
  if (lastSet.weight != null) newSet.weight = lastSet.weight;
  if (lastSet.reps != null) newSet.reps = lastSet.reps;
  if (lastSet.duration_seconds != null) newSet.duration_seconds = lastSet.duration_seconds;
  if (lastSet.distance != null) newSet.distance = lastSet.distance;

  // Inherit the placement's current weight_mode (v3.1.0). New sets in a
  // toggled placement should carry the same override so renders + volume
  // math + persistence are consistent.
  newSet.weight_mode = (exState.sets[0] && exState.sets[0].weight_mode) || null;
  exState.sets.push(newSet);
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
  // Cascade-collect drop children of a non-drop parent. Drops can only
  // chain to a set earlier in the array, so children all live at indices
  // > si. Without cascade, deleting a parent extra would orphan its drops
  // in-memory — they'd render past the prescribed range with parentSetIdx
  // pointing at a deleted slot. DB-side, sets.parent_set_id ON DELETE
  // CASCADE removes drop rows automatically when the parent is deleted,
  // so we just need to mirror in-memory.
  var dropChildren = [];
  if (sl.setType !== 'drop') {
    for (var ci = si + 1; ci < exState.sets.length; ci++) {
      var c = exState.sets[ci];
      if (c && c.setType === 'drop' && c.parentSetIdx === si) {
        dropChildren.push(ci);
      }
    }
  }
  var indicesToRemove = [si].concat(dropChildren);
  var persisted = !!sl.setId;
  if (persisted && !confirm('Delete this set?')) return;
  try {
    if (persisted) {
      var r = await sb.from('sets').delete().eq('id', sl.setId);
      if (r.error) throw r.error;
      // Update set_order on surviving persisted sets to close the gap left
      // by ALL removed indices (parent + cascaded drops). Skip rows being
      // removed; new set_order = old k minus number of removed indices < k.
      var updates = [];
      for (var k = si + 1; k < exState.sets.length; k++) {
        if (indicesToRemove.indexOf(k) >= 0) continue;
        var row = exState.sets[k];
        if (!row || !row.setId) continue;
        var removedBefore = 0;
        for (var ri2 = 0; ri2 < indicesToRemove.length; ri2++) {
          if (indicesToRemove[ri2] < k) removedBefore++;
        }
        updates.push(sb.from('sets').update({ set_order: k - removedBefore }).eq('id', row.setId));
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
  // Splice in descending order so earlier indices stay valid during the
  // splices, then walk surviving drops and decrement parentSetIdx where
  // the parent's array position has shifted (parent at an index past one
  // of the removals).
  var sortedDesc = indicesToRemove.slice().sort(function(a, b) { return b - a; });
  for (var ridx = 0; ridx < sortedDesc.length; ridx++) {
    exState.sets.splice(sortedDesc[ridx], 1);
  }
  for (var fi = 0; fi < exState.sets.length; fi++) {
    var f = exState.sets[fi];
    if (!f || f.setType !== 'drop' || f.parentSetIdx == null) continue;
    var dec = 0;
    for (var ridx2 = 0; ridx2 < indicesToRemove.length; ridx2++) {
      if (indicesToRemove[ridx2] < f.parentSetIdx) dec++;
    }
    if (dec) f.parentSetIdx -= dec;
  }
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
  // Default title = short date (e.g. "Wed, Apr 22") so unnamed ad-hoc
  // sessions still carry a useful label in the dropdown, history list,
  // and coach/export surfaces. User can overwrite freely via the title
  // input in the ad-hoc header. Format matches the .adhoc-date row
  // rendered immediately below so both reference points agree.
  var defaultTitle = new Date().toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  try {
    // performed_on uses the user-local date so the row's calendar date
    // lines up with what the app considers "today" for hydration.
    var res = await sb.from('workouts').insert({
      user_id: userId, plan_id: null, day_index: null,
      performed_at: now, started_at: now,
      performed_on: sessionTodayDateString(),
      location_id: recentLocationId || null,
      title: defaultTitle,
    }).select().single();
    if (res.error) throw res.error;
    var adState = {
      workoutId: res.data.id, planId: null, dayIndex: null,
      startedAt: now, endedAt: null,
      title: res.data.title || defaultTitle, isAdHoc: true,
      notes: '', notesExpanded: false,
      locationId: res.data.location_id || null,
      exercises: {},
    };
    todayAdHocs.push(adState);
    focusTab('ah_' + res.data.id);
    // Hide the no-plan empty state (if it was visible) and show the
    // summary bar — matches the pattern used by savePlanAsActive,
    // activateExistingPlan, onEndPlan's focused-ad-hoc branch, and
    // the hydrate paths in app.js. Idempotent when emptyState was
    // already hidden (e.g., creating an ad-hoc from inside a plan day).
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'flex';
    buildTabs();
    buildDay(currentDay);
    refreshCoachForNewSession();
  } catch(err) {
    console.error('createAdHocSession error:', err);
    showToast("Couldn't start ad-hoc session: " + err.message, null);
  }
}

// ---- Historical workout edits (v2.5.13) ----
// Direct DB updates on a logged set / workout — used by the history-detail
// edit mode, which intentionally bypasses the todayState-coupled
// persistSet path. The caller (renderHistoryDetail in ui.js) is
// responsible for updating the in-memory historyDetails cache after a
// successful update so re-renders reflect the change without a refetch.
//
// All four helpers throw on failure so the caller can showToast.

// Update a single field on one set row (weight, reps, rpe, done,
// duration_seconds, distance, note). Note: rpe + note are typically per-
// exercise — use historyUpdateExerciseRpe / historyUpdateExerciseNote
// when you want the change to fan out to all sets in the exercise.
async function historyUpdateSetField(setId, field, value) {
  if (!userId || !setId || !field) throw new Error('Missing context');
  var payload = {};
  payload[field] = value;
  var r = await sb.from('sets').update(payload).eq('id', setId).eq('user_id', userId);
  if (r.error) throw new Error(r.error.message);
}

// Toggle a single set's done state. When flipping done -> not-done,
// completed_at is cleared (the CHECK constraint requires it null when
// done=false). When flipping not-done -> done, we stamp completed_at
// to the workout's start time so per-set ordering by completed_at
// stays sensible (rather than "now" which would re-order an old workout
// to look like it ended just now).
async function historyUpdateSetDone(setId, newDone, workoutStartedAt) {
  if (!userId || !setId) throw new Error('Missing context');
  var payload;
  if (newDone) {
    var stamp = workoutStartedAt || new Date().toISOString();
    payload = { done: true, completed_at: stamp };
  } else {
    payload = { done: false, completed_at: null };
  }
  var r = await sb.from('sets').update(payload).eq('id', setId).eq('user_id', userId);
  if (r.error) throw new Error(r.error.message);
}

// Per-exercise RPE: fans out to every set on this exercise within the
// workout. Mirrors the live-session pattern where RPE is conceptually
// per-exercise but stored per-set (replicated).
async function historyUpdateExerciseRpe(workoutId, exerciseOrder, rpe) {
  if (!userId || !workoutId) throw new Error('Missing context');
  var r = await sb.from('sets')
    .update({ rpe: rpe })
    .eq('user_id', userId)
    .eq('workout_id', workoutId)
    .eq('exercise_order', exerciseOrder);
  if (r.error) throw new Error(r.error.message);
}

// Per-exercise note: same fan-out pattern as RPE.
async function historyUpdateExerciseNote(workoutId, exerciseOrder, note) {
  if (!userId || !workoutId) throw new Error('Missing context');
  var r = await sb.from('sets')
    .update({ note: note || null })
    .eq('user_id', userId)
    .eq('workout_id', workoutId)
    .eq('exercise_order', exerciseOrder);
  if (r.error) throw new Error(r.error.message);
}

// History-edit equivalent of setExerciseWeightMode. Same fan-out pattern
// as historyUpdateExerciseRpe: UPDATE all sets in (workout_id, exercise_order).
// Caller is responsible for patching historyDetails[workoutId] in-memory
// so re-render reflects the change.
async function historyUpdateExerciseWeightMode(workoutId, exerciseOrder, mode) {
  if (!userId || !workoutId) throw new Error('Missing context');
  var r = await sb.from('sets')
    .update({ weight_mode: mode })
    .eq('user_id', userId)
    .eq('workout_id', workoutId)
    .eq('exercise_order', exerciseOrder);
  if (r.error) throw new Error(r.error.message);
}

// Workout-level notes: lives on the workouts row, not replicated to sets.
async function historyUpdateWorkoutNotes(workoutId, notes) {
  if (!userId || !workoutId) throw new Error('Missing context');
  var r = await sb.from('workouts')
    .update({ notes: notes || null })
    .eq('id', workoutId)
    .eq('user_id', userId);
  if (r.error) throw new Error(r.error.message);
}

// Delete a workout by id. Sets cascade via the workout_id FK. Used by the
// history detail "Discard session" action (plan + ad-hoc) and the today
// "Cancel session" action on 0-set in-progress plan days. Caller handles
// the confirm prompt + post-delete cleanup (cache invalidation, re-render).
async function discardWorkout(workoutId) {
  if (!userId || !workoutId) throw new Error('Missing context');
  var r = await sb.from('workouts').delete().eq('id', workoutId).eq('user_id', userId);
  if (r.error) throw new Error(r.error.message);
  // Best-effort in-memory cache cleanup — the modal + history view will
  // re-render off fresh state, but drop the stale entries immediately so
  // nothing flashes the deleted workout during the transition.
  if (historyDetails && historyDetails[workoutId]) delete historyDetails[workoutId];
  invalidateHistoryCache();
}

// ---- History edit: add / delete sets retroactively (v3.6.3) ----
// Add a missing set to a historical workout's exercise. Used by the
// history-edit "+ Add Set" affordance. Inserts at the next set_order
// for (workout_id, exercise_id, exercise_order); carries forward
// weight/reps (or duration_seconds/distance for cardio) from the
// most recently populated set in the same exercise so the user
// doesn't have to retype values that match prior rows. Returns the
// inserted row (caller patches in-memory historyDetails state).
async function historyAddSet(workoutId, exerciseOrder, exerciseId, hint) {
  if (!userId || !workoutId || !exerciseId) throw new Error('Missing context');
  if (typeof exerciseOrder !== 'number') throw new Error('Invalid exercise_order');
  // Find the next set_order.
  var sr = await sb.from('sets')
    .select('set_order')
    .eq('workout_id', workoutId)
    .eq('exercise_id', exerciseId)
    .eq('exercise_order', exerciseOrder)
    .order('set_order', { ascending: false })
    .limit(1);
  if (sr.error) throw new Error(sr.error.message);
  var nextSo = (sr.data && sr.data[0]) ? (sr.data[0].set_order + 1) : 0;
  hint = hint || {};
  var payload = {
    user_id: userId,
    workout_id: workoutId,
    exercise_id: exerciseId,
    exercise_order: exerciseOrder,
    set_order: nextSo,
    done: false,
    set_type: hint.set_type || 'standard',
    weight: hint.weight != null ? hint.weight : null,
    reps: hint.reps != null ? hint.reps : null,
    duration_seconds: hint.duration_seconds != null ? hint.duration_seconds : null,
    distance: hint.distance != null ? hint.distance : null,
  };
  var ir = await sb.from('sets').insert(payload).select().single();
  if (ir.error) throw new Error(ir.error.message);
  return ir.data;
}

// Delete a single sets row by id. Used by the history-edit × affordance
// on user-added (isExtra) rows. Caller is responsible for splicing the
// in-memory historyDetails entry. Prescribed-set rows are not deletable
// from the UI — gating happens at the render layer (deletable flag) so
// this helper is a thin DELETE without a class check.
async function historyDeleteSet(setId) {
  if (!userId || !setId) throw new Error('Missing context');
  var r = await sb.from('sets').delete().eq('id', setId).eq('user_id', userId);
  if (r.error) throw new Error(r.error.message);
}

// ---- Drag-to-reorder: compute map + persist -----------------------------
// Computes the exercise_order permutation for a single move. Keys are the
// old positions that need updating; values are the new positions. Positions
// outside the move's range aren't in the map (unchanged).
function computeReorderMap(oldIndex, newIndex) {
  var map = {};
  if (oldIndex === newIndex) return map;
  map[oldIndex] = newIndex;
  if (newIndex > oldIndex) {
    for (var i = oldIndex + 1; i <= newIndex; i++) map[i] = i - 1;
  } else {
    for (var j = newIndex; j < oldIndex; j++) map[j] = j + 1;
  }
  return map;
}

// Apply a reorder map to the in-memory state.exercises keys. Ex slots at
// remapped positions get their new ex_<N> key; unchanged slots stay put.
function remapStateExerciseKeys(state, mapping) {
  if (!state || !state.exercises) return;
  var newEx = {};
  for (var ek in state.exercises) {
    var idx = parseInt(ek.slice(3), 10);
    var newIdx = (idx in mapping) ? mapping[idx] : idx;
    newEx['ex_' + newIdx] = state.exercises[ek];
  }
  state.exercises = newEx;
}

// Persist an exercise_order remap for a single workout's sets. Two-phase to
// avoid transient unique-index collisions on the partial index
// (workout_id, exercise_id, exercise_order, set_order) WHERE done = true —
// if we updated rows directly to their new positions, the intermediate
// state could briefly duplicate keys and throw 23505. Phase 1 shifts all
// affected rows into a temp range (+OFFSET); phase 2 brings them down to
// their final positions. PostgREST doesn't support column arithmetic in
// updates, so each phase issues one UPDATE per affected position.
async function persistExerciseReorder(workoutId, mapping) {
  if (!userId || !workoutId) return;
  var keys = Object.keys(mapping).map(Number);
  if (!keys.length) return;
  var OFFSET = 10000;

  var p1 = keys.map(function(oldPos) {
    return sb.from('sets')
      .update({ exercise_order: oldPos + OFFSET })
      .eq('workout_id', workoutId)
      .eq('exercise_order', oldPos);
  });
  var r1 = await Promise.all(p1);
  for (var i = 0; i < r1.length; i++) if (r1[i].error) throw new Error(r1[i].error.message);

  var p2 = keys.map(function(oldPos) {
    return sb.from('sets')
      .update({ exercise_order: mapping[oldPos] })
      .eq('workout_id', workoutId)
      .eq('exercise_order', oldPos + OFFSET);
  });
  var r2 = await Promise.all(p2);
  for (var j = 0; j < r2.length; j++) if (r2[j].error) throw new Error(r2[j].error.message);
}

// Plan-level reorder. Mirrors Swap (v2.0.29) semantics: mutates the active
// plan's day exercises, persists plans.data, then remaps the current
// workout's sets so already-logged sets stay attached to their exercise.
// Scope: rest of the week — future sessions on this plan day follow the
// new order. Toast calls this out explicitly.
async function reorderPlanExercises(di, oldIndex, newIndex) {
  if (!plan || !plan.days || !plan.days[di]) return;
  if (oldIndex === newIndex) return;
  var exercises = plan.days[di].exercises;
  if (!Array.isArray(exercises)) return;
  if (oldIndex < 0 || oldIndex >= exercises.length) return;
  if (newIndex < 0 || newIndex >= exercises.length) return;

  // Snapshot for rollback if Supabase writes fail.
  var originalCopy = JSON.parse(JSON.stringify(exercises));

  var moved = exercises.splice(oldIndex, 1)[0];
  exercises.splice(newIndex, 0, moved);

  try {
    var pr = await sb.from('plans').update({ data: plan }).eq('id', activePlanId);
    if (pr.error) throw new Error(pr.error.message);
    planCache[activePlanId] = plan;
  } catch(err) {
    // Revert in-memory so UI doesn't drift from DB.
    plan.days[di].exercises = originalCopy;
    console.error('reorderPlanExercises plan write error:', err);
    showToast("Couldn't save reorder: " + (err.message || 'unknown error'), null);
    buildDay(currentDay);
    return;
  }

  var mapping = computeReorderMap(oldIndex, newIndex);
  try {
    if (todayState && todayState.workoutId && !todayState.isAdHoc) {
      await persistExerciseReorder(todayState.workoutId, mapping);
      remapStateExerciseKeys(todayState, mapping);
    }
  } catch(err) {
    // Plan already wrote; sets may now be mis-attributed on this workout.
    // Surface explicitly — we don't roll back the plan, the user's reorder
    // intent stands and they can re-log affected sets if needed.
    console.error('reorderPlanExercises set remap error:', err);
    showToast('Plan reordered but set positions didn\'t save: ' + (err.message || 'unknown error'), null);
  }

  buildTabs();
  buildDay(currentDay);
  showToast('Reordered for the rest of the week. Plan updated.', null);
}

// Ad-hoc-zone reorder. Doesn't touch the plan (ad-hoc extras have no plan
// representation). Just remaps exercise_order on sets + in-memory state
// keys. Positions are absolute exercise_order values (include plan-length
// offset when on a plan day). Scope: this session only.
// Reorder exercises within a drag zone (pure ad-hoc session OR plan-day
// extras). Takes ZONE-LOCAL DOM indices (0-based within the zone) and a
// `zoneStartEi` boundary: only exercises with ex_N >= zoneStartEi are
// candidates. State is keyed by ex_N where N can be sparse after add/
// delete cycles, so we must translate DOM index → actual ei before
// computing the reorder map — doing arithmetic on DOM indices directly
// (as pre-v2.4.14 did) moves the wrong exercise whenever gaps exist.
async function reorderAdHocExtras(oldDomIdx, newDomIdx, zoneStartEi) {
  if (!todayState || !todayState.workoutId) return;
  if (oldDomIdx === newDomIdx) return;
  zoneStartEi = zoneStartEi | 0;

  // Translate DOM indices → zone-scoped (ei, data) entries sorted by ei,
  // matching the order buildDay / buildAdHocDay use when painting cards.
  var allKeys = Object.keys(todayState.exercises || {});
  var zoneEntries = allKeys
    .map(function(k) { return { ei: parseInt(k.slice(3), 10), data: todayState.exercises[k] }; })
    .filter(function(e) { return e.ei >= zoneStartEi; })
    .sort(function(a, b) { return a.ei - b.ei; });
  if (oldDomIdx < 0 || oldDomIdx >= zoneEntries.length) return;
  if (newDomIdx < 0 || newDomIdx >= zoneEntries.length) return;

  // Capture out-of-zone ei values so we don't accidentally re-use them
  // when packing the zone into a contiguous range after the move.
  var usedOutOfZone = {};
  for (var i = 0; i < allKeys.length; i++) {
    var ei = parseInt(allKeys[i].slice(3), 10);
    if (ei < zoneStartEi) usedOutOfZone[ei] = true;
  }

  // Perform the array splice to reflect the intended new order.
  var moved = zoneEntries.splice(oldDomIdx, 1)[0];
  zoneEntries.splice(newDomIdx, 0, moved);

  // Assign new ei values sequentially starting at zoneStartEi, skipping
  // any values that belong to an out-of-zone exercise. Build the
  // oldEi → newEi mapping (skip no-op entries).
  var nextEi = zoneStartEi;
  var mapping = {};
  var newAssignments = [];
  for (var j = 0; j < zoneEntries.length; j++) {
    while (usedOutOfZone[nextEi]) nextEi++;
    newAssignments.push(nextEi);
    if (zoneEntries[j].ei !== nextEi) mapping[zoneEntries[j].ei] = nextEi;
    nextEi++;
  }
  if (!Object.keys(mapping).length) return;

  try {
    await persistExerciseReorder(todayState.workoutId, mapping);
    // Rebuild state.exercises: out-of-zone entries unchanged; zone
    // entries re-keyed to their new ei values.
    var newEx = {};
    for (var k = 0; k < allKeys.length; k++) {
      var key = allKeys[k];
      if (parseInt(key.slice(3), 10) < zoneStartEi) newEx[key] = todayState.exercises[key];
    }
    for (var m = 0; m < zoneEntries.length; m++) {
      newEx['ex_' + newAssignments[m]] = zoneEntries[m].data;
    }
    todayState.exercises = newEx;
  } catch(err) {
    console.error('reorderAdHocExtras error:', err);
    showToast("Couldn't save reorder: " + (err.message || 'unknown error'), null);
    return;
  }

  buildTabs();
  buildDay(currentDay);
  showToast(todayState.isAdHoc ? 'Reordered — this session only.' : 'Extras reordered.', null);
}

// "Bring to today": move a historical or orphaned workout to the current
// date, resetting the timer so the user can actually do the session. Keeps
// any logged sets attached to the workout row. Partial unique index on
// (user_id, plan_id, day_index, performed_on) enforces "one per plan-day
// per date" — collision returns 23505 and we surface a clear message.
//
// Caller guarantees the workout is eligible (plan_id matches activePlanId
// or is null for ad-hoc). Timer fields reset to current moment so the
// session's duration reflects actual work from the reactivation point
// forward, not yesterday's accidental tap-then-pause.
async function reactivateWorkout(workoutId) {
  if (!userId || !workoutId) throw new Error('Missing context');
  var now = new Date().toISOString();
  var today = sessionTodayDateString();
  // performed_at MUST be updated alongside performed_on — hydrate's
  // today-workouts query filters on performed_at (timestamp), not
  // performed_on (calendar date). Without this, a reactivated workout
  // stays outside today's bounds; hydrate can't find it; the session-start
  // modal opens (line 143-144 of app.js) because inProgressKey is null.
  var r = await sb.from('workouts').update({
    performed_on: today,
    performed_at: now,
    started_at: now,
    ended_at: null,
    paused_ms: 0,
  }).eq('id', workoutId).eq('user_id', userId).select().maybeSingle();
  if (r.error) {
    if (r.error.code === '23505') {
      throw new Error("You already have this day started today. Complete or discard that one first.");
    }
    throw new Error(r.error.message);
  }
  if (historyDetails && historyDetails[workoutId]) delete historyDetails[workoutId];
  invalidateHistoryCache();
  return r.data;
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
  // Focus plan day 0 if a plan exists, else first remaining ad-hoc, else
  // drop back into the no-plan empty state. The third branch needs an
  // explicit DOM reset because buildDay(0) returns early when `plan` is
  // null, so neither the leftover ad-hoc DOM in #workoutContainer nor
  // the hidden #emptyState would otherwise be touched.
  if (plan) {
    focusTab(0);
  } else if (todayAdHocs.length) {
    focusTab('ah_' + todayAdHocs[0].workoutId);
  } else {
    currentDay = 0;
    todayState = null;
    document.getElementById('workoutContainer').innerHTML = '';
    document.getElementById('emptyState').style.display = 'block';
    document.getElementById('summaryBar').style.display = 'none';
    if (typeof renderEmptyState === 'function') renderEmptyState();
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
  // Coach: fresh session = fresh context + cleared chat. Non-blocking —
  // buildCoachContext runs in the background; the session starts immediately.
  refreshCoachForNewSession();
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
  // Coach: session data just landed. Rebuild context so the just-completed
  // workout is reflected, and clear chat so next session starts clean.
  refreshCoachForNewSession();
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
  // Explicit resume clears the per-session suppression flag (set by the
  // resume-prompt's "Just log it" choice). If the user later completes
  // again and adds more, they'll be re-prompted as a fresh decision.
  todayState.suppressResumePrompt = false;
  buildDay(currentDay);
  invalidateHistoryCache();
}

// ---- Coaching profile load/save ----
// One row per user in coaching_profile; `data` jsonb holds the full profile.
// Edge Functions read the same table via service role on every Claude call
// (next commit); frontend keeps an in-memory copy for the modal and for
// any future read paths.
async function loadCoachingProfile() {
  if (!userId) return null;
  try {
    var res = await sb.from('coaching_profile')
      .select('data')
      .eq('user_id', userId)
      .maybeSingle();
    if (res.error) {
      console.warn('loadCoachingProfile error:', res.error.message);
      coachingProfile = {};
      return coachingProfile;
    }
    coachingProfile = (res.data && res.data.data) || {};
    return coachingProfile;
  } catch (err) {
    console.warn('loadCoachingProfile exception:', err);
    coachingProfile = {};
    return coachingProfile;
  }
}

// Upsert the profile blob. Keeps the in-memory copy in sync on success.
// Failures propagate so the modal can surface an error toast.
async function saveCoachingProfile(profile) {
  if (!userId) throw new Error('not signed in');
  var payload = {
    user_id: userId,
    data: profile || {},
    updated_at: new Date().toISOString(),
  };
  var res = await sb.from('coaching_profile')
    .upsert(payload, { onConflict: 'user_id' });
  if (res.error) throw new Error(res.error.message);
  coachingProfile = profile || {};
  return coachingProfile;
}

// Per-bucket model resolvers (v3.2.0). Reads the user's stored selection
// from coachingProfile.model_<bucket> (the JSONB blob is loaded flat into
// `coachingProfile`, not nested under .data — see loadCoachingProfile).
// Falls back to bucket default if unset or pointing at a retired model.
function modelForCoach() {
  return resolveModel(coachingProfile && coachingProfile.model_coach, 'coach');
}
function modelForPlan() {
  return resolveModel(coachingProfile && coachingProfile.model_plan, 'plan');
}
function modelForAnalyze() {
  return resolveModel(coachingProfile && coachingProfile.model_analyze, 'analyze');
}

// Merge accepted profile updates (from the analyze review's "Apply selected"
// flow, v2.5 layer 3) into a profile object, returning a new object — does
// NOT mutate the input. Scalar fields overwrite by field name; injury_*
// ops operate on a copy of the injuries array. Pure transform: no DB, no
// globals. Lives in data.js alongside load/save so the profile-shape logic
// is colocated; ui.js invokes it from onAnalyzeApplyProfileUpdates.
function applyProfileUpdatesFrom(profile, updates) {
  var next = Object.assign({}, profile || {});
  next.injuries = Array.isArray(profile && profile.injuries) ? profile.injuries.slice() : [];
  for (var i = 0; i < updates.length; i++) {
    var u = updates[i];
    if (u.field === 'injury_add') {
      next.injuries.push({
        name: (u.proposed && u.proposed.name) || '',
        notes: (u.proposed && u.proposed.notes) || '',
      });
    } else if (u.field === 'injury_remove') {
      var removeName = u.current && u.current.name;
      next.injuries = next.injuries.filter(function(inj) {
        return !inj || inj.name !== removeName;
      });
    } else if (u.field === 'injury_update') {
      var updateName = u.current && u.current.name;
      next.injuries = next.injuries.map(function(inj) {
        if (!inj || inj.name !== updateName) return inj;
        return {
          name: (u.proposed && u.proposed.name) || inj.name,
          notes: (u.proposed && u.proposed.notes) || '',
        };
      });
    } else {
      // Scalar field: assign proposed directly. null proposed clears it.
      next[u.field] = u.proposed == null ? null : u.proposed;
    }
  }
  return next;
}

// ---- Coach message persistence ----
// Fire-and-forget insert into coach_messages. Used by chat send, swap
// request/accept, and plan-gen submit/accept so all three coaching
// surfaces share one durable log. Failures are non-fatal and never
// surface to the user — the chat / swap / plan flows must keep working
// even if the persistence layer is degraded. Edge Functions read this
// table with the service role to inject "RECENT COACHING CONVERSATIONS"
// into Claude's user message on every call (B3).
//
// contextType: 'chat' | 'swap' | 'plan_generation' (constrained by the
// CHECK on the table — anything else throws at the DB layer).
// exerciseName: populated for 'swap' rows so the prompt can render
// "[exercise swap: Cable Row]" inline. Null for chat / plan_generation.
function logCoachMessage(role, content, contextType, exerciseName, createdAt) {
  if (!userId || !content) return;
  try {
    var payload = {
      user_id: userId,
      role: role,
      content: content,
      context_type: contextType || null,
      exercise_name: exerciseName || null,
    };
    // Optional client-stamped timestamp. Used by the chat path to
    // disambiguate the user/assistant pair that fires back-to-back —
    // server-side `default now()` can race when two concurrent INSERTs
    // arrive in either order over HTTP/2, leaving the assistant row
    // with an earlier created_at than the user's question and rendering
    // the transcript out-of-order on app restart.
    if (createdAt) payload.created_at = createdAt;
    sb.from('coach_messages').insert(payload).then(function(r) {
      if (r && r.error) {
        console.warn('coach_messages insert failed:', r.error.message);
      }
    });
  } catch (err) {
    console.warn('coach_messages insert exception:', err);
  }
}

// ---- Import ----
// Historical workouts and sets rows are NEVER modified on import.
// See DECISIONS.md → "No more log wipes".
//
// savePlanAsActive persists a plan blob to Supabase, flips the previously
// active plan to inactive, and refreshes the in-memory view. Shared
// between file-based import (handleImport) and AI-generated plans
// (onAcceptGeneratedPlan). Throws on error so callers can decide how to
// surface the failure.
//
// Stamps `start_date` on the plan JSON with today's local date so the
// AI planner can ground phase-awareness reasoning in actual calendar
// dates. Preserves an explicit start_date if one was set upstream.
async function savePlanAsActive(newPlan) {
  // Canonicalize compact-set notation BEFORE persistence (v3.6.9). The
  // AI-gen path expands server-side; hand-pasted imports + "use template
  // as plan" did not — so a blob with {"repeat": 3} stored one set and
  // rendered as one. Doing it here makes the DB row the canonical
  // (expanded) shape regardless of source. Idempotent: blobs that have
  // already been expanded contain no `repeat` field and pass through
  // untouched.
  expandSetRepeatsInPlan(newPlan);
  if (!newPlan.start_date) {
    newPlan.start_date = sessionTodayDateString();
  }
  // Normalize plan.week to the Sunday-Saturday range containing
  // start_date so the tracker header matches the History browser's
  // week labels (both use formatWeekLabel). Overrides whatever string
  // Claude emitted — Claude's output is inconsistent (sometimes
  // "Week 5", sometimes a Mon-Fri range). Single source of truth:
  // start_date. planWeekLabel() also re-derives this at render time
  // so plans saved before this fix display correctly.
  newPlan.week = planWeekLabel(newPlan) || newPlan.week || '';

  var r1 = await sb.from('plans').update({ is_active: false })
    .eq('user_id', userId).eq('is_active', true);
  if (r1.error) throw new Error(r1.error.message);

  var r2 = await sb.from('plans').insert({
    user_id: userId,
    title: newPlan.title || null,
    week: newPlan.week || null,
    data: newPlan,
    is_active: true,
  }).select().single();
  if (r2.error) throw new Error(r2.error.message);

  activePlanId = r2.data.id;
  plan = newPlan;
  planCache[activePlanId] = plan;
  // Reset plan-related in-memory view only; past workouts/sets remain
  // untouched in the DB. Ad-hoc sessions are plan-agnostic and stay.
  todayState = null;
  todayPlanStates = {};
  historicalCache = {};
  daysWithHistory = {};
  exerciseIdCache = {};
  currentDay = 0;

  // Repopulate days-with-history for the new active plan so dots render
  // correctly in buildTabs below. Cheap query; new plans return nothing.
  await loadDaysWithHistory();

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('summaryBar').style.display = 'flex';
  document.getElementById('planTitle').textContent = plan.title || 'Workout Tracker';
  document.getElementById('planWeek').textContent = planWeekLabel(plan) || plan.week || '';
  buildTabs(); buildDay(0);
  // Coach: new active plan → old chat + context are stale. Refresh both.
  refreshCoachForNewSession();
  // Persist the now-active plan so next boot paints it, not the old one.
  saveHydrationSnapshot();
  return r2.data;
}

// Re-activate an existing plan (used by the Plans management modal).
// Unlike savePlanAsActive, this does NOT create a new plan row — it
// just flips is_active on the target plan and on the previously
// active one. start_date on the activated plan is preserved as-is.
async function activateExistingPlan(planId) {
  var r1 = await sb.from('plans').update({ is_active: false })
    .eq('user_id', userId).eq('is_active', true);
  if (r1.error) throw new Error(r1.error.message);

  var r2 = await sb.from('plans').update({ is_active: true })
    .eq('id', planId).eq('user_id', userId)
    .select().single();
  if (r2.error) throw new Error(r2.error.message);

  activePlanId = r2.data.id;
  plan = ensureStartDate(r2.data.data || {}, r2.data);
  planCache[activePlanId] = plan;
  todayState = null;
  todayPlanStates = {};
  historicalCache = {};
  daysWithHistory = {};
  exerciseIdCache = {};
  currentDay = 0;

  // Repopulate days-with-history for the new active plan so dots render
  // correctly in buildTabs below. Cheap query; new plans return nothing.
  await loadDaysWithHistory();

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('summaryBar').style.display = 'flex';
  document.getElementById('planTitle').textContent = plan.title || 'Workout Tracker';
  document.getElementById('planWeek').textContent = planWeekLabel(plan) || plan.week || '';
  buildTabs(); buildDay(0);
  refreshCoachForNewSession();
  // Persist the re-activated plan so next boot paints it.
  saveHydrationSnapshot();
  return r2.data;
}

// Deactivate the currently-active plan without replacing it. Used by the
// Plans modal "End plan" action. Unlike savePlanAsActive / activateExistingPlan
// this leaves the user in a no-plan state — DB plan row stays intact (is_active
// flipped to false), all attached workouts/sets/coach history preserved. The
// user can re-activate via the Plans modal at any time.
//
// Mirrors the structure of activateExistingPlan but in reverse: DB write
// first, then in-memory state cleared, then UI re-rendered into empty-state.
async function endActivePlan() {
  if (!userId) throw new Error('Not signed in');
  if (!activePlanId) throw new Error('No active plan to end');

  var r = await sb.from('plans').update({ is_active: false })
    .eq('user_id', userId).eq('is_active', true);
  if (r.error) throw new Error(r.error.message);

  // Clear plan-anchored in-memory state. planCache is intentionally retained
  // — other plans may still be browsable via the Plans modal.
  activePlanId = null;
  plan = null;
  todayState = null;
  todayPlanStates = {};
  historicalCache = {};
  daysWithHistory = {};
  exerciseIdCache = {};
  currentDay = 0;
  suggestedDayIndex = null;

  // Coach context is plan-anchored; rebuild against the now-empty plan slot
  // so chat doesn't keep referencing the ended plan. buildCoachContext
  // (data.js:2801) handles plan == null cleanly — _formatPlanForCoach
  // returns '' when plan is null/empty, so the plan block just drops out.
  if (typeof refreshCoachForNewSession === 'function') {
    refreshCoachForNewSession();
  }

  // Drop the hydration snapshot. saveHydrationSnapshot's existing guard
  // (`if (!activePlanId || !plan) return;`) means we can't save a no-plan
  // snapshot directly — clearing is the right move. paintFromCache will
  // skip on next boot and hydrate runs from scratch into the empty state.
  if (typeof clearHydrationSnapshot === 'function') {
    clearHydrationSnapshot();
  }

  // Stop the running session timer interval if it was ticking against
  // the now-cleared Day card. Self-cleans on next tick anyway (the
  // tick callback finds #sessionTimer missing and calls stopTimerTick),
  // but stopping eagerly avoids a stray tick re-rendering anything.
  if (typeof stopTimerTick === 'function') stopTimerTick();

  // UI side effects: tracker drops to empty state. Caller is responsible
  // for re-rendering (renderEmptyState in ui.js). We only handle the
  // direct DOM toggles here that are already done by savePlanAsActive's
  // mirror — keeps the data-layer / UI-layer split clean.
  var emptyEl = document.getElementById('emptyState');
  if (emptyEl) emptyEl.style.display = 'block';
  var summaryEl = document.getElementById('summaryBar');
  if (summaryEl) summaryEl.style.display = 'none';
  var titleEl = document.getElementById('planTitle');
  if (titleEl) titleEl.textContent = 'No active plan';
  var weekEl = document.getElementById('planWeek');
  if (weekEl) weekEl.textContent = '';
  var container = document.getElementById('workoutContainer');
  if (container) container.innerHTML = '';
}

// ---- Superset merge / separate (v3.4.0) ----

// Resolve a list of flat exercise_order values to (blockIdx, memberIdx)
// tuples within dayPlan.exercises[]. blockIdx is the dayPlan.exercises[]
// index of the block (or the standalone exercise); memberIdx is the
// position within the block (or -1 for standalone).
function _resolveFlatEi(dayPlan, flatEiList) {
  var out = new Array(flatEiList.length);
  var flatI = 0;
  for (var i = 0; i < dayPlan.exercises.length; i++) {
    var entry = dayPlan.exercises[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        var idx = flatEiList.indexOf(flatI);
        if (idx >= 0) out[idx] = { flatEi: flatI, blockIdx: i, memberIdx: ci };
        flatI++;
      }
    } else {
      var idx2 = flatEiList.indexOf(flatI);
      if (idx2 >= 0) out[idx2] = { flatEi: flatI, blockIdx: i, memberIdx: -1 };
      flatI++;
    }
  }
  return out;
}

// Resolve a FLAT exercise_order ei to its prescribed exercise object
// in dayPlan.exercises[]. Walks the nested structure: block entries
// expand into their members, standalone entries occupy one flat slot.
// Returns null when ei is past the day flat range (e.g., extras).
function _flatEiToPlanMember(dayPlan, ei) {
  if (!dayPlan || !Array.isArray(dayPlan.exercises)) return null;
  var flatI = 0;
  for (var i = 0; i < dayPlan.exercises.length; i++) {
    var entry = dayPlan.exercises[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        if (flatI === ei) return entry.exercises[ci];
        flatI++;
      }
    } else {
      if (flatI === ei) return entry;
      flatI++;
    }
  }
  return null;
}

// Check whether the just-toggled set in a block is "last of round" --
// i.e., this tap brought min(completed-set-count) across members up
// by one. Used by _toggleSetCommit to decide whether to fire the
// rest timer when the exercise is a superset member.
//
// Returns true when the round is complete (fire timer).
// Returns false when the round is NOT complete (suppress timer).
//
// Members with fewer sets than the block's max round count don't
// gate the round -- the check uses min only across members that have
// a set at the current round index si.
function shouldFireRestForBlockMember(state, ei, si) {
  var ek = 'ex_' + ei;
  var exState = state && state.exercises && state.exercises[ek];
  if (!exState || !exState.supersetGroup) return false;
  var groupKey = exState.supersetGroup;

  var memberDoneCounts = [];
  var memberHasSetAtSi = [];
  for (var ek2 in state.exercises) {
    if (!state.exercises.hasOwnProperty(ek2)) continue;
    var mEx = state.exercises[ek2];
    if (mEx.supersetGroup !== groupKey) continue;
    var doneCount = 0;
    if (Array.isArray(mEx.sets)) {
      for (var j = 0; j < mEx.sets.length; j++) {
        if (mEx.sets[j] && mEx.sets[j].done) doneCount++;
      }
    }
    memberDoneCounts.push(doneCount);
    memberHasSetAtSi.push(Array.isArray(mEx.sets) && mEx.sets[si] != null);
  }
  if (!memberDoneCounts.length) return false;

  // Round just completed = min(doneCount across members with a set at si)
  // is at least si + 1.
  var minDone = Infinity;
  for (var k = 0; k < memberDoneCounts.length; k++) {
    if (memberHasSetAtSi[k] && memberDoneCounts[k] < minDone) minDone = memberDoneCounts[k];
  }
  if (minDone === Infinity) return false;
  return minDone >= (si + 1);
}

// Re-stamp supersetGroup / supersetRest on state.exercises after the
// column was rewritten. Mirrors the derivation in stateFromWorkout.
function _restateFromSupersetGroups(state, groups) {
  for (var ek in state.exercises) {
    if (state.exercises.hasOwnProperty(ek)) {
      state.exercises[ek].supersetGroup = null;
      state.exercises[ek].supersetRest = null;
    }
  }
  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    if (!g || !Array.isArray(g.exercise_orders)) continue;
    var key = 'g' + gi;
    for (var oi = 0; oi < g.exercise_orders.length; oi++) {
      var ek2 = 'ex_' + g.exercise_orders[oi];
      if (state.exercises[ek2]) {
        state.exercises[ek2].supersetGroup = key;
        state.exercises[ek2].supersetRest = Number.isInteger(g.rest) ? g.rest : 60;
      }
    }
  }
}

// Merge two exercises on the same day into a superset block. eiA is
// the source (the user tapped the chain-link icon on this card); eiB is the target
// (picker selection). If eiB is in an existing block, eiA joins that
// block; if both are standalone, a new 2-member block is created.
//
// Plan-day path: mutates plan.data and persists via plans.update.
// Recomputes today plan-day workout superset_groups if a workouts row
// already exists. Ad-hoc path: rewrites workouts.superset_groups
// directly. Either way, in-memory state is mirrored before returning.
async function applySupersetMerge(di, eiA, eiB) {
  if (!userId) throw new Error('Not signed in');
  if (eiA === eiB) throw new Error('Cannot pair an exercise with itself');
  if (isAdHocKey(di)) {
    return _applySupersetMergeAdHoc(di, eiA, eiB);
  }
  return _applySupersetMergePlan(di, eiA, eiB);
}

async function _applySupersetMergePlan(di, eiA, eiB) {
  if (!plan || !plan.days || !plan.days[di]) throw new Error('Plan day not found');
  var dayPlan = plan.days[di];
  var resolved = _resolveFlatEi(dayPlan, [eiA, eiB]);
  if (!resolved || resolved.length !== 2 || !resolved[0] || !resolved[1]) {
    throw new Error('Could not resolve ei to plan entries');
  }

  var rA = resolved[0], rB = resolved[1];
  var entryA = dayPlan.exercises[rA.blockIdx];
  var entryB = dayPlan.exercises[rB.blockIdx];

  // Deep clone for atomic mutation. We will mutate newDay then assign
  // it back into a cloned plan and persist.
  var newDay = JSON.parse(JSON.stringify(dayPlan));

  if (entryA.superset && !entryB.superset) {
    newDay.exercises[rA.blockIdx].exercises.push(JSON.parse(JSON.stringify(entryB)));
    newDay.exercises.splice(rB.blockIdx, 1);
  } else if (!entryA.superset && entryB.superset) {
    newDay.exercises[rB.blockIdx].exercises.push(JSON.parse(JSON.stringify(entryA)));
    newDay.exercises.splice(rA.blockIdx, 1);
  } else if (!entryA.superset && !entryB.superset) {
    var rest = (Number.isInteger(entryA.rest) ? entryA.rest : null)
            || (Number.isInteger(entryB.rest) ? entryB.rest : null)
            || 60;
    var memberA = JSON.parse(JSON.stringify(entryA)); delete memberA.rest;
    var memberB = JSON.parse(JSON.stringify(entryB)); delete memberB.rest;
    var block = { superset: true, rest: rest, exercises: [memberA, memberB] };
    var lo = Math.min(rA.blockIdx, rB.blockIdx);
    var hi = Math.max(rA.blockIdx, rB.blockIdx);
    newDay.exercises[lo] = block;
    newDay.exercises.splice(hi, 1);
  } else {
    // Both blocks -- concat B into A.
    newDay.exercises[rA.blockIdx].exercises = newDay.exercises[rA.blockIdx].exercises.concat(
      JSON.parse(JSON.stringify(entryB.exercises))
    );
    newDay.exercises.splice(rB.blockIdx, 1);
  }

  var newPlan = JSON.parse(JSON.stringify(plan));
  newPlan.days[di] = newDay;
  var pr = await sb.from('plans').update({ data: newPlan }).eq('id', activePlanId);
  if (pr.error) throw new Error(pr.error.message);
  plan = newPlan;
  planCache[activePlanId] = plan;

  var todayPlanState = todayPlanStates[di];
  if (todayPlanState && todayPlanState.workoutId) {
    var newGroups = supersetGroupsFromPlanDay(newDay);
    var wr = await sb.from('workouts').update({ superset_groups: newGroups })
      .eq('id', todayPlanState.workoutId);
    if (wr.error) throw new Error(wr.error.message);
    _restateFromSupersetGroups(todayPlanState, newGroups);
  }
}

async function _applySupersetMergeAdHoc(di, eiA, eiB) {
  var state = findAdHoc(di);
  if (!state) throw new Error('Ad-hoc session not found');

  // Compute current groups from state.
  var orderedKeys = Object.keys(state.exercises).sort(function(a, b) {
    return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
  });
  var currentGroups = [];
  var groupKeyToGroupIdx = {};
  for (var i = 0; i < orderedKeys.length; i++) {
    var ek = orderedKeys[i];
    var ex = state.exercises[ek];
    var ei = parseInt(ek.slice(3), 10);
    if (ex.supersetGroup) {
      var idx = groupKeyToGroupIdx[ex.supersetGroup];
      if (idx == null) {
        groupKeyToGroupIdx[ex.supersetGroup] = currentGroups.length;
        currentGroups.push({ orders: [ei], rest: ex.supersetRest || 60 });
      } else {
        currentGroups[idx].orders.push(ei);
      }
    }
  }

  var groupOfA = -1, groupOfB = -1;
  for (var gi = 0; gi < currentGroups.length; gi++) {
    if (currentGroups[gi].orders.indexOf(eiA) >= 0) groupOfA = gi;
    if (currentGroups[gi].orders.indexOf(eiB) >= 0) groupOfB = gi;
  }

  var newGroups;
  if (groupOfA < 0 && groupOfB < 0) {
    newGroups = currentGroups.slice();
    newGroups.push({ orders: [eiA, eiB].sort(function(a, b) { return a - b; }), rest: 60 });
  } else if (groupOfA >= 0 && groupOfB < 0) {
    newGroups = currentGroups.slice();
    newGroups[groupOfA] = {
      orders: newGroups[groupOfA].orders.concat([eiB]).sort(function(a, b) { return a - b; }),
      rest: newGroups[groupOfA].rest
    };
  } else if (groupOfA < 0 && groupOfB >= 0) {
    newGroups = currentGroups.slice();
    newGroups[groupOfB] = {
      orders: newGroups[groupOfB].orders.concat([eiA]).sort(function(a, b) { return a - b; }),
      rest: newGroups[groupOfB].rest
    };
  } else if (groupOfA === groupOfB) {
    return;  // Already paired; no-op.
  } else {
    newGroups = [];
    for (var gj = 0; gj < currentGroups.length; gj++) {
      if (gj === groupOfB) continue;
      if (gj === groupOfA) {
        newGroups.push({
          orders: currentGroups[gj].orders.concat(currentGroups[groupOfB].orders)
            .sort(function(a, b) { return a - b; }),
          rest: currentGroups[gj].rest
        });
      } else {
        newGroups.push(currentGroups[gj]);
      }
    }
  }

  var payload = newGroups.map(function(g) {
    return { exercise_orders: g.orders, rest: g.rest };
  });
  var wr = await sb.from('workouts').update({ superset_groups: payload }).eq('id', state.workoutId);
  if (wr.error) throw new Error(wr.error.message);
  _restateFromSupersetGroups(state, payload);
}

// Remove the card at ei from its superset block. If the block now has
// only 1 member, the whole block dissolves (the leftover becomes
// standalone). Mutates plan.data (plan-day) or workouts.superset_groups
// (ad-hoc); persists; mirrors to in-memory state.
async function applySupersetSeparate(di, ei) {
  if (!userId) throw new Error('Not signed in');
  if (isAdHocKey(di)) {
    return _applySupersetSeparateAdHoc(di, ei);
  }
  return _applySupersetSeparatePlan(di, ei);
}

async function _applySupersetSeparatePlan(di, ei) {
  if (!plan || !plan.days || !plan.days[di]) throw new Error('Plan day not found');
  var dayPlan = plan.days[di];
  var resolved = _resolveFlatEi(dayPlan, [ei]);
  if (!resolved || !resolved[0]) throw new Error('Could not resolve ei');
  var r = resolved[0];
  if (r.memberIdx < 0) {
    return;  // already standalone -- no-op
  }

  var newDay = JSON.parse(JSON.stringify(dayPlan));
  var block = newDay.exercises[r.blockIdx];
  var poppedMember = block.exercises.splice(r.memberIdx, 1)[0];

  if (block.exercises.length === 1) {
    // Dissolve the block: the remaining member becomes standalone in
    // place of the block; the popped member is inserted right after.
    var soleSurvivor = block.exercises[0];
    if (soleSurvivor.rest == null) soleSurvivor.rest = block.rest;
    if (poppedMember.rest == null) poppedMember.rest = block.rest;
    newDay.exercises[r.blockIdx] = soleSurvivor;
    newDay.exercises.splice(r.blockIdx + 1, 0, poppedMember);
  } else {
    // Block survives with N-1 members. Insert popped member after the
    // block as a standalone.
    if (poppedMember.rest == null) poppedMember.rest = block.rest;
    // newDay.exercises[r.blockIdx] is already the mutated block; just
    // splice the popped member after it.
    newDay.exercises.splice(r.blockIdx + 1, 0, poppedMember);
  }

  var newPlan = JSON.parse(JSON.stringify(plan));
  newPlan.days[di] = newDay;
  var pr = await sb.from('plans').update({ data: newPlan }).eq('id', activePlanId);
  if (pr.error) throw new Error(pr.error.message);
  plan = newPlan;
  planCache[activePlanId] = plan;

  var todayPlanState = todayPlanStates[di];
  if (todayPlanState && todayPlanState.workoutId) {
    var newGroups = supersetGroupsFromPlanDay(newDay);
    var wr = await sb.from('workouts').update({ superset_groups: newGroups })
      .eq('id', todayPlanState.workoutId);
    if (wr.error) throw new Error(wr.error.message);
    _restateFromSupersetGroups(todayPlanState, newGroups);
  }
}

async function _applySupersetSeparateAdHoc(di, ei) {
  var state = findAdHoc(di);
  if (!state) throw new Error('Ad-hoc session not found');

  var orderedKeys = Object.keys(state.exercises).sort(function(a, b) {
    return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
  });
  var currentGroups = [];
  var groupKeyToGroupIdx = {};
  for (var i = 0; i < orderedKeys.length; i++) {
    var ek = orderedKeys[i];
    var ex = state.exercises[ek];
    var eiCur = parseInt(ek.slice(3), 10);
    if (ex.supersetGroup) {
      var idx = groupKeyToGroupIdx[ex.supersetGroup];
      if (idx == null) {
        groupKeyToGroupIdx[ex.supersetGroup] = currentGroups.length;
        currentGroups.push({ orders: [eiCur], rest: ex.supersetRest || 60 });
      } else {
        currentGroups[idx].orders.push(eiCur);
      }
    }
  }

  // Find the group containing ei and remove ei from it.
  var newGroups = [];
  for (var gj = 0; gj < currentGroups.length; gj++) {
    var g = currentGroups[gj];
    var has = g.orders.indexOf(ei) >= 0;
    if (!has) {
      newGroups.push(g);
      continue;
    }
    var withoutEi = g.orders.filter(function(o) { return o !== ei; });
    if (withoutEi.length >= 2) {
      newGroups.push({ orders: withoutEi, rest: g.rest });
    }
    // If withoutEi has 1 entry, the block dissolves -- just don't push it.
  }

  var payload = newGroups.map(function(g) {
    return { exercise_orders: g.orders, rest: g.rest };
  });
  var wr = await sb.from('workouts').update({ superset_groups: payload }).eq('id', state.workoutId);
  if (wr.error) throw new Error(wr.error.message);
  _restateFromSupersetGroups(state, payload);
}

// Reorder members within a superset block. newMemberEisInOrder is the
// new member exercise_order sequence as derived from the DOM after the
// drag drop. Plan-day path: rewrites block.exercises[] in plan.data
// AND rewrites today plan-day workout superset_groups exercise_orders
// to match (so renders see the new order). Ad-hoc path: rewrites
// workouts.superset_groups exercise_orders directly.
//
// No set remap -- members keep their exercise_order values. Only
// metadata (block member order in plan.data, exercise_orders[] in
// the workouts.superset_groups column) changes.
async function applySupersetReorderMembers(di, groupKey, newMemberEisInOrder) {
  if (!userId) throw new Error('Not signed in');
  if (!Array.isArray(newMemberEisInOrder) || newMemberEisInOrder.length < 2) return;

  if (isAdHocKey(di)) {
    return _applySupersetReorderAdHoc(di, groupKey, newMemberEisInOrder);
  }
  return _applySupersetReorderPlan(di, groupKey, newMemberEisInOrder);
}

async function _applySupersetReorderPlan(di, groupKey, newMemberEisInOrder) {
  if (!plan || !plan.days || !plan.days[di]) throw new Error('Plan day not found');
  var dayPlan = plan.days[di];
  // Find the block's nested index by walking dayPlan.exercises[] flat.
  // Use _resolveFlatEi on the first member ei to locate the block.
  var resolved = _resolveFlatEi(dayPlan, [newMemberEisInOrder[0]]);
  if (!resolved || !resolved[0] || resolved[0].memberIdx < 0) return;
  var blockIdx = resolved[0].blockIdx;

  // Reconstruct the OLD member order by enumerating exercise_orders
  // contiguously from the block's flat-start.
  var newDayClone = JSON.parse(JSON.stringify(dayPlan));
  var blockClone = newDayClone.exercises[blockIdx];

  // Resolve flat-start for the block: walk exercises[] up to blockIdx
  // and accumulate flat sizes (1 for standalone, N for block).
  var blockFlatStart = 0;
  for (var ki = 0; ki < blockIdx; ki++) {
    var ke = newDayClone.exercises[ki];
    if (ke && ke.superset === true && Array.isArray(ke.exercises)) {
      blockFlatStart += ke.exercises.length;
    } else {
      blockFlatStart += 1;
    }
  }
  var oldOrderToMemberIdx = {};
  for (var oi = 0; oi < blockClone.exercises.length; oi++) {
    oldOrderToMemberIdx[blockFlatStart + oi] = oi;
  }

  // Build new member array in the new order.
  var newMembers = newMemberEisInOrder.map(function(newEi) {
    var srcMemberIdx = oldOrderToMemberIdx[newEi];
    if (srcMemberIdx == null) return null;
    return blockClone.exercises[srcMemberIdx];
  });
  if (newMembers.indexOf(null) >= 0) return;  // resolution failure -- bail safely
  blockClone.exercises = newMembers;
  newDayClone.exercises[blockIdx] = blockClone;

  var newPlan = JSON.parse(JSON.stringify(plan));
  newPlan.days[di] = newDayClone;
  var pr = await sb.from('plans').update({ data: newPlan }).eq('id', activePlanId);
  if (pr.error) throw new Error(pr.error.message);
  plan = newPlan;
  planCache[activePlanId] = plan;

  var todayPlanState = todayPlanStates[di];
  if (todayPlanState && todayPlanState.workoutId) {
    var newGroups = supersetGroupsFromPlanDay(newDayClone);
    var wr = await sb.from('workouts').update({ superset_groups: newGroups })
      .eq('id', todayPlanState.workoutId);
    if (wr.error) throw new Error(wr.error.message);
    _restateFromSupersetGroups(todayPlanState, newGroups);
  }
}

async function _applySupersetReorderAdHoc(di, groupKey, newMemberEisInOrder) {
  var state = findAdHoc(di);
  if (!state) throw new Error('Ad-hoc session not found');

  // Rebuild current groups from state.
  var orderedKeys = Object.keys(state.exercises).sort(function(a, b) {
    return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
  });
  var currentGroups = [];
  var groupKeyToGroupIdx = {};
  for (var i = 0; i < orderedKeys.length; i++) {
    var ek = orderedKeys[i];
    var ex = state.exercises[ek];
    var ei = parseInt(ek.slice(3), 10);
    if (ex.supersetGroup) {
      var idx = groupKeyToGroupIdx[ex.supersetGroup];
      if (idx == null) {
        groupKeyToGroupIdx[ex.supersetGroup] = currentGroups.length;
        currentGroups.push({ orders: [ei], rest: ex.supersetRest || 60, key: ex.supersetGroup });
      } else {
        currentGroups[idx].orders.push(ei);
      }
    }
  }

  // Replace target group's orders with the new sequence (preserve rest).
  var found = false;
  for (var gj = 0; gj < currentGroups.length; gj++) {
    if (currentGroups[gj].key === groupKey) {
      currentGroups[gj].orders = newMemberEisInOrder.slice();
      found = true;
      break;
    }
  }
  if (!found) return;

  var payload = currentGroups.map(function(g) {
    return { exercise_orders: g.orders, rest: g.rest };
  });
  var wr = await sb.from('workouts').update({ superset_groups: payload }).eq('id', state.workoutId);
  if (wr.error) throw new Error(wr.error.message);
  _restateFromSupersetGroups(state, payload);
}

// Add one set to every member of a superset block. Mirrors the
// existing addExtraSet semantics per-member (carry-forward applied,
// set.done = false, weight_mode inherited). Used by the block-level
// "+ Add round" button at the bottom of each block.
//
// di: 'ah_<workoutId>' for ad-hoc, integer day index for plan-day.
// groupKey: the supersetGroup string ('g0', 'g1', ...) -- the renderer
// stamps this on data-add-round so we can find affected members.
async function addRoundToBlockMembers(di, groupKey) {
  var state;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
  } else {
    state = stateForDay(di);
  }
  if (!state) return;
  // Snapshot member eis BEFORE mutating; addExtraSet pushes to
  // state.exercises[ek].sets so the iteration order matters.
  var memberEis = [];
  for (var ek in state.exercises) {
    if (!state.exercises.hasOwnProperty(ek)) continue;
    if (state.exercises[ek].supersetGroup === groupKey) {
      memberEis.push(parseInt(ek.slice(3), 10));
    }
  }
  memberEis.sort(function(a, b) { return a - b; });
  for (var i = 0; i < memberEis.length; i++) {
    addExtraSet(memberEis[i]);
  }
}

// ---- Templates ----
// Templates are plans rows with is_template = true, is_active = false.
// They're never activated directly — they're copied into ad-hoc sessions
// via the Template card in the start-session modal.

// Save a plan blob as a reusable template. Strips start_date / week since
// templates have no calendar anchor. `sourcePlanBlob` is deep-cloned so
// mutating the returned row's data in place can't leak back to the source.
async function saveAsTemplate(templateName, sourcePlanBlob) {
  if (!userId) throw new Error('Not signed in');
  if (!templateName || !templateName.trim()) throw new Error('Template name required');
  var blob = JSON.parse(JSON.stringify(sourcePlanBlob || {}));
  // Canonicalize compact-set notation before persistence (v3.6.9).
  // Same reasoning as savePlanAsActive — make the DB row the expanded
  // shape so render-time code never sees {"repeat": N}.
  expandSetRepeatsInPlan(blob);
  delete blob.start_date;
  delete blob.week;
  var r = await sb.from('plans').insert({
    user_id: userId,
    title: blob.title || templateName,
    week: null,
    data: blob,
    is_active: false,
    is_template: true,
    template_name: templateName.trim(),
  }).select().single();
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

// Extract one day from a multi-day plan blob into a single-day template blob.
// Returned blob keeps the day's full exercise/set structure intact.
function extractSingleDayPlan(sourcePlanBlob, dayIndex) {
  var days = (sourcePlanBlob && Array.isArray(sourcePlanBlob.days)) ? sourcePlanBlob.days : [];
  var day = days[dayIndex];
  if (!day) throw new Error('Day not found at index ' + dayIndex);
  return {
    title: day.name || ('Day ' + (dayIndex + 1)),
    days: [JSON.parse(JSON.stringify(day))],
  };
}

// Fetch templates for the current user, newest first. Returns hydrated
// summaries suitable for list rendering.
async function loadTemplates() {
  if (!userId) return [];
  var r = await sb.from('plans')
    .select('id, title, template_name, data, created_at')
    .eq('user_id', userId)
    .eq('is_template', true)
    .order('created_at', { ascending: false });
  if (r.error) throw r.error;
  return (r.data || []).map(function(t) {
    var days = (t.data && t.data.days) || [];
    return {
      id: t.id,
      template_name: t.template_name || t.title || 'Untitled',
      title: t.title || '',
      data: t.data || {},
      created_at: t.created_at,
      day_count: days.length,
      days: days,
    };
  });
}

async function deleteTemplate(templateId) {
  if (!userId) throw new Error('Not signed in');
  var r = await sb.from('plans').delete().eq('id', templateId);
  if (r.error) throw new Error(r.error.message);
}

// Rename a non-template plan row. Updates both the top-level `title`
// column (source of truth for Plans list + week-label renders) and the
// embedded data.title (used by the in-memory `plan` global + downstream
// references). If the renamed plan is the active one, the caller is
// responsible for syncing the in-memory `plan` and header UI — this
// function only touches the database.
async function renamePlan(planId, newName) {
  if (!userId) throw new Error('Not signed in');
  var trimmed = (newName || '').trim();
  if (!trimmed) throw new Error('Plan name required');
  var row = await sb.from('plans').select('data').eq('id', planId).eq('is_template', false).single();
  if (row.error) throw new Error(row.error.message);
  var blob = row.data.data || {};
  blob.title = trimmed;
  var r = await sb.from('plans').update({
    title: trimmed,
    data: blob,
  }).eq('id', planId).eq('is_template', false);
  if (r.error) throw new Error(r.error.message);
}

// Rename a template. Updates both the `template_name` column (source of
// truth for the Templates list + start-screen picker) and the embedded
// data.title (used downstream by createAdHocFromTemplate when seeding the
// generated session's title). Keeps the two in sync so historical uses
// of the template remain labeled consistently with its new name.
async function renameTemplate(templateId, newName) {
  if (!userId) throw new Error('Not signed in');
  var trimmed = (newName || '').trim();
  if (!trimmed) throw new Error('Template name required');
  var row = await sb.from('plans').select('data').eq('id', templateId).single();
  if (row.error) throw new Error(row.error.message);
  var blob = row.data.data || {};
  blob.title = trimmed;
  var r = await sb.from('plans').update({
    template_name: trimmed,
    title: trimmed,
    data: blob,
  }).eq('id', templateId);
  if (r.error) throw new Error(r.error.message);
}

// Create a new ad-hoc workout pre-populated from a template day. Mirrors
// createAdHocSession's insert + state-init, then loads the template's
// exercises into the state with resolved library ids. plan_id stays null
// — template-based sessions are still ad-hoc, not plan-based.
async function createAdHocFromTemplate(template, dayIndex) {
  if (!userId) return;
  var days = (template && template.data && template.data.days) || [];
  var idx = Number.isFinite(dayIndex) ? dayIndex : 0;
  var day = days[idx];
  if (!day) { showToast("Template day not found", null); return; }

  var now = new Date().toISOString();
  var dayName = day.name || ('Day ' + (idx + 1));
  var title = template.day_count > 1
    ? (template.template_name + ' — ' + dayName)
    : template.template_name;

  try {
    var res = await sb.from('workouts').insert({
      user_id: userId, plan_id: null, day_index: null,
      performed_at: now, started_at: now,
      performed_on: sessionTodayDateString(),
      location_id: recentLocationId || null,
      title: title,
    }).select().single();
    if (res.error) throw res.error;

    // Build the exercises map. Resolve each template name to its library
    // row so subsequent set-done taps write to the correct exercise_id.
    // If resolution fails (template exercise not in user's library), skip
    // the exercise with a console warning — user can re-add via picker.
    var exercisesMap = {};
    var exArr = Array.isArray(day.exercises) ? day.exercises : [];
    var skipped = 0;
    for (var i = 0, ei = 0; i < exArr.length; i++) {
      var ex = exArr[i];
      if (!ex || !ex.name) continue;
      var libRow = resolveLibraryRow(ex.name);
      if (!libRow) {
        console.warn('createAdHocFromTemplate: no library match for', ex.name);
        skipped++;
        continue;
      }
      var sets = [];
      var setsArr = Array.isArray(ex.sets) ? ex.sets : [];
      for (var j = 0; j < setsArr.length; j++) {
        var s = setsArr[j] || {};
        sets.push({
          weight: s.weight != null ? Number(s.weight) : null,
          reps: s.reps_target != null ? Number(s.reps_target) : null,
          done: false,
          isExtra: true,  // marks ad-hoc sets so delete affordance renders
        });
      }
      if (!sets.length) sets.push({ isExtra: true });
      exercisesMap['ex_' + ei] = {
        rpe: null,
        note: ex.note || '',
        sub: '',
        sets: sets,
        isExtra: false,  // per-card isExtra drives plan-day "added" badge; ignored for ad-hoc
        exerciseId: libRow.id,
        exerciseMeta: libRow,
      };
      exerciseIdCache[libRow.name] = libRow.id;
      ei++;
    }

    var adState = {
      workoutId: res.data.id, planId: null, dayIndex: null,
      startedAt: now, endedAt: null,
      title: title, isAdHoc: true,
      notes: '', notesExpanded: false,
      locationId: res.data.location_id || null,
      exercises: exercisesMap,
    };
    todayAdHocs.push(adState);
    focusTab('ah_' + res.data.id);
    buildTabs();
    buildDay(currentDay);
    if (skipped > 0) {
      showToast('Loaded template. ' + skipped + ' exercise' + (skipped === 1 ? '' : 's') +
                ' skipped (not in your library)', null);
    }
    refreshCoachForNewSession();
  } catch(err) {
    console.error('createAdHocFromTemplate error:', err);
    showToast("Couldn't start template session: " + (err.message || 'unknown error'), null);
  }
}

// ---- Coach Chat: context builders ----
// coachContext is the semi-static context sent with every coach chat message.
// Built on session start / complete / plan import / chat-open-with-empty.
// Lives in memory for the session — not persisted across reloads (intentional:
// cheap to rebuild from Supabase, and a stale context would hurt coaching).
var coachContext = '';

// Target: keep total under ~1500 tokens. These caps enforce the budget even
// on users with big libraries or long histories.
var COACH_CONTEXT_MAX_EXERCISES_RECENT = 18;
// Number of COMPLETE prior calendar weeks (Sun-Sat) the coach sees for
// per-exercise recent performance + session notes. The current in-progress
// week is always included additionally via the weekSummary + live-context
// layers, regardless of this constant. So effective coverage is
// COACH_CONTEXT_RECENT_WEEKS full prior weeks + current partial week.
var COACH_CONTEXT_RECENT_WEEKS = 2;
var COACH_CONTEXT_MAX_NOTES = 6;
// Multi-week per-muscle volume trend window (v3.6.7). Independent from the
// recent-performance window — that one wants per-exercise depth (2 weeks
// is enough to see "last time you did X"); this one wants enough weeks to
// expose a trend (4 = one month — drift, ramp, deload all show up).
// Reuses the same Schoenfeld counting the History dashboard shows so the
// numbers in the prompt match what the user sees in Body / Volume Trends.
var COACH_CONTEXT_VOLUME_WEEKS = 4;
// Cap muscles to the top-N by total volume across the window so the block
// stays bounded for high-variety lifters. fetchVolumeTrends already sorts
// muscles by total desc, so taking the head is the right pick.
var COACH_CONTEXT_VOLUME_MUSCLES_MAX = 12;

async function buildCoachContext() {
  if (!userId) { coachContext = ''; return; }

  var nowStr = sessionTodayDateString();
  var weekStart = weekStartForLocalDate(new Date(nowStr + 'T00:00:00'));
  var weekEnd = addDaysToDateString(weekStart, 6);
  // Sunday-anchored: cutoff is N complete weeks before the current week's
  // Sunday. Current week's workouts still flow in via fetchWeekSummary +
  // getLiveContext, so effective window = N full prior weeks + current partial.
  // N is the user-configurable coaching_profile.coach_context_weeks (1-12,
  // v3.5.2) when present, falling back to the COACH_CONTEXT_RECENT_WEEKS
  // default. Same value is sent through to swap on the server side.
  var weeksBack = COACH_CONTEXT_RECENT_WEEKS;
  if (coachingProfile && Number.isFinite(coachingProfile.coach_context_weeks)) {
    weeksBack = Math.max(1, Math.min(12, coachingProfile.coach_context_weeks));
  }
  var recentCutoff = addDaysToDateString(weekStart, -weeksBack * 7);

  try {
    // Four parallel fetches. Plan comes from in-memory (hydrate loads it);
    // no DB round-trip needed for Layer 1 of semi-static context.
    // Volume trend uses COACH_CONTEXT_VOLUME_WEEKS (which already includes
    // the current partial week as its latest entry) — independent from the
    // recent-perf window which wants per-exercise depth not trend shape.
    var results = await Promise.all([
      fetchWeekSummary(userId, weekStart, weekEnd).catch(function(e) {
        console.warn('buildCoachContext week summary failed:', e); return null;
      }),
      _fetchRecentExercisePerformance(userId, recentCutoff).catch(function(e) {
        console.warn('buildCoachContext recent perf failed:', e); return [];
      }),
      _fetchRecentSessionNotes(userId, recentCutoff).catch(function(e) {
        console.warn('buildCoachContext notes failed:', e); return [];
      }),
      fetchVolumeTrends(userId, COACH_CONTEXT_VOLUME_WEEKS).catch(function(e) {
        console.warn('buildCoachContext volume trend failed:', e); return null;
      }),
    ]);
    var weekSummary = results[0];
    var recentPerf = results[1];
    var recentNotes = results[2];
    var volumeTrend = results[3];

    var parts = [];
    var planBlock = _formatPlanForCoach(plan);
    if (planBlock) parts.push(planBlock);
    var weekBlock = _formatWeekStatusForCoach(weekSummary);
    if (weekBlock) parts.push(weekBlock);
    var volumeBlock = _formatVolumeTrendForCoach(volumeTrend);
    if (volumeBlock) parts.push(volumeBlock);
    var perfBlock = _formatRecentPerfForCoach(recentPerf);
    if (perfBlock) parts.push(perfBlock);
    var notesBlock = _formatRecentNotesForCoach(recentNotes);
    if (notesBlock) parts.push(notesBlock);

    coachContext = parts.filter(Boolean).join('\n\n');
  } catch(err) {
    console.error('buildCoachContext error:', err);
    coachContext = '';
  }
}

function _formatPlanForCoach(planBlob) {
  if (!planBlob || !Array.isArray(planBlob.days) || !planBlob.days.length) return '';
  var out = 'CURRENT PLAN: ' + (planBlob.title || 'Untitled');
  var weekLabel = planWeekLabel(planBlob) || planBlob.week;
  if (weekLabel) out += ' — ' + weekLabel;
  out += '\n';
  for (var i = 0; i < planBlob.days.length; i++) {
    var d = planBlob.days[i];
    if (!d) continue;
    var exs = Array.isArray(d.exercises) ? d.exercises : [];
    // Skip empty days (active-recovery stubs from older plan blobs). They
    // inflate the day count and add noise for the coach without any data.
    if (!exs.length) continue;
    // Compact format: "Day 1 — Back Width: Pull-ups 3×12, ⟷ Cable Row 3×12 @120 / Lateral Raise 3×12 @20 (60s rest), Tricep Pushdown 3×10"
    function _coachFmtRegular(ex) {
      if (!ex || !ex.name) return '';
      var sets = Array.isArray(ex.sets) ? ex.sets : [];
      var count = sets.length;
      var first = sets[0] || {};
      var repsTarget = first.reps_target || first.reps_range || '?';
      var weight = first.weight != null ? first.weight : '';
      var weightStr = weight !== '' ? ' @' + weight : '';
      return ex.name + ' ' + count + '×' + repsTarget + weightStr;
    }
    var exStrs = exs.map(function(ex) {
      if (ex && ex.superset === true && Array.isArray(ex.exercises)) {
        var memberStrs = ex.exercises.map(_coachFmtRegular).filter(Boolean);
        if (!memberStrs.length) return '';
        var rest = Number.isInteger(ex.rest) ? ex.rest : 60;
        return '⟷ ' + memberStrs.join(' / ') + ' (' + rest + 's rest)';
      }
      return _coachFmtRegular(ex);
    }).filter(Boolean);
    // Plan day names already start with "Day N — ..." in most cases (Claude
    // emits them that way). Avoid double-prefixing — use the name as-is if
    // it already starts with "Day", else prepend.
    var rawName = d.name || '';
    var dayLabel = /^day\s+\d/i.test(rawName) ? rawName : ('Day ' + (i + 1) + ' — ' + rawName);
    out += '  ' + dayLabel + ': ' + exStrs.join(', ') + '\n';
  }
  return out.trim();
}

function _formatWeekStatusForCoach(weekSummary) {
  if (!weekSummary) return '';
  // Prefer a count computed from the in-memory plan that excludes empty /
  // active-recovery days — matches what the coach sees in _formatPlanForCoach.
  // Falls back to weekSummary.daysPlanned if plan isn't in memory.
  var trainablePlanned = null;
  if (plan && Array.isArray(plan.days)) {
    trainablePlanned = 0;
    for (var pi = 0; pi < plan.days.length; pi++) {
      var pd = plan.days[pi];
      if (pd && Array.isArray(pd.exercises) && pd.exercises.length) trainablePlanned++;
    }
  }
  var total = trainablePlanned != null
    ? trainablePlanned
    : (weekSummary.daysPlanned != null ? weekSummary.daysPlanned : '?');
  var done = weekSummary.daysTrained || 0;
  var out = 'THIS WEEK: ' + done + '/' + total + ' days trained';
  var workouts = Array.isArray(weekSummary.workouts) ? weekSummary.workouts : [];
  if (workouts.length) {
    var labels = workouts.map(function(w) {
      // fetchWeekSummary returns `date` (YYYY-MM-DD), not performedOn. Slice
      // to "MM-DD" for terse in-prompt dates. `dayName` is pre-formatted and
      // already carries the "Day N — " prefix when applicable.
      var perf = w.date ? String(w.date).slice(5) : '';
      var label = w.dayName || 'workout';
      return label + (perf ? ' (' + perf + ')' : '');
    });
    out += ' — ' + labels.join(', ');
  }
  return out;
}

// Query sets done in the last N days; roll up per exercise into a compact
// one-line summary per exercise for the coach prompt.
async function _fetchRecentExercisePerformance(uid, cutoffYmd) {
  // Two-step: fetch workouts in window (their sets joined), then client-side rollup.
  var res = await sb.from('workouts')
    .select('performed_on, plan_id, sets(weight, reps, rpe, done, exercise_order, set_order, exercises!exercise_id(name, weight_mode))')
    .eq('user_id', uid)
    .gte('performed_on', cutoffYmd)
    .order('performed_on', { ascending: false });
  if (res.error) throw res.error;
  return res.data || [];
}

function _formatRecentPerfForCoach(workouts) {
  if (!Array.isArray(workouts) || !workouts.length) return '';
  // For each exercise name: collect the most recent <=3 workouts where the user
  // did that exercise, format as "Exercise: W×R/R/R (Apr 14), 60×10/10/10 (Apr 8)".
  var perExercise = {};  // name → array of per-workout summary strings (most recent first)
  for (var i = 0; i < workouts.length; i++) {
    var w = workouts[i];
    var dateShort = w.performed_on ? w.performed_on.slice(5) : '';
    var byOrder = {};
    var sets = Array.isArray(w.sets) ? w.sets : [];
    for (var j = 0; j < sets.length; j++) {
      var s = sets[j];
      if (!s || !s.done) continue;
      var ex = s.exercises;
      if (!ex || !ex.name) continue;
      var key = ex.name;
      if (!byOrder[key]) byOrder[key] = { name: ex.name, sets: [] };
      byOrder[key].sets.push({ w: s.weight, r: s.reps, rpe: s.rpe, order: s.set_order });
    }
    var keys = Object.keys(byOrder);
    for (var k = 0; k < keys.length; k++) {
      var entry = byOrder[keys[k]];
      entry.sets.sort(function(a, b) { return a.order - b.order; });
      var setStrs = entry.sets.map(function(st) {
        var wtStr = st.w != null ? String(st.w) : '?';
        var rStr = st.r != null ? String(st.r) : '?';
        return wtStr + '×' + rStr;
      });
      var rpes = entry.sets.map(function(st) { return st.rpe; }).filter(function(v) { return v != null; });
      var rpeTag = '';
      if (rpes.length) {
        var avg = Math.round(rpes.reduce(function(a, b) { return a + b; }, 0) / rpes.length * 10) / 10;
        rpeTag = ' RPE ' + avg;
      }
      var line = setStrs.join('/') + rpeTag + ' (' + dateShort + ')';
      if (!perExercise[entry.name]) perExercise[entry.name] = [];
      if (perExercise[entry.name].length < 3) perExercise[entry.name].push(line);
    }
  }
  var names = Object.keys(perExercise);
  if (!names.length) return '';
  // Rank by most-recently-trained — entries with later first workout sort first.
  // Cheap proxy: rely on workouts iteration order (already desc by performed_on).
  names = names.slice(0, COACH_CONTEXT_MAX_EXERCISES_RECENT);
  var out = 'RECENT PERFORMANCE (last ' + COACH_CONTEXT_RECENT_WEEKS + 'w + this week):';
  for (var n = 0; n < names.length; n++) {
    out += '\n  ' + names[n] + ': ' + perExercise[names[n]].join(', ');
  }
  return out;
}

async function _fetchRecentSessionNotes(uid, cutoffYmd) {
  var res = await sb.from('workouts')
    .select('performed_on, notes')
    .eq('user_id', uid)
    .gte('performed_on', cutoffYmd)
    .not('notes', 'is', null)
    .order('performed_on', { ascending: false })
    .limit(COACH_CONTEXT_MAX_NOTES);
  if (res.error) throw res.error;
  return (res.data || []).filter(function(r) { return r.notes && String(r.notes).trim(); });
}

function _formatRecentNotesForCoach(notes) {
  if (!Array.isArray(notes) || !notes.length) return '';
  var out = 'RECENT SESSION NOTES:';
  for (var i = 0; i < notes.length; i++) {
    var n = notes[i];
    var dateShort = n.performed_on ? n.performed_on.slice(5) : '';
    var body = String(n.notes || '').trim().replace(/\s+/g, ' ').slice(0, 140);
    out += '\n  "' + body + '" (' + dateShort + ')';
  }
  return out;
}

// Multi-week per-muscle set volume — gives the coach a trend read that
// matches the Body / Volume Trends dashboard (same Schoenfeld counting:
// primary 1.0 + each secondary 0.5; cardio + mobility excluded).
// Layout: header row of week labels (M/D), then one line per muscle
// with a comma-separated count series and the window average. Capped
// at COACH_CONTEXT_VOLUME_MUSCLES_MAX top muscles by total volume so
// high-variety lifters don't blow the token budget.
function _formatVolumeTrendForCoach(trend) {
  if (!trend || !Array.isArray(trend.muscles) || !trend.muscles.length) return '';
  var weekLabels = (trend.weeks || []).map(function(w) { return w.label; });
  if (!weekLabels.length) return '';
  var muscles = trend.muscles.slice(0, COACH_CONTEXT_VOLUME_MUSCLES_MAX);
  var fmt = function(v) {
    var r = Math.round(v * 10) / 10;
    return r === Math.floor(r) ? String(r) : r.toFixed(1);
  };
  var out = 'WEEKLY VOLUME TREND (sets/wk per muscle, Schoenfeld primary 1.0 + secondary 0.5; oldest → newest)';
  out += '\n  weeks: ' + weekLabels.join(', ');
  for (var i = 0; i < muscles.length; i++) {
    var m = muscles[i];
    var arr = trend.byMuscle[m] || [];
    var series = arr.map(fmt).join(', ');
    var avg = trend.averages && trend.averages[m] != null ? trend.averages[m] : 0;
    out += '\n  ' + m + ': ' + series + ' (avg ' + fmt(avg) + ')';
  }
  return out;
}

// Lifecycle hook: rebuild coachContext and clear chat history. Called from
// session start / complete, ad-hoc start (incl. template-based), and plan
// save (import + AI-accept). Sign-out path calls resetCoachForSignOut instead.
// Non-blocking — kicks off buildCoachContext without awaiting so the calling
// flow (start session etc.) doesn't wait on the context fetch.
function refreshCoachForNewSession() {
  if (typeof clearChatHistory === 'function') clearChatHistory();
  if (typeof buildCoachContext === 'function') {
    buildCoachContext().catch(function(err) {
      console.error('coach context rebuild failed:', err);
    });
  }
}

// Sign-out: dump context + chat. Avoids leaking the prior user's context
// to a subsequent signed-in user in the same tab.
function resetCoachForSignOut() {
  coachContext = '';
  if (typeof clearChatHistory === 'function') clearChatHistory();
}

// Read-only snapshot of the current session for the coach. Runs on every
// chat-message send — must be synchronous, no queries.
function getLiveContext() {
  // No session state at all: short fallback per spec.
  var st = todayState;
  if (!st || !st.workoutId) {
    var planTitle = plan ? (plan.title || 'Untitled') : null;
    var weekLabel = plan ? (planWeekLabel(plan) || plan.week || '') : '';
    if (planTitle) {
      return 'NO ACTIVE SESSION. Current plan: ' + planTitle + (weekLabel ? ' — ' + weekLabel : '') + '.';
    }
    return 'NO ACTIVE SESSION. No active plan.';
  }

  var lines = [];
  // Header: day name + elapsed + location.
  var dayName;
  if (st.isAdHoc) {
    dayName = st.title || 'Ad-hoc session';
  } else if (plan && plan.days && typeof st.dayIndex === 'number' && plan.days[st.dayIndex]) {
    dayName = plan.days[st.dayIndex].name || ('Day ' + (st.dayIndex + 1));
  } else {
    dayName = 'Day ' + ((st.dayIndex || 0) + 1);
  }
  lines.push('CURRENT SESSION: ' + dayName);

  var metaBits = [];
  if (st.startedAt) {
    var elapsedMin = Math.max(0, Math.round(sessionElapsedMs(st) / 60000));
    metaBits.push('Started ' + elapsedMin + ' min ago');
  }
  if (st.locationId && locationById && locationById[st.locationId]) {
    metaBits.push('Location: ' + locationById[st.locationId].name);
  }
  if (metaBits.length) lines.push(metaBits.join(' · '));

  // Prescribed exercises (if plan-day). Each line includes the plan
  // prescription inline so the coach can compare actuals against target
  // without cross-referencing the separate plan block in coachContext.
  // For superset days: walks the nested plan structure with a flat-ei
  // counter so block members resolve to the right state entry, and tags
  // member lines with (superset) so the coach knows the grouping.
  var planDay = (!st.isAdHoc && plan && plan.days && plan.days[st.dayIndex]) ? plan.days[st.dayIndex] : null;
  var currentMarked = false;
  if (planDay && Array.isArray(planDay.exercises)) {
    lines.push('');

    function _liveLineForExercise(ex, flatEi, supersetTag) {
      var exState = (st.exercises && st.exercises['ex_' + flatEi]) || { sets: [] };
      var planSets = Array.isArray(ex.sets) ? ex.sets : [];
      var totalSets = planSets.length;
      var firstSet = planSets[0] || {};
      var prescWt = firstSet.weight != null ? firstSet.weight : '';
      var prescReps = firstSet.reps_target || firstSet.reps_range || '?';
      var prescStr = totalSets + '×' + prescReps + (prescWt !== '' ? ' @' + prescWt : '');

      var doneCount = 0;
      var logged = [];
      for (var si = 0; si < totalSets; si++) {
        var sl = (exState.sets && exState.sets[si]) || {};
        if (sl.done) {
          doneCount++;
          var wt = sl.weight != null ? sl.weight : '?';
          var r = sl.reps != null ? sl.reps : '?';
          logged.push(wt + '×' + r);
        }
      }
      var displayName = ex.name;
      if (exState.subExercise && exState.subExercise.name) {
        displayName = ex.name + ' → ' + exState.subExercise.name;
      } else if (exState.sub) {
        displayName = ex.name + ' → ' + exState.sub + ' (legacy)';
      }
      var line = '  ' + displayName + (supersetTag ? ' (superset)' : '') +
                 ' [plan: ' + prescStr + ']: ' +
                 (logged.length ? logged.join(', ') + ' — ' : '') +
                 doneCount + '/' + totalSets + ' done';
      if (exState.rpe != null) line += ' — RPE ' + exState.rpe;
      if (!currentMarked && doneCount < totalSets) {
        line += ' ← CURRENT';
        currentMarked = true;
      }
      if (exState.note) line += ' — note: "' + String(exState.note).slice(0, 80) + '"';
      return line;
    }

    var liveFlatEi = 0;
    for (var i = 0; i < planDay.exercises.length; i++) {
      var entry = planDay.exercises[i];
      if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
        for (var ci = 0; ci < entry.exercises.length; ci++) {
          lines.push(_liveLineForExercise(entry.exercises[ci], liveFlatEi, true));
          liveFlatEi++;
        }
      } else {
        lines.push(_liveLineForExercise(entry, liveFlatEi, false));
        liveFlatEi++;
      }
    }
  }

  // Added / ad-hoc exercises (extras).
  if (st.exercises) {
    var extraKeys = Object.keys(st.exercises).filter(function(k) {
      var ei = parseInt(k.slice(3), 10);
      // On plan days: extras are keys past planDay.exercises.length. On ad-hoc: all are extras.
      if (st.isAdHoc) return true;
      return planDay ? ei >= planDay.exercises.length : true;
    });
    extraKeys.sort(function(a, b) { return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10); });
    if (extraKeys.length) {
      if (planDay) lines.push('');  // visual separator
      for (var xi = 0; xi < extraKeys.length; xi++) {
        var xek = extraKeys[xi];
        var xState = st.exercises[xek] || { sets: [] };
        var xMeta = xState.exerciseMeta || {};
        var xName = xMeta.name || 'Exercise';
        var xSets = Array.isArray(xState.sets) ? xState.sets : [];
        var xDone = 0, xLogged = [];
        for (var xsi = 0; xsi < xSets.length; xsi++) {
          var xsl = xSets[xsi] || {};
          if (xsl.done) {
            xDone++;
            var xw = xsl.weight != null ? xsl.weight : '?';
            var xr = xsl.reps != null ? xsl.reps : '?';
            xLogged.push(xw + '×' + xr);
          }
        }
        var xLine = '  [Ad-hoc] ' + xName + ': ' + (xLogged.length ? xLogged.join(', ') + ' — ' : '') +
                    xDone + '/' + xSets.length + ' sets done';
        if (xState.rpe != null) xLine += ' — RPE ' + xState.rpe;
        if (!currentMarked && xDone < xSets.length) {
          xLine += ' ← CURRENT';
          currentMarked = true;
        }
        lines.push(xLine);
      }
    }
  }

  // Session-level notes (if user has typed any).
  if (st.notes && String(st.notes).trim()) {
    lines.push('');
    lines.push('Session note: "' + String(st.notes).trim().slice(0, 200) + '"');
  }

  return lines.join('\n');
}

// ---- Exercise form notes (v3.5.8) ----
// One row per (user_id, exercise_id) in exercise_form_notes. Stores BOTH
// the user's own free-text notes (user_note) and an AI-generated form-
// coaching summary (ai_note + ai_generated_at). Modal renders whichever
// of the two is present; either or both can be empty.

async function loadFormNotes(exerciseId) {
  if (!userId || !exerciseId) return null;
  try {
    var res = await sb.from('exercise_form_notes')
      .select('user_note, ai_note, ai_generated_at')
      .eq('user_id', userId)
      .eq('exercise_id', exerciseId)
      .maybeSingle();
    if (res.error) {
      console.warn('loadFormNotes error:', res.error.message);
      return null;
    }
    return res.data || null;
  } catch (err) {
    console.warn('loadFormNotes exception:', err);
    return null;
  }
}

// Batch loader — one query for many exercise_ids (v3.6.10). Powers the
// inline form-notes pills on every live exercise card without N round-
// trips. Returns a map { exercise_id: { user_note, ai_note,
// ai_generated_at } } — missing ids simply don't appear in the map.
async function loadFormNotesBatch(exerciseIds) {
  if (!userId || !Array.isArray(exerciseIds) || !exerciseIds.length) return {};
  var seen = {};
  var unique = [];
  for (var i = 0; i < exerciseIds.length; i++) {
    var id = exerciseIds[i];
    if (id && !seen[id]) { seen[id] = true; unique.push(id); }
  }
  if (!unique.length) return {};
  try {
    var res = await sb.from('exercise_form_notes')
      .select('exercise_id, user_note, ai_note, ai_generated_at')
      .eq('user_id', userId)
      .in('exercise_id', unique);
    if (res.error) {
      console.warn('loadFormNotesBatch error:', res.error.message);
      return {};
    }
    var map = {};
    var rows = res.data || [];
    for (var ri = 0; ri < rows.length; ri++) {
      map[rows[ri].exercise_id] = {
        user_note: rows[ri].user_note,
        ai_note: rows[ri].ai_note,
        ai_generated_at: rows[ri].ai_generated_at,
      };
    }
    return map;
  } catch (err) {
    console.warn('loadFormNotesBatch exception:', err);
    return {};
  }
}

// Upsert path: insert if (user_id, exercise_id) row doesn't exist, else
// update the user_note column only. Touches updated_at on either path.
// Empty string is preserved (user explicitly cleared their note);
// callers pass null only when they want to keep the existing value.
async function saveUserFormNote(exerciseId, text) {
  if (!userId || !exerciseId) throw new Error('Not signed in');
  var payload = {
    user_id: userId,
    exercise_id: exerciseId,
    user_note: (text == null) ? null : String(text),
    updated_at: new Date().toISOString(),
  };
  var res = await sb.from('exercise_form_notes')
    .upsert(payload, { onConflict: 'user_id,exercise_id' });
  if (res.error) throw new Error(res.error.message);
}

async function saveAiFormNote(exerciseId, text) {
  if (!userId || !exerciseId) throw new Error('Not signed in');
  var payload = {
    user_id: userId,
    exercise_id: exerciseId,
    ai_note: (text == null) ? null : String(text),
    ai_generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  var res = await sb.from('exercise_form_notes')
    .upsert(payload, { onConflict: 'user_id,exercise_id' });
  if (res.error) throw new Error(res.error.message);
}

// Fire a focused biomechanics-only call asking for 3-4 sentences of
// form cues on this specific exercise. Uses /api/coach-chat with
// mode: 'form_only' (v3.6.11) — that swaps in FORM_ONLY_SYSTEM_PROMPT
// and skips the profile/history/templates splicing, so the response is
// pure mechanics independent of the client's current plan. Output is
// saved per-(user, exercise) in exercise_form_notes.ai_note and re-
// read across many future sessions, so it has to be plan-independent.
//
// userNote (v3.6.12, optional): the client's own free-text notes for
// this exercise (exercise_form_notes.user_note). When present, the
// system prompt instructs Claude to weave form-relevant content from
// the notes into the description — cues, equipment quirks, mobility
// limitations. Non-form content (weight numbers, set/rep goals) is
// explicitly ignored per the system prompt's CLIENT NOTES rule.
async function generateAiFormNote(exerciseRow, userNote) {
  if (!userId) throw new Error('Not signed in');
  if (!exerciseRow || !exerciseRow.name) throw new Error('Exercise not found');
  var sessionRes = await sb.auth.getSession();
  var token = sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
  if (!token) throw new Error('Not signed in');
  // Compact data-only prompt — the system prompt does the heavy lifting.
  // Avoids re-stating output rules in every user message (which would
  // miss the prompt cache and add tokens with no benefit).
  var prompt = 'Exercise: ' + exerciseRow.name +
    '\nEquipment: ' + (exerciseRow.equipment || 'unknown') +
    '\nPrimary muscle: ' + (exerciseRow.muscle_group || 'unspecified') +
    '\nWeight mode: ' + (exerciseRow.weight_mode || 'total');
  var trimmedNote = userNote ? String(userNote).trim() : '';
  if (trimmedNote) {
    prompt += '\n\nCLIENT NOTES:\n' + trimmedNote;
  }
  prompt += '\n\nDescribe the form for this exercise per your rules.';
  var res = await fetch('/api/coach-chat', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelForCoach(),
      mode: 'form_only',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    var errBody = await res.json().catch(function() { return null; });
    throw new Error((errBody && errBody.error) || ('HTTP ' + res.status));
  }
  var body = await res.json();
  if (!body || !body.reply) throw new Error('Empty reply');
  return String(body.reply).trim();
}

// Expand `"repeat": N` shorthand into N identical set objects, in place.
// Mirrors api/generate-plan.js's expandSetRepeats so JSON pasted by a
// Claude project (or hand-authored) renders the right set count instead
// of collapsing to one. Recurses into superset blocks. Clamps N to
// [1, 10] as a defense against bogus values. Called from both import
// paths before save so the stored plan blob is already canonical.
function expandSetRepeatsInPlan(planBlob) {
  if (!planBlob || !Array.isArray(planBlob.days)) return planBlob;
  function expandOne(ex) {
    if (!ex || !Array.isArray(ex.sets)) return;
    var out = [];
    for (var i = 0; i < ex.sets.length; i++) {
      var s = ex.sets[i] || {};
      var raw = typeof s.repeat === 'number' ? s.repeat : parseInt(s.repeat, 10);
      var n = Math.min(10, Math.max(1, Number.isFinite(raw) ? raw : 1));
      var clean = Object.assign({}, s);
      delete clean.repeat;
      for (var k = 0; k < n; k++) out.push(Object.assign({}, clean));
    }
    ex.sets = out;
  }
  for (var di = 0; di < planBlob.days.length; di++) {
    var day = planBlob.days[di];
    if (!day || !Array.isArray(day.exercises)) continue;
    for (var ei = 0; ei < day.exercises.length; ei++) {
      var entry = day.exercises[ei];
      if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
        for (var mi = 0; mi < entry.exercises.length; mi++) expandOne(entry.exercises[mi]);
      } else {
        expandOne(entry);
      }
    }
  }
  return planBlob;
}

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
      await savePlanAsActive(newPlan);
      document.getElementById('importModal').classList.remove('show');
    } catch(err) {
      console.error(err);
      showToast('Import error: ' + err.message, null);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// Import a plan JSON as a saved template (v3.5.7). Mirrors handleImport
// but writes via saveAsTemplate (is_template=true, is_active=false).
// Accepts three input shapes for flexibility:
//   1. Bare plan blob:                { title, days: [...] }
//   2. Plan-import wrapper:           { plan: { title, days: [...] } }
//   3. Full template-row export:      { template_name, data: { days: [...] }, ... }
// Prompts for the template name with a sensible default (template_name
// from the row export → blob.title → "Imported Template"), so a manually-
// edited JSON without a name still imports cleanly.
function handleImportTemplate(event) {
  var file = event.target.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = async function(e) {
    try {
      var raw = JSON.parse(e.target.result);
      var blob;
      var nameHint = null;
      if (raw && raw.template_name && raw.data && Array.isArray(raw.data.days)) {
        blob = raw.data;
        nameHint = raw.template_name;
      } else if (raw && raw.plan && Array.isArray(raw.plan.days)) {
        blob = raw.plan;
      } else if (raw && Array.isArray(raw.days)) {
        blob = raw;
      } else {
        showToast('Invalid template file format', null);
        return;
      }
      var nameDefault = nameHint || blob.title || 'Imported Template';
      var name = prompt('Template name:', nameDefault);
      if (name == null) return;  // user cancelled
      name = String(name).trim();
      if (!name) { showToast('Template name required', null); return; }
      await saveAsTemplate(name, blob);
      document.getElementById('importTemplateModal').classList.remove('show');
      showToast('Template imported: ' + name, null);
    } catch(err) {
      console.error('handleImportTemplate error:', err);
      showToast('Import error: ' + (err.message || 'unknown'), null);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}
