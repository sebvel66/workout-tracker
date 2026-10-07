// api/_history.js — Shared training-history fetch + formatting helpers.
//
// Extracted from api/generate-plan.js (v3.8.0) so the coach-chat tool
// `get_training_history` can produce the EXACT same per-week structure the
// plan/analyze prompts build, rather than re-implementing it. generate-plan.js
// imports fetchRecentWorkouts / splitHistoryByRecency / formatVerbatimHistory /
// formatSummarizedHistory / formatVolumeByMuscleGroup from here; the four
// remaining functions (formatWorkoutVerbatim / formatWeekSummary / volumeForSet /
// weekStartForDateString) are internal helpers of the exported ones.
//
// NEVER writes to the training log — read-only PostgREST SELECTs via the
// service-role key, same as the callers.

// Local service-role PostgREST fetch. Reads env at call time (not module
// load) so import ordering can't leave the URL/key undefined. Mirrors the
// sbFetch in generate-plan.js; the duplication is intentional per the
// api/ "helpers duplicated across files" convention (no shared-module
// bundler today beyond plain ESM imports).
function sbFetch(route) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(`${url}/rest/v1${route}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
}

export async function fetchRecentWorkouts(userId, weeks) {
  // Sunday-anchored window: the last `weeks` COMPLETE prior calendar weeks
  // (Sun-Sat) PLUS the in-progress current week. Keeps weekly groupings in
  // the prompt aligned with planWeekLabel + the History browser (both
  // Sun-Sat) rather than splitting older weeks mid-week on a rolling 28-day
  // cutoff. getDay() returns 0 for Sunday in UTC on the Vercel runtime.
  const today = new Date();
  const weekSunday = new Date(today);
  weekSunday.setUTCHours(0, 0, 0, 0);
  weekSunday.setUTCDate(today.getUTCDate() - today.getUTCDay());
  const start = new Date(weekSunday);
  start.setUTCDate(start.getUTCDate() - weeks * 7);
  const startStr = start.toISOString().slice(0, 10);
  // PostgREST FK disambiguation (v2.2.1+): sets has two FKs to exercises
  // (exercise_id and prescribed_exercise_id). "!exercise_id" picks the
  // actual-performed FK so the planner sees what the user actually did.
  const select = encodeURIComponent('*,sets(*,exercises!exercise_id(name,equipment,muscle_group,secondary_muscles,movement_pattern,weight_mode))');
  const res = await sbFetch(
    `/workouts?user_id=eq.${userId}&performed_on=gte.${startStr}&order=performed_on.asc&select=${select}`
  );
  if (!res.ok) throw new Error('Failed to fetch workouts');
  return await res.json();
}

export function splitHistoryByRecency(workouts, verbatimWeeks) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - verbatimWeeks * 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const verbatim = [];
  const summarized = [];
  for (const w of workouts) {
    if (w.performed_on >= cutoffStr) verbatim.push(w);
    else summarized.push(w);
  }
  return { verbatim, summarized };
}

export function formatVerbatimHistory(workouts, activePlan, verbatimWeeks) {
  if (!workouts.length) return '';
  let out = `RECENT PERFORMANCE (verbatim, last ${verbatimWeeks} week${verbatimWeeks === 1 ? '' : 's'})\n`;
  const sorted = [...workouts].sort((a, b) => a.performed_on.localeCompare(b.performed_on));
  for (const w of sorted) out += formatWorkoutVerbatim(w, activePlan);
  return out + '\n';
}

function formatWorkoutVerbatim(w, activePlan) {
  const isAdHoc = w.plan_id === null;
  const dayLabel = isAdHoc
    ? (w.title || 'Ad-hoc session')
    : ('Day ' + ((w.day_index || 0) + 1));
  let out = `\n${dayLabel} | ${w.performed_on}`;

  // Target duration for sessions on the currently-active plan. We don't
  // try to resolve plan data for older-plan workouts — the signal most
  // useful to the AI is current-plan pace drift.
  const activePlanData = activePlan && activePlan.data;
  const activePlanId = activePlan && activePlan.id;
  const targetDuration = (!isAdHoc && activePlanId && w.plan_id === activePlanId
    && activePlanData && activePlanData.days
    && activePlanData.days[w.day_index]
    && activePlanData.days[w.day_index].duration) || null;

  if (w.started_at && w.ended_at) {
    const ms = new Date(w.ended_at).getTime() - new Date(w.started_at).getTime() - (w.paused_ms || 0);
    const mins = Math.round(ms / 60000);
    if (mins > 0) {
      out += targetDuration ? ` | Target ${targetDuration} · Actual ${mins} min` : ` | ${mins} min`;
    }
  }
  if (isAdHoc) out += ' | ad-hoc';
  out += '\n';

  // Group sets by exercise_order; keep canonical order.
  const byOrder = {};
  for (const s of (w.sets || [])) {
    const eo = s.exercise_order;
    if (!byOrder[eo]) byOrder[eo] = { ex: s.exercises, sets: [] };
    byOrder[eo].sets.push(s);
  }
  const keys = Object.keys(byOrder).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    const { ex, sets } = byOrder[k];
    sets.sort((a, b) => a.set_order - b.set_order);
    const name = ex ? ex.name : '?';
    const mode = ex ? (ex.weight_mode || 'total') : 'total';
    const setStrs = sets.map(s => {
      const wt = s.weight != null ? s.weight : '?';
      const reps = s.reps != null ? s.reps : '?';
      return `${wt}×${reps}${s.done ? '' : ' (not completed)'}`;
    });
    out += `  ${name} (${mode}): ${setStrs.join(', ')}`;
    const rpes = sets.map(s => s.rpe).filter(v => v != null);
    if (rpes.length) {
      const avgRpe = Math.round(rpes.reduce((a, b) => a + b, 0) / rpes.length * 10) / 10;
      out += ` | RPE ${avgRpe}`;
    }
    const firstSet = sets[0];
    if (firstSet && firstSet.prescribed_weight != null) {
      out += ` | Prescribed: ${firstSet.prescribed_weight}×${firstSet.prescribed_reps || '?'}`;
    }
    const exNotes = [...new Set(sets.map(s => s.note).filter(Boolean))];
    if (exNotes.length) out += ` | Note: "${exNotes.join('; ')}"`;
    out += '\n';
  }
  if (w.notes) out += `  Session note: "${w.notes}"\n`;
  return out;
}

export function formatSummarizedHistory(workouts) {
  if (!workouts.length) return '';
  const byWeek = {};
  for (const w of workouts) {
    const weekStart = weekStartForDateString(w.performed_on);
    if (!byWeek[weekStart]) byWeek[weekStart] = [];
    byWeek[weekStart].push(w);
  }
  let out = 'TRAINING HISTORY (summary, older weeks)\n';
  for (const weekStart of Object.keys(byWeek).sort()) {
    out += formatWeekSummary(weekStart, byWeek[weekStart]);
  }
  return out + '\n';
}

function formatWeekSummary(weekStart, workouts) {
  let done = 0, total = 0, rpeSum = 0, rpeCount = 0, volSum = 0;
  const muscleVol = {};
  for (const w of workouts) {
    for (const s of (w.sets || [])) {
      total++;
      if (s.done) {
        done++;
        if (s.rpe != null) { rpeSum += s.rpe; rpeCount++; }
        const mode = s.exercises ? (s.exercises.weight_mode || 'total') : 'total';
        const vol = volumeForSet(s.weight, s.reps, mode);
        volSum += vol;
        const mg = s.exercises ? (s.exercises.muscle_group || 'other') : 'other';
        muscleVol[mg] = (muscleVol[mg] || 0) + vol;
      }
    }
  }
  const completion = total ? Math.round(done / total * 100) : 0;
  const avgRpe = rpeCount ? Math.round(rpeSum / rpeCount * 10) / 10 : null;
  let out = `\nWeek of ${weekStart}: ${workouts.length} session${workouts.length === 1 ? '' : 's'}, ${done}/${total} sets (${completion}%)`;
  if (avgRpe != null) out += `, avg RPE ${avgRpe}`;
  out += `, volume ${Math.round(volSum)} lbs\n`;
  const topMuscles = Object.keys(muscleVol).sort((a, b) => muscleVol[b] - muscleVol[a]).slice(0, 6);
  if (topMuscles.length) {
    out += `  Volume by muscle: ${topMuscles.map(m => `${m} ${Math.round(muscleVol[m])}`).join(', ')}\n`;
  }
  return out;
}

function volumeForSet(weight, reps, mode) {
  if (!reps || weight == null) return 0;
  if (mode === 'none') return 0;
  if (mode === 'per_side') return weight * 2 * reps;
  return weight * reps;
}

// Per-muscle set count grouped by Sun-anchored week with Schoenfeld-style
// fractional counting: each completed set contributes 1.0 to its primary
// muscle_group and 0.5 to each entry in secondary_muscles. This is the
// hypertrophy literature's preferred volume metric (10-20 sets/wk per
// major muscle group), distinct from formatWeekSummary's "Volume by
// muscle" which is lbs of work. Spans the full historyWeeks window so
// the coach can flag week-over-week deficits / excesses. Cardio + mobility
// are skipped (not relevant to hypertrophy volume tracking).
export function formatVolumeByMuscleGroup(workouts, historyWeeks) {
  if (!workouts || !workouts.length) return '';
  const byWeek = {};  // weekStart -> muscle -> count
  for (const w of workouts) {
    const weekStart = weekStartForDateString(w.performed_on);
    if (!byWeek[weekStart]) byWeek[weekStart] = {};
    for (const s of (w.sets || [])) {
      if (!s.done) continue;
      const ex = s.exercises;
      if (!ex) continue;
      const primary = ex.muscle_group;
      if (!primary || primary === 'cardio' || primary === 'mobility') continue;
      byWeek[weekStart][primary] = (byWeek[weekStart][primary] || 0) + 1;
      const secondaries = Array.isArray(ex.secondary_muscles) ? ex.secondary_muscles : [];
      for (const mg2 of secondaries) {
        if (!mg2 || mg2 === primary || mg2 === 'cardio' || mg2 === 'mobility') continue;
        byWeek[weekStart][mg2] = (byWeek[weekStart][mg2] || 0) + 0.5;
      }
    }
  }
  const weekKeys = Object.keys(byWeek).sort();
  if (!weekKeys.length) return '';
  const fmt = (v) => {
    const r = Math.round(v * 10) / 10;
    return r === Math.floor(r) ? String(r) : r.toFixed(1);
  };
  let out = `WEEKLY SETS BY MUSCLE GROUP (Schoenfeld fractional counting: primary 1.0 + each secondary 0.5; last ${historyWeeks} week${historyWeeks === 1 ? '' : 's'})\n`;
  for (const wk of weekKeys) {
    const muscles = byWeek[wk];
    const ordered = Object.keys(muscles).sort((a, b) => muscles[b] - muscles[a]);
    const parts = ordered.map(m => `${m} ${fmt(muscles[m])}`);
    out += `  ${wk}: ${parts.join(', ')}\n`;
  }
  return out + '\n';
}

function weekStartForDateString(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
