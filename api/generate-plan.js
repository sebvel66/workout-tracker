// api/generate-plan.js — AI weekly plan generator (Session B, Part 2b).
//
// Vercel Node serverless function. Flow:
//   1. Verify the caller's Supabase session via /auth/v1/user.
//   2. Query active plan + last HISTORY_WEEKS of workouts + exercise
//      library + latest physique photos (service-role key, bypasses RLS).
//   3. Build a text+images user message; pair with the system prompt
//      loaded from system-prompt.md at cold start.
//   4. Call Claude and parse the JSON response; validate shape.
//   5. Return { plan, coaching_notes, weeks_analyzed, generated_at }.
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
const HISTORY_WEEKS = 4;
const VERBATIM_WEEKS = 2;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---- System prompt (loaded once at cold start) ----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = loadSystemPrompt();

function loadSystemPrompt() {
  const candidates = [
    path.join(__dirname, '..', 'system-prompt.md'),
    path.join(process.cwd(), 'system-prompt.md'),
    path.join(__dirname, 'system-prompt.md'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf-8'); } catch { /* try next */ }
  }
  throw new Error('Could not locate system-prompt.md');
}

// ---- Handler ----
export default async function handler(req, res) {
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

    const [activePlan, history, exercises, photos] = await Promise.all([
      fetchActivePlan(userId),
      fetchRecentWorkouts(userId, HISTORY_WEEKS),
      fetchExerciseLibrary(userId),
      fetchPhysiquePhotos(userId),
    ]);

    if (!activePlan) {
      return jsonError(res, 400, 'No active plan. Import a plan before generating.');
    }
    if (!history.length) {
      return jsonError(res, 400, 'No workout history found. Log at least one week of training before generating a plan.');
    }

    const userMessage = await buildUserMessage({ activePlan, history, exercises, photos });

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
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
        // Breakpoint 1: the system prompt alone. Cached at the tools→system
        // boundary. Invalidated only when system-prompt.md changes.
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error('Claude API error', claudeRes.status, errBody);
      return jsonError(res, 502, 'AI service unavailable', { detail: errBody });
    }

    const claudeData = await claudeRes.json();

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

    const validationError = validatePlan(plan);
    if (validationError) {
      return jsonError(res, 422, 'Plan validation failed: ' + validationError, { raw: rawText });
    }

    // Expand `"repeat": N` shorthand into N identical set objects so the
    // stored plan JSON matches the shape the frontend expects (one object
    // per set). The prompt tells Claude to emit the compact form to save
    // output tokens; expansion happens server-side so the client never
    // sees `repeat`.
    expandSetRepeats(plan);

    return res.status(200).json({
      plan,
      coaching_notes: plan.coaching_notes || '',
      weeks_analyzed: HISTORY_WEEKS,
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
  const select = encodeURIComponent('*,sets(*,exercises(name,equipment,muscle_group,movement_pattern,weight_mode))');
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
async function buildUserMessage({ activePlan, history, exercises, photos }) {
  const content = [];
  const { verbatim, summarized } = splitHistoryByRecency(history);

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

  let dynText = '';
  dynText += formatCurrentPlan(activePlan);
  dynText += formatVerbatimHistory(verbatim, activePlan);
  dynText += formatSummarizedHistory(summarized);
  dynText += '\nGENERATE a full training plan for the upcoming week. Match the current plan\'s day structure (5-day Upper/Lower split, Sunday through Thursday). Return ONLY the JSON object as specified in your instructions. No preamble, no markdown fences, no trailing text.\n';
  content.push({ type: 'text', text: dynText });

  if (photos.goal) {
    const img = await downloadPhotoAsBase64(photos.goal.storage_path);
    if (img) {
      content.push({ type: 'text', text: `GOAL PHYSIQUE photo (uploaded ${String(photos.goal.taken_at).slice(0, 10)}):` });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
    }
  }
  if (photos.progress.length) {
    const latest = photos.progress[0];
    const img = await downloadPhotoAsBase64(latest.storage_path);
    if (img) {
      content.push({ type: 'text', text: `CURRENT PROGRESS photo (${String(latest.taken_at).slice(0, 10)}):` });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
    }
  }

  return content;
}

function splitHistoryByRecency(workouts) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - VERBATIM_WEEKS * 7);
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

function formatVerbatimHistory(workouts, activePlan) {
  if (!workouts.length) return '';
  let out = `RECENT PERFORMANCE (verbatim, last ${VERBATIM_WEEKS} weeks)\n`;
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

function formatExerciseLibrary(exercises) {
  let out = 'AVAILABLE EXERCISES (use only these names, verbatim — preserve capitalization)\n';
  for (const e of exercises) {
    out += `- ${e.name} | ${e.equipment || '-'} | ${e.muscle_group || '-'} | ${e.movement_pattern || '-'} | weight_mode=${e.weight_mode || 'total'}\n`;
  }
  return out + '\n';
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

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return 'plan is not an object';
  if (!plan.title) return 'missing title';
  if (!plan.coaching_notes) return 'missing coaching_notes';
  if (!Array.isArray(plan.days) || !plan.days.length) return 'missing or empty days';
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
