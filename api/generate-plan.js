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

export const maxDuration = 60;  // Claude generation takes ~10-20s; Hobby plan cap.

// ---- Config ----
const MODEL = 'claude-sonnet-4-6';
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
const SWAP_MAX_TOKENS = 500;
const SWAP_HISTORY_WEEKS = 2;  // enough for weight calibration on the movement

const SWAP_SYSTEM_PROMPT = `You are a strength and hypertrophy coach. The client wants to replace one exercise in their plan. Suggest a single alternative that:
1. Targets the same primary muscle group and movement pattern
2. Uses equipment available in the client's exercise library (provided in the user message)
3. Is not already programmed for the same day
4. Has an appropriate weight prescription based on the client's recent history with similar movements

If the client provided a reason for the swap, factor it in:
- "different gym" or "equipment unavailable" → pick an exercise using different equipment
- "knee pain" or injury-related → pick a joint-friendly alternative
- "want variety" → pick something the client hasn't done recently
- No reason given → pick the best general alternative

Return ONLY valid JSON matching this exact structure, no other text (no markdown fences, no preamble, no explanation):
{
  "name": "Chest-Supported Machine Row",
  "note": "Replaces Cable Row — similar horizontal pull, machine-based. Starting at 100 based on prior row history.",
  "rest": 120,
  "sets": [
    {"weight": 100, "reps_target": 12, "reps_range": "10-12", "repeat": 3}
  ]
}

RULES:
- "name" must be an exact, verbatim name from the AVAILABLE EXERCISES list. Preserve capitalization.
- Weight must respect the exercise's weight_mode (per_side = per-hand/per-leg, total = bar/stack load, bodyweight = added load only, none = 0). The AVAILABLE EXERCISES list includes weight_mode for every entry.
- Round weights to realistic gym increments: 2.5-5 lbs for dumbbells / plated barbells, 5-10 lbs for cables / machines. Never decimals like 67.5 for a dumbbell.
- "rest" is an INTEGER in seconds (e.g., 120 for 2 min). Never a string.
- Omit a "unit" field — the app defaults to lbs.
- Use the "repeat": N shorthand when all sets are identical (single set object with repeat: N). Use separate set objects only when sets differ.
- "note" explains why this replacement was chosen and how the weight was derived. Hard cap 20 words.
- Return exactly ONE exercise. Do not offer options, do not hedge, do not list alternatives.
- Do not suggest an exercise that is already programmed on the same day (list provided in the user message).
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

    const t0 = Date.now();
    const [activePlan, history, exercises, photos] = await Promise.all([
      fetchActivePlan(userId),
      fetchRecentWorkouts(userId, userInputs.historyWeeks),
      fetchExerciseLibrary(userId),
      userInputs.includePhotos ? fetchPhysiquePhotos(userId) : Promise.resolve({ goal: null, progress: [] }),
    ]);
    console.log('[generate-plan] data fetch:', Date.now() - t0, 'ms', '· history_weeks:', userInputs.historyWeeks, '· training_days:', userInputs.trainingDays, '· include_photos:', userInputs.includePhotos);

    if (!activePlan) {
      return jsonError(res, 400, 'No active plan. Import a plan before generating.');
    }
    if (!history.length) {
      return jsonError(res, 400, 'No workout history found. Log at least one week of training before generating a plan.');
    }

    const t1 = Date.now();
    const userMessage = await buildUserMessage({ activePlan, history, exercises, photos, userInputs, verbatimWeeks });
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
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
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
      model: MODEL,
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
  const start = new Date();
  start.setDate(start.getDate() - weeks * 7);
  const startStr = start.toISOString().slice(0, 10);
  // PostgREST FK disambiguation (v2.2.1+): sets has two FKs to exercises
  // (exercise_id and prescribed_exercise_id). "!exercise_id" picks the
  // actual-performed FK so the planner sees what the user actually did.
  const select = encodeURIComponent('*,sets(*,exercises!exercise_id(name,equipment,muscle_group,movement_pattern,weight_mode))');
  const res = await sbFetch(
    `/workouts?user_id=eq.${userId}&performed_on=gte.${startStr}&order=performed_on.asc&select=${select}`
  );
  if (!res.ok) throw new Error('Failed to fetch workouts');
  return await res.json();
}

async function fetchExerciseLibrary(userId) {
  // Seed library has user_id IS NULL; user-custom has user_id = userId.
  const res = await sbFetch(
    `/exercises?or=(user_id.is.null,user_id.eq.${userId})&select=name,equipment,muscle_group,movement_pattern,weight_mode&order=name.asc`
  );
  if (!res.ok) throw new Error('Failed to fetch exercise library');
  return await res.json();
}

async function fetchPhysiquePhotos(userId) {
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
  return { goal, progress: progress.slice(0, 1) };  // latest 1 progress in v1 — keep prompt lean
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
async function buildUserMessage({ activePlan, history, exercises, photos, userInputs, verbatimWeeks }) {
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
  let dynText = '';
  dynText += formatCurrentPlan(activePlan);
  dynText += formatVerbatimHistory(verbatim, activePlan, verbatimWeeks);
  dynText += formatSummarizedHistory(summarized);
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
    const exs = Array.isArray(day.exercises) ? day.exercises.map(e => e.name).join(', ') : '';
    out += `  Day ${i + 1}: ${day.name || ''}${dur} — ${exs}\n`;
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
const ANALYZE_MAX_TOKENS = 1000;

async function handleAnalyze(res, userId, rawInputs) {
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
  const [activePlan, history, exercises, photos] = await Promise.all([
    fetchActivePlan(userId),
    fetchRecentWorkouts(userId, historyWeeks),
    fetchExerciseLibrary(userId),
    includePhotos ? fetchPhysiquePhotos(userId) : Promise.resolve({ goal: null, progress: [] }),
  ]);
  console.log('[generate-plan:analyze] data fetch:', Date.now() - t0, 'ms', '· history_weeks:', historyWeeks, '· include_photos:', includePhotos);

  if (!history.length) {
    return jsonError(res, 400, 'No workout history found. Log at least one week of training before requesting an analysis.');
  }

  const t1 = Date.now();
  const userMessage = await buildAnalyzeUserMessage({ activePlan, history, exercises, photos, historyWeeks, verbatimWeeks, notes });
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
        model: MODEL,
        max_tokens: ANALYZE_MAX_TOKENS,
        temperature: TEMPERATURE,
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
    model: MODEL,
    usage: claudeData.usage || null,
    generated_at: new Date().toISOString(),
  });
}

async function buildAnalyzeUserMessage({ activePlan, history, exercises, photos, historyWeeks, verbatimWeeks, notes }) {
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
  if (activePlan) dynText += formatCurrentPlan(activePlan);
  dynText += formatVerbatimHistory(verbatim, activePlan, verbatimWeeks);
  dynText += formatSummarizedHistory(summarized);
  dynText += formatAnalyzeInputs({ historyWeeks, notes });
  dynText += '\nProduce the analysis per your instructions. Return ONLY the JSON object. No preamble, no markdown fences.\n';
  content.push({ type: 'text', text: dynText });

  // Photos — same pattern as plan-gen. Analyze benefits from visual cues
  // for physique-driven commentary when photos exist.
  const latestProgress = photos && photos.progress && photos.progress.length ? photos.progress[0] : null;
  const [goalImg, progressImg] = await Promise.all([
    photos && photos.goal ? downloadPhotoAsBase64(photos.goal.storage_path) : Promise.resolve(null),
    latestProgress ? downloadPhotoAsBase64(latestProgress.storage_path) : Promise.resolve(null),
  ]);
  if (photos && photos.goal && goalImg) {
    content.push({ type: 'text', text: `GOAL PHYSIQUE photo (uploaded ${String(photos.goal.taken_at).slice(0, 10)}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: goalImg.mime, data: goalImg.base64 } });
  }
  if (latestProgress && progressImg) {
    content.push({ type: 'text', text: `CURRENT PROGRESS photo (${String(latestProgress.taken_at).slice(0, 10)}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: progressImg.mime, data: progressImg.base64 } });
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
  return null;
}

// ---- Swap mode ----
// Separate workflow from plan generation: single-exercise replacement with
// its own system prompt, 500-token budget, and validation. Shares
// fetchExerciseLibrary + fetchRecentWorkouts with the main path but builds
// a narrower user message.
async function handleSwap(res, userId, rawInputs) {
  const exercise = rawInputs.exercise;
  if (!exercise || typeof exercise !== 'object' || !exercise.name) {
    return jsonError(res, 400, 'Missing exercise to replace');
  }
  const reason = typeof rawInputs.reason === 'string' ? rawInputs.reason.trim().slice(0, 200) : '';
  const dayName = typeof rawInputs.day_name === 'string' ? rawInputs.day_name.slice(0, 120) : '';

  const t0 = Date.now();
  const [activePlan, history, exercises] = await Promise.all([
    fetchActivePlan(userId),
    fetchRecentWorkouts(userId, SWAP_HISTORY_WEEKS),
    fetchExerciseLibrary(userId),
  ]);
  console.log('[generate-plan:swap] data fetch:', Date.now() - t0, 'ms');

  const libraryNames = new Set(exercises.map(e => e.name));

  // Compute other exercises on the same day so Claude avoids duplicates.
  // Match on day name rather than day_index — plan days can be re-ordered
  // or renamed, and the frontend knows the current day by label.
  let otherToday = [];
  if (activePlan && activePlan.data && Array.isArray(activePlan.data.days)) {
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
  const userText = buildSwapUserMessage({ exercise, reason, dayName, otherToday, movementHistory });
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
        model: MODEL,
        max_tokens: SWAP_MAX_TOKENS,
        temperature: TEMPERATURE,
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

  let replacement;
  try {
    replacement = JSON.parse(stripJsonFences(rawText));
  } catch {
    return jsonError(res, 422, 'Swap response was not valid JSON', { raw: rawText });
  }

  const validationError = validateSwapReplacement(replacement, libraryNames, exercise.name, otherToday);
  if (validationError) {
    return jsonError(res, 422, 'Swap validation failed: ' + validationError, { raw: rawText });
  }

  // Expand repeat: N shorthand into N identical set objects so the client
  // receives the canonical fully-expanded shape — matches plan-generation
  // output and keeps the client-side contract uniform.
  expandSetRepeatsForOneExercise(replacement);

  return res.status(200).json({
    replacement,
    replaced: exercise.name,
    reason: reason || null,
    model: MODEL,
    usage: claudeData.usage || null,
    generated_at: new Date().toISOString(),
  });
}

function buildSwapUserMessage({ exercise, reason, dayName, otherToday, movementHistory }) {
  let out = 'EXERCISE TO REPLACE\n';
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

  out += 'Return ONLY the JSON object for the replacement exercise. No preamble, no markdown fences, no trailing text.\n';
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
function expandSetRepeats(plan) {
  if (!plan || !Array.isArray(plan.days)) return plan;
  for (const day of plan.days) {
    if (!Array.isArray(day.exercises)) continue;
    for (const ex of day.exercises) {
      if (!Array.isArray(ex.sets)) continue;
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
  }
  return plan;
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
      if (!e.name) return `day ${i + 1} exercise ${j + 1}: missing name`;
      if (!Array.isArray(e.sets) || !e.sets.length) return `day ${i + 1} exercise "${e.name}": missing or empty sets`;
    }
  }
  return null;
}
