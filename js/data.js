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
  // PostgREST FK disambiguation: sets now has TWO FKs to exercises
  // (exercise_id = actual, prescribed_exercise_id = plan's ask, added in
  // v2.2.1). "exercises!exercise_id" tells the planner to join via the
  // exercise_id FK — what was actually performed. Without this hint, the
  // query fails with PGRST201 ambiguous relationship.
  var wRes = await sb.from('workouts')
    .select('*, sets(*, exercises!exercise_id(name, equipment, muscle_group, weight_mode))')
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
  // Auto-start rest timer on set-done (v2.4.14): fires for every set
  // regardless of whether the exercise is prescribed, extras, ad-hoc,
  // or template-imported. Prescribed sets use plan's per-exercise rest;
  // everything else falls back to 90s. User can disable in hamburger →
  // "Auto rest timer".
  if (sl.done && getRestTimerAuto()) {
    var prescribedRest =
      (plan && plan.days && plan.days[di] && plan.days[di].exercises[ei])
        ? plan.days[di].exercises[ei].rest
        : null;
    startRestTimer(prescribedRest || 90);
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
    buildTabs();
    buildDay(currentDay);
    refreshCoachForNewSession();
  } catch(err) {
    console.error('createAdHocSession error:', err);
    showToast("Couldn't start ad-hoc session: " + err.message, null);
  }
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
  buildDay(currentDay);
  invalidateHistoryCache();
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

async function buildCoachContext() {
  if (!userId) { coachContext = ''; return; }

  var nowStr = sessionTodayDateString();
  var weekStart = weekStartForLocalDate(new Date(nowStr + 'T00:00:00'));
  var weekEnd = addDaysToDateString(weekStart, 6);
  // Sunday-anchored: cutoff is N complete weeks before the current week's
  // Sunday. Current week's workouts still flow in via fetchWeekSummary +
  // getLiveContext, so effective window = N full prior weeks + current partial.
  var recentCutoff = addDaysToDateString(weekStart, -COACH_CONTEXT_RECENT_WEEKS * 7);

  try {
    // Three parallel fetches. Plan comes from in-memory (hydrate loads it);
    // no DB round-trip needed for Layer 1 of semi-static context.
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
    ]);
    var weekSummary = results[0];
    var recentPerf = results[1];
    var recentNotes = results[2];

    var parts = [];
    var planBlock = _formatPlanForCoach(plan);
    if (planBlock) parts.push(planBlock);
    var weekBlock = _formatWeekStatusForCoach(weekSummary);
    if (weekBlock) parts.push(weekBlock);
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
    // Compact format: "Day 1 — Back Width: Pull-ups 3×12, Cable Row 3×12 @120"
    var exStrs = exs.map(function(ex) {
      if (!ex || !ex.name) return '';
      var sets = Array.isArray(ex.sets) ? ex.sets : [];
      var count = sets.length;
      // Use the first set's reps/weight as the representative prescription;
      // same-set exercises (the common case) get compact one-line form.
      var first = sets[0] || {};
      var repsTarget = first.reps_target || first.reps_range || '?';
      var weight = first.weight != null ? first.weight : '';
      var weightStr = weight !== '' ? ' @' + weight : '';
      return ex.name + ' ' + count + '×' + repsTarget + weightStr;
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
      if (!byOrder[key]) byOrder[key] = { name: ex.name, mode: ex.weight_mode || 'total', sets: [] };
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
  var planDay = (!st.isAdHoc && plan && plan.days && plan.days[st.dayIndex]) ? plan.days[st.dayIndex] : null;
  var currentMarked = false;
  if (planDay && Array.isArray(planDay.exercises)) {
    lines.push('');
    for (var i = 0; i < planDay.exercises.length; i++) {
      var ex = planDay.exercises[i];
      var exState = (st.exercises && st.exercises['ex_' + i]) || { sets: [] };
      var planSets = Array.isArray(ex.sets) ? ex.sets : [];
      var totalSets = planSets.length;
      // Compact prescription: "3×12 @120" (first set is representative since
      // same-weight sets are the common case). If sets vary, show the top
      // set's weight / target reps — the coach gets the magnitude.
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
      // Substitution: if the user swapped this exercise for something else,
      // show the label as "Prescribed → Substitute" so the coach knows what
      // was actually performed and doesn't confuse it with the plan exercise.
      var displayName = ex.name;
      if (exState.subExercise && exState.subExercise.name) {
        displayName = ex.name + ' → ' + exState.subExercise.name;
      } else if (exState.sub) {
        displayName = ex.name + ' → ' + exState.sub + ' (legacy)';
      }
      var line = '  ' + displayName + ' [plan: ' + prescStr + ']: ' +
                 (logged.length ? logged.join(', ') + ' — ' : '') +
                 doneCount + '/' + totalSets + ' done';
      if (exState.rpe != null) line += ' — RPE ' + exState.rpe;
      if (!currentMarked && doneCount < totalSets) {
        line += ' ← CURRENT';
        currentMarked = true;
      }
      if (exState.note) line += ' — note: "' + String(exState.note).slice(0, 80) + '"';
      lines.push(line);
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
