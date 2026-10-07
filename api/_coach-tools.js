// api/_coach-tools.js — Tool definitions + server-side executors for the
// coach-chat agentic loop (v3.8.0).
//
// This commit ships the READ-ONLY tools (get_training_history,
// get_active_plan, list_plans, get_plan). Write tools (update_plan,
// set_active_plan, activate_plan, end_active_plan, save_template,
// delete_plan, update_coaching_profile) + the confirm gate land in the
// next commit and extend COACH_TOOLS / executeCoachTool here.
//
// Every query is scoped to the authenticated userId (passed in ctx by the
// caller, which already validated the session JWT) and uses the service
// role key. NOTHING here ever inserts/updates/deletes `workouts` or `sets`
// — the training log is read-only to the coach, by construction.
//
// Designed for testability: uses the global `fetch` + process.env so the
// commit-7 test harness can stub `global.fetch` and exercise handlers
// without a live Supabase.

import {
  fetchRecentWorkouts,
  splitHistoryByRecency,
  formatVerbatimHistory,
  formatSummarizedHistory,
  formatVolumeByMuscleGroup,
} from './_history.js';

const DEFAULT_HISTORY_WEEKS = 6;  // v3.8.0 default (analyze default also 6)
const MAX_HISTORY_WEEKS = 12;
const MAX_VERBATIM_WEEKS = 2;     // mirror generate-plan.js

// ---- service-role PostgREST read helper ----
function sbUrl(route) {
  return `${process.env.SUPABASE_URL}/rest/v1${route}`;
}
function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}
async function sbJson(route) {
  const res = await fetch(sbUrl(route), { headers: sbHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ---- Tool specifications (Anthropic `tools` array) ----
export const COACH_TOOLS = [
  {
    name: 'get_training_history',
    description:
      "The client's logged training over the last N weeks (default 6, max 12). Returns the same per-week structure the plan/analyze prompts use: recent sessions verbatim with per-exercise sets (prescribed vs actual weight×reps, RPE, done/skipped, notes), older weeks summarized, and the weekly fractional sets-per-muscle table (Schoenfeld counting: primary 1.0 + each secondary 0.5) shown on the Body tab. Read-only. Use for multi-week reviews, progression/stagnation checks, adherence, and skip patterns.",
    input_schema: {
      type: 'object',
      properties: {
        weeks: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_HISTORY_WEEKS,
          description: 'How many weeks of history to include. Defaults to 6; capped at 12.',
        },
      },
    },
  },
  {
    name: 'get_active_plan',
    description:
      "The client's current ACTIVE plan: { id, title, week, start_date, data }, or null if no plan is active. `data` is the full plan blob (days → exercises → sets with weights/reps/rest). Read-only.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_plans',
    description:
      "List the client's plans and templates: id, title, week, is_active, is_template, template_name, created_at, and workout_count (how many logged workouts reference each plan). Pass templates_only:true to list only saved templates. Use to find a specific plan/template by id before get_plan / update_plan / activate_plan / delete_plan. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        templates_only: {
          type: 'boolean',
          description: 'When true, return only template rows (is_template = true).',
        },
      },
    },
  },
  {
    name: 'get_plan',
    description:
      "The full contents of ONE plan or template by id: { id, title, week, is_active, is_template, template_name, data }. Use after list_plans to read a plan you intend to discuss or edit. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'The plan row id (uuid) from list_plans.' },
      },
      required: ['plan_id'],
    },
  },
];

// ---- read-only handlers ----
async function getTrainingHistory(userId, weeksInput) {
  const weeks = clampInt(weeksInput, 1, MAX_HISTORY_WEEKS, DEFAULT_HISTORY_WEEKS);
  const verbatimWeeks = Math.min(MAX_VERBATIM_WEEKS, weeks);
  const [activePlan, workouts] = await Promise.all([
    getActivePlanRow(userId),
    fetchRecentWorkouts(userId, weeks),
  ]);
  if (!workouts.length) {
    return `No workouts logged in the last ${weeks} week${weeks === 1 ? '' : 's'}.`;
  }
  const { verbatim, summarized } = splitHistoryByRecency(workouts, verbatimWeeks);
  let out = '';
  out += formatVerbatimHistory(verbatim, activePlan, verbatimWeeks);
  out += formatSummarizedHistory(summarized);
  out += formatVolumeByMuscleGroup(workouts, weeks);
  out = out.trim();
  return out || `No completed sets in the last ${weeks} week${weeks === 1 ? '' : 's'}.`;
}

async function getActivePlanRow(userId) {
  const rows = await sbJson(
    `/plans?user_id=eq.${userId}&is_active=eq.true&select=id,title,week,data,created_at&limit=1`
  );
  return rows[0] || null;
}

async function getActivePlan(userId) {
  const p = await getActivePlanRow(userId);
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    week: p.week,
    start_date: (p.data && p.data.start_date) || null,
    data: p.data,
  };
}

async function listPlans(userId, templatesOnly) {
  let route = `/plans?user_id=eq.${userId}&select=id,title,week,is_active,is_template,template_name,created_at&order=created_at.desc`;
  if (templatesOnly) route += `&is_template=eq.true`;
  const plans = await sbJson(route);
  // Workout reference counts: one lightweight select of plan_id, tallied
  // client-side. Avoids needing a PostgREST aggregate view/RPC.
  const workouts = await sbJson(`/workouts?user_id=eq.${userId}&select=plan_id`);
  const counts = {};
  for (const w of workouts) {
    if (w && w.plan_id) counts[w.plan_id] = (counts[w.plan_id] || 0) + 1;
  }
  return plans.map((p) => ({ ...p, workout_count: counts[p.id] || 0 }));
}

async function getPlan(userId, planId) {
  if (!planId || typeof planId !== 'string') {
    return { __error: 'plan_id is required' };
  }
  const rows = await sbJson(
    `/plans?user_id=eq.${userId}&id=eq.${planId}&select=id,title,week,is_active,is_template,template_name,data&limit=1`
  );
  if (!rows.length) return { __error: `No plan with id ${planId} belongs to this client.` };
  return rows[0];
}

// ---- executor ----
// Returns { ok: boolean, content: string }. `content` is what gets placed in
// the Anthropic tool_result block (a string); object results are JSON-encoded
// here so the caller stays agnostic. ctx = { userId, actions }.
export async function executeCoachTool(name, input, ctx) {
  const userId = ctx && ctx.userId;
  if (!userId) return { ok: false, content: 'Internal error: no authenticated user.' };
  const args = input && typeof input === 'object' ? input : {};
  try {
    switch (name) {
      case 'get_training_history': {
        const text = await getTrainingHistory(userId, args.weeks);
        return { ok: true, content: text };
      }
      case 'get_active_plan': {
        const v = await getActivePlan(userId);
        return { ok: true, content: JSON.stringify(v) };
      }
      case 'list_plans': {
        const v = await listPlans(userId, !!args.templates_only);
        return { ok: true, content: JSON.stringify(v) };
      }
      case 'get_plan': {
        const v = await getPlan(userId, args.plan_id);
        if (v && v.__error) return { ok: false, content: v.__error };
        return { ok: true, content: JSON.stringify(v) };
      }
      default:
        return { ok: false, content: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, content: (err && err.message) || 'Tool execution failed.' };
  }
}
