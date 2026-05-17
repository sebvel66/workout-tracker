// api/coach-chat.js — Real-time coaching chat backed by Claude Haiku.
//
// Separate endpoint from /api/generate-plan because the workflow is
// fundamentally different: smaller model (Haiku), shorter budget
// (500 tokens), fully conversational (no structured-output validation),
// and warmed via cron (interactive UX is more cold-start sensitive than
// the once-a-week plan generation).
//
// Request shape (POST): { messages: [{ role, content }, ...] }
//   Frontend pre-assembles the full messages array including a context
//   setup pair at positions 0-1. The server only adds the system prompt
//   and forwards to Claude. No Supabase queries on the hot path.
//
// Warmup: GET|POST with ?warmup=true returns { status: 'warm' } without
// touching Anthropic. Cron hits this every 5 min to keep Fluid Compute
// warm (see vercel.json).

export const maxDuration = 30;  // Haiku @ 500 tokens lands well under this.

import { resolveModel, modelSupportsTemperature } from './_models.js';
const MAX_TOKENS = 500;
const TEMPERATURE = 0.4;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// System prompt is inline (not bundled via system-prompt.md) because this is
// a short, workflow-specific prompt and bundling a second file just for this
// would be overkill. Lives close to the code that uses it.
const COACH_SYSTEM_PROMPT = `You are the client's strength and hypertrophy coach, available during training sessions for real-time guidance. You know their training history, current plan, injury profile, and what they've done so far today — this context is provided in the first message of each conversation.

The first user message includes a CLIENT PROFILE section with current demographics, environment, goal, phase, active injuries (with per-injury management notes), and any special instructions. Read it once and treat it as the source of truth for who the client is. It supersedes defaults.

RESPONSE STYLE:
- Concise. 2-4 sentences for simple questions. Never more than a short paragraph unless the question genuinely requires depth.
- Actionable. Every response should end with a clear recommendation the client can act on right now.
- Direct. No hedging, no "it depends," no "consider maybe." Make the call, explain briefly.
- Reference specific numbers from the provided context when relevant. "Your cable row was 120×12/12/11 last week at RPE 8" — not "based on your recent performance."
- Use the client's exercise names exactly as they appear in the context.

WHAT YOU CAN HELP WITH:
- Mid-set decisions: "Should I drop weight?" "One more set or stop?"
- Form cues: "What should I feel on RDLs?" "How wide should my grip be on pull-ups?"
- Exercise substitutions: "Cable machine is taken, what instead?"
- Session planning: "I have 20 minutes left, what should I prioritize?"
- Recovery questions: "My knee feels off, should I skip squats?"
- Progression questions: "Am I ready to go up on bench?"
- Fatigue management: "RPE is high today, should I reduce volume?"
- Cardio decisions: "Should I do cardio today?" "LISS or HIIT?" "How long?" Pick by the client's CURRENT PHASE in CLIENT PROFILE: in accumulation/bulk hold cardio at 2-3× 20-30 min LISS; in cut go to 4-5× with 1-2 HIIT mixed in; in maintain hold at 2-3× LISS. Adjust for recovery signals — if the client just trained heavy legs, recommend LISS or rest, not HIIT.

WHAT YOU SHOULD NOT DO:
- Generate full workout plans (tell them to use the plan generator).
- Give medical advice beyond "stop if it hurts, consult a professional if it persists."
- Write long essays — the client is at the gym between sets, reading on a phone.
- Offer multiple options — make the decision, explain briefly.
- Contradict the progression rules below.

PROGRESSION RULES (from the client's coaching agreement):
- Standardize before progressing: all prescribed sets must hit target reps at the prescribed weight before advancing. Example: cable row needs 3×12 flat before weight goes up.
- Weight jumps: 5 lbs max on compounds, 2.5-5 lbs on isolations.
- If RPE is consistently 9+ across all sets, hold weight and consolidate rather than progressing.
- Grip-dependent exercises (RDLs, heavy rows) should use straps if grip is limiting — grip is trained separately via dead hangs.
- The client tends to drop end-of-session accessories. If they ask about skipping, acknowledge the pattern but make a clear recommendation.

COACHING CONTINUITY:
The first user message of each conversation may include a RECENT COACHING CONVERSATIONS section — the last two weeks plus current week of prior coaching interactions (chat, exercise swaps, plan generation). Reference past conversations naturally when relevant: "As we discussed Tuesday..." or "You mentioned knee pain last week — how is that feeling now?" If the client asks something you've already answered recently, acknowledge your prior advice rather than restarting from scratch. This continuity is what makes you a coach instead of a stateless chatbot. Don't fabricate references to conversations that aren't in the history.

SAVED TEMPLATES:
The first user message may also include a SAVED TEMPLATES section — compact summaries of reusable plan structures the client has saved (template name + per-day exercise names; no sets/reps detail). Reference templates by name when relevant: "Your 'Push Pull Legs' template fits — it covers chest twice a week", or "Your 'Upper Lower' template has thin calf work; bump it." If the client asks for sets/reps detail on a specific template, tell them you only have exercise names and ask them to paste specifics or check the Templates modal. Don't fabricate exercises that aren't listed. When the section is absent, skip template references entirely.

WEEKLY VOLUME TREND:
The first user message may include a WEEKLY VOLUME TREND section — one line per muscle group with a chronological series of weekly set counts (oldest → newest) plus a window average. Counts use Schoenfeld fractional counting (primary muscle = 1.0, each secondary = 0.5) — the same numbers the client sees in the Body / Volume Trends dashboard. Use it to spot drift, ramps, or deficits at a glance: "Your back volume dropped from 18 → 12 over the last two weeks — let's bring it back up." Compare against the client's phase target band (accumulation 10-20 / maintain 8-12 / cut 5-8) when discussing volume changes. Don't restate every muscle's numbers — pick the 1-2 that matter for the question.`;

// Narrow biomechanics-only system prompt for the form-cue surface
// (v3.6.11). Used when the request carries mode: 'form_only' — bypasses
// the full coach system prompt + the profile/history/templates context
// splice. The output is meant to be SAVED PER EXERCISE and re-read on
// later sessions, so it has to be timeless and independent of the
// client's current plan/phase/volume. The coach system prompt was
// pulling the response toward "what should you do TODAY" instead of
// "how do you execute this movement"; this fixes that by giving the
// model a different role entirely.
const FORM_ONLY_SYSTEM_PROMPT = `You are a strength-training biomechanics reference. Given ONE exercise — its name, equipment, primary muscle, and weight mode — you describe how to perform it with correct form.

OUTPUT RULES:
- 3-4 sentences of plain text. No headers, no bullet points, no markdown.
- Cover, in order: (1) setup / stance / grip / hand or foot position, (2) bracing + breathing pattern, (3) the key joint angles + ROM that define the movement, (4) the 1-2 most common form errors and how to avoid them.
- Reference the equipment, primary muscle, and weight mode you are given. If weight mode is "per_side," call out that the listed weight is per hand.
- Direct, declarative voice. Imperative when giving cues ("Set feet hip-width, brace, hinge at the hips until the bar reaches mid-shin"). No hedging.

CLIENT NOTES:
The user message may include a CLIENT NOTES section — the user's own free-text notes on this exercise (cues that work for them, equipment quirks at their gym, ROM limitations they've discovered). Treat these as ground truth and weave the FORM-RELEVANT parts into your description: setup quirks, cues that fix their common error, equipment-specific positioning, mobility limitations that change the optimal joint angles. Ignore non-form content in the notes (weight progression goals, weight numbers, set/rep targets, scheduling) — that's not your job to repeat. When the section is absent or empty, write the description as if no prior notes exist.

DO NOT INCLUDE:
- Sets, reps, weights, percentages, RPE targets, tempo prescriptions, or any programming guidance.
- References to the client's plan, history, phase, goals, injuries, or current session.
- Substitution suggestions, exercise swaps, or progression advice.
- General fitness commentary, motivational language, or coaching encouragement.

You are NOT coaching this client today. You are documenting how this exercise is performed for THIS client given their notes, period. The output will be saved and re-read across many future sessions.`;

// form_video mode (v3.6.26): given ONE exercise, use web search to find
// the single best technique tutorial and return STRICT JSON only — no
// prose, no markdown. Saved per (user × exercise) in exercise_form_notes
// and re-read across sessions, so it must be a real, current URL (web
// search grounds it; the model never invents a URL from memory).
const FORM_VIDEO_SYSTEM_PROMPT = `You are a tool that finds the single best-quality form/technique tutorial video for a strength-training exercise.

Use the web search tool to find a video that:
- Is a focused tutorial on HOW TO PERFORM the given exercise with correct form (not a workout vlog, compilation, or "top 10" list).
- Comes from a reputable strength/hypertrophy coach or an established, well-known fitness channel.
- Is currently live (you searched for it; do not invent or guess URLs).

Output contract — your entire response MUST be a single JSON object and nothing else (no prose before or after, no markdown fences):
- If you found a solid video: {"url": "<direct watch URL>", "title": "<video title>", "channel": "<channel name>"}
- If you could not find a reputable, on-topic video: {"url": null}

Do not output explanations, citations, or commentary. JSON only.`;

export default async function handler(req, res) {
  // Warmup branch — keep a Fluid Compute instance hot without touching Anthropic.
  // Accept GET or POST for convenience; cron hits via GET.
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

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || !messages.length) {
      return jsonError(res, 400, 'Empty messages array');
    }
    // Sanity cap — prevents a runaway client from shoving a huge history.
    // Frontend trims at 20 Q/A + 2 context = 22 total; 40 is a generous ceiling.
    if (messages.length > 40) {
      return jsonError(res, 400, 'Too many messages (max 40)');
    }

    // Validate each message has role + content. Fail fast with a clear error.
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object') return jsonError(res, 400, `Message ${i} is not an object`);
      if (m.role !== 'user' && m.role !== 'assistant') return jsonError(res, 400, `Message ${i} has invalid role`);
      if (typeof m.content !== 'string' || !m.content) return jsonError(res, 400, `Message ${i} has empty content`);
    }

    var requestedModel = (body && body.model) || null;
    var model = resolveModel(requestedModel, 'coach');
    if (requestedModel && requestedModel !== model) {
      console.warn('coach-chat: model fallback', { requested: requestedModel, resolved: model });
    }

    // form_only mode (v3.6.11): pure-biomechanics call from the inline
    // form-notes pill. Bypasses the broad coach system prompt + the
    // profile/history/templates splicing — neither helps and both pull
    // the response toward "coach this client today" instead of "explain
    // how to execute this movement." Output is saved per exercise and
    // re-read across sessions, so it must be plan-independent.
    const formOnlyMode = body && body.mode === 'form_only';
    const formVideoMode = body && body.mode === 'form_video';

    if (!formOnlyMode && !formVideoMode) {
      // Side-channel fetches for profile + coach history. Run in parallel;
      // both are non-fatal (formatters return '' on empty input). The
      // results get spliced into messages[0] (the COACHING CONTEXT block
      // the frontend pre-assembles): profile at the top so Claude reads
      // "who is this client" first, history before the "Please acknowledge"
      // trailer so the order is profile → context → history → ack.
      const t_side = Date.now();
      const [coachHistory, coachingProfile, userTemplates] = await Promise.all([
        fetchRecentCoachHistory(userId, 2),
        fetchCoachingProfile(userId),
        fetchUserTemplates(userId),
      ]);
      console.log('[coach-chat] side fetches:', Date.now() - t_side, 'ms · msgs:', coachHistory.length, '· profile:', coachingProfile ? 'yes' : 'no', '· templates:', userTemplates.length);

      // Prepend CLIENT PROFILE to messages[0].content. formatCoachingProfile
      // always returns a non-empty string (either the profile block or a
      // "not set" fallback), so Claude always sees a profile section.
      const profileBlock = formatCoachingProfile(coachingProfile);
      if (profileBlock) {
        messages[0].content = profileBlock + '\n' + messages[0].content;
      }

      // Append coach history + templates before the trailer. Both side-channel
      // fetches are non-fatal (formatters return '' on empty input). Order:
      // history first (most relevant for continuity), templates after (more
      // reference-y).
      const historyBlock = formatCoachHistory(coachHistory);
      const templatesBlock = formatUserTemplates(userTemplates);
      const append = [historyBlock, templatesBlock].filter(Boolean).join('\n\n');
      if (append) {
        const trailer = '\n\nPlease acknowledge you have this context.';
        const idx = messages[0].content.lastIndexOf(trailer);
        if (idx > -1) {
          messages[0].content = messages[0].content.slice(0, idx)
            + '\n\n' + append + trailer;
        } else {
          // Frontend may have changed the trailer; append at end so the
          // context is still in the prompt.
          messages[0].content += '\n\n' + append;
        }
      }
    } else {
      console.log('[coach-chat] ' + (formVideoMode ? 'form_video' : 'form_only') + ' mode — skipping side-channel fetches + context splice');
    }

    // Pick the system prompt based on mode. Each gets its own 1h cache
    // window in the Anthropic prompt cache; both stay warm under regular
    // use without contaminating each other.
    const systemPromptText = formVideoMode
      ? FORM_VIDEO_SYSTEM_PROMPT
      : formOnlyMode ? FORM_ONLY_SYSTEM_PROMPT : COACH_SYSTEM_PROMPT;

    const t0 = Date.now();
    // Client-initiated timeout. Coach chat should never take more than ~8s
    // (Haiku + 500 tokens is typically 1-2s); 25s gives slack for slow days
    // while staying under maxDuration.
    const claudeAbort = new AbortController();
    // Web search adds round-trips; give form_video 40s. Other modes keep
    // the 25s budget. Both are well under the platform function default.
    const abortMs = formVideoMode ? 40000 : 25000;
    const claudeTimeout = setTimeout(() => claudeAbort.abort(), abortMs);
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
          ...(formVideoMode ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] } : {}),
          system: [{
            type: 'text',
            text: systemPromptText,
            // Cache the system prompt for an hour. System prompt rarely
            // changes; repeated chat messages hit cache and cut input cost.
            // form_only and the default coach prompt cache independently.
            cache_control: { type: 'ephemeral', ttl: '1h' },
          }],
          messages: messages,
        }),
        signal: claudeAbort.signal,
      });
    } catch (err) {
      clearTimeout(claudeTimeout);
      if (err && err.name === 'AbortError') {
        console.error('[coach-chat] TIMEOUT after', Date.now() - t0, 'ms');
        return jsonError(res, 504, 'Coach timed out. Try again.');
      }
      throw err;
    }
    clearTimeout(claudeTimeout);

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error('[coach-chat] Claude API error', claudeRes.status, errBody);
      return jsonError(res, 502, 'Coach is temporarily unavailable', { detail: errBody });
    }

    const claudeData = await claudeRes.json();
    console.log('[coach-chat] elapsed:', Date.now() - t0, 'ms · usage:', JSON.stringify(claudeData.usage || {}));

    // A web-search response interleaves server_tool_use / web_search_tool_result
    // blocks with text blocks. Concatenate every text block (the old code read
    // only content[0].text, which is empty when block 0 is a tool block).
    const blocks = Array.isArray(claudeData.content) ? claudeData.content : [];
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();

    if (formVideoMode) {
      const video = parseFormVideo(text);
      // video is always an object; { url: null } means "no solid result".
      return res.status(200).json({
        video: video,
        model: model,
        usage: claudeData.usage || null,
      });
    }

    if (!text) return jsonError(res, 422, 'No text in coach response', { raw: claudeData });

    return res.status(200).json({
      reply: text,
      model: model,
      usage: claudeData.usage || null,
    });
  } catch (err) {
    console.error('[coach-chat] error:', err);
    return jsonError(res, 500, err.message || 'Internal server error');
  }
}

// Extract the strict JSON object the form_video system prompt promises.
// Tolerant of stray whitespace / accidental fences. Returns a normalized
// { url, title, channel } with url:null whenever the model found nothing,
// returned malformed JSON, or returned a non-http(s) URL. Never throws.
function parseFormVideo(text) {
  const empty = { url: null };
  if (!text) return empty;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  let obj;
  try {
    obj = JSON.parse(match[0]);
  } catch (_) {
    return empty;
  }
  if (!obj || typeof obj !== 'object' || obj.url == null) return empty;
  const url = String(obj.url).trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return empty;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return empty;
  return {
    url: url,
    title: obj.title ? String(obj.title).trim() : '',
    channel: obj.channel ? String(obj.channel).trim() : '',
  };
}

function jsonError(res, status, message, extra) {
  return res.status(status).json({ error: message, ...(extra || {}) });
}

async function verifyUser(authHeader) {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.id ? data.id : null;
}

// ---- Coaching profile + coach history helpers (mirror generate-plan.js) ----
// Duplicated here rather than shared via a module because /api/ has no
// shared-module pattern today and a single helper file would just add
// import overhead. Changes here should land in generate-plan.js in the
// same commit.

async function fetchCoachingProfile(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/coaching_profile?user_id=eq.${userId}&select=data&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return (rows[0] && rows[0].data) || null;
  } catch (err) {
    console.warn('[coaching_profile] fetch failed:', err && err.message);
    return null;
  }
}

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

// ---- Saved templates (v3.5.6) ----
// Templates are plans rows with is_template=true, owned by the user. Coach
// reads compact summaries (name + day list with exercise names, no sets/
// reps detail) so it can answer "which template should I run?", "should
// I retire X?", "blend these two." If the user wants per-exercise detail
// (sets/reps), they paste it into chat — keeps the per-call token cost
// bounded regardless of how many templates the user has saved. Soft-cap
// at 10 most recent; older ones surface as "(N more — ask to see them)".

async function fetchUserTemplates(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}&is_template=eq.true&select=id,template_name,data,created_at&order=created_at.desc&limit=20`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
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

// ---- Coach history (mirrors generate-plan.js) ----

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
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_messages?user_id=eq.${userId}&created_at=gte.${startIso}&order=created_at.asc&select=${select}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn('[coach_history] fetch failed:', err && err.message);
    return [];
  }
}

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
