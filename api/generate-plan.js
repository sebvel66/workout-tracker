// api/generate-plan.js — AI weekly plan generator (Session B, Part 2b).
//
// Vercel Node serverless function. Flow:
//   1. Verify the caller's Supabase session via /auth/v1/user.
//   2. Query active plan + last HISTORY_WEEKS of workouts + exercise
//      library + latest physique photos (service-role key, bypasses RLS).
//   3. Build a text+images user message; pair with the system prompt
//      loaded from system-prompt.md at cold start.
//   4. Call Claude and parse the JSON response; validate shape.
//   5. Return { plan, weeks_analyzed, generated_at }.
//
// Design notes:
//   - No npm deps: raw fetch for both Supabase PostgREST and Anthropic.
//   - System prompt lives at repo root; vercel.json bundles it into the
//     function via includeFiles. We probe a few paths because Vercel's
//     bundle layout for top-level files isn't perfectly deterministic.
//   - v1 scope: full 5-day week only, 4-week history, photos auto-
//     included if they exist. No user notes, no replan mode, no
//     configurable context window — those land separately.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModel, modelSupportsTemperature } from './_models.js';

export const maxDuration = 60;  // Claude generation takes ~10-20s; Hobby plan cap.

// ---- Config ----
const MAX_TOKENS = 16000;
const TEMPERATURE = 0.3;
const DEFAULT_HISTORY_WEEKS = 4;
const MAX_VERBATIM_WEEKS = 2;   // cap; effective verbatim = min(cap, requested history)
const DEFAULT_TRAINING_DAYS = 5;
const MIN_TRAINING_DAYS = 1;
const MAX_TRAINING_DAYS = 6;
const MIN_HISTORY_WEEKS = 1;
const MAX_HISTORY_WEEKS = 12;

// Swap mode — budget + prompt are separate from plan generation because the
// task is narrower (one exercise, one JSON object) and we want it fast.
// Cached system prompt + library block give a warm-path ~8-12s response.
const SWAP_MAX_TOKENS = 1400;  // three fully-prescribed exercises
const SWAP_HISTORY_WEEKS = 2;  // enough for weight calibration on the movement

const SWAP_SYSTEM_PROMPT = `You are a strength and hypertrophy coach. The client wants to replace one exercise. Suggest EXACTLY 3 alternatives, ranked best-fit first, each of which:
1. Targets the same primary muscle group and movement pattern
2. Uses equipment available in the client's exercise library (provided in the user message)
3. Is not already programmed for the same day
4. Has an appropriate weight prescription based on the client's recent history with similar movements

Rank them by overall fit: #1 is the closest, most effective replacement; #2 and #3 are progressively different trade-offs (e.g. different equipment, more joint-friendly, more novel) that are still strong choices. If the client provided a reason for the swap, factor it into the ranking:
- "different gym" or "equipment unavailable" → favor exercises using different equipment
- "knee pain" or injury-related → favor joint-friendly alternatives
- "want variety" → favor exercises the client hasn't done recently
- No reason given → rank by best general fit

Return ONLY valid JSON matching this exact structure, no other text (no markdown fences, no preamble, no explanation):
{
  "options": [
    {
      "name": "Chest-Supported Machine Row",
      "why": "#1 — same horizontal pull, machine-based, removes lower-back load.",
      "note": "Starting at 100 based on prior row history.",
      "rest": 120,
      "sets": [
        {"weight": 100, "reps_target": 12, "reps_range": "10-12", "repeat": 3}
      ]
    },
    { "...": "option #2" },
    { "...": "option #3" }
  ]
}

RULES:
- Return EXACTLY 3 options, ordered best-fit first. The 3 names must be distinct, and none may equal the exercise being replaced.
- "name" must be an exact, verbatim name from the AVAILABLE EXERCISES list. Preserve capitalization.
- "why" explains why this option sits at this rank (lead with "#1"/"#2"/"#3"). Hard cap 15 words.
- Weight must respect the exercise's weight_mode (per_side = per-hand/per-leg, total = bar/stack load, bodyweight = added load only, none = 0). The AVAILABLE EXERCISES list includes weight_mode for every entry.
- Round weights to realistic gym increments: 2.5-5 lbs for dumbbells / plated barbells, 5-10 lbs for cables / machines. Never decimals like 67.5 for a dumbbell.
- "rest" is an INTEGER in seconds (e.g., 120 for 2 min). Never a string.
- Omit a "unit" field — the app defaults to lbs.
- Use the "repeat": N shorthand when all sets are identical (single set object with repeat: N). Use separate set objects only when sets differ.
- "note" explains how the weight was derived. Hard cap 20 words.
- Do not suggest any exercise that is already programmed on the same day (list provided in the user message).

COACHING CONTINUITY:
The user message may include a RECENT COACHING CONVERSATIONS section with prior swap requests, injury discussions, and session notes from the last two weeks plus current week. If the client has discussed this exercise or muscle group recently, factor that into your suggestion. For example, if the client mentioned knee pain in chat earlier this week, prioritize knee-friendly alternatives even if they don't restate that in the swap reason. Don't repeat a substitute they recently rejected.
`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---- System prompts (loaded once at cold start) ----
// v2.3.0 splits the monolithic system prompt into three pieces so the
// coaching philosophy + client profile stays DRY while plan-gen and
// analyze each get their own mode-specific suffix. Two final strings are
// assembled: SYSTEM_PROMPT_PLAN (core + plan) and SYSTEM_PROMPT_ANALYZE
// (core + analyze). Each is sent with its own cache_control breakpoint
// so they cache independently in Anthropic.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_CORE = loadPromptPiece('system-prompt-core.md');
const PROMPT_PLAN_SUFFIX = loadPromptPiece('system-prompt-plan.md');
const PROMPT_ANALYZE_SUFFIX = loadPromptPiece('system-prompt-analyze.md');
const SYSTEM_PROMPT_PLAN = PROMPT_CORE + '\n\n' + PROMPT_PLAN_SUFFIX;
const SYSTEM_PROMPT_ANALYZE = PROMPT_CORE + '\n\n' + PROMPT_ANALYZE_SUFFIX;

function loadPromptPiece(filename) {
  const candidates = [
    path.join(__dirname, '..', filename),
    path.join(process.cwd(), filename),
    path.join(__dirname, filename),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf-8'); } catch { /* try next */ }
  }
  throw new Error('Could not locate ' + filename);
}

// ---- Handler ----
export default async function handler(req, res) {
  // Warmup branch — keep a Fluid Compute instance hot. Doesn't touch Supabase
  // or Anthropic; just answers 200. Note this only warms the Vercel side; the
  // Anthropic prompt cache (1h ephemeral) is a separate system and the
  // dominant latency driver on this endpoint.
  if (req.url && req.url.indexOf('warmup=true') !== -1) {
    return res.status(200).json({ status: 'warm' });
  }

  if (req.method !== 'POST') return jsonError(res, 405, 'Method not allowed');

  const missingVars = [];
  if (!SUPABASE_URL) missingVars.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missingVars.push('SUPABASE_ANON_KEY');
  if (!SUPABASE_SERVICE_ROLE_KEY) missingVars.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANTHROPIC_API_KEY) missingVars.push('ANTHROPIC_API_KEY');
  if (missingVars.length) {
    return jsonError(res, 500, 'Server misconfigured — missing: ' + missingVars.join(', '));
  }

  try {
    const userId = await verifyUser(req.headers.authorization);
    if (!userId) return jsonError(res, 401, 'Authentication required');

    // Parse user-supplied inputs from the Generate form (all optional).
    // Vercel's Node runtime auto-parses JSON request bodies when the
    // Content-Type header is application/json.
    const rawInputs = (req.body && typeof req.body === 'object') ? req.body : {};

    // Early dispatch: swap mode is a different workflow with its own
    // prompt, budget, and validation. Separate path keeps the happy
    // path (plan generation) untouched.
    if (rawInputs.mode === 'swap') {
      return await handleSwap(res, userId, rawInputs);
    }
    if (rawInputs.mode === 'analyze') {
      return await handleAnalyze(res, userId, rawInputs);
    }
    if (rawInputs.mode === 'analyze_chat') {
      return await handleAnalyzeChat(res, userId, rawInputs);
    }
    if (rawInputs.mode === 'refine') {
      return await handleRefine(res, userId, rawInputs);
    }

    const userInputs = {
      startDate: typeof rawInputs.start_date === 'string' ? rawInputs.start_date.slice(0, 10) : null,
      targetDuration: Number.isFinite(rawInputs.target_duration) ? rawInputs.target_duration : null,
      notes: (typeof rawInputs.notes === 'string' && rawInputs.notes.trim()) ? rawInputs.notes.trim().slice(0, 500) : null,
      trainingDays: clampInt(rawInputs.training_days, MIN_TRAINING_DAYS, MAX_TRAINING_DAYS, DEFAULT_TRAINING_DAYS),
      historyWeeks: clampInt(rawInputs.history_weeks, MIN_HISTORY_WEEKS, MAX_HISTORY_WEEKS, DEFAULT_HISTORY_WEEKS),
      // Default true: safe backward-compat for any non-form caller. Frontend
      // explicitly sends false when the checkbox is unchecked.
      includePhotos: rawInputs.include_photos === false ? false : true,
    };
    const verbatimWeeks = Math.min(MAX_VERBATIM_WEEKS, userInputs.historyWeeks);

    var requestedModel = (rawInputs && rawInputs.model) || null;
    var model = resolveModel(requestedModel, 'plan');
    if (requestedModel && requestedModel !== model) {
      console.warn('generate-plan/plan: model fallback', { requested: requestedModel, resolved: model });
    }

    const t0 = Date.now();
    const [activePlan, history, exercises, photos, coachHistory, coachingProfile] = await Promise.all([
      fetchActivePlan(userId),
      fetchRecentWorkouts(userId, userInputs.historyWeeks),
      fetchExerciseLibrary(userId),
      userInputs.includePhotos ? fetchPhysiquePhotos(userId) : Promise.resolve({ goal: null, progress: [] }),
      fetchRecentCoachHistory(userId, 2),
      fetchCoachingProfile(userId),
    ]);
    console.log('[generate-plan] data fetch:', Date.now() - t0, 'ms', '· history_weeks:', userInputs.historyWeeks, '· training_days:', userInputs.trainingDays, '· include_photos:', userInputs.includePhotos, '· coach_msgs:', coachHistory.length, '· profile:', coachingProfile ? 'yes' : 'no');

    const t1 = Date.now();
    const userMessage = await buildUserMessage({ activePlan, history, exercises, photos, userInputs, verbatimWeeks, coachHistory, coachingProfile });
    console.log('[generate-plan] prompt build (incl photo b64):', Date.now() - t1, 'ms');

    const t2 = Date.now();
    // Wrap the Anthropic call in a hard timeout so a stuck upstream
    // can't leave the user staring at an infinite spinner. 55s sits
    // just under Vercel Hobby's 60s function cap, giving us time to
    // return a clean error envelope if Anthropic goes unresponsive.
    const claudeAbort = new AbortController();
    const claudeTimeout = setTimeout(() => claudeAbort.abort(), 55000);
    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model,
          max_tokens: MAX_TOKENS,
          ...(modelSupportsTemperature(model) ? { temperature: TEMPERATURE } : {}),
          // Breakpoint 1: the plan-mode system prompt (core + plan suffix).
          // Cached at the tools→system boundary. Invalidated only when
          // either the core or plan suffix file changes.
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT_PLAN,
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          messages: [{ role: 'user', content: userMessage }],
        }),
        signal: claudeAbort.signal,
      });
    } catch (err) {
      clearTimeout(claudeTimeout);
      if (err && err.name === 'AbortError') {
        console.error('[generate-plan] claude call: TIMEOUT after', Date.now() - t2, 'ms');
        return jsonError(res, 504, 'AI service timed out (55s). Try again — cache should be warm on the next call.');
      }
      throw err;
    }
    clearTimeout(claudeTimeout);

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error('Claude API error', claudeRes.status, errBody);
      return jsonError(res, 502, 'AI service unavailable', { detail: errBody });
    }

    const claudeData = await claudeRes.json();
    console.log('[generate-plan] claude call:', Date.now() - t2, 'ms · usage:', JSON.stringify(claudeData.usage || {}));

    if (claudeData.stop_reason === 'max_tokens') {
      return jsonError(res, 422, 'Response truncated (max_tokens hit). Plan may be incomplete.', { raw: claudeData });
    }

    const rawText = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
    if (!rawText) return jsonError(res, 422, 'No text in Claude response', { raw: claudeData });

    let plan;
    try {
      plan = JSON.parse(stripJsonFences(rawText));
    } catch {
      return jsonError(res, 422, 'Plan generation failed — invalid JSON', { raw: rawText });
    }

    const validationError = validatePlan(plan, userInputs.trainingDays);
    if (validationError) {
      return jsonError(res, 422, 'Plan validation failed: ' + validationError, { raw: rawText });
    }

    // Expand `"repeat": N` shorthand into N identical set objects so the
    // stored plan JSON matches the shape the frontend expects (one object
    // per set). The prompt tells Claude to emit the compact form to save
    // output tokens; expansion happens server-side so the client never
    // sees `repeat`.
    expandSetRepeats(plan);

    // coaching_notes intentionally dropped in v2.3.0 — commentary moved
    // to the analyze endpoint. If the plan blob happens to carry one
    // (pre-v2.3.0 plan regenerated by an old prompt cache), we don't
    // surface it on the wire; the frontend doesn't render it anymore.
    return res.status(200).json({
      plan,
      weeks_analyzed: userInputs.historyWeeks,
      training_days: userInputs.trainingDays,
      include_photos: userInputs.includePhotos,
      model: model,
      usage: claudeData.usage || null,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('generate-plan error:', err);
    return jsonError(res, 500, err.message || 'Internal server error');
  }
}

function jsonError(res, status, message, extra) {
  return res.status(status).json({ error: message, ...(extra || {}) });
}

// Clamp a numeric input to [min, max]; fall back to `fallback` if missing or invalid.
// Accepts numbers and numeric strings from JSON bodies.
function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ---- Auth ----
async function verifyUser(authHeader) {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.id ? data.id : null;
}

// ---- Supabase queries (PostgREST, service-role) ----
function sbFetch(route) {
  return fetch(`${SUPABASE_URL}/rest/v1${route}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
}

async function fetchActivePlan(userId) {
  const res = await sbFetch(`/plans?user_id=eq.${userId}&is_active=eq.true&select=id,title,week,data,created_at&limit=1`);
  if (!res.ok) throw new Error('Failed to fetch active plan');
  const rows = await res.json();
  return rows[0] || null;
}

async function fetchRecentWorkouts(userId, weeks) {
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

async function fetchExerciseLibrary(userId) {
  // Seed library has user_id IS NULL; user-custom has user_id = userId.
  const res = await sbFetch(
    `/exercises?or=(user_id.is.null,user_id.eq.${userId})&select=name,equipment,muscle_group,secondary_muscles,movement_pattern,weight_mode&order=name.asc`
  );
  if (!res.ok) throw new Error('Failed to fetch exercise library');
  return await res.json();
}

// Adaptive coaching profile (v2.5 layer 1). Replaces the hardcoded CLIENT
// PROFILE / Injury-aware programming / Phase awareness blocks that used to
// live in system-prompt-core.md. One row per user in coaching_profile;
// the `data` jsonb holds the full shape. Missing row -> returns null and
// formatCoachingProfile falls back to a one-line "not set" note.
async function fetchCoachingProfile(userId) {
  try {
    const res = await sbFetch(
      `/coaching_profile?user_id=eq.${userId}&select=data&limit=1`
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return (rows[0] && rows[0].data) || null;
  } catch (err) {
    console.warn('[coaching_profile] fetch failed:', err && err.message);
    return null;
  }
}

// Build the CLIENT PROFILE text block that gets injected into the user
// message. Keys follow the jsonb shape written by saveCoachingProfile in
// js/data.js. Every field is optional — we only emit lines for populated
// fields so a partially-filled profile doesn't bloat the prompt.
function formatCoachingProfile(profile) {
  if (!profile || typeof profile !== 'object' || Object.keys(profile).length === 0) {
    return 'CLIENT PROFILE: (not set — client has not filled in their coaching profile yet. Rely on training data and general coaching principles.)\n\n';
  }
  let out = 'CLIENT PROFILE\n\n';
  const basics = [];
  if (profile.sex) basics.push(`Sex: ${profile.sex}`);
  if (profile.height_ft != null || profile.height_in != null) {
    const ft = profile.height_ft != null ? profile.height_ft : '?';
    const inch = profile.height_in != null ? profile.height_in : '0';
    basics.push(`Height: ${ft}'${inch}"`);
  }
  if (profile.weight_lbs != null) basics.push(`Current weight: ${profile.weight_lbs} lbs`);
  if (profile.experience_level) basics.push(`Experience level: ${profile.experience_level}`);
  if (basics.length) out += 'BASICS:\n- ' + basics.join('\n- ') + '\n\n';

  if (profile.environment) out += `ENVIRONMENT: ${profile.environment}\n\n`;
  if (profile.split_preference) out += `TRAINING PREFERENCE: ${profile.split_preference}\n\n`;

  if (profile.goal_type || profile.goal_detail) {
    out += 'GOAL';
    if (profile.goal_type) out += `: ${profile.goal_type}`;
    out += '\n';
    if (profile.goal_detail) out += `Details: ${profile.goal_detail}\n`;
    out += '\n';
  }

  if (profile.phase || profile.phase_notes || profile.phase_start_date) {
    out += 'CURRENT PHASE';
    if (profile.phase) out += `: ${profile.phase}`;
    out += '\n';
    if (profile.phase_start_date) out += `Started (or planned start): ${profile.phase_start_date}\n`;
    if (profile.phase_notes) out += `Notes: ${profile.phase_notes}\n`;
    out += '\n';
  }

  if (Array.isArray(profile.injuries) && profile.injuries.length) {
    out += 'INJURIES / LIMITATIONS:\n';
    for (const inj of profile.injuries) {
      if (!inj || (!inj.name && !inj.notes)) continue;
      out += `- ${inj.name || '(unnamed)'}\n`;
      if (inj.notes) out += `  Management: ${inj.notes}\n`;
    }
    out += '\n';
  }

  if (profile.special_instructions) {
    out += `SPECIAL INSTRUCTIONS: ${profile.special_instructions}\n\n`;
  }

  return out;
}

// Saved templates (v3.5.6). Compact summary keyed by name + day list with
// exercise names only — no per-exercise sets/reps detail (the user can
// share specifics in chat if needed). Soft-cap at 10 most-recent shown;
// older ones surface as "(N more — ask to see them)" so the prompt stays
// bounded regardless of how many templates the user has saved. Mirrors
// the helpers in api/coach-chat.js.
async function fetchUserTemplates(userId) {
  try {
    const res = await sbFetch(
      `/plans?user_id=eq.${userId}&is_template=eq.true&select=id,template_name,data,created_at&order=created_at.desc&limit=20`
    );
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn('[user_templates] fetch failed:', err && err.message);
    return [];
  }
}

function formatUserTemplates(templates) {
  if (!Array.isArray(templates) || !templates.length) return '';
  const cap = 10;
  const shown = templates.slice(0, cap);
  const overflow = templates.length - shown.length;

  let out = `SAVED TEMPLATES (${templates.length} total — exercise names only; ask the client for sets/reps if you need them)\n\n`;
  for (const t of shown) {
    const name = (t.template_name || (t.data && t.data.title) || '(untitled)').toString().slice(0, 80);
    const data = t.data || {};
    const days = Array.isArray(data.days) ? data.days : [];
    out += `[Template] "${name}" — ${days.length} day${days.length === 1 ? '' : 's'}\n`;
    for (let di = 0; di < days.length; di++) {
      const day = days[di] || {};
      const dayName = (day.name || `Day ${di + 1}`).toString().slice(0, 60);
      const exNames = [];
      const entries = Array.isArray(day.exercises) ? day.exercises : [];
      for (const e of entries) {
        if (e && e.superset === true && Array.isArray(e.exercises)) {
          for (const m of e.exercises) {
            if (m && m.name) exNames.push(m.name);
          }
        } else if (e && e.name) {
          exNames.push(e.name);
        }
      }
      out += `  Day ${di + 1} - ${dayName}: ${exNames.length ? exNames.join(', ') : '(no exercises)'}\n`;
    }
    out += '\n';
  }
  if (overflow > 0) {
    out += `(${overflow} more template${overflow === 1 ? '' : 's'} not shown — ask the client to share specific ones if relevant.)\n\n`;
  }
  return out;
}

// Coach history window: last `weeksBack` complete prior weeks (Sun-anchored)
// + current week to date. Same shape as fetchRecentWorkouts so the prompt
// blocks line up temporally. Failure is NON-fatal — return [] so the plan
// generation never fails because the chat-history side-channel is degraded.
async function fetchRecentCoachHistory(userId, weeksBack) {
  if (!Number.isFinite(weeksBack) || weeksBack < 1) weeksBack = 2;
  try {
    const today = new Date();
    const weekSunday = new Date(today);
    weekSunday.setUTCHours(0, 0, 0, 0);
    weekSunday.setUTCDate(today.getUTCDate() - today.getUTCDay());
    const start = new Date(weekSunday);
    start.setUTCDate(start.getUTCDate() - weeksBack * 7);
    const startIso = start.toISOString();
    const select = encodeURIComponent('role,content,context_type,exercise_name,created_at');
    const res = await sbFetch(
      `/coach_messages?user_id=eq.${userId}&created_at=gte.${startIso}&order=created_at.asc&select=${select}`
    );
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn('[coach_history] fetch failed:', err && err.message);
    return [];
  }
}

// Render coach_messages as a labeled text block keyed by date so Claude
// can read the conversation as a journal. Returns '' for empty input so
// callers can append unconditionally without polluting the prompt with
// an empty header. Format mirrors the spec example: "--- Tue, Apr 15 ---"
// header per day, "Client" / "Coach" prefix, optional "[exercise swap: X]"
// or "[plan generation]" inline tag from context_type.
function formatCoachHistory(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  let out = 'RECENT COACHING CONVERSATIONS (last 2 weeks + current week):\n';
  let currentDate = '';
  for (const m of messages) {
    if (!m || !m.content) continue;
    const d = new Date(m.created_at);
    const dateStr = d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
    if (dateStr !== currentDate) {
      currentDate = dateStr;
      out += `\n--- ${dateStr} ---\n`;
    }
    const prefix = m.role === 'user' ? 'Client' : 'Coach';
    let tag = '';
    if (m.context_type === 'swap' && m.exercise_name) {
      tag = ` [exercise swap: ${m.exercise_name}]`;
    } else if (m.context_type === 'plan_generation') {
      tag = ' [plan generation]';
    }
    out += `${prefix}${tag}: ${m.content}\n`;
  }
  return out + '\n';
}

// progressLimit controls how many progress photos come back. Plan-gen
// uses 1 (latest only — visual cue for programming, more would bloat the
// prompt). Analyze mode uses more (up to ~4) so the prompt carries the
// chronological sequence Claude needs for over-time comparison.
async function fetchPhysiquePhotos(userId, progressLimit) {
  if (!Number.isFinite(progressLimit) || progressLimit < 1) progressLimit = 1;
  const res = await sbFetch(
    `/physique_photos?user_id=eq.${userId}&order=taken_at.desc&select=id,storage_path,photo_type,taken_at,notes`
  );
  if (!res.ok) return { goal: null, progress: [] };
  const rows = await res.json();
  let goal = null;
  const progress = [];
  for (const r of rows) {
    if (r.photo_type === 'goal') {
      if (!goal) goal = r;  // most recent goal only
    } else {
      progress.push(r);
    }
  }
  return { goal, progress: progress.slice(0, progressLimit) };
}

async function downloadPhotoAsBase64(storagePath) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/physique-photos/${storagePath}`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const ext = (storagePath.split('.').pop() || 'jpg').toLowerCase();
  const mime = ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/jpeg';
  return { base64, mime };
}

// ---- Prompt assembly ----
async function buildUserMessage({ activePlan, history, exercises, photos, userInputs, verbatimWeeks, coachHistory, coachingProfile }) {
  const content = [];
  const { verbatim, summarized } = splitHistoryByRecency(history, verbatimWeeks);

  // Breakpoint 2: exercise library as the FIRST user-message block. Together
  // with the cached system prompt, this caches the full static prefix —
  // invalidated only when the user's library changes (new custom exercise).
  // Dynamic content (plan snapshot, history, generation instruction) follows
  // in a separate uncached block so it can vary per request without
  // busting the cache.
  content.push({
    type: 'text',
    text: formatExerciseLibrary(exercises),
    cache_control: { type: 'ephemeral', ttl: '1h' },
  });

  // Day count + history window are driven by USER INPUTS; the system prompt's
  // USER INPUTS section holds the rules, the data section below holds the
  // values. No re-statement of day structure here — that would duplicate what
  // the CLIENT PROFILE section and the formatCurrentPlan snapshot already say.
  // Coach history slots between RECENT PERFORMANCE (verbatim+summarized) and
  // USER INPUTS so Claude reads "what happened in training" → "what we
  // talked about" → "what the user asked for this time" in that order.
  // CLIENT PROFILE comes FIRST so Claude reads "who is this client" before
  // interpreting plan state, history, coaching context, and user inputs.
  let dynText = '';
  dynText += formatCoachingProfile(coachingProfile);
  // v3.3.0 cold-start marker — explicit signal to the planner when both
  // the active plan and history are absent. When only one is missing
  // (post-End-plan with prior history; or brand-new with no profile yet),
  // the marker is omitted and the model infers from absent sections.
  if (!activePlan && history.length === 0) {
    dynText += 'COLD START: No prior plan and no logged training history. Build the first training week for this client based on CLIENT PROFILE and USER INPUTS below.\n\n';
  }
  dynText += formatCurrentPlan(activePlan);
  dynText += formatVerbatimHistory(verbatim, activePlan, verbatimWeeks);
  dynText += formatSummarizedHistory(summarized);
  dynText += formatCoachHistory(coachHistory);
  dynText += formatUserInputs(userInputs);
  dynText += '\nGENERATE the training plan per the USER INPUTS above. Return ONLY the JSON object as specified in your instructions. No preamble, no markdown fences, no trailing text.\n';
  content.push({ type: 'text', text: dynText });

  // Download the two photos in parallel — they're independent Supabase Storage
  // round-trips; serializing them adds ~200-500ms for no reason. Order of
  // pushed content blocks is preserved (goal first, then progress) so prompt
  // structure — and therefore the Anthropic cache prefix — is unchanged.
  const latestProgress = photos.progress.length ? photos.progress[0] : null;
  const [goalImg, progressImg] = await Promise.all([
    photos.goal ? downloadPhotoAsBase64(photos.goal.storage_path) : Promise.resolve(null),
    latestProgress ? downloadPhotoAsBase64(latestProgress.storage_path) : Promise.resolve(null),
  ]);
  if (photos.goal && goalImg) {
    content.push({ type: 'text', text: `GOAL PHYSIQUE photo (uploaded ${String(photos.goal.taken_at).slice(0, 10)}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: goalImg.mime, data: goalImg.base64 } });
  }
  if (latestProgress && progressImg) {
    content.push({ type: 'text', text: `CURRENT PROGRESS photo (${String(latestProgress.taken_at).slice(0, 10)}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: progressImg.mime, data: progressImg.base64 } });
  }

  return content;
}

function splitHistoryByRecency(workouts, verbatimWeeks) {
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

function formatCurrentPlan(activePlan) {
  if (!activePlan) return '';
  const d = activePlan.data || {};
  let out = 'CURRENT PLAN\n';
  out += `Title: ${d.title || activePlan.title || 'Untitled'}\n`;
  out += `Week: ${d.week || activePlan.week || 'N/A'}\n`;

  // Ground the AI in calendar time. start_date is stamped at save time;
  // fall back to plans.created_at for plans that predate that stamping.
  const startDate = d.start_date || (activePlan.created_at ? String(activePlan.created_at).slice(0, 10) : null);
  if (startDate) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const weeksSince = weeksBetweenDates(startDate, todayStr);
    out += `Started: ${startDate} (${weeksSince} week${weeksSince === 1 ? '' : 's'} ago)\n`;
  }

  const days = Array.isArray(d.days) ? d.days : [];
  out += `Days: ${days.length}\n`;
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const dur = day.duration ? ` (target ${day.duration})` : '';
    const entries = Array.isArray(day.exercises) ? day.exercises : [];
    const labels = entries.map(entry => {
      if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
        const memberNames = entry.exercises.map(c => c && c.name).filter(Boolean);
        const rest = Number.isInteger(entry.rest) ? entry.rest : 60;
        return `⟷ ${memberNames.join(' / ')} (${rest}s rest)`;
      }
      return entry && entry.name ? entry.name : '';
    }).filter(Boolean);
    out += `  Day ${i + 1}: ${day.name || ''}${dur} — ${labels.join(', ')}\n`;
  }
  return out + '\n';
}

function weeksBetweenDates(startYmd, endYmd) {
  const s = new Date(startYmd + 'T00:00:00Z');
  const e = new Date(endYmd + 'T00:00:00Z');
  if (isNaN(s) || isNaN(e)) return 0;
  const days = Math.round((e - s) / 86400000);
  return Math.max(0, Math.floor(days / 7));
}

function formatVerbatimHistory(workouts, activePlan, verbatimWeeks) {
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

function formatSummarizedHistory(workouts) {
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
function formatVolumeByMuscleGroup(workouts, historyWeeks) {
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

function formatUserInputs(userInputs) {
  if (!userInputs) return '';
  // Training days and history weeks are ALWAYS emitted — they drive plan
  // structure and context window, so Claude needs them even on the "bare"
  // call (no optional inputs). Start date / duration / notes only emit when
  // the user set them; the cached system prompt handles their defaults.
  const parts = [];
  parts.push(`Training days: ${userInputs.trainingDays}`);
  parts.push(`History context: ${userInputs.historyWeeks} week${userInputs.historyWeeks === 1 ? '' : 's'} of data in this prompt`);
  if (userInputs.startDate) parts.push(`Plan intended start date: ${userInputs.startDate}`);
  if (userInputs.targetDuration) parts.push(`Target session duration: ${userInputs.targetDuration} min`);
  if (userInputs.notes) parts.push(`Notes from client: "${userInputs.notes}"`);
  return '\nUSER INPUTS FOR THIS WEEK\n' + parts.map(p => '  ' + p).join('\n') + '\n';
}

function formatExerciseLibrary(exercises) {
  let out = 'AVAILABLE EXERCISES (use only these names, verbatim — preserve capitalization)\n';
  for (const e of exercises) {
    out += `- ${e.name} | ${e.equipment || '-'} | ${e.muscle_group || '-'} | ${e.movement_pattern || '-'} | weight_mode=${e.weight_mode || 'total'}\n`;
  }
  return out + '\n';
}

// ---- Analyze mode ----
// Written assessment of the client's recent training. Same model + context
// depth as plan-gen (Sonnet, configurable history window, optional photos)
// but narrower output — ~500-800 tokens of structured JSON with trends /
// progressing / concerns / next_week sections. User can copy next_week
// forward into plan-gen's notes field to chain analysis → plan.
const ANALYZE_MAX_TOKENS = 1400;  // 400 headroom vs the pre-profile-updates budget
// Analyze mode pulls more progress photos than plan-gen so Claude can
// compare them chronologically for over-time observations. 4 keeps token
// cost bounded (~6-8K image tokens at this count) while giving a useful
// sequence across a typical 4-week history window.
const ANALYZE_PROGRESS_PHOTO_LIMIT = 4;

async function handleAnalyze(res, userId, rawInputs) {
  var requestedModel = (rawInputs && rawInputs.model) || null;
  var model = resolveModel(requestedModel, 'analyze');
  if (requestedModel && requestedModel !== model) {
    console.warn('generate-plan/analyze: model fallback', { requested: requestedModel, resolved: model });
  }

  const historyWeeks = clampInt(rawInputs.history_weeks, MIN_HISTORY_WEEKS, MAX_HISTORY_WEEKS, DEFAULT_HISTORY_WEEKS);
  const verbatimWeeks = Math.min(MAX_VERBATIM_WEEKS, historyWeeks);
  // Analyze-mode inputs: history_weeks (sets the window), optional notes
  // (user questions / focus areas — NOT programming constraints), and
  // optional photos. training_days / target_duration / start_date are
  // forward-looking for plan-gen and intentionally dropped upstream by the
  // frontend so they don't bleed into the analyze prompt's reasoning.
  const notes = (typeof rawInputs.notes === 'string' && rawInputs.notes.trim())
    ? rawInputs.notes.trim().slice(0, 500) : null;
  const includePhotos = rawInputs.include_photos === false ? false : true;

  const t0 = Date.now();
  const [activePlan, history, exercises, photos, coachHistory, coachingProfile, userTemplates] = await Promise.all([
    fetchActivePlan(userId),
    fetchRecentWorkouts(userId, historyWeeks),
    fetchExerciseLibrary(userId),
    includePhotos
      ? fetchPhysiquePhotos(userId, ANALYZE_PROGRESS_PHOTO_LIMIT)
      : Promise.resolve({ goal: null, progress: [] }),
    fetchRecentCoachHistory(userId, 2),
    fetchCoachingProfile(userId),
    fetchUserTemplates(userId),
  ]);
  console.log('[generate-plan:analyze] data fetch:', Date.now() - t0, 'ms', '· history_weeks:', historyWeeks, '· include_photos:', includePhotos, '· progress_photos:', (photos.progress || []).length, '· coach_msgs:', coachHistory.length, '· profile:', coachingProfile ? 'yes' : 'no', '· templates:', userTemplates.length);

  if (!history.length) {
    return jsonError(res, 400, `No workouts in the last ${historyWeeks} weeks. Try a wider history window or generate a fresh plan first.`);
  }

  const t1 = Date.now();
  const userMessage = await buildAnalyzeUserMessage({ activePlan, history, exercises, photos, historyWeeks, verbatimWeeks, notes, coachHistory, coachingProfile, userTemplates });
  console.log('[generate-plan:analyze] prompt build:', Date.now() - t1, 'ms');

  const t2 = Date.now();
  const claudeAbort = new AbortController();
  const claudeTimeout = setTimeout(() => claudeAbort.abort(), 55000);
  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: ANALYZE_MAX_TOKENS,
        ...(modelSupportsTemperature(model) ? { temperature: TEMPERATURE } : {}),
        system: [{
          type: 'text',
          text: SYSTEM_PROMPT_ANALYZE,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: claudeAbort.signal,
    });
  } catch (err) {
    clearTimeout(claudeTimeout);
    if (err && err.name === 'AbortError') {
      console.error('[generate-plan:analyze] TIMEOUT after', Date.now() - t2, 'ms');
      return jsonError(res, 504, 'AI service timed out. Try again — cache should be warm on the next call.');
    }
    throw err;
  }
  clearTimeout(claudeTimeout);

  if (!claudeRes.ok) {
    const errBody = await claudeRes.text();
    console.error('[generate-plan:analyze] Claude API error', claudeRes.status, errBody);
    return jsonError(res, 502, 'AI service unavailable', { detail: errBody });
  }

  const claudeData = await claudeRes.json();
  console.log('[generate-plan:analyze] claude call:', Date.now() - t2, 'ms · usage:', JSON.stringify(claudeData.usage || {}));

  if (claudeData.stop_reason === 'max_tokens') {
    return jsonError(res, 422, 'Analysis truncated (max_tokens hit). Try again.', { raw: claudeData });
  }

  const rawText = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
  if (!rawText) return jsonError(res, 422, 'No text in analyze response', { raw: claudeData });

  let analysis;
  try {
    analysis = JSON.parse(stripJsonFences(rawText));
  } catch {
    return jsonError(res, 422, 'Analysis response was not valid JSON', { raw: rawText });
  }

  const validationError = validateAnalysis(analysis);
  if (validationError) {
    return jsonError(res, 422, 'Analysis validation failed: ' + validationError, { raw: rawText });
  }

  return res.status(200).json({
    analysis,
    weeks_analyzed: historyWeeks,
    include_photos: includePhotos,
    model: model,
    usage: claudeData.usage || null,
    generated_at: new Date().toISOString(),
  });
}

// Follow-up Q&A on a delivered analysis (v3.5.3). Rides the same Anthropic
// prompt cache as `analyze` (system-prompt-analyze.md + library block at
// the same cache_control breakpoint) so per-turn input cost on the cached
// prefix stays at ~10% of cold rate. The cached SYSTEM_PROMPT_ANALYZE
// describes both modes via its TWO REQUEST TYPES section; this handler
// just builds a slimmed dynText (skipping verbatim/summarized history —
// the original analysis already synthesized those) and ends with a
// "FOLLOW-UP QUESTION" trailer instead of the JSON trailer so Claude
// flips to free-form output.
async function handleAnalyzeChat(res, userId, rawInputs) {
  var requestedModel = (rawInputs && rawInputs.model) || null;
  var model = resolveModel(requestedModel, 'analyze');
  if (requestedModel && requestedModel !== model) {
    console.warn('generate-plan/analyze_chat: model fallback', { requested: requestedModel, resolved: model });
  }

  const original = rawInputs && rawInputs.original_analysis;
  if (!original || typeof original !== 'object') {
    return jsonError(res, 400, 'Missing original_analysis');
  }
  const question = (typeof rawInputs.question === 'string' ? rawInputs.question.trim() : '').slice(0, 1000);
  if (!question) return jsonError(res, 400, 'Empty question');

  const qaHistoryRaw = Array.isArray(rawInputs.qa_history) ? rawInputs.qa_history : [];
  const qaHistory = [];
  for (let i = 0; i < qaHistoryRaw.length && qaHistory.length < 20; i++) {
    const m = qaHistoryRaw[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (typeof m.content !== 'string' || !m.content) continue;
    qaHistory.push({ role: m.role, content: m.content.slice(0, 4000) });
  }

  const historyWeeks = clampInt(rawInputs.history_weeks, MIN_HISTORY_WEEKS, MAX_HISTORY_WEEKS, DEFAULT_HISTORY_WEEKS);

  const t0 = Date.now();
  const [activePlan, history, exercises, coachHistory, coachingProfile, userTemplates] = await Promise.all([
    fetchActivePlan(userId),
    fetchRecentWorkouts(userId, historyWeeks),
    fetchExerciseLibrary(userId),
    fetchRecentCoachHistory(userId, 2),
    fetchCoachingProfile(userId),
    fetchUserTemplates(userId),
  ]);
  console.log('[generate-plan:analyze_chat] data fetch:', Date.now() - t0, 'ms', '· history_weeks:', historyWeeks, '· qa_turns:', qaHistory.length, '· coach_msgs:', coachHistory.length, '· templates:', userTemplates.length);

  const t1 = Date.now();
  const userMessage = buildAnalyzeChatUserMessage({
    activePlan, history, exercises, coachHistory, coachingProfile, userTemplates,
    historyWeeks, original, qaHistory, question,
  });
  console.log('[generate-plan:analyze_chat] prompt build:', Date.now() - t1, 'ms');

  const t2 = Date.now();
  const claudeAbort = new AbortController();
  const claudeTimeout = setTimeout(() => claudeAbort.abort(), 55000);
  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 600,  // conversational follow-ups are short by design
        ...(modelSupportsTemperature(model) ? { temperature: TEMPERATURE } : {}),
        system: [{
          type: 'text',
          text: SYSTEM_PROMPT_ANALYZE,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: claudeAbort.signal,
    });
  } catch (err) {
    clearTimeout(claudeTimeout);
    if (err && err.name === 'AbortError') {
      console.error('[generate-plan:analyze_chat] TIMEOUT after', Date.now() - t2, 'ms');
      return jsonError(res, 504, 'AI service timed out. Try again.');
    }
    throw err;
  }
  clearTimeout(claudeTimeout);

  if (!claudeRes.ok) {
    const errBody = await claudeRes.text();
    console.error('[generate-plan:analyze_chat] Claude API error', claudeRes.status, errBody);
    return jsonError(res, 502, 'AI service unavailable', { detail: errBody });
  }

  const claudeData = await claudeRes.json();
  console.log('[generate-plan:analyze_chat] claude call:', Date.now() - t2, 'ms · usage:', JSON.stringify(claudeData.usage || {}));

  const rawText = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
  if (!rawText) return jsonError(res, 422, 'No text in analyze_chat response', { raw: claudeData });

  return res.status(200).json({
    reply: rawText.trim(),
    model: model,
    usage: claudeData.usage || null,
    generated_at: new Date().toISOString(),
  });
}

function buildAnalyzeChatUserMessage({ activePlan, history, exercises, coachHistory, coachingProfile, userTemplates, historyWeeks, original, qaHistory, question }) {
  const content = [];

  // Same cache breakpoint as analyze: library block first, identical
  // content + cache_control. Keeps the analyze cache hot across both
  // modes — initial analyze writes, follow-ups ride.
  content.push({
    type: 'text',
    text: formatExerciseLibrary(exercises),
    cache_control: { type: 'ephemeral', ttl: '1h' },
  });

  let dynText = '';
  dynText += formatCoachingProfile(coachingProfile);
  if (activePlan) dynText += formatCurrentPlan(activePlan);
  // Volume-by-muscle is the most-likely follow-up topic given v3.5.x; keep
  // it present and cheap. Skip verbatim + summarized history -- the
  // ORIGINAL ANALYSIS below already synthesized those.
  dynText += formatVolumeByMuscleGroup(history, historyWeeks);
  dynText += formatCoachHistory(coachHistory);
  dynText += formatUserTemplates(userTemplates);

  // The four-section analysis the client just received. Sonnet can cite
  // its own prior phrasing back to the user without the user having to
  // restate it.
  dynText += 'ORIGINAL ANALYSIS (just delivered to the client):\n';
  if (original.trends) dynText += `TRENDS: ${original.trends}\n\n`;
  if (original.progressing) dynText += `PROGRESSING: ${original.progressing}\n\n`;
  if (original.concerns) dynText += `CONCERNS: ${original.concerns}\n\n`;
  if (original.next_week) dynText += `NEXT WEEK FOCUS: ${original.next_week}\n\n`;

  if (qaHistory.length) {
    dynText += 'PRIOR FOLLOW-UPS (this conversation, in order):\n';
    for (const m of qaHistory) {
      const who = m.role === 'user' ? 'You' : 'Coach';
      dynText += `${who}: ${m.content}\n\n`;
    }
  }

  dynText += `FOLLOW-UP QUESTION:\n${question}\n\n`;
  dynText += 'Answer conversationally — no JSON, no four-section structure, no markdown fences. Plain text. 2-4 sentences typically; longer only if the question demands depth. Reference specific numbers and exercise names when relevant.\n';

  content.push({ type: 'text', text: dynText });
  return content;
}

async function buildAnalyzeUserMessage({ activePlan, history, exercises, photos, historyWeeks, verbatimWeeks, notes, coachHistory, coachingProfile, userTemplates }) {
  const content = [];
  const { verbatim, summarized } = splitHistoryByRecency(history, verbatimWeeks);

  // Breakpoint 2: library block shares the same cache entry approach as
  // plan-gen. Analyze and plan each have distinct system prompts so they
  // don't share the full prefix, but the library block can still be cached
  // within the analyze call stream.
  content.push({
    type: 'text',
    text: formatExerciseLibrary(exercises),
    cache_control: { type: 'ephemeral', ttl: '1h' },
  });

  let dynText = '';
  dynText += formatCoachingProfile(coachingProfile);
  if (activePlan) dynText += formatCurrentPlan(activePlan);
  dynText += formatVerbatimHistory(verbatim, activePlan, verbatimWeeks);
  dynText += formatSummarizedHistory(summarized);
  dynText += formatVolumeByMuscleGroup(history, historyWeeks);
  dynText += formatCoachHistory(coachHistory);
  dynText += formatUserTemplates(userTemplates);
  dynText += formatAnalyzeInputs({ historyWeeks, notes });
  dynText += '\nProduce the analysis per your instructions. Return ONLY the JSON object. No preamble, no markdown fences.\n';
  content.push({ type: 'text', text: dynText });

  // Photos — analyze mode includes multiple progress photos in chronological
  // order (oldest → newest) so Claude can compare them to each other over
  // time AND compare the latest to the goal. Fetch ordering from
  // fetchPhysiquePhotos is DESC by taken_at (latest first) so we reverse
  // for chronological display. Each progress photo is labeled with its
  // date AND its sequence index so the prompt makes the ordering unambiguous.
  const progressAll = (photos && Array.isArray(photos.progress)) ? photos.progress.slice() : [];
  const progressChrono = progressAll.reverse();  // oldest first
  const latestProgress = progressAll.length ? progressAll[progressAll.length - 1] : null;

  const downloadPromises = [];
  downloadPromises.push(photos && photos.goal ? downloadPhotoAsBase64(photos.goal.storage_path) : Promise.resolve(null));
  for (const p of progressChrono) {
    downloadPromises.push(downloadPhotoAsBase64(p.storage_path));
  }
  const downloaded = await Promise.all(downloadPromises);
  const goalImg = downloaded[0];
  const progressImgs = downloaded.slice(1);

  if (photos && photos.goal && goalImg) {
    content.push({ type: 'text', text: `GOAL PHYSIQUE photo (uploaded ${String(photos.goal.taken_at).slice(0, 10)}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: goalImg.mime, data: goalImg.base64 } });
  }
  for (let i = 0; i < progressChrono.length; i++) {
    const img = progressImgs[i];
    if (!img) continue;
    const p = progressChrono[i];
    const isLatest = latestProgress && p.id === latestProgress.id;
    const label = progressChrono.length === 1
      ? `CURRENT PROGRESS photo (${String(p.taken_at).slice(0, 10)}):`
      : `PROGRESS photo ${i + 1} of ${progressChrono.length}${isLatest ? ' (LATEST)' : ''} (${String(p.taken_at).slice(0, 10)}):`;
    content.push({ type: 'text', text: label });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
  }

  return content;
}

function formatAnalyzeInputs({ historyWeeks, notes }) {
  const parts = [];
  parts.push(`History context: ${historyWeeks} week${historyWeeks === 1 ? '' : 's'} of data in this prompt`);
  if (notes) parts.push(`Notes from client: "${notes}"`);
  return '\nUSER INPUTS FOR ANALYSIS\n' + parts.map(p => '  ' + p).join('\n') + '\n';
}

function validateAnalysis(a) {
  if (!a || typeof a !== 'object') return 'analysis is not an object';
  const required = ['trends', 'progressing', 'concerns', 'next_week'];
  for (const key of required) {
    if (typeof a[key] !== 'string' || !a[key].trim()) return `missing or empty ${key}`;
  }
  // profile_updates is a new optional field (v2.5 layer 3). Prompt says
  // "return as empty array when nothing warrants a proposal", but we
  // tolerate a missing field for backward compat with any in-flight
  // cached prompts from before the spec extension. When present, it
  // must be an array of valid update objects.
  if (a.profile_updates != null) {
    if (!Array.isArray(a.profile_updates)) return 'profile_updates must be an array';
    for (let i = 0; i < a.profile_updates.length; i++) {
      const err = validateProfileUpdate(a.profile_updates[i]);
      if (err) return `profile_updates[${i}]: ${err}`;
    }
  } else {
    // Normalize missing to empty so downstream (frontend + response) never
    // has to null-check.
    a.profile_updates = [];
  }
  return null;
}

// Valid field names per the system-prompt-analyze.md spec. Fields not in
// this list (sex, height, experience_level) are explicitly off-limits to
// Claude per the prompt — if one slips through, reject the whole response
// rather than silently applying a forbidden update.
const PROFILE_UPDATE_FIELDS = new Set([
  'weight_lbs', 'phase', 'phase_start_date', 'phase_notes',
  'goal_type', 'goal_detail', 'split_preference', 'environment',
  'special_instructions',
  'injury_add', 'injury_remove', 'injury_update',
]);

function validateProfileUpdate(u) {
  if (!u || typeof u !== 'object') return 'not an object';
  if (typeof u.field !== 'string' || !PROFILE_UPDATE_FIELDS.has(u.field)) {
    return `invalid field "${u.field}"`;
  }
  if (typeof u.reasoning !== 'string' || !u.reasoning.trim()) {
    return 'missing or empty reasoning';
  }
  // Type rules per field:
  //   injury_add:    current = null, proposed = { name, notes }
  //   injury_remove: current = { name, notes }, proposed = null
  //   injury_update: both { name, notes }, same name
  //   scalar:        either current or proposed is defined; we don't
  //                  require current (profile may be empty at first)
  if (u.field === 'injury_add') {
    if (u.current != null) return 'injury_add: current must be null';
    if (!u.proposed || typeof u.proposed !== 'object' || !u.proposed.name) {
      return 'injury_add: proposed must be { name, notes }';
    }
  } else if (u.field === 'injury_remove') {
    if (!u.current || typeof u.current !== 'object' || !u.current.name) {
      return 'injury_remove: current must be { name, notes }';
    }
    if (u.proposed !== null && u.proposed !== undefined) {
      return 'injury_remove: proposed must be null';
    }
  } else if (u.field === 'injury_update') {
    if (!u.current || !u.current.name || !u.proposed || !u.proposed.name) {
      return 'injury_update: current and proposed must both be { name, notes }';
    }
    if (u.current.name !== u.proposed.name) {
      return 'injury_update: current.name and proposed.name must match';
    }
  }
  // Scalars: no further validation here. Frontend renders current -> proposed
  // and applies by field name. Null proposed on a scalar means "clear the
  // field" which is valid.
  return null;
}

// ---- Swap mode ----
// Separate workflow from plan generation: single-exercise replacement with
// its own system prompt, 500-token budget, and validation. Shares
// fetchExerciseLibrary + fetchRecentWorkouts with the main path but builds
// a narrower user message.
async function handleSwap(res, userId, rawInputs) {
  var requestedModel = (rawInputs && rawInputs.model) || null;
  var model = resolveModel(requestedModel, 'plan');
  if (requestedModel && requestedModel !== model) {
    console.warn('generate-plan/swap: model fallback', { requested: requestedModel, resolved: model });
  }

  const exercise = rawInputs.exercise;
  if (!exercise || typeof exercise !== 'object' || !exercise.name) {
    return jsonError(res, 400, 'Missing exercise to replace');
  }
  const reason = typeof rawInputs.reason === 'string' ? rawInputs.reason.trim().slice(0, 200) : '';
  const dayName = typeof rawInputs.day_name === 'string' ? rawInputs.day_name.slice(0, 120) : '';

  // Swap workout-history window: client-controlled via coaching_profile
  // (v3.5.2). Frontend sends `coach_context_weeks` in the payload when the
  // user has set it; server clamps 1-12 defensively and falls back to
  // SWAP_HISTORY_WEEKS when absent. Same value is also surfaced in
  // buildCoachContext on the frontend so coach chat sees the matching
  // window — one knob in the Coaching Profile screen, two consumers.
  let swapHistoryWeeks = SWAP_HISTORY_WEEKS;
  if (Number.isFinite(rawInputs && rawInputs.coach_context_weeks)) {
    swapHistoryWeeks = Math.max(1, Math.min(12, rawInputs.coach_context_weeks));
  }

  const t0 = Date.now();
  const [activePlan, history, exercises, coachHistory, coachingProfile] = await Promise.all([
    fetchActivePlan(userId),
    fetchRecentWorkouts(userId, swapHistoryWeeks),
    fetchExerciseLibrary(userId),
    fetchRecentCoachHistory(userId, 2),
    fetchCoachingProfile(userId),
  ]);
  console.log('[generate-plan:swap] data fetch:', Date.now() - t0, 'ms', '· history_weeks:', swapHistoryWeeks, '· coach_msgs:', coachHistory.length, '· profile:', coachingProfile ? 'yes' : 'no');

  const libraryNames = new Set(exercises.map(e => e.name));

  // Compute other exercises on the same day so Claude avoids duplicates.
  // Frontend can pass `other_today` directly when the swap source is a
  // plan-in-review (post-Generate, pre-Accept) since that plan only
  // exists in the frontend; the DB lookup below would find nothing or
  // pull from a coincidentally-named day in a stale active plan. When
  // the payload omits `other_today`, fall back to the DB active plan
  // matched by dayName (live-tracker swap path).
  let otherToday = [];
  if (Array.isArray(rawInputs && rawInputs.other_today)) {
    otherToday = rawInputs.other_today
      .filter(n => typeof n === 'string' && n && n !== exercise.name)
      .slice(0, 30);  // defensive cap
  } else if (activePlan && activePlan.data && Array.isArray(activePlan.data.days)) {
    for (const d of activePlan.data.days) {
      if (d.name === dayName && Array.isArray(d.exercises)) {
        otherToday = d.exercises
          .map(e => e && e.name)
          .filter(n => n && n !== exercise.name);
        break;
      }
    }
  }

  const movementHistory = summarizeMovementHistory(history, exercise.movement_pattern, exercise.muscle_group);

  const t1 = Date.now();
  const userText = buildSwapUserMessage({ exercise, reason, dayName, otherToday, movementHistory, coachHistory, coachingProfile });
  const userContent = [
    // Library block is cached (same 1h TTL pattern as plan generation).
    // Multiple swaps within an hour reuse this cache entry as long as the
    // library hasn't changed.
    { type: 'text', text: formatExerciseLibrary(exercises), cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: userText },
  ];
  console.log('[generate-plan:swap] prompt build:', Date.now() - t1, 'ms');

  const t2 = Date.now();
  const claudeAbort = new AbortController();
  const claudeTimeout = setTimeout(() => claudeAbort.abort(), 55000);
  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: SWAP_MAX_TOKENS,
        ...(modelSupportsTemperature(model) ? { temperature: TEMPERATURE } : {}),
        system: [{
          type: 'text',
          text: SWAP_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: claudeAbort.signal,
    });
  } catch (err) {
    clearTimeout(claudeTimeout);
    if (err && err.name === 'AbortError') {
      console.error('[generate-plan:swap] claude call: TIMEOUT after', Date.now() - t2, 'ms');
      return jsonError(res, 504, 'AI service timed out. Try again — cache should be warm on the next call.');
    }
    throw err;
  }
  clearTimeout(claudeTimeout);

  if (!claudeRes.ok) {
    const errBody = await claudeRes.text();
    console.error('[generate-plan:swap] Claude API error', claudeRes.status, errBody);
    return jsonError(res, 502, 'AI service unavailable', { detail: errBody });
  }

  const claudeData = await claudeRes.json();
  console.log('[generate-plan:swap] claude call:', Date.now() - t2, 'ms · usage:', JSON.stringify(claudeData.usage || {}));

  if (claudeData.stop_reason === 'max_tokens') {
    return jsonError(res, 422, 'Response truncated (max_tokens hit). Try again.', { raw: claudeData });
  }

  const rawText = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
  if (!rawText) return jsonError(res, 422, 'No text in swap response', { raw: claudeData });

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFences(rawText));
  } catch {
    return jsonError(res, 422, 'Swap response was not valid JSON', { raw: rawText });
  }

  const options = parsed && Array.isArray(parsed.options) ? parsed.options : null;
  const validationError = validateSwapOptions(options, libraryNames, exercise.name, otherToday);
  if (validationError) {
    return jsonError(res, 422, 'Swap validation failed: ' + validationError, { raw: rawText });
  }

  // Expand repeat: N shorthand into N identical set objects so the client
  // receives the canonical fully-expanded shape — matches plan-generation
  // output and keeps the client-side contract uniform.
  for (const opt of options) expandSetRepeatsForOneExercise(opt);

  return res.status(200).json({
    options,
    replaced: exercise.name,
    reason: reason || null,
    model: model,
    usage: claudeData.usage || null,
    generated_at: new Date().toISOString(),
  });
}

// ---- Refine mode ----
// Iterative plan refinement. Frontend keeps the multi-turn conversation in
// memory and replays it to the server on each refine call. Server
// reconstructs the SAME first-user-message that the original generate
// produced (so the cached prefix hits), appends the prior iterations as
// alternating assistant (plan JSON) / user (feedback) turns, then appends
// the latest assistant turn (current plan) and the new user feedback.
//
// Cache strategy (4 breakpoints max):
//   1. system prompt (SYSTEM_PROMPT_PLAN) — same as plan-gen
//   2. library block in the first user message — same as plan-gen
//   3. (iter ≥ 2) the previous assistant turn — caches the prior plan so
//      iter N+1 reuses iter N's emission as part of the prefix
//
// Anthropic's prefix-based cache means iters 1+ within an hour pay only
// the new user feedback + new assistant response in input tokens.
//
// Output shape (Claude returns this shape, server forwards):
//   { plan: <revised plan JSON>, change_notes: "<2-4 sentence explanation>" }

const REFINE_MAX_TOKENS = MAX_TOKENS;
const MAX_REFINE_FEEDBACK_LENGTH = 2000;
const MAX_REFINE_ITERATIONS = 10;  // Hard cap to bound payload size and token bloat

async function handleRefine(res, userId, rawInputs) {
  var requestedModel = (rawInputs && rawInputs.model) || null;
  var model = resolveModel(requestedModel, 'plan');
  if (requestedModel && requestedModel !== model) {
    console.warn('generate-plan/refine: model fallback', { requested: requestedModel, resolved: model });
  }

  const currentPlan = rawInputs.current_plan;
  if (!currentPlan || typeof currentPlan !== 'object') {
    return jsonError(res, 400, 'current_plan required (full plan JSON from latest iteration)');
  }
  const newFeedback = (typeof rawInputs.new_feedback === 'string') ? rawInputs.new_feedback.trim() : '';
  if (!newFeedback) return jsonError(res, 400, 'new_feedback required');
  if (newFeedback.length > MAX_REFINE_FEEDBACK_LENGTH) {
    return jsonError(res, 400, `new_feedback too long (max ${MAX_REFINE_FEEDBACK_LENGTH} chars)`);
  }

  // iteration_history: array of { plan, feedback } pairs from prior iters.
  // [] on the first refine call. Each entry's `plan` is what was shown to
  // the user before that feedback was given; `feedback` is what they said.
  // Server reconstructs assistant turns from these.
  const iterationHistory = Array.isArray(rawInputs.iteration_history) ? rawInputs.iteration_history : [];
  if (iterationHistory.length > MAX_REFINE_ITERATIONS) {
    return jsonError(res, 400, `too many iterations (max ${MAX_REFINE_ITERATIONS})`);
  }

  // Reconstruct the original user inputs so the FIRST user turn matches
  // the initial plan-gen call exactly (cache hit on the cached prefix).
  // Frontend sends these unchanged from the original generate.
  const userInputs = {
    startDate: typeof rawInputs.start_date === 'string' ? rawInputs.start_date.slice(0, 10) : null,
    targetDuration: Number.isFinite(rawInputs.target_duration) ? rawInputs.target_duration : null,
    notes: (typeof rawInputs.notes === 'string' && rawInputs.notes.trim()) ? rawInputs.notes.trim().slice(0, 500) : null,
    trainingDays: clampInt(rawInputs.training_days, MIN_TRAINING_DAYS, MAX_TRAINING_DAYS, DEFAULT_TRAINING_DAYS),
    historyWeeks: clampInt(rawInputs.history_weeks, MIN_HISTORY_WEEKS, MAX_HISTORY_WEEKS, DEFAULT_HISTORY_WEEKS),
    includePhotos: rawInputs.include_photos === false ? false : true,
  };
  const verbatimWeeks = Math.min(MAX_VERBATIM_WEEKS, userInputs.historyWeeks);

  // Same parallel fetch as the initial plan-gen path. We refetch on every
  // refine call rather than trusting the frontend to send the prefix bytes
  // verbatim — keeps the Edge Function the source of truth and means a
  // workout logged between the initial generate and a refinement is
  // visible to Claude on the next iteration.
  const t0 = Date.now();
  const [activePlan, history, exercises, photos, coachHistory, coachingProfile] = await Promise.all([
    fetchActivePlan(userId),
    fetchRecentWorkouts(userId, userInputs.historyWeeks),
    fetchExerciseLibrary(userId),
    userInputs.includePhotos ? fetchPhysiquePhotos(userId) : Promise.resolve({ goal: null, progress: [] }),
    fetchRecentCoachHistory(userId, 2),
    fetchCoachingProfile(userId),
  ]);
  console.log('[generate-plan:refine] data fetch:', Date.now() - t0, 'ms', '· iterations_so_far:', iterationHistory.length, '· coach_msgs:', coachHistory.length, '· profile:', coachingProfile ? 'yes' : 'no');

  // No activePlan check: refine targets the plan-in-flight (rawInputs.current_plan,
  // already validated at the top of this handler), not whatever is saved in the
  // DB. Pre-v3.4.3 this bailed with "No active plan" when a user generated a
  // brand-new plan in no-plan state and immediately tried to refine the review.
  // buildUserMessage is null-safe for activePlan (v3.3.0 cold-start path).

  // Build the FIRST user message exactly as the initial plan-gen call did.
  // buildUserMessage returns an array of content blocks (library block has
  // its own cache_control); we keep that shape so the cached prefix matches.
  const t1 = Date.now();
  const initialUserContent = await buildUserMessage({
    activePlan, history, exercises, photos, userInputs, verbatimWeeks, coachHistory, coachingProfile,
  });

  // Assemble the messages array. Each prior iteration adds an assistant
  // turn (the plan that was shown) and a user turn (the feedback that was
  // given). The latest assistant turn is currentPlan; the latest user
  // turn is the newFeedback wrapped in the refine instruction.
  const messages = [
    { role: 'user', content: initialUserContent },
  ];
  for (let i = 0; i < iterationHistory.length; i++) {
    const turn = iterationHistory[i];
    if (!turn || typeof turn !== 'object') continue;
    const planJson = JSON.stringify(turn.plan || {});
    const feedback = (typeof turn.feedback === 'string') ? turn.feedback : '';
    messages.push({ role: 'assistant', content: planJson });
    messages.push({ role: 'user', content: buildRefineUserText(feedback) });
  }
  // Latest pair: current plan as assistant turn, new feedback as user turn.
  // Add cache_control on the latest assistant turn so iter N+1 reuses it.
  messages.push({
    role: 'assistant',
    content: [
      { type: 'text', text: JSON.stringify(currentPlan), cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
  });
  messages.push({ role: 'user', content: buildRefineUserText(newFeedback) });
  console.log('[generate-plan:refine] prompt build:', Date.now() - t1, 'ms · turns:', messages.length);

  const t2 = Date.now();
  const claudeAbort = new AbortController();
  const claudeTimeout = setTimeout(() => claudeAbort.abort(), 55000);
  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: REFINE_MAX_TOKENS,
        ...(modelSupportsTemperature(model) ? { temperature: TEMPERATURE } : {}),
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT_PLAN,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: messages,
      }),
      signal: claudeAbort.signal,
    });
  } catch (err) {
    clearTimeout(claudeTimeout);
    if (err && err.name === 'AbortError') {
      console.error('[generate-plan:refine] TIMEOUT after', Date.now() - t2, 'ms');
      return jsonError(res, 504, 'AI service timed out (55s). Try again.');
    }
    throw err;
  }
  clearTimeout(claudeTimeout);

  if (!claudeRes.ok) {
    const errBody = await claudeRes.text();
    console.error('[generate-plan:refine] Claude API error', claudeRes.status, errBody);
    return jsonError(res, 502, 'AI service unavailable', { detail: errBody });
  }

  const claudeData = await claudeRes.json();
  console.log('[generate-plan:refine] claude call:', Date.now() - t2, 'ms · usage:', JSON.stringify(claudeData.usage || {}));

  if (claudeData.stop_reason === 'max_tokens') {
    return jsonError(res, 422, 'Response truncated (max_tokens hit). Refined plan may be incomplete.', { raw: claudeData });
  }

  const rawText = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
  if (!rawText) return jsonError(res, 422, 'No text in refine response', { raw: claudeData });

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFences(rawText));
  } catch {
    return jsonError(res, 422, 'Refine response was not valid JSON', { raw: rawText });
  }

  // Refine response shape: { plan, change_notes }. Extract and validate.
  const revisedPlan = parsed && parsed.plan;
  const changeNotes = (parsed && typeof parsed.change_notes === 'string')
    ? parsed.change_notes.trim() : '';
  if (!revisedPlan || typeof revisedPlan !== 'object') {
    return jsonError(res, 422, 'Refine response missing plan field', { raw: rawText });
  }

  // Day-count strictness is intentionally skipped in refine mode. User
  // feedback IS the source of truth for what they want — if they ask to
  // change "5 days to 1 day", Claude correctly emits a 1-day plan and
  // validating against the original trainingDays would wrongly reject it.
  // Every other structural check (days exist, names present, sets non-
  // empty, etc.) still runs via validatePlan(plan, null).
  const validationError = validatePlan(revisedPlan, null);
  if (validationError) {
    return jsonError(res, 422, 'Refined plan validation failed: ' + validationError, { raw: rawText });
  }
  expandSetRepeats(revisedPlan);

  return res.status(200).json({
    plan: revisedPlan,
    change_notes: changeNotes,
    weeks_analyzed: userInputs.historyWeeks,
    training_days: userInputs.trainingDays,
    include_photos: userInputs.includePhotos,
    iterations: iterationHistory.length + 1,
    model: model,
    usage: claudeData.usage || null,
    generated_at: new Date().toISOString(),
  });
}

// User-message text wrapping each refine feedback. Tells Claude what shape
// to return (overrides the plan-only output of system-prompt-plan.md) and
// frames the feedback as a focused revision request — keep everything the
// client did NOT ask to change.
function buildRefineUserText(feedback) {
  return `REVISION REQUEST

The client wants to revise the plan above. Their feedback for THIS revision:

"${feedback}"

Apply ONLY the requested changes. Keep everything else the client did NOT ask to change. The revised plan must satisfy ALL the same RULES as the original (USER INPUTS day count, exercise library names, weight_mode handling, set count rules, target session duration, no exercise duplicates per day, etc.).

OUTPUT for revision mode (overrides the plain plan-only output of the original instructions):

Return ONLY valid JSON in this exact shape:

{
  "plan": { /* full revised plan JSON, same shape as the original */ },
  "change_notes": "2-4 sentence explanation of what you changed and why, conversational, referencing specific exercises by name. Example: 'Moved pull-ups from Day 1 to Day 3 to keep grip fresh for the heavy pulling. Reduced Day 2 quad volume by removing the second leg extension — total quad sets dropped from 16 to 12.'"
}

No markdown fences, no preamble, no trailing text.
`;
}

function buildSwapUserMessage({ exercise, reason, dayName, otherToday, movementHistory, coachHistory, coachingProfile }) {
  let out = formatCoachingProfile(coachingProfile);
  out += 'EXERCISE TO REPLACE\n';
  out += `Name: ${exercise.name}\n`;
  if (exercise.muscle_group) out += `Muscle group: ${exercise.muscle_group}\n`;
  if (exercise.movement_pattern) out += `Movement pattern: ${exercise.movement_pattern}\n`;
  if (exercise.equipment) out += `Equipment: ${exercise.equipment}\n`;
  if (exercise.weight_mode) out += `Weight mode: ${exercise.weight_mode}\n`;
  if (Array.isArray(exercise.sets) && exercise.sets.length) {
    const setStrs = exercise.sets.map(s => {
      const w = s.weight != null ? s.weight : '?';
      const r = s.reps_target != null ? s.reps_target : (s.reps_range || '?');
      return `${w}×${r}`;
    });
    out += `Current prescription: ${setStrs.join(', ')}\n`;
  }
  out += '\n';

  if (reason) out += `REASON FOR SWAP\n${reason}\n\n`;

  if (dayName) out += `CURRENT DAY\n${dayName}\n\n`;

  if (otherToday.length) {
    out += 'OTHER EXERCISES ON THIS DAY (do NOT suggest any of these)\n';
    for (const n of otherToday) out += `- ${n}\n`;
    out += '\n';
  }

  if (movementHistory) {
    out += 'RECENT HISTORY FOR THIS MOVEMENT PATTERN (use for weight calibration)\n';
    out += movementHistory + '\n\n';
  }

  // Coach history goes after movement context but before the JSON return
  // instruction. formatCoachHistory returns '' for empty input so the prompt
  // stays clean when there's nothing to inject.
  out += formatCoachHistory(coachHistory);

  out += 'Return ONLY the JSON object with the "options" array of exactly 3 ranked replacements. No preamble, no markdown fences, no trailing text.\n';
  return out;
}

// Summarize recent sets for exercises matching the target's movement_pattern
// (fallback: muscle_group). Used for weight calibration on the replacement.
function summarizeMovementHistory(workouts, movementPattern, muscleGroup) {
  const byName = {};
  for (const w of workouts) {
    for (const s of (w.sets || [])) {
      if (!s.done) continue;
      const ex = s.exercises;
      if (!ex) continue;
      const matchesPattern = movementPattern && ex.movement_pattern === movementPattern;
      const matchesMuscle = !movementPattern && muscleGroup && ex.muscle_group === muscleGroup;
      if (!matchesPattern && !matchesMuscle) continue;
      if (!byName[ex.name]) byName[ex.name] = [];
      const w_ = s.weight != null ? s.weight : '?';
      const r_ = s.reps != null ? s.reps : '?';
      byName[ex.name].push(`${w_}×${r_}`);
    }
  }
  const lines = [];
  for (const name of Object.keys(byName)) {
    // Keep the tail (most recent sets). 9 is enough for ~3 sessions of 3 sets.
    const recent = byName[name].slice(-9);
    lines.push(`${name}: ${recent.join(', ')}`);
  }
  return lines.join('\n');
}

function validateSwapReplacement(r, libraryNames, replacedName, otherToday) {
  if (!r || typeof r !== 'object') return 'replacement is not an object';
  if (!r.name || typeof r.name !== 'string') return 'missing name';
  if (!libraryNames.has(r.name)) return `name "${r.name}" is not in the exercise library`;
  if (r.name === replacedName) return `replacement matches the replaced exercise`;
  if (otherToday.indexOf(r.name) !== -1) return `replacement "${r.name}" is already programmed on this day`;
  if (!Number.isFinite(r.rest)) return 'rest must be an integer (seconds)';
  if (!Array.isArray(r.sets) || !r.sets.length) return 'missing or empty sets';
  return null;
}

// Validate the ranked options array: exactly 3, each individually valid,
// no duplicate names across the three (a list of dupes is useless to the
// user). Reuses the single-option validator so the rules can't drift.
function validateSwapOptions(options, libraryNames, replacedName, otherToday) {
  if (!Array.isArray(options)) return 'options is not an array';
  if (options.length !== 3) return `expected exactly 3 options, got ${options.length}`;
  const seen = new Set();
  for (let i = 0; i < options.length; i++) {
    const err = validateSwapReplacement(options[i], libraryNames, replacedName, otherToday);
    if (err) return `option ${i + 1}: ${err}`;
    const nm = options[i].name;
    if (seen.has(nm)) return `duplicate option name "${nm}"`;
    seen.add(nm);
  }
  return null;
}

function expandSetRepeatsForOneExercise(ex) {
  if (!ex || !Array.isArray(ex.sets)) return;
  const expanded = [];
  for (const set of ex.sets) {
    const raw = typeof set.repeat === 'number' ? set.repeat : parseInt(set.repeat, 10);
    const n = Math.min(10, Math.max(1, Number.isFinite(raw) ? raw : 1));
    const clean = { ...set };
    delete clean.repeat;
    for (let i = 0; i < n; i++) expanded.push({ ...clean });
  }
  ex.sets = expanded;
}

// ---- Response parsing / validation ----
function stripJsonFences(text) {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  return m ? m[1].trim() : text.trim();
}

// Expand compact-set notation. A set object with `repeat: N` becomes N
// copies of the same set (without the `repeat` field). Used to keep
// Claude's output small when all sets of an exercise are identical.
// Clamps N to [1, 10] as a defense against model hallucinations.
//
// Recurses into superset block children so the repeat shorthand works
// inside member sets exactly as it does for regular exercises.
function expandSetRepeats(plan) {
  if (!plan || !Array.isArray(plan.days)) return plan;
  for (const day of plan.days) {
    if (!Array.isArray(day.exercises)) continue;
    for (const entry of day.exercises) {
      if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
        for (const child of entry.exercises) expandSetRepeatsForOneExercise(child);
      } else {
        expandSetRepeatsForOneExercise(entry);
      }
    }
  }
  return plan;
}

function validateRegularExercise(e, dayIdx, exIdx) {
  if (!e.name) return `day ${dayIdx + 1} exercise ${exIdx + 1}: missing name`;
  if (!Array.isArray(e.sets) || !e.sets.length) return `day ${dayIdx + 1} exercise "${e.name}": missing or empty sets`;
  return null;
}

function validateSupersetBlock(block, dayIdx, exIdx) {
  if (!Array.isArray(block.exercises) || block.exercises.length < 2) {
    return `day ${dayIdx + 1} block ${exIdx + 1}: superset block must have at least 2 exercises`;
  }
  if (!Number.isInteger(block.rest)) {
    return `day ${dayIdx + 1} block ${exIdx + 1}: superset block rest must be an integer (seconds)`;
  }
  for (let ci = 0; ci < block.exercises.length; ci++) {
    const child = block.exercises[ci];
    if (!child) {
      return `day ${dayIdx + 1} block ${exIdx + 1} member ${ci + 1}: missing entry`;
    }
    if (child.rest != null) {
      return `day ${dayIdx + 1} block ${exIdx + 1} member ${ci + 1}: superset members may not carry their own rest field — use block-level rest`;
    }
    if (child.superset === true) {
      return `day ${dayIdx + 1} block ${exIdx + 1} member ${ci + 1}: nested supersets not supported`;
    }
    const childErr = validateRegularExercise(child, dayIdx, exIdx);
    if (childErr) return childErr;
  }
  return null;
}

function validatePlan(plan, expectedDays) {
  if (!plan || typeof plan !== 'object') return 'plan is not an object';
  if (!plan.title) return 'missing title';
  // v2.3.0: coaching_notes was removed from the plan contract. Analysis
  // is produced by the /mode=analyze call instead. Don't validate it.
  if (!Array.isArray(plan.days) || !plan.days.length) return 'missing or empty days';
  if (Number.isFinite(expectedDays) && plan.days.length !== expectedDays) {
    return `expected ${expectedDays} day${expectedDays === 1 ? '' : 's'}, got ${plan.days.length}`;
  }
  for (let i = 0; i < plan.days.length; i++) {
    const d = plan.days[i];
    if (!d.name) return `day ${i + 1}: missing name`;
    if (!Array.isArray(d.exercises) || !d.exercises.length) return `day ${i + 1}: missing or empty exercises`;
    for (let j = 0; j < d.exercises.length; j++) {
      const e = d.exercises[j];
      if (e && e.superset === true) {
        const blockErr = validateSupersetBlock(e, i, j);
        if (blockErr) return blockErr;
      } else {
        const exErr = validateRegularExercise(e, i, j);
        if (exErr) return exErr;
      }
    }
  }
  return null;
}
