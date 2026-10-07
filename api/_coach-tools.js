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
import { validatePlanStrict, makeLib, expandSetRepeatsInPlan } from './_plan-validate.js';

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

// Service-role write (POST/PATCH/DELETE). Returns the representation array
// (Prefer: return=representation) or null on empty body. `extraPrefer` adds
// e.g. 'resolution=merge-duplicates' for upserts. NEVER called for the
// workouts/sets tables — plan rows + coaching_profile only.
async function sbWrite(method, route, body, extraPrefer) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, sbHeaders());
  const prefer = ['return=representation'];
  if (extraPrefer) prefer.push(extraPrefer);
  headers['Prefer'] = prefer.join(',');
  const res = await fetch(sbUrl(route), {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${res.status}: ${t.slice(0, 200)}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// UTC today (YYYY-MM-DD). Server has no client timezone; a midnight-edge
// off-by-one vs the frontend's local date is acceptable for a coach-stamped
// start_date (planWeekLabel re-derives the display label on next load).
function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

// Sun–Sat label for the week containing `ymd`, e.g. "Oct 5 – Oct 11". Stored
// as a hint; the frontend's planWeekLabel is the render-time source of truth.
function sundayWeekLabel(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  if (isNaN(d)) return '';
  const sun = new Date(d);
  sun.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const sat = new Date(sun);
  sat.setUTCDate(sun.getUTCDate() + 6);
  const fmt = (x) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(sun)} – ${fmt(sat)}`;
}

// Coaching-profile fields the coach may write via update_coaching_profile.
// "The fields that exist today plus coaching_rules." Injuries are an array;
// everything else is scalar/string. model_* + muscle_bands + coach_context_weeks
// are included since they already live in data and the client may ask to change
// them in chat.
const PROFILE_WRITABLE = new Set([
  'sex', 'height_ft', 'height_in', 'weight_lbs', 'experience_level',
  'environment', 'split_preference', 'goal_type', 'goal_detail',
  'phase', 'phase_start_date', 'phase_notes', 'injuries',
  'special_instructions', 'coaching_rules', 'coach_context_weeks',
  'model_coach', 'model_plan', 'model_analyze', 'muscle_bands',
]);

// Fetch (and per-request cache) the exercise library as a validator `lib`.
async function getLib(userId, ctx) {
  if (ctx && ctx._lib) return ctx._lib;
  const rows = await sbJson(
    `/exercises?or=(user_id.is.null,user_id.eq.${userId})&select=name,equipment,muscle_group,secondary_muscles,movement_pattern,weight_mode`
  );
  const lib = makeLib(rows);
  if (ctx) ctx._lib = lib;
  return lib;
}

function ok(content) { return { ok: true, content: content }; }
function err(content) { return { ok: false, content: content }; }

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

  // ---- WRITE tools (require client confirmation; see CONFIRMATION in the
  // system prompt and the mechanical confirm gate in executeCoachTool) ----
  {
    name: 'update_plan',
    description:
      "Replace the contents of an existing plan or template (by id) with a revised plan blob — IN PLACE (same row id, same start_date/week for a plan; history stays linked). Use for 'swap/move/add/remove an exercise', 'change the sets/load', 'drop the drop set', etc. Send the FULL plan blob with ONLY the requested change applied; keep every other day/exercise exactly as it was. The blob is validated (names must be exact library names; integer rest; superset members carry no rest; timed exercises need duration_seconds) and repeat-expanded before saving; a readable error comes back if it fails. For a template, start_date/week are stripped. Never touches the workout log. Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'id of the plan/template to overwrite (from list_plans).' },
        plan: { type: 'object', description: 'The full revised plan blob: { title, week?, start_date?, days: [...] }.' },
        summary: { type: 'string', description: 'One-line plain-language description of what changed, for the confirmation card.' },
      },
      required: ['plan_id', 'plan'],
    },
  },
  {
    name: 'set_active_plan',
    description:
      "Save a NEW plan and make it the active plan (inserts a new row, flips the previous active plan to inactive). Stamps start_date (today, or the provided start_date) and a Sun–Sat week label. Use for a brand-new plan, or to start a template as a fresh dated plan. To edit the plan already on screen in place, use update_plan instead (that keeps the same row + history). Validated + repeat-expanded. Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'object', description: 'The full plan blob: { title, days: [...] }.' },
        start_date: { type: 'string', description: 'Optional YYYY-MM-DD Sunday start date. Defaults to today.' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'activate_plan',
    description:
      "Re-activate an existing (non-template) plan by id, flipping the current active plan to inactive. Does NOT create a new row or change the plan's start_date. Use for 'make the Jul 12 plan active again'. Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'id of the plan to activate (from list_plans; must not be a template).' },
      },
      required: ['plan_id'],
    },
  },
  {
    name: 'end_active_plan',
    description:
      "End the current active plan (flips is_active to false) leaving the client in a no-plan state. The plan row + all logged workouts are preserved and it can be re-activated later. Requires confirmation.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_template',
    description:
      "Save a plan blob as a reusable template (is_template = true, not active). Use for 'save this week as a template called X'. start_date/week are stripped. Validated + repeat-expanded. Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'object', description: 'The full plan blob to store as a template.' },
        template_name: { type: 'string', description: 'The template name the client chose.' },
      },
      required: ['plan', 'template_name'],
    },
  },
  {
    name: 'delete_plan',
    description:
      "Delete a plan or template by id. If logged workouts reference the plan, the deletion is REFUSED (with the count) unless force:true — and even with force, the workouts/sets are preserved (their plan_id is just set null). Templates have no references and delete directly. Use for 'delete the X template'. Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'id of the plan/template to delete.' },
        force: { type: 'boolean', description: 'Set true to delete a plan that still has logged workouts (workouts survive, plan_id nulled).' },
      },
      required: ['plan_id'],
    },
  },
  {
    name: 'update_coaching_profile',
    description:
      "Shallow-merge a patch into the client's coaching profile (coaching_profile.data). Allowed fields: weight_lbs, experience_level, environment, split_preference, goal_type, goal_detail, phase, phase_start_date, phase_notes, special_instructions, coaching_rules, injuries (full array), sex, height_ft, height_in, coach_context_weeks. Use when the client asks to update a standing fact ('I'm cutting now', 'add this rule'). Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        patch: { type: 'object', description: 'Object of profile fields to merge; only allowed keys are applied.' },
      },
      required: ['patch'],
    },
  },
];

// Which tools mutate state and therefore require an explicit confirmed turn.
const WRITE_TOOLS = new Set([
  'update_plan', 'set_active_plan', 'activate_plan', 'end_active_plan',
  'save_template', 'delete_plan', 'update_coaching_profile',
]);

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

// ---- write handlers ----
// Each validates, performs the PostgREST write scoped to userId, pushes a
// structured entry onto ctx.actions (for the frontend confirmation card +
// refresh), and returns { ok, content }. None touches workouts/sets.

async function doUpdatePlan(userId, args, ctx) {
  const planId = args.plan_id;
  const blob = args.plan;
  if (!planId || typeof planId !== 'string') return err('plan_id is required.');
  if (!blob || typeof blob !== 'object') return err('plan (the full plan blob) is required.');
  const rows = await sbJson(`/plans?user_id=eq.${userId}&id=eq.${planId}&select=id,is_template,is_active&limit=1`);
  if (!rows.length) return err(`No plan with id ${planId} belongs to this client.`);
  const isTemplate = !!rows[0].is_template;
  const lib = await getLib(userId, ctx);
  const vErr = validatePlanStrict(blob, lib);
  if (vErr) return err('Plan validation failed: ' + vErr);
  expandSetRepeatsInPlan(blob);
  if (isTemplate) { delete blob.start_date; delete blob.week; }
  const patch = { data: blob, title: blob.title || null };
  if (!isTemplate) patch.week = blob.week || null;
  await sbWrite('PATCH', `/plans?id=eq.${planId}&user_id=eq.${userId}`, patch);
  ctx.actions.push({
    type: 'update_plan', plan_id: planId, title: blob.title || null,
    is_template: isTemplate, is_active: !!rows[0].is_active, summary: args.summary || null,
  });
  return ok(`Updated ${isTemplate ? 'template' : 'plan'} "${blob.title || planId}".`);
}

async function doSetActivePlan(userId, args, ctx) {
  const blob = args.plan;
  if (!blob || typeof blob !== 'object') return err('plan (the full plan blob) is required.');
  const lib = await getLib(userId, ctx);
  const vErr = validatePlanStrict(blob, lib);
  if (vErr) return err('Plan validation failed: ' + vErr);
  expandSetRepeatsInPlan(blob);
  const startDate = (typeof args.start_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.start_date))
    ? args.start_date : todayYmd();
  blob.start_date = startDate;
  blob.week = sundayWeekLabel(startDate);
  await sbWrite('PATCH', `/plans?user_id=eq.${userId}&is_active=eq.true`, { is_active: false });
  const inserted = await sbWrite('POST', '/plans', {
    user_id: userId, title: blob.title || null, week: blob.week || null, data: blob, is_active: true,
  });
  const newId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : null;
  ctx.actions.push({ type: 'set_active_plan', plan_id: newId, title: blob.title || null, start_date: startDate });
  return ok(`Activated new plan "${blob.title || 'Untitled'}" starting ${startDate}.`);
}

async function doActivatePlan(userId, args, ctx) {
  const planId = args.plan_id;
  if (!planId || typeof planId !== 'string') return err('plan_id is required.');
  const rows = await sbJson(`/plans?user_id=eq.${userId}&id=eq.${planId}&select=id,title,is_template&limit=1`);
  if (!rows.length) return err(`No plan with id ${planId} belongs to this client.`);
  if (rows[0].is_template) {
    return err('That id is a template, not a plan. Start it with set_active_plan (pass the template contents), not activate_plan.');
  }
  await sbWrite('PATCH', `/plans?user_id=eq.${userId}&is_active=eq.true`, { is_active: false });
  await sbWrite('PATCH', `/plans?id=eq.${planId}&user_id=eq.${userId}`, { is_active: true });
  ctx.actions.push({ type: 'activate_plan', plan_id: planId, title: rows[0].title || null });
  return ok(`Made plan "${rows[0].title || planId}" active again.`);
}

async function doEndActivePlan(userId, args, ctx) {
  const active = await sbJson(`/plans?user_id=eq.${userId}&is_active=eq.true&select=id,title&limit=1`);
  if (!active.length) return err('There is no active plan to end.');
  await sbWrite('PATCH', `/plans?user_id=eq.${userId}&is_active=eq.true`, { is_active: false });
  ctx.actions.push({ type: 'end_active_plan', plan_id: active[0].id, title: active[0].title || null });
  return ok(`Ended the active plan "${active[0].title || ''}". The client is now in a no-plan state.`);
}

async function doSaveTemplate(userId, args, ctx) {
  const src = args.plan;
  const name = typeof args.template_name === 'string' ? args.template_name.trim() : '';
  if (!src || typeof src !== 'object') return err('plan (the full plan blob) is required.');
  if (!name) return err('template_name is required.');
  const blob = JSON.parse(JSON.stringify(src));
  const lib = await getLib(userId, ctx);
  const vErr = validatePlanStrict(blob, lib);
  if (vErr) return err('Template validation failed: ' + vErr);
  expandSetRepeatsInPlan(blob);
  delete blob.start_date;
  delete blob.week;
  const inserted = await sbWrite('POST', '/plans', {
    user_id: userId, title: blob.title || name, week: null, data: blob,
    is_active: false, is_template: true, template_name: name,
  });
  const newId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : null;
  ctx.actions.push({ type: 'save_template', plan_id: newId, template_name: name });
  return ok(`Saved template "${name}".`);
}

async function doDeletePlan(userId, args, ctx) {
  const planId = args.plan_id;
  const force = !!args.force;
  if (!planId || typeof planId !== 'string') return err('plan_id is required.');
  const rows = await sbJson(`/plans?user_id=eq.${userId}&id=eq.${planId}&select=id,title,is_template,is_active&limit=1`);
  if (!rows.length) return err(`No plan with id ${planId} belongs to this client.`);
  const refs = await sbJson(`/workouts?user_id=eq.${userId}&plan_id=eq.${planId}&select=id`);
  const count = Array.isArray(refs) ? refs.length : 0;
  if (count > 0 && !force) {
    return err(`"${rows[0].title || planId}" has ${count} logged workout${count === 1 ? '' : 's'} referencing it. Deletion is blocked to protect the training log. If the client is sure, confirm again with force (the workouts are preserved — only their plan_id link is cleared).`);
  }
  await sbWrite('DELETE', `/plans?id=eq.${planId}&user_id=eq.${userId}`, null);
  ctx.actions.push({ type: 'delete_plan', plan_id: planId, title: rows[0].title || null, is_template: !!rows[0].is_template, is_active: !!rows[0].is_active, forced: count > 0 });
  return ok(`Deleted ${rows[0].is_template ? 'template' : 'plan'} "${rows[0].title || planId}".`);
}

async function doUpdateCoachingProfile(userId, args, ctx) {
  const patch = args.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return err('patch (an object of profile fields) is required.');
  const keys = Object.keys(patch);
  if (!keys.length) return err('patch is empty — nothing to update.');
  const bad = keys.filter((k) => !PROFILE_WRITABLE.has(k));
  if (bad.length) return err(`These profile fields can't be updated here: ${bad.join(', ')}.`);
  const rows = await sbJson(`/coaching_profile?user_id=eq.${userId}&select=data&limit=1`);
  const current = (rows[0] && rows[0].data) || {};
  const next = Object.assign({}, current, patch);  // shallow merge
  await sbWrite(
    'POST',
    '/coaching_profile?on_conflict=user_id',
    { user_id: userId, data: next, updated_at: new Date().toISOString() },
    'resolution=merge-duplicates'
  );
  ctx.actions.push({ type: 'update_coaching_profile', fields: keys });
  return ok(`Updated coaching profile: ${keys.join(', ')}.`);
}

// ---- executor ----
// Returns { ok: boolean, content: string }. `content` is what goes in the
// Anthropic tool_result block (a string); object results are JSON-encoded here
// so the caller stays agnostic. ctx = { userId, actions, confirm }.
//
// Confirm gate: a write tool may run ONLY when ctx.confirm === true (the
// frontend sets confirm:true on a turn after the client taps Confirm). Without
// it, the tool is refused with an instruction to propose + ask first. This is
// the mechanical half of the confirmation rule; the system prompt is the other.
export async function executeCoachTool(name, input, ctx) {
  const userId = ctx && ctx.userId;
  if (!userId) return err('Internal error: no authenticated user.');
  if (!ctx.actions) ctx.actions = [];
  const args = input && typeof input === 'object' ? input : {};

  if (WRITE_TOOLS.has(name) && ctx.confirm !== true) {
    return err('REFUSED: write actions require explicit client confirmation. Do NOT call this tool yet. First reply with a <proposal>…</proposal> block describing exactly what will change (plan/day/exercise, sets, loads, what it replaces) and ask the client to confirm. The app re-sends the conversation with confirmation after they tap Confirm, and the tool will then succeed.');
  }

  try {
    switch (name) {
      // read-only
      case 'get_training_history':
        return ok(await getTrainingHistory(userId, args.weeks));
      case 'get_active_plan':
        return ok(JSON.stringify(await getActivePlan(userId)));
      case 'list_plans':
        return ok(JSON.stringify(await listPlans(userId, !!args.templates_only)));
      case 'get_plan': {
        const v = await getPlan(userId, args.plan_id);
        if (v && v.__error) return err(v.__error);
        return ok(JSON.stringify(v));
      }
      // writes (confirm-gated above)
      case 'update_plan':             return await doUpdatePlan(userId, args, ctx);
      case 'set_active_plan':         return await doSetActivePlan(userId, args, ctx);
      case 'activate_plan':           return await doActivatePlan(userId, args, ctx);
      case 'end_active_plan':         return await doEndActivePlan(userId, args, ctx);
      case 'save_template':           return await doSaveTemplate(userId, args, ctx);
      case 'delete_plan':             return await doDeletePlan(userId, args, ctx);
      case 'update_coaching_profile': return await doUpdateCoachingProfile(userId, args, ctx);
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err((e && e.message) || 'Tool execution failed.');
  }
}

// Exported for tests.
export { WRITE_TOOLS };
