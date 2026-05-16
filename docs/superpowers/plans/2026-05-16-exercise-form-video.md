# Exercise Form-Video Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand, web-grounded "form video" per exercise, cached per user×exercise, surfaced as a button in the exercise modal's Form Notes section.

**Architecture:** A new `mode: 'form_video'` in the existing `/api/coach-chat` function uses Anthropic's server-side web search to find one real tutorial video and returns strict JSON. The result is upserted into the existing `exercise_form_notes` row (three new columns) and rendered in the existing modal Form Notes pane. A labeled YouTube-search link is the no-result fallback.

**Tech Stack:** Vanilla JS (no build, no test harness — manual verification), Supabase (Postgres + RLS), Vercel serverless function calling the Anthropic Messages API.

> **Note on TDD:** This project has no automated test harness (confirmed: no test runner, vanilla `<script>` includes). Steps therefore use explicit **manual verification** in place of automated red/green. Keep commits frequent and per-task.

**Spec:** `docs/superpowers/specs/2026-05-16-exercise-form-video-design.md`

---

### Task 1: Database migration — video columns on `exercise_form_notes`

**Files:**
- Create: `supabase/migrations/20260516000000_exercise_form_video.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260516000000_exercise_form_video.sql` with exactly:

```sql
-- Web-grounded form-video link per (user × exercise), v3.6.26.
-- Sits alongside the existing AI/user form notes in exercise_form_notes.
-- Populated on demand via /api/coach-chat mode:'form_video' (Anthropic
-- server-side web search), re-read across future sessions like ai_note.
--
-- No new RLS: the composite PK (user_id, exercise_id) and the existing
-- owner-only select/insert/update/delete policies already cover these
-- columns. Nullable: a row may have notes but no video, or vice versa.

alter table exercise_form_notes
  add column ai_video_url text,
  add column ai_video_title text,
  add column ai_video_generated_at timestamptz;
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db push` (or apply via the Supabase SQL editor for the project — confirm with the user which path they use; the repo uses hosted Supabase).
Expected: migration applies cleanly; `exercise_form_notes` now has `ai_video_url`, `ai_video_title`, `ai_video_generated_at` (all nullable).

- [ ] **Step 3: Verify columns exist**

Run (Supabase SQL editor): `select column_name from information_schema.columns where table_name = 'exercise_form_notes' order by ordinal_position;`
Expected: list includes `ai_video_url`, `ai_video_title`, `ai_video_generated_at`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260516000000_exercise_form_video.sql
git commit -m "feat: add form-video columns to exercise_form_notes"
```

---

### Task 2: API — `mode: 'form_video'` in `/api/coach-chat`

**Files:**
- Modify: `api/coach-chat.js`

- [ ] **Step 1: Add the `FORM_VIDEO_SYSTEM_PROMPT` constant**

Immediately after the `FORM_ONLY_SYSTEM_PROMPT` constant ends (the closing `` `; `` of that template literal, ~line 102), add:

```js
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
```

- [ ] **Step 2: Detect the mode and exclude it from the context splice**

Find (~line 157):

```js
    const formOnlyMode = body && body.mode === 'form_only';

    if (!formOnlyMode) {
```

Replace with:

```js
    const formOnlyMode = body && body.mode === 'form_only';
    const formVideoMode = body && body.mode === 'form_video';

    if (!formOnlyMode && !formVideoMode) {
```

- [ ] **Step 3: Update the skip-splice log line**

Find (~line 202):

```js
    } else {
      console.log('[coach-chat] form_only mode — skipping side-channel fetches + context splice');
    }
```

Replace with:

```js
    } else {
      console.log('[coach-chat] ' + (formVideoMode ? 'form_video' : 'form_only') + ' mode — skipping side-channel fetches + context splice');
    }
```

- [ ] **Step 4: Select the system prompt for the new mode**

Find (~line 208):

```js
    const systemPromptText = formOnlyMode ? FORM_ONLY_SYSTEM_PROMPT : COACH_SYSTEM_PROMPT;
```

Replace with:

```js
    const systemPromptText = formVideoMode
      ? FORM_VIDEO_SYSTEM_PROMPT
      : formOnlyMode ? FORM_ONLY_SYSTEM_PROMPT : COACH_SYSTEM_PROMPT;
```

- [ ] **Step 5: Raise the timeout for the web-search mode**

Find (~line 213-215):

```js
    const claudeAbort = new AbortController();
    const claudeTimeout = setTimeout(() => claudeAbort.abort(), 25000);
```

Replace with:

```js
    const claudeAbort = new AbortController();
    // Web search adds round-trips; give form_video 40s. Other modes keep
    // the 25s budget. Both are well under the platform function default.
    const abortMs = formVideoMode ? 40000 : 25000;
    const claudeTimeout = setTimeout(() => claudeAbort.abort(), abortMs);
```

- [ ] **Step 6: Attach the web search tool for `form_video`**

Find the Anthropic request body (~line 230-237):

```js
        body: JSON.stringify({
          model: model,
          max_tokens: MAX_TOKENS,
          ...(modelSupportsTemperature(model) ? { temperature: TEMPERATURE } : {}),
          system: [{
            type: 'text',
            text: systemPromptText,
```

Replace with:

```js
        body: JSON.stringify({
          model: model,
          max_tokens: MAX_TOKENS,
          ...(modelSupportsTemperature(model) ? { temperature: TEMPERATURE } : {}),
          ...(formVideoMode ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] } : {}),
          system: [{
            type: 'text',
            text: systemPromptText,
```

- [ ] **Step 7: Parse multi-block responses and branch the return shape**

Find the response read + return (~line 259-266):

```js
    const text = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
    if (!text) return jsonError(res, 422, 'No text in coach response', { raw: claudeData });

    return res.status(200).json({
      reply: text,
      model: model,
      usage: claudeData.usage || null,
    });
```

Replace with:

```js
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
```

- [ ] **Step 8: Add the `parseFormVideo` helper**

Find the `jsonError` helper near the end of the file:

```js
function jsonError(res, status, message, extra) {
  return res.status(status).json({ error: message, ...(extra || {}) });
}
```

Immediately **above** it, add:

```js
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
```

- [ ] **Step 9: Lint-check the file parses**

Run: `node --check api/coach-chat.js`
Expected: no output, exit 0 (syntax valid).

- [ ] **Step 10: Commit**

```bash
git add api/coach-chat.js
git commit -m "feat: add form_video mode (web-grounded video lookup) to coach-chat"
```

---

### Task 3: Client data layer — generate / save / load video

**Files:**
- Modify: `js/data.js`

- [ ] **Step 1: Extend `loadFormNotes` select**

Find (~line 4984):

```js
    var res = await sb.from('exercise_form_notes')
      .select('user_note, ai_note, ai_generated_at')
      .eq('user_id', userId)
```

Replace the `.select(...)` line with:

```js
    var res = await sb.from('exercise_form_notes')
      .select('user_note, ai_note, ai_generated_at, ai_video_url, ai_video_title, ai_video_generated_at')
      .eq('user_id', userId)
```

- [ ] **Step 2: Extend `loadFormNotesBatch` select and map**

Find (~line 5014):

```js
    var res = await sb.from('exercise_form_notes')
      .select('exercise_id, user_note, ai_note, ai_generated_at')
      .eq('user_id', userId)
```

Replace the `.select(...)` line with:

```js
    var res = await sb.from('exercise_form_notes')
      .select('exercise_id, user_note, ai_note, ai_generated_at, ai_video_url, ai_video_title, ai_video_generated_at')
      .eq('user_id', userId)
```

Then find the map assignment (~line 5031):

```js
      map[rows[ri].exercise_id] = {
        user_note: rows[ri].user_note,
        ai_note: rows[ri].ai_note,
        ai_generated_at: rows[ri].ai_generated_at,
      };
```

Replace with:

```js
      map[rows[ri].exercise_id] = {
        user_note: rows[ri].user_note,
        ai_note: rows[ri].ai_note,
        ai_generated_at: rows[ri].ai_generated_at,
        ai_video_url: rows[ri].ai_video_url,
        ai_video_title: rows[ri].ai_video_title,
        ai_video_generated_at: rows[ri].ai_video_generated_at,
      };
```

- [ ] **Step 3: Add `saveAiFormVideo`**

Find the end of `saveAiFormNote` (~line 5066, its closing `}` after the `if (res.error) throw`). Immediately after that function, add:

```js
// Upsert the web-grounded video link for (user, exercise). Pass a
// { url, title } object to set it; pass null to clear all three video
// fields. Mirrors saveAiFormNote's upsert (same conflict key); only
// touches the video columns + updated_at so it never clobbers notes.
async function saveAiFormVideo(exerciseId, video) {
  if (!userId || !exerciseId) throw new Error('Not signed in');
  var clearing = (video == null) || !video.url;
  var payload = {
    user_id: userId,
    exercise_id: exerciseId,
    ai_video_url: clearing ? null : String(video.url),
    ai_video_title: clearing ? null : String(video.title || ''),
    ai_video_generated_at: clearing ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  var res = await sb.from('exercise_form_notes')
    .upsert(payload, { onConflict: 'user_id,exercise_id' });
  if (res.error) throw new Error(res.error.message);
}
```

- [ ] **Step 4: Add `generateAiFormVideo`**

Find the end of `generateAiFormNote` (~line 5118, the line `return String(body.reply).trim();` then its closing `}`). Immediately after that function, add:

```js
// Web-grounded video lookup (v3.6.26). Mirrors generateAiFormNote's
// transport (session token + /api/coach-chat) but with mode:'form_video'
// so the server attaches Anthropic web search and returns parsed JSON.
// Resolves to { url, title, channel }; url is null when nothing solid
// was found (caller falls back to a YouTube search link).
async function generateAiFormVideo(exerciseRow) {
  if (!userId) throw new Error('Not signed in');
  if (!exerciseRow || !exerciseRow.name) throw new Error('Exercise not found');
  var sessionRes = await sb.auth.getSession();
  var token = sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
  if (!token) throw new Error('Not signed in');
  var prompt = 'Exercise: ' + exerciseRow.name +
    '\nEquipment: ' + (exerciseRow.equipment || 'unknown') +
    '\nPrimary muscle: ' + (exerciseRow.muscle_group || 'unspecified') +
    '\n\nFind the best form tutorial video for this exercise per your rules.';
  var res = await fetch('/api/coach-chat', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelForCoach(),
      mode: 'form_video',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    var errBody = await res.json().catch(function() { return null; });
    throw new Error((errBody && errBody.error) || ('HTTP ' + res.status));
  }
  var body = await res.json();
  var v = body && body.video;
  if (!v || v.url == null) return { url: null };
  return { url: String(v.url), title: String(v.title || ''), channel: String(v.channel || '') };
}
```

- [ ] **Step 5: Lint-check the file parses**

Run: `node --check js/data.js`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add js/data.js
git commit -m "feat: client data layer for form-video (generate/save/load)"
```

---

### Task 4: UI — video control in the Form Notes pane

**Files:**
- Modify: `js/ui.js`

- [ ] **Step 1: Add a YouTube-search URL helper**

Directly above `function renderFormNotesPane() {` (~line 2185), add:

```js
// Plain YouTube search URL — the transparent no-result fallback. Always
// valid; clearly a search, not a vetted pick (label says so in the UI).
function youtubeSearchUrl(exerciseName) {
  var q = encodeURIComponent(String(exerciseName || '').trim() + ' proper form');
  return 'https://www.youtube.com/results?search_query=' + q;
}
```

- [ ] **Step 2: Track the video-generating flag in modal state**

Find (~line 1974):

```js
var exModalState = { tab: 'recent', exerciseRow: null, exerciseName: null, sessionsHtml: '', formNotes: null, formGenerating: false };
```

Replace with:

```js
var exModalState = { tab: 'recent', exerciseRow: null, exerciseName: null, sessionsHtml: '', formNotes: null, formGenerating: false, videoGenerating: false };
```

Then find the re-init in `openExerciseHistory` (~line 2004):

```js
  exModalState = { tab: 'recent', exerciseRow: null, exerciseName: exerciseName, sessionsHtml: '', formNotes: null, formGenerating: false };
```

Replace with:

```js
  exModalState = { tab: 'recent', exerciseRow: null, exerciseName: exerciseName, sessionsHtml: '', formNotes: null, formGenerating: false, videoGenerating: false };
```

- [ ] **Step 3: Render the video block inside `renderFormNotesPane`**

Find the end of the AI Coach Notes section — the `h += '</div>';` that closes it, immediately before `// User notes section` (~line 2218):

```js
  h += '</div>';
  // User notes section
```

Replace with:

```js
  h += '</div>';
  // Form video section (web-grounded link, cached per exercise)
  var videoUrl = fn.ai_video_url || '';
  var videoTitle = fn.ai_video_title || '';
  var videoAt = fn.ai_video_generated_at || '';
  var videoGenerating = !!exModalState.videoGenerating;
  var videoStamp = '';
  if (videoAt) {
    try {
      videoStamp = new Date(videoAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) { videoStamp = ''; }
  }
  h += '<div class="form-notes-section">';
  h += '<div class="form-notes-section-header">';
  h += '<span class="form-notes-section-label">Form Video</span>';
  h += '<button type="button" class="form-notes-regen-btn" id="btnFormVideoFind"' + (videoGenerating ? ' disabled' : '') + '>' +
       (videoGenerating ? 'Searching…' : (videoUrl ? 'Re-search' : 'Find form video')) + '</button>';
  h += '</div>';
  if (videoGenerating) {
    h += '<div class="form-notes-text" style="opacity:0.6">Searching the web for a good demo…</div>';
  } else if (videoUrl) {
    var label = videoTitle || 'Watch form video';
    if (fn.ai_video_channel) label += ' · ' + fn.ai_video_channel;
    h += '<div class="form-notes-text"><a href="' + escapeHtml(videoUrl) + '" target="_blank" rel="noopener">▶ ' + escapeHtml(label) + '</a></div>';
    if (videoStamp) {
      h += '<div class="form-notes-meta">Found: ' + escapeHtml(videoStamp) + '</div>';
    }
  } else {
    h += '<div class="form-notes-empty">No video yet — tap "Find form video" to search the web for a vetted technique demo, saved per exercise.</div>';
  }
  h += '</div>';
  // User notes section
```

> Note: `channel` is returned by the API but not persisted (spec keeps storage to url/title). The `fn.ai_video_channel` reference above is only ever truthy from the in-memory result set in Step 5; from the DB it is absent and the label is just the title. This is intentional and correct — no extra column.

- [ ] **Step 4: Add the `onFormVideoFind` handler**

Directly after the `onFormNotesRegen` function ends (its final `}` ~line 2262, before the `// Inline form-notes regen` comment), add:

```js
async function onFormVideoFind() {
  if (exModalState.videoGenerating || !exModalState.exerciseRow) return;
  exModalState.videoGenerating = true;
  renderExerciseModal();
  var exId = exModalState.exerciseRow.id;
  try {
    var v = await generateAiFormVideo(exModalState.exerciseRow);
    if (v && v.url) {
      await saveAiFormVideo(exId, { url: v.url, title: v.title });
      exModalState.formNotes = exModalState.formNotes || {};
      exModalState.formNotes.ai_video_url = v.url;
      exModalState.formNotes.ai_video_title = v.title;
      exModalState.formNotes.ai_video_channel = v.channel; // in-memory only
      exModalState.formNotes.ai_video_generated_at = new Date().toISOString();
      formNotesCache[exId] = Object.assign({}, formNotesCache[exId] || {}, {
        ai_video_url: v.url,
        ai_video_title: v.title,
        ai_video_generated_at: exModalState.formNotes.ai_video_generated_at,
      });
    } else {
      // No solid pick — do NOT overwrite any existing saved video.
      var name = exModalState.exerciseRow.name;
      showToast('Couldn\'t find a vetted video — opening a YouTube search instead.', null);
      window.open(youtubeSearchUrl(name), '_blank', 'noopener');
    }
  } catch (err) {
    console.error('onFormVideoFind error:', err);
    showToast('Couldn\'t search right now: ' + (err.message || 'unknown'), null);
  } finally {
    exModalState.videoGenerating = false;
    renderExerciseModal();
  }
}
```

- [ ] **Step 5: Wire the button into the modal click delegator**

Find (~line 8699):

```js
  if (e.target.closest && e.target.closest('#btnFormNotesRegen')) {
    onFormNotesRegen();
    return;
```

Immediately **after** the closing `}` of that `if` block, add:

```js
  if (e.target.closest && e.target.closest('#btnFormVideoFind')) {
    onFormVideoFind();
    return;
  }
```

- [ ] **Step 6: Lint-check the file parses**

Run: `node --check js/ui.js`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add js/ui.js
git commit -m "feat: Form Video control + YouTube-search fallback in exercise modal"
```

---

### Task 5: Version bump, manual verification, finalize

**Files:**
- Modify: `js/app.js:10`

- [ ] **Step 1: Bump `APP_VERSION`**

Find in `js/app.js` (~line 10):

```js
var APP_VERSION = 'v3.6.25';
```

Replace with:

```js
var APP_VERSION = 'v3.6.26';
```

> If `v3.6.25` has already been committed/shipped for another feature by execution time, bump to the next unused patch instead and note it in the commit message.

- [ ] **Step 2: Run the app locally**

Run: `vercel dev` (the project deploys on Vercel; `vercel dev` serves the static app + `/api`).
Expected: app loads at the printed localhost URL, sign-in works.

- [ ] **Step 3: Manual verification — happy path**

1. Sign in. Open any exercise's detail modal (tap an exercise → modal opens).
2. Switch to the **Form** tab. Confirm a new **Form Video** section appears below AI Coach Notes with a **"Find form video"** button.
3. For a common lift (e.g. "Barbell Back Squat"), tap **Find form video**. Button shows "Searching…".
4. Within ~40s a link appears: **▶ &lt;title&gt; · &lt;channel&gt;** with a "Found: &lt;date&gt;" stamp. Click it → opens a real, on-topic technique video in a new tab.
Expected: PASS — real video, correct exercise.

- [ ] **Step 4: Manual verification — cache + re-search**

1. Close the modal, reopen the same exercise, Form tab.
Expected: the video link renders immediately with no spinner/network call (served from `exercise_form_notes` via `loadFormNotes`).
2. Tap **Re-search**. On a good new result the link/title/date update.
Expected: PASS.

- [ ] **Step 5: Manual verification — no-result fallback**

1. Create/pick a custom exercise with a nonsense name (e.g. "Zorbax Glute Twizzler").
2. Open its modal → Form tab → **Find form video**.
Expected: toast "Couldn't find a vetted video — opening a YouTube search instead.", a YouTube **search** page opens in a new tab, and **nothing is persisted** (reopen modal → still "No video yet", no broken link).

- [ ] **Step 6: Manual verification — error + regression**

1. Stop `vercel dev` (or go offline) and tap **Find form video** → expect a toast, button returns to idle, no crash, any previously saved video still shown on reopen.
2. Regression: on an exercise with no AI notes, tap **"Ask the coach"** (AI Coach Notes). Confirm it still returns 3-4 sentences quickly and is unaffected by the multi-block parsing change.
Expected: PASS for both.

- [ ] **Step 7: Commit**

```bash
git add js/app.js
git commit -m "v3.6.26 -- AI web-grounded form-video lookup per exercise"
```

- [ ] **Step 8: Report results**

Report the manual verification matrix outcomes (Steps 3-6) to the reviewer. Do NOT claim completion unless every manual check passed; if any failed, report the failure with details and stop.

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1) ✓; `form_video` mode + web search + multi-block parse + URL validation + 40s timeout (Task 2) ✓; `generateAiFormVideo`/`saveAiFormVideo`/extended loaders (Task 3) ✓; modal UI + cache reuse + YouTube fallback + no-result-doesn't-overwrite (Task 4) ✓; versioning + manual test matrix (Task 5) ✓. Modal-only / no-bundling / no-session-card scope respected (no session-card edits).
- **Type consistency:** API returns `{ video: { url, title, channel } }` for `form_video` (or `{ video: { url: null } }`); `generateAiFormVideo` normalizes to `{ url, title, channel }`; `saveAiFormVideo` reads `video.url`/`video.title`; DB/loaders use `ai_video_url`/`ai_video_title`/`ai_video_generated_at` consistently. `ai_video_channel` is explicitly in-memory-only (documented in Task 4 Step 3 note + Step 4) — not in the migration, not in any select.
- **No placeholders:** every step has concrete code/commands/expected output.
