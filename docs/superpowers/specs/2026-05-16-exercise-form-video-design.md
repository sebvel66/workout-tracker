# Exercise Form-Video Lookup — Design

**Date:** 2026-05-16
**Status:** Approved (pending spec review)

## Problem

Users want a link to a good demonstration of how to perform each exercise
with correct form. The app already documents technique per exercise via the
**AI Coach Notes** / **My Notes** sections (`exercise_form_notes` table,
surfaced in the exercise detail modal). There is no video reference.

## Goal

Add an on-demand, web-grounded "form video" per exercise, cached per
user × exercise alongside the existing AI notes, surfaced in the exercise
detail modal's Form Notes section. The link must be a *real, current* video
(no hallucinated dead URLs), so it is grounded with Anthropic's server-side
web search rather than asking the model to recall a URL blind.

## Non-Goals

- No curated/shared video library column on `exercises`.
- No video links on session cards or anywhere outside the exercise modal
  (v1 is modal-only).
- No bundling into the AI Coach Notes regeneration — the video lookup is a
  separate, explicitly triggered action so text-note regen stays fast/cheap.
- No automated tests (this app has no test harness; manual matrix below).

## Architecture

Extends the existing AI form-notes feature with a new on-demand lookup that
reuses the same storage row, the same `/api/coach-chat` function (new mode),
and the same modal section.

### 1. Data model

New migration `supabase/migrations/<ts>_exercise_form_video.sql` adding three
columns to `exercise_form_notes`:

- `ai_video_url text`
- `ai_video_title text`
- `ai_video_generated_at timestamptz`

No new RLS: the existing composite PK `(user_id, exercise_id)` and the
owner-only select/insert/update/delete policies already cover these columns.
Writes upsert on `onConflict: 'user_id,exercise_id'`, identical to
`saveAiFormNote`.

### 2. API — new `mode: 'form_video'` in `/api/coach-chat`

- **`FORM_VIDEO_SYSTEM_PROMPT`** (new constant): role is "find the single
  best-quality form/technique tutorial video for the given exercise from a
  reputable strength/hypertrophy coach or established fitness channel."
  Output contract: **strict JSON only, no prose** —
  `{"url": "...", "title": "...", "channel": "..."}` when a solid video is
  found, or `{"url": null}` when nothing reputable is found. Prefer
  well-known coaching channels; prefer a single dedicated technique video
  over compilations.
- **Web search tool**: when `body.mode === 'form_video'`, add
  `tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]`
  to the Anthropic request. `anthropic-version: 2023-06-01` (already in use)
  supports this server tool; no beta header needed. `max_uses: 3` caps the
  per-call search cost (~$10 / 1000 searches).
- **Context splice**: skipped, exactly like `form_only` — no profile /
  history / templates. The system prompt is sent as its own
  `cache_control` text block, so it caches independently from the
  `form_only` and default coach prompts (distinct content → distinct cache).
- **Response parsing**: a web-search response contains multiple content
  blocks (`server_tool_use`, `web_search_tool_result`, then one or more
  `text` blocks with citation annotations). The handler must:
  1. Concatenate the `.text` of every `type === 'text'` content block
     (the current code only reads `content[0].text`, which breaks here).
  2. Extract the trailing JSON object (last balanced `{ ... }`), tolerant
     of surrounding whitespace/citation markup.
  3. Parse it; validate `url` (when non-null) is a well-formed `http(s)`
     URL. Reject any other scheme / malformed value → treat as `url:null`.
  4. Return `{ url, title, channel }` (or `{ url: null }`) plus `model` /
     `usage`, mirroring the existing response envelope.
- **Timeout**: the existing `form_only` path uses a 25s client-initiated
  abort. Web search is slower; `form_video` uses a ~40s abort. The function
  has no `maxDuration` override in `vercel.json`, so it runs under the
  platform default (300s) — 40s is safely within it.
- Non-`form_video` modes are completely unchanged (same prompt, no tools,
  same 25s timeout, same single-block text read).

### 3. Client — `js/data.js`

- `generateAiFormVideo(exerciseRow)` — mirrors `generateAiFormNote`:
  resolves the session token, POSTs `/api/coach-chat` with
  `{ model: modelForCoach(), mode: 'form_video', messages: [{ role:'user',
  content: <compact exercise descriptor> }] }`. The user message is a
  data-only prompt (name + equipment + primary muscle), matching the
  `generateAiFormNote` pattern (rules live in the cached system prompt).
  Returns the parsed `{ url, title, channel }` (or `{ url: null }`).
- `saveAiFormVideo(exerciseId, video)` — upserts
  `{ user_id, exercise_id, ai_video_url, ai_video_title,
  ai_video_generated_at: now, updated_at: now }` into
  `exercise_form_notes` with `onConflict: 'user_id,exercise_id'`. Passing
  `null` clears the three video fields (re-search that finds nothing should
  *not* wipe a previously good link — see UI behavior).
- `loadFormNotes` and `loadFormNotesBatch` selects extended to include
  `ai_video_url, ai_video_title, ai_video_generated_at` so an already-found
  video renders on modal open with no API call (reuses `formNotesCache`).

### 4. UI — exercise modal Form Notes section (`js/ui.js`)

A control row beneath the AI Coach Notes block:

- **No cached video** → button **"▶ Find form video"**.
- **In flight** → button disabled with a spinner / "Searching…" label
  (reuse the existing form-notes generating-state pattern /
  `formNotesGenerating`-style flag).
- **Video found** → a link card: **"▶ <title> · <channel>"** that opens
  `ai_video_url` in a new tab (`target="_blank" rel="noopener"`), a
  "found <date>" stamp from `ai_video_generated_at`, and a small **↻**
  affordance to re-search (overwrites on a new good result).
- **No-result fallback** → when the API returns `url: null`, do *not*
  overwrite any existing saved video. Show a clearly-labeled
  **"Search YouTube for &lt;exercise&gt;"** link that opens
  `https://www.youtube.com/results?search_query=<exercise name + " form">`
  (URL-encoded), plus a toast: "Couldn't find a vetted video — here's a
  YouTube search instead." The fallback link is transient (not persisted);
  it is clearly a search, not a picked video.
- Reuses `formNotesCache` so reopening the modal shows the cached link with
  no network call.

## Data Flow

1. User opens exercise modal → `loadFormNotes` returns row incl. video
   columns → if `ai_video_url` present, render the link card from cache.
2. User clicks "Find form video" → `generateAiFormVideo(exerciseRow)` →
   `/api/coach-chat` (mode `form_video`, web search) → parsed result.
3. `{url: "..."}` → `saveAiFormVideo` upsert → update `formNotesCache` →
   re-render as link card.
4. `{url: null}` → no save → render the YouTube-search fallback link +
   toast.

## Error Handling

- API non-200 / network failure / 40s timeout → non-destructive toast
  ("Couldn't search right now — try again"), button returns to idle,
  nothing saved, any existing cached video preserved.
- Server-side: non-`http(s)` or malformed `url` from the model is coerced
  to `{url:null}` (treated as no-result → fallback path).
- Empty/parse-failure model output → `{url:null}` (fallback path), logged
  server-side like other coach-chat errors.

## Testing

No automated test harness in this project — manual verification matrix:

1. Common lift (e.g. "barbell back squat") → returns a reputable
   single-exercise technique video; link opens correctly in a new tab.
2. Obscure custom exercise (nonsense name) → graceful no-result → YouTube
   search fallback link + toast; nothing persisted.
3. Reopen modal after a successful find → cached card renders with no
   network call; "found <date>" correct.
4. Re-search (↻) over an existing video with a good new result →
   overwrites; with a no-result → keeps the old video, shows fallback toast.
5. API down / airplane mode → toast, button idle, no crash, existing
   cached video preserved.
6. `form_only` (AI Coach Notes) regen still works unchanged and stays fast
   (regression check that the multi-block parsing change didn't break the
   single-block path).

## Versioning

Patch-level follow-up within the current minor (per the versioning
convention: milestone bundles use the minor version, patches are for
follow-ups). Bump `APP_VERSION` in `js/app.js` to the next patch on the
visible change. Migration committed with the feature.

## Open Questions

None — all design decisions resolved during brainstorming.
