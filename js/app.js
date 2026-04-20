// app.js — initialization, hydration, and the auth-state→hydrate wire-up.
//
// Loads last. By the time this file runs, resolver/data/ui/auth are all in
// place. APP_VERSION lives here because it's the bootstrap surface the user
// hits first (footer paint), and hydrate() is the glue that ties every module
// together once the user is signed in.

// Bump this on every deploy. Displayed at the bottom of the app so stale-
// cache issues can be diagnosed from the client ("which version am I on?").
var APP_VERSION = 'v2.0.27';

// Paint the version tag in the bottom-right as soon as APP_VERSION is declared.
// DOM is already parsed here (all the script tags sit at the end of <body>).
(function paintVersion() {
  var el = document.getElementById('versionFooter');
  if (el) el.textContent = APP_VERSION;
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

    var planRes = await sb.from('plans').select('*')
      .eq('user_id', userId).eq('is_active', true).maybeSingle();
    if (planRes.error) { showToast('Failed to load plan', null); return; }
    if (!planRes.data) {
      plan = null; activePlanId = null;
      document.getElementById('emptyState').style.display = 'block';
      document.getElementById('summaryBar').style.display = 'none';
      document.getElementById('planTitle').textContent = 'Workout Tracker';
      document.getElementById('planWeek').textContent = 'No plan loaded';
      document.getElementById('dayPicker').innerHTML = '';
      openStartScreen();
      return;
    }
    activePlanId = planRes.data.id;
    plan = ensureStartDate(planRes.data.data, planRes.data);
    planCache[activePlanId] = plan;
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'flex';
    document.getElementById('planTitle').textContent = plan.title || 'Workout Tracker';
    document.getElementById('planWeek').textContent = planWeekLabel(plan) || plan.week || '';

    await loadExerciseLibrary();
    await loadRecentExercises();
    await loadLocations();
    await loadSuggestedDayIndex();

    var bounds = sessionBounds();
    var wRes = await sb.from('workouts').select('*, sets(*)')
      .eq('user_id', userId)
      .gte('performed_at', bounds.start.toISOString())
      .lt('performed_at', bounds.end.toISOString())
      .order('performed_at', { ascending: true });
    if (wRes.error) { showToast("Failed to load today's workouts", null); }
    else {
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

    // If the focused plan-day has no today-state yet, auto-load its
    // most recent historical workout so the tracker shows the user's
    // last attempt at that day instead of an empty template. Mirrors
    // the day-picker change handler. Only fires for plan days — ad-hoc
    // tabs have no historical equivalent.
    if (!isAdHocKey(currentDay) && !todayPlanStates[currentDay] && !historicalCache[currentDay]) {
      try { await loadHistorical(currentDay); } catch (e) { /* non-fatal */ }
    }

    buildTabs();
    buildDay(currentDay);

    // Auto-open the start modal when no session is in-progress. Completed
    // sessions do not block the modal.
    if (inProgressKey == null) {
      openStartScreen();
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
