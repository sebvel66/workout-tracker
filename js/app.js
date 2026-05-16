// app.js — initialization, hydration, and the auth-state→hydrate wire-up.
//
// Loads last. By the time this file runs, resolver/data/ui/auth are all in
// place. APP_VERSION lives here because it's the bootstrap surface the user
// hits first (footer paint), and hydrate() is the glue that ties every module
// together once the user is signed in.

// Bump this on every deploy. Displayed at the bottom of the app so stale-
// cache issues can be diagnosed from the client ("which version am I on?").
var APP_VERSION = 'v3.6.25';

// Paint the version tag in the bottom-right as soon as APP_VERSION is declared.
// DOM is already parsed here (all the script tags sit at the end of <body>).
(function paintVersion() {
  var el = document.getElementById('versionFooter');
  if (el) el.textContent = APP_VERSION;
})();

// ---- Paint from hydration cache ----
// Runs synchronously before any network call. Reads the last-saved
// tracker state from localStorage and paints it so the user sees their
// last view instantly on warm boot. hydrate() then reconciles in the
// background and swaps in fresh data. Cold boot (no cache) falls through
// unchanged — #emptyState stays visible per HTML default until auth
// resolves. Full design: docs/superpowers/specs/2026-04-21-hydration-cache-design.md
var __hydratedFromCache = false;
function __removeRefreshingPill() {
  var pill = document.getElementById('refreshingPill');
  if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
  __hydratedFromCache = false;
}
(function paintFromCache() {
  var blob = readHydrationSnapshot();
  if (!blob) return;
  try {
    // Populate globals. hydrate() will overwrite these with fresh server
    // state when it runs; this is the optimistic first paint.
    activePlanId = blob.activePlanId;
    plan = blob.plan;
    planCache[activePlanId] = plan;
    currentDay = blob.currentDay;
    daysWithHistory = blob.daysWithHistory || {};
    sessionTodayStart = dayBounds(new Date()).start;
    // Today-state restore is gated on the cache having been saved on this
    // same local calendar day. Yesterday's snapshot can carry an empty (or
    // any) todayPlanStates entry that would shadow earlier-this-week
    // historical workouts on the day-tab view (viewModeFor short-circuits
    // to 'editable' whenever todayPlanStates[di] is truthy, and the day-
    // picker handler skips loadHistorical for the same reason). Dropping
    // stale today-state means cross-midnight warm-boots paint a brief
    // empty shell for ~1s until hydrate fills it from DB — but the
    // historical workout the user actually did this week reliably surfaces.
    var savedAtMs = blob.savedAt ? new Date(blob.savedAt).getTime() : 0;
    var todayMidnightMs = sessionTodayStart.getTime();
    if (savedAtMs >= todayMidnightMs) {
      todayPlanStates = blob.todayPlanStates || {};
      todayAdHocs = blob.todayAdHocs || [];
    } else {
      todayPlanStates = {};
      todayAdHocs = [];
    }

    // Paint.
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'flex';
    document.getElementById('planTitle').textContent = blob.planTitle || 'Workout Tracker';
    var weekEl = document.getElementById('planWeek');
    weekEl.textContent = blob.planWeek || '';
    var pill = document.createElement('span');
    pill.id = 'refreshingPill';
    pill.className = 'refreshing-pill';
    pill.textContent = 'Refreshing…';
    weekEl.appendChild(pill);

    buildTabs();
    buildDay(currentDay);

    __hydratedFromCache = true;
  } catch (err) {
    // Paint failed — wipe the bad cache, reset globals, let hydrate do
    // its normal cold-render. Don't mask the error; log it.
    console.error('paintFromCache failed:', err);
    clearHydrationSnapshot();
    activePlanId = null; plan = null;
    todayPlanStates = {}; todayAdHocs = []; daysWithHistory = {};
    __hydratedFromCache = false;
  }
})();

// ---- Hydration ----
async function hydrate() {
  try {
    // Snapshot the today-boundary once per hydrate. Subsequent in-session
    // reads go through sessionBounds() and see the same answer even if
    // the calendar rolls over mid-workout.
    sessionTodayStart = dayBounds(new Date()).start;
    var ures = await sb.auth.getUser();
    if (!ures.data || !ures.data.user) return;
    userId = ures.data.user.id;

    // If we painted from cache but the signed-in user doesn't match the
    // cached user (e.g. sign-out + sign-in as a different account), drop
    // the cache + pill and let the rest of hydrate render fresh.
    if (__hydratedFromCache) {
      var cachedBlob = readHydrationSnapshot();
      if (!cachedBlob || cachedBlob.userId !== userId) {
        clearHydrationSnapshot();
        __removeRefreshingPill();
      }
    }

    var planRes = await sb.from('plans').select('*')
      .eq('user_id', userId).eq('is_active', true).maybeSingle();
    if (planRes.error) { showToast('Failed to load plan', null); return; }
    if (!planRes.data) {
      plan = null; activePlanId = null;
      // If we painted from cache, the cached plan has been deleted on
      // another device. Clear cache + pill, then show empty state.
      if (__hydratedFromCache) {
        clearHydrationSnapshot();
        __removeRefreshingPill();
      }

      // No-plan hydrate Phase 1 — fire today's ad-hoc workouts + the
      // exercise library + locations in parallel. The library is needed
      // by stateFromWorkout (resolves exerciseMeta names) and the picker;
      // locations supplies gym-tag rendering. Plan-anchored queries
      // (daysWithHistory, suggestedDayIndex) are skipped — irrelevant
      // when there's no plan.
      var bounds = sessionBounds();
      var pAdHocs = sb.from('workouts').select('*, sets(*)')
        .eq('user_id', userId)
        .is('plan_id', null)
        .gte('performed_at', bounds.start.toISOString())
        .lt('performed_at', bounds.end.toISOString())
        .order('performed_at', { ascending: true });
      var pLib = loadExerciseLibrary();
      var pLoc = loadLocations();
      var wRes;
      try {
        var phase1 = await Promise.all([pAdHocs, pLib, pLoc]);
        wRes = phase1[0];
      } catch (err) {
        console.error('no-plan hydrate phase 1 error:', err);
        wRes = { error: err };
      }

      // Reconcile today's ad-hocs from DB. paintFromCache may have
      // populated todayAdHocs from the snapshot; clear before pushing
      // fresh rows to avoid duplicates (same pattern as plan hydrate).
      todayAdHocs = [];
      todayPlanStates = {};
      if (wRes && !wRes.error) {
        var rows = wRes.data || [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var adState = stateFromWorkout(row);
          adState.title = row.title || null;
          adState.isAdHoc = true;
          todayAdHocs.push(adState);
        }
      }

      // Focus hierarchy: in-progress ad-hoc wins; else first ad-hoc of
      // any state (so a completed ad-hoc today is still visible — user
      // can view what they did, log more sets, or open the start screen
      // to add another session). If neither, fall through to the empty
      // state. Mirrors the plan-hydrate focus pattern but scoped to
      // ad-hocs since plan days don't exist here.
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

      document.getElementById('planTitle').textContent = 'No active plan';
      document.getElementById('planWeek').textContent = '';

      if (focusedAdHocKey) {
        document.getElementById('emptyState').style.display = 'none';
        document.getElementById('summaryBar').style.display = 'flex';
        currentDay = focusedAdHocKey;
        focusTab(currentDay);
        buildTabs();
        buildDay(currentDay);
        // Auto-open the start-screen overlay so the no-plan options
        // (Generate / Use a template / Blank session) are surfaced
        // while the user is in their ad-hoc. Close button is always
        // visible in the no-plan branch (per v3 fix), so this is a
        // gentle prompt, not a forced wall.
        if (typeof openStartScreen === 'function') openStartScreen();
      } else {
        document.getElementById('emptyState').style.display = 'block';
        if (typeof renderEmptyState === 'function') renderEmptyState();
        document.getElementById('summaryBar').style.display = 'none';
        buildTabs();
      }
      __removeRefreshingPill();
      return;
    }
    activePlanId = planRes.data.id;
    plan = ensureStartDate(planRes.data.data, planRes.data);
    planCache[activePlanId] = plan;
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'flex';
    document.getElementById('planTitle').textContent = plan.title || 'Workout Tracker';
    document.getElementById('planWeek').textContent = planWeekLabel(plan) || plan.week || '';

    // Phase 1 (parallel) — fire ALL post-plan queries simultaneously.
    // Pre-v2.5.5 these awaited sequentially; aggregate latency was ~6×
    // the slowest query, dominated by serial round-trip costs. Now the
    // bound is just max(query times), typically ~300-500ms.
    //
    // Three queries are awaited inline because their results gate the
    // first render:
    //   - today's workouts: drives focus hierarchy + populates today-states
    //   - exercise library: needed by seedExerciseIdCache so set-done writes
    //     hit the cache instead of falling through to a per-name lookup
    //   - daysWithHistory: drives the completion dot in buildTabs
    //
    // Three queries fire in parallel but are NOT awaited for first paint
    // (Phase 2). They re-render their consumers when they complete:
    //   - locations: re-renders buildDay so the session-location dropdown
    //     fills in
    //   - suggestedDayIndex: gates openStartScreen, which we delay until
    //     this resolves so the modal's "Suggested" badge is correct
    //   - loadRecentExercises: only consumed by the picker on open;
    //     no re-render needed (the picker reads fresh state when opened)
    //
    // Errors inside loadX helpers are non-fatal: each shows a toast and
    // returns silently. So the awaits below never throw.
    var bounds = sessionBounds();
    var pWorkouts = sb.from('workouts').select('*, sets(*)')
      .eq('user_id', userId)
      .gte('performed_at', bounds.start.toISOString())
      .lt('performed_at', bounds.end.toISOString())
      .order('performed_at', { ascending: true });
    var pLibrary = loadExerciseLibrary();
    var pDaysWithHistory = loadDaysWithHistory();
    // Phase 2 (background, non-blocking).
    var pLocations = loadLocations();
    var pSuggestedDay = loadSuggestedDayIndex();

    // Await Phase 1 essentials. Promise.all collapses to max(query times)
    // since all three are already in flight.
    var wRes;
    try {
      var phase1 = await Promise.all([pWorkouts, pLibrary, pDaysWithHistory]);
      wRes = phase1[0];
    } catch (err) {
      console.error('Hydrate phase 1 error:', err);
      wRes = { error: err };
    }
    if (wRes.error) { showToast("Failed to load today's workouts", null); }
    else {
      // Reconcile: replace cached today-state with fresh DB state.
      // paintFromCache may have populated todayAdHocs / todayPlanStates
      // from the hydration snapshot; without clearing, the push loop
      // below duplicates each ad-hoc entry (push, not assign) and
      // leaves stale plan-day states for day_indexes not in today's
      // rows. A stale cache paired with a duplicated fresh entry
      // caused a 23505 on persistSet — findAdHoc returned the FIRST
      // (stale) match with missing setIds, so taps on already-logged
      // sets went INSERT instead of UPDATE and collided with the
      // existing done=true row under sets_unique_position_per_workout.
      todayAdHocs = [];
      todayPlanStates = {};
      var rows = wRes.data || [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.plan_id === null) {
          // Ad-hoc session.
          var adState = stateFromWorkout(row);
          adState.title = row.title || null;
          adState.isAdHoc = true;
          todayAdHocs.push(adState);
        } else if (row.plan_id === activePlanId) {
          // Plan-based workout matching the currently active plan.
          if (!planCache[row.plan_id]) {
            var pr = await sb.from('plans').select('data').eq('id', row.plan_id).maybeSingle();
            if (pr.data) planCache[row.plan_id] = pr.data.data;
          }
          var planState = stateFromWorkout(row);
          if (planState.dayIndex != null) {
            todayPlanStates[planState.dayIndex] = planState;
            seedExerciseIdCache(planState);
          }
        }
        // Else (row.plan_id !== activePlanId && row.plan_id !== null):
        // old-plan workout from a mid-day import — skipped per Feature 3 fix.
      }
    }

    // Focus hierarchy:
    //   1. An in-progress session (started_at set, ended_at null) wins.
    //   2. Else the lowest plan-day with any today-state.
    //   3. Else plan day 0.
    //   4. Else the first ad-hoc.
    //   5. Else day 0.
    // In-progress winning matters so a user who completed Day 2 today and
    // started Day 3 lands on Day 3 on reload, not the lowest-index Day 2.
    var inProgressKey = null;
    var planDayKeysAsc = Object.keys(todayPlanStates).map(Number).sort(function(a, b) { return a - b; });
    for (var pk = 0; pk < planDayKeysAsc.length; pk++) {
      var ps = todayPlanStates[planDayKeysAsc[pk]];
      if (ps && ps.workoutId && ps.startedAt && !ps.endedAt) {
        inProgressKey = planDayKeysAsc[pk];
        break;
      }
    }
    if (inProgressKey == null) {
      for (var ak = 0; ak < todayAdHocs.length; ak++) {
        var as = todayAdHocs[ak];
        if (as && as.workoutId && as.startedAt && !as.endedAt) {
          inProgressKey = 'ah_' + as.workoutId;
          break;
        }
      }
    }
    if (inProgressKey != null) {
      currentDay = inProgressKey;
    } else if (planDayKeysAsc.length) {
      currentDay = planDayKeysAsc[0];
    } else if (plan) {
      currentDay = 0;
    } else if (todayAdHocs.length) {
      currentDay = 'ah_' + todayAdHocs[0].workoutId;
    } else {
      currentDay = 0;
    }
    focusTab(currentDay);

    // First paint as soon as Phase 1 essentials are in. The focused day's
    // historical fetch (if needed) used to await here; v2.5.5 moved it to
    // Phase 2 so the day cards paint immediately and historical fills in
    // ~300-500ms later for cold-cache cases.
    buildTabs();
    buildDay(currentDay);

    // Fresh server state is now rendered. Remove the refreshing pill if
    // this was a warm boot from cache.
    __removeRefreshingPill();

    // Snapshot the now-fresh state for next boot's paintFromCache.
    saveHydrationSnapshot();

    // Phase 2 (background). Don't await — the user is already looking at
    // the day cards. Each branch re-renders only the part it touches when
    // its query lands. Capture currentDay so a mid-flight day-tab change
    // doesn't make us re-render the wrong day.
    var phase2Day = currentDay;

    // Locations: drives the session-location dropdown in buildDay. Re-
    // render the focused day when the load finishes. If the user has
    // navigated to a different day in the meantime, buildDay(currentDay)
    // is still correct — it just paints whichever day is focused now.
    pLocations.then(function() { buildDay(currentDay); }).catch(function(){});

    // loadRecentExercises depends on exerciseLibraryById (populated by
    // pLibrary which already resolved in Phase 1). It's only consumed by
    // the picker on open, so no re-render needed.
    loadRecentExercises().catch(function(){});

    // Historical for the focused day (if there's no today-state). Lazy
    // because it's the same fetch the day-picker handler uses on demand.
    // Re-render guarded by phase2Day so a mid-flight day change doesn't
    // re-paint stale state on top of the user's selection.
    if (!isAdHocKey(phase2Day) && !todayPlanStates[phase2Day] && !historicalCache[phase2Day]) {
      loadHistorical(phase2Day).then(function() {
        if (currentDay === phase2Day) buildDay(currentDay);
      }).catch(function(){});
    }

    // Auto-open the start modal when no session is in-progress. Wait for
    // suggestedDayIndex so the modal's "Suggested" badge points at the
    // right day. Completed sessions do not block the modal.
    if (inProgressKey == null) {
      pSuggestedDay.then(function() { openStartScreen(); })
                   .catch(function() { openStartScreen(); });
    }
  } catch(err) {
    console.error('Hydrate error:', err);
    showToast('Something went wrong loading your data', null);
  }
}

// ---- Auth state wiring ----
// On initial page load, resume an existing session (if any) via getSession().
// onAuthStateChange fires on subsequent sign-in / sign-out events.
sb.auth.getSession().then(function(res) {
  applySession(res.data.session);
});
sb.auth.onAuthStateChange(function(_event, session) {
  applySession(session);
});
