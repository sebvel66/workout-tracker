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

const MODEL = 'claude-haiku-4-5-20251001';
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
The first user message of each conversation may include a RECENT COACHING CONVERSATIONS section — the last two weeks plus current week of prior coaching interactions (chat, exercise swaps, plan generation). Reference past conversations naturally when relevant: "As we discussed Tuesday..." or "You mentioned knee pain last week — how is that feeling now?" If the client asks something you've already answered recently, acknowledge your prior advice rather than restarting from scratch. This continuity is what makes you a coach instead of a stateless chatbot. Don't fabricate references to conversations that aren't in the history.`;

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

    // Side-channel fetches for profile + coach history. Run in parallel;
    // both are non-fatal (formatters return '' on empty input). The
    // results get spliced into messages[0] (the COACHING CONTEXT block
    // the frontend pre-assembles): profile at the top so Claude reads
    // "who is this client" first, history before the "Please acknowledge"
    // trailer so the order is profile → context → history → ack.
    const t_side = Date.now();
    const [coachHistory, coachingProfile] = await Promise.all([
      fetchRecentCoachHistory(userId, 2),
      fetchCoachingProfile(userId),
    ]);
    console.log('[coach-chat] side fetches:', Date.now() - t_side, 'ms · msgs:', coachHistory.length, '· profile:', coachingProfile ? 'yes' : 'no');

    // Prepend CLIENT PROFILE to messages[0].content. formatCoachingProfile
    // always returns a non-empty string (either the profile block or a
    // "not set" fallback), so Claude always sees a profile section.
    const profileBlock = formatCoachingProfile(coachingProfile);
    if (profileBlock) {
      messages[0].content = profileBlock + '\n' + messages[0].content;
    }

    // Append coach history before the trailer. Failure of the
    // side-channel fetch is non-fatal (formatCoachHistory returns ''
    // on empty input), and we never block the chat call on it.
    const historyBlock = formatCoachHistory(coachHistory);
    if (historyBlock) {
      const trailer = '\n\nPlease acknowledge you have this context.';
      const idx = messages[0].content.lastIndexOf(trailer);
      if (idx > -1) {
        messages[0].content = messages[0].content.slice(0, idx)
          + '\n\n' + historyBlock + trailer;
      } else {
        // Frontend may have changed the trailer; append at end so the
        // history is still in the prompt.
        messages[0].content += '\n\n' + historyBlock;
      }
    }

    const t0 = Date.now();
    // Client-initiated timeout. Coach chat should never take more than ~8s
    // (Haiku + 500 tokens is typically 1-2s); 25s gives slack for slow days
    // while staying under maxDuration.
    const claudeAbort = new AbortController();
    const claudeTimeout = setTimeout(() => claudeAbort.abort(), 25000);
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
          system: [{
            type: 'text',
            text: COACH_SYSTEM_PROMPT,
            // Cache the system prompt for an hour. System prompt rarely
            // changes; repeated chat messages hit cache and cut input cost.
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

    const text = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
    if (!text) return jsonError(res, 422, 'No text in coach response', { raw: claudeData });

    return res.status(200).json({
      reply: text,
      model: MODEL,
      usage: claudeData.usage || null,
    });
  } catch (err) {
    console.error('[coach-chat] error:', err);
    return jsonError(res, 500, err.message || 'Internal server error');
  }
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
