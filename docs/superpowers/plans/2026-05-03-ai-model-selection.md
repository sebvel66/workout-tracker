# Per-user AI model selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 3-bucket per-user model selector (Coach / Plan flows / Analyze) in the Coaching Profile screen, with the user's choice persisted in `coaching_profile.data` and a hardcoded allowlist mirrored on client and server.

**Architecture:** Two parallel allowlist files (`api/_models.js` ESM + `js/models.js` browser globals) declare `AVAILABLE_MODELS`, `DEFAULT_MODELS`, and a `resolveModel(requestedId, bucket)` validator. The client passes the selected model in each AI request body; the server validates against the allowlist and falls back to bucket-default on miss. The Coaching Profile screen gains a new section with three `<select>` rows that load from / write to `coachingProfile.model_coach / model_plan / model_analyze`.

**Tech Stack:** Plain JS (no build step), ESM on the API side (Vercel Node serverless, `package.json` `"type": "module"`), browser globals on the client (loaded via `<script src>`), Supabase JS client. No automated test framework — verification is manual browser smoke testing per project convention.

**Spec:** [docs/superpowers/specs/2026-05-03-ai-model-selection-design.md](../specs/2026-05-03-ai-model-selection-design.md)

**Version target:** **`v3.2.0`** — first feature on top of v3.1.x. Minor bump per project convention.

**Workflow rules:**
- Subagent writes + commits; user smoke-tests asynchronously.
- Working on `main`. No worktree.
- Never push without explicit user approval.
- Never amend; always new commits.

---

## File map

| File | Change |
|---|---|
| `api/_models.js` | **NEW** — server-side ESM allowlist + `resolveModel`. |
| `js/models.js` | **NEW** — client-side browser-globals copy of the same data. |
| `index.html` | Add `<script src="js/models.js">` before `js/data.js`. Add the new "AI models" section markup inside `#coachingProfileBody` (after Special Instructions, before form close). |
| `api/coach-chat.js` | Replace `const MODEL = '...'` with `import { resolveModel } from './_models.js'` + per-request resolution using bucket `'coach'`. |
| `api/generate-plan.js` | Same import; per-request resolution using bucket `'analyze'` if `mode === 'analyze'`, else `'plan'`. |
| `js/data.js` | Add three resolver helpers (`modelForCoach` / `modelForPlan` / `modelForAnalyze`) near the existing `loadCoachingProfile` / `saveCoachingProfile` (~line 2600). |
| `js/ui.js` | Wire 5 AI POST bodies to send `model:` (call sites at ~2557, ~2933, ~4170, ~3977 for coach, plus the per-mode `payload.model` for plan/analyze sharing). Update `populateCoachingProfileForm` to populate + select dropdowns. Update Coaching Profile save handler to read the three new fields into the saved profile. |
| `js/app.js` | Bump `APP_VERSION` from `v3.1.0` → `v3.2.0` (final task). |
| `HANDOFF.md` | Add v3.2.0 milestone paragraph. |
| `ROADMAP.md` | Add `Shipped — v3.2.0` section. |

No migration. No new schema. The three new keys (`model_coach`, `model_plan`, `model_analyze`) live inside the existing `coaching_profile.data` JSONB blob.

---

### Task 1: Allowlist module (server + client) + script tag

Create both copies of the allowlist module and load the client copy in `index.html`. After this task: data exists, no callers yet — feature inert but loadable.

**Files:**
- Create: `api/_models.js` (ESM)
- Create: `js/models.js` (browser globals)
- Modify: `index.html` — `<script src="js/models.js">` before `js/data.js`

- [ ] **Step 1: Create `api/_models.js`**

```js
// api/_models.js — Allowlist of AI models the user may select per bucket
// (Coach / Plan flows / Analyze). Server-side ESM copy; the browser
// globals copy lives at js/models.js and MUST be kept in sync byte-for-
// byte in the data sections (only the module wrapper differs).
//
// When Anthropic ships a new model: add a row to AVAILABLE_MODELS in
// BOTH files, then redeploy. Optionally retire an older entry by
// deleting its row — users with that model selected fall back to the
// bucket default automatically (resolveModel below).

export const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-7',           label: 'Opus 4.7',   tier: 'most capable' },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', tier: 'balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  tier: 'fast' },
];

export const DEFAULT_MODELS = {
  coach:   'claude-haiku-4-5-20251001',
  plan:    'claude-sonnet-4-6',
  analyze: 'claude-sonnet-4-6',
};

// resolveModel: return requestedId if it's in AVAILABLE_MODELS, else
// fall back to the bucket's default. Falsy / unknown input always falls
// back. Used both server-side (validation) and client-side (load-time
// resolution before the dropdown render).
export function resolveModel(requestedId, bucket) {
  if (requestedId && AVAILABLE_MODELS.some(function(m) { return m.id === requestedId; })) {
    return requestedId;
  }
  return DEFAULT_MODELS[bucket];
}
```

- [ ] **Step 2: Create `js/models.js`**

```js
// js/models.js — Browser-globals copy of the model allowlist + helper.
// MIRRORS api/_models.js byte-for-byte in the data sections; only the
// wrapper differs (var globals here vs ESM exports there). Kept in two
// physical files because the project has no build step; the operational
// checklist for new model releases is "edit both files + redeploy."

var AVAILABLE_MODELS = [
  { id: 'claude-opus-4-7',           label: 'Opus 4.7',   tier: 'most capable' },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', tier: 'balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  tier: 'fast' },
];

var DEFAULT_MODELS = {
  coach:   'claude-haiku-4-5-20251001',
  plan:    'claude-sonnet-4-6',
  analyze: 'claude-sonnet-4-6',
};

function resolveModel(requestedId, bucket) {
  if (requestedId && AVAILABLE_MODELS.some(function(m) { return m.id === requestedId; })) {
    return requestedId;
  }
  return DEFAULT_MODELS[bucket];
}
```

- [ ] **Step 3: Add `<script src="js/models.js">` to `index.html`**

In `index.html`, find the existing block of script tags around line 3062-3066:

```html
<script src="js/resolver.js"></script>
<script src="js/data.js"></script>
<script src="js/ui.js"></script>
<script src="js/auth.js"></script>
<script src="js/app.js"></script>
```

Insert `models.js` after `resolver.js` (so it's loaded before `data.js`, which will reference the globals):

```html
<script src="js/resolver.js"></script>
<script src="js/models.js"></script>
<script src="js/data.js"></script>
<script src="js/ui.js"></script>
<script src="js/auth.js"></script>
<script src="js/app.js"></script>
```

- [ ] **Step 4: Verify in browser console**

After hard-reload: open DevTools console. Verify:
- `typeof AVAILABLE_MODELS === 'object' && AVAILABLE_MODELS.length === 3` → `true`.
- `typeof DEFAULT_MODELS === 'object'` → `true`.
- `typeof resolveModel === 'function'` → `true`.
- `resolveModel('claude-sonnet-4-6', 'plan')` → `'claude-sonnet-4-6'`.
- `resolveModel('not-a-real-model', 'coach')` → `'claude-haiku-4-5-20251001'`.
- `resolveModel(null, 'analyze')` → `'claude-sonnet-4-6'`.

- [ ] **Step 5: Commit**

```bash
git add api/_models.js js/models.js index.html
git commit -F /tmp/commit_msg_t1.txt
```

Where `/tmp/commit_msg_t1.txt` contains:

```
feat(models): server + client allowlist module (v3.2.0 prep)

Adds api/_models.js (ESM) and js/models.js (browser globals) declaring
AVAILABLE_MODELS, DEFAULT_MODELS, and resolveModel. No callers yet.
index.html loads the client copy before js/data.js so resolver helpers
(coming next task) can reference the globals.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 2: Server-side per-request model resolution

Replace the hardcoded `MODEL` constant in both API files with `resolveModel(req.body.model, bucket)`. After this task: server accepts an optional `model` field in the request body, validates against the allowlist, falls back to default if missing/invalid. Backwards-compatible — existing client requests (which don't send `model`) get the default.

**Files:**
- Modify: `api/coach-chat.js` — line 20 (`const MODEL = ...`) and line 165 (`model: MODEL`).
- Modify: `api/generate-plan.js` — line 28 (`const MODEL = ...`), and four sites that use `model: MODEL` (lines 207, 854, 1125, 1314).

- [ ] **Step 1: `api/coach-chat.js` — import resolver and replace MODEL**

Add the import near the top (after `export const maxDuration = 30;` at line 18):

```js
import { resolveModel } from './_models.js';
```

Delete the hardcoded constant at line 20:

```js
const MODEL = 'claude-haiku-4-5-20251001';
```

Find the request handler — search for `const MODEL` references inside the handler. The Anthropic POST is around line 165 (`model: MODEL`). Before that POST, derive `model` from the request body. The exact location depends on how the handler reads its body — it likely already has a parsed `body` variable. Add this near the top of the handler body, after body parsing succeeds:

```js
    var requestedModel = (body && body.model) || null;
    var model = resolveModel(requestedModel, 'coach');
    if (requestedModel && requestedModel !== model) {
      console.warn('coach-chat: model fallback', { requested: requestedModel, resolved: model });
    }
```

Replace the `model: MODEL` reference at the Anthropic POST (line 165) with:

```js
        model: model,
```

And the response echo at ~line 203 (also `model: MODEL`):

```js
        model: model,
```

- [ ] **Step 2: `api/generate-plan.js` — import resolver and replace MODEL**

Add the import near the top of the imports block (after the `node:url` import at line 23):

```js
import { resolveModel } from './_models.js';
```

Delete the hardcoded constant at line 28:

```js
const MODEL = 'claude-sonnet-4-6';
```

The handler in this file dispatches on `mode` (plan / refine / swap / analyze). Bucket is `'analyze'` when `mode === 'analyze'`, else `'plan'`. Each of the four mode-handler blocks calls Anthropic with `model: MODEL`. For each, derive `model` near the top of that block:

For the **plan** mode block (default, around line 199-208):
```js
    var requestedModel = (rawInputs && rawInputs.model) || null;
    var model = resolveModel(requestedModel, 'plan');
    if (requestedModel && requestedModel !== model) {
      console.warn('generate-plan/plan: model fallback', { requested: requestedModel, resolved: model });
    }
```
Replace `model: MODEL` at line 207 with `model: model,`.
And the response echo at line 278 (`model: MODEL,`) with `model: model,`.

For the **swap** mode block (around line 846-854):
```js
    var requestedModelSwap = (rawInputs && rawInputs.model) || null;
    var modelSwap = resolveModel(requestedModelSwap, 'plan');
    if (requestedModelSwap && requestedModelSwap !== modelSwap) {
      console.warn('generate-plan/swap: model fallback', { requested: requestedModelSwap, resolved: modelSwap });
    }
```
Replace `model: MODEL` at line 854 with `model: modelSwap,`.
And the response echo at line 908 (`model: MODEL,`) with `model: modelSwap,`.

For the **refine** mode block (around line 1117-1125):
```js
    var requestedModelRefine = (rawInputs && rawInputs.model) || null;
    var modelRefine = resolveModel(requestedModelRefine, 'plan');
    if (requestedModelRefine && requestedModelRefine !== modelRefine) {
      console.warn('generate-plan/refine: model fallback', { requested: requestedModelRefine, resolved: modelRefine });
    }
```
Replace `model: MODEL` at line 1125 with `model: modelRefine,`.
And the response echo at line 1184 (`model: MODEL,`) with `model: modelRefine,`.

For the **analyze** mode block (around line 1306-1314):
```js
    var requestedModelAnalyze = (rawInputs && rawInputs.model) || null;
    var modelAnalyze = resolveModel(requestedModelAnalyze, 'analyze');
    if (requestedModelAnalyze && requestedModelAnalyze !== modelAnalyze) {
      console.warn('generate-plan/analyze: model fallback', { requested: requestedModelAnalyze, resolved: modelAnalyze });
    }
```
Replace `model: MODEL` at line 1314 with `model: modelAnalyze,`.
And the response echo at line 1388 (`model: MODEL,`) with `model: modelAnalyze,`.

(The four blocks use distinct variable names — `model`, `modelSwap`, `modelRefine`, `modelAnalyze` — to avoid `var` hoisting collisions if these blocks share a scope. If on inspection they're truly in independent function scopes, `model` everywhere is fine; pick the form that suits the actual structure.)

- [ ] **Step 3: Manual server smoke**

After deploying or running locally:
- POST `/api/coach-chat` with body `{ messages: [...] }` (no `model`). Should succeed using haiku.
- POST `/api/coach-chat` with body `{ messages: [...], model: 'claude-sonnet-4-6' }`. Should succeed using sonnet (no fallback warning in logs).
- POST `/api/coach-chat` with body `{ messages: [...], model: 'fake-model' }`. Should succeed using haiku, with a `coach-chat: model fallback` warning in Vercel logs.

(In practice the user does this AFTER all client-side wiring lands; Task 2 alone produces no client-visible behavior change.)

- [ ] **Step 4: Commit**

```bash
git add api/coach-chat.js api/generate-plan.js
git commit -F /tmp/commit_msg_t2.txt
```

`/tmp/commit_msg_t2.txt`:

```
feat(api): per-request model resolution via _models.js

Both /api/coach-chat and /api/generate-plan now read an optional
`model` field from the request body, validate via resolveModel, and
fall back to bucket default (haiku for coach, sonnet for plan/analyze)
on miss. Logs a warn on fallback so retired-model selections stored in
coaching_profile surface in Vercel logs.

No client behavior change — clients aren't sending `model` yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 3: Client resolver helpers in `js/data.js`

Add three small helpers that read the user's stored model selection (or default if unset) for each bucket. After this task: helpers exist, used in Task 4.

**Files:**
- Modify: `js/data.js` — insert after `saveCoachingProfile` (~line 2628).

- [ ] **Step 1: Add the three helpers**

Find the closing `}` of `saveCoachingProfile` in `js/data.js` (~line 2628). Insert directly after, with a blank line above:

```js

// Per-bucket model resolvers (v3.2.0). Reads the user's stored selection
// from coachingProfile.model_<bucket> (the JSONB blob is loaded flat into
// `coachingProfile`, not nested under .data — see loadCoachingProfile).
// Falls back to bucket default if unset or pointing at a retired model.
function modelForCoach() {
  return resolveModel(coachingProfile && coachingProfile.model_coach, 'coach');
}
function modelForPlan() {
  return resolveModel(coachingProfile && coachingProfile.model_plan, 'plan');
}
function modelForAnalyze() {
  return resolveModel(coachingProfile && coachingProfile.model_analyze, 'analyze');
}
```

- [ ] **Step 2: Verify in browser console**

After hard-reload (load Coaching Profile at least once so `coachingProfile` is populated):

- `typeof modelForCoach === 'function'` → `true`.
- `modelForCoach()` → `'claude-haiku-4-5-20251001'` (default, since no field saved yet).
- `modelForPlan()` → `'claude-sonnet-4-6'`.
- `modelForAnalyze()` → `'claude-sonnet-4-6'`.

- [ ] **Step 3: Commit**

```bash
git add js/data.js
git commit -F /tmp/commit_msg_t3.txt
```

`/tmp/commit_msg_t3.txt`:

```
feat(models): client resolver helpers for model buckets

Three small helpers read coachingProfile.model_<bucket> and fall back
to DEFAULT_MODELS via resolveModel. Used by the AI call sites in the
next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 4: Wire 5 client AI call sites to send `model:`

Five POST bodies need a `model:` field added. Each uses the bucket-appropriate helper from Task 3.

**Files:**
- Modify: `js/ui.js` — five sites:
  1. Plan/analyze payload at ~line 2557-2574 (`submitGenerateInputs`).
  2. Refine payload at ~line 2933 (`fireRefine`).
  3. Swap payload at ~line 4170 (`fireSwapFetch`).
  4. Coach POST at ~line 3977 (`attemptCoachCall`).

(That's actually 4 distinct POST bodies — the plan vs analyze split happens via `mode` inside one payload, so we add a single conditional `model:` line that picks the right bucket.)

- [ ] **Step 1: Plan + Analyze payloads (~line 2557-2574)**

Find the existing `submitGenerateInputs` payload construction:

```js
  var payload;
  if (mode === 'analyze') {
    payload = {
      mode: 'analyze',
      history_weeks: historyWeeks,
      include_photos: includePhotos,
      notes: notes,
    };
  } else {
    payload = {
      start_date: startDate,
      target_duration: targetDuration,
      training_days: trainingDays,
      history_weeks: historyWeeks,
      include_photos: includePhotos,
      notes: notes,
    };
  }
```

Replace with (adds `model:` to each branch):

```js
  var payload;
  if (mode === 'analyze') {
    payload = {
      mode: 'analyze',
      model: modelForAnalyze(),
      history_weeks: historyWeeks,
      include_photos: includePhotos,
      notes: notes,
    };
  } else {
    payload = {
      model: modelForPlan(),
      start_date: startDate,
      target_duration: targetDuration,
      training_days: trainingDays,
      history_weeks: historyWeeks,
      include_photos: includePhotos,
      notes: notes,
    };
  }
```

- [ ] **Step 2: Refine payload (~line 2933)**

Find:

```js
    var payload = {
      mode: 'refine',
      current_plan: generatedPlan,
      iteration_history: iterationHistory,
      new_feedback: feedback,
```

Add `model: modelForPlan()` between `mode` and `current_plan`:

```js
    var payload = {
      mode: 'refine',
      model: modelForPlan(),
      current_plan: generatedPlan,
      iteration_history: iterationHistory,
      new_feedback: feedback,
```

- [ ] **Step 3: Swap payload (~line 4170)**

Find:

```js
    var payload = {
      mode: 'swap',
      exercise: exercise,
      reason: swapState.reason || '',
      day_name: swapState.dayName,
    };
```

Add `model: modelForPlan()`:

```js
    var payload = {
      mode: 'swap',
      model: modelForPlan(),
      exercise: exercise,
      reason: swapState.reason || '',
      day_name: swapState.dayName,
    };
```

- [ ] **Step 4: Coach POST body (~line 3977)**

Find:

```js
    var res = await fetch('/api/coach-chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages }),
    });
```

Replace the body to include `model`:

```js
    var res = await fetch('/api/coach-chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages, model: modelForCoach() }),
    });
```

- [ ] **Step 5: Smoke test in DevTools**

Hard-reload. With no model fields saved (defaults active):
1. Send a coach message → DevTools Network → `/api/coach-chat` request body shows `"model":"claude-haiku-4-5-20251001"`.
2. Open Generate Plan → submit → `/api/generate-plan` body shows `"model":"claude-sonnet-4-6"`.
3. Trigger Refine on a generated plan → body shows `"model":"claude-sonnet-4-6"`.
4. Trigger Swap from a plan-day exercise → body shows `"model":"claude-sonnet-4-6"`.
5. Run Analyze → body shows `"model":"claude-sonnet-4-6"`.

All five requests succeed (server falls back to default if it doesn't recognize the field, but it should recognize all five since Task 2 added handling).

- [ ] **Step 6: Commit**

```bash
git add js/ui.js
git commit -F /tmp/commit_msg_t4.txt
```

`/tmp/commit_msg_t4.txt`:

```
feat(models): wire 5 AI call sites to send selected model

Each AI POST body now includes model: modelFor<Bucket>(). Five sites:
- submitGenerateInputs (plan vs analyze branch)
- fireRefine
- fireSwapFetch
- attemptCoachCall (coach)

With no user selection saved, all helpers return DEFAULT_MODELS — same
models as before. Behavior unchanged until Task 5/6 add the picker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 5: HTML form section for model pickers

Add the new "AI models" section to the Coaching Profile screen. After this task: dropdowns appear in the UI but are empty (no options) and don't load saved values yet — that's Task 6.

**Files:**
- Modify: `index.html` — inside `#coachingProfileBody` → `.generate-inputs`, after the existing Special Instructions row.

- [ ] **Step 1: Find the insertion point**

Run:
```bash
grep -n "cpSpecialInstructions" /Users/sebastianvelez/workout-tracker/index.html
```

This gives the line of the Special Instructions textarea. The insertion point is the closing `</label>` of that row (the `<label class="generate-form-row">` that wraps the Special Instructions field).

- [ ] **Step 2: Insert the new section**

Insert this block immediately after the closing `</label>` of the Special Instructions row, and BEFORE the closing `</div>` that ends `.generate-inputs`:

```html
<div class="profile-section-label" style="margin-top:18px;">AI models</div>
<label class="generate-form-row">
  <span class="generate-form-label">Coach</span>
  <select id="cpModelCoach" class="generate-form-input"></select>
  <span class="generate-form-hint">Fast chat replies</span>
</label>
<label class="generate-form-row">
  <span class="generate-form-label">Plan flows</span>
  <select id="cpModelPlan" class="generate-form-input"></select>
  <span class="generate-form-hint">Plan generation, refinement, swaps</span>
</label>
<label class="generate-form-row">
  <span class="generate-form-label">Analyze</span>
  <select id="cpModelAnalyze" class="generate-form-input"></select>
  <span class="generate-form-hint">Post-workout reviews + profile updates</span>
</label>
<div class="generate-form-hint" style="margin-top:6px;">
  Selections apply on the next request. Switching mid-session may briefly slow the first request after the change (prompt cache cold).
</div>
```

(The classes `.generate-form-row`, `.generate-form-label`, `.generate-form-input`, `.generate-form-hint`, and `.profile-section-label` all exist already — no new CSS needed.)

- [ ] **Step 3: Verify in browser**

Hard-reload → hamburger → Coaching Profile. Scroll to the bottom of the form. Confirm:
- A new section heading "AI models" appears.
- Three rows below it labelled "Coach", "Plan flows", "Analyze".
- Each row has an empty `<select>` (no options yet — Task 6 populates).
- The hint paragraph appears at the bottom.

The form save still works for the other fields. Saving with empty model dropdowns shouldn't crash anything (the change handler in Task 6 will guard on missing values).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -F /tmp/commit_msg_t5.txt
```

`/tmp/commit_msg_t5.txt`:

```
feat(models): "AI models" section in Coaching Profile form

Three labelled <select> rows for Coach / Plan flows / Analyze, plus
the inline hint about cache-cold latency on switch. Dropdowns are
empty until the JS populator + load wiring lands in the next task.
Reuses existing generate-form-* / profile-section-label classes — no
new CSS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 6: UI populate + save wiring

Populate the three `<select>` elements from `AVAILABLE_MODELS` on form open, select the saved value (or default), and persist on Save. After this task: full feature works.

**Files:**
- Modify: `js/ui.js` — `populateCoachingProfileForm` (~line 927), Coaching Profile save handler (~line 1032-1047).

- [ ] **Step 1: Add `populateModelSelects` helper near `populateCoachingProfileForm`**

In `js/ui.js`, just above `function populateCoachingProfileForm` (~line 927), insert:

```js
// Populate the three model <select>s from AVAILABLE_MODELS. Run before
// setVal'ing them so the saved option exists to be selected.
function populateModelSelects() {
  var ids = ['cpModelCoach', 'cpModelPlan', 'cpModelAnalyze'];
  for (var i = 0; i < ids.length; i++) {
    var sel = document.getElementById(ids[i]);
    if (!sel) continue;
    sel.innerHTML = '';
    for (var j = 0; j < AVAILABLE_MODELS.length; j++) {
      var m = AVAILABLE_MODELS[j];
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label + ' (' + m.tier + ')';
      sel.appendChild(opt);
    }
  }
}
```

- [ ] **Step 2: Update `populateCoachingProfileForm` to call the helper + setVal the three new fields**

Find the existing function body (~line 927-946):

```js
function populateCoachingProfileForm(p) {
  var setVal = function(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = (val == null) ? '' : String(val);
  };
  setVal('cpSex', p.sex);
  ...
  setVal('cpSpecialInstructions', p.special_instructions);
  renderInjuryList(Array.isArray(p.injuries) ? p.injuries : []);
}
```

Insert two changes:
1. Call `populateModelSelects()` at the top, before any `setVal` calls.
2. Add three `setVal` calls for the new fields, after the existing `setVal('cpSpecialInstructions', ...)` line and before `renderInjuryList`.

Final shape:

```js
function populateCoachingProfileForm(p) {
  var setVal = function(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = (val == null) ? '' : String(val);
  };
  // Populate the model <select> options before setVal'ing — the saved
  // value's <option> must exist for the assignment to take effect.
  populateModelSelects();
  setVal('cpSex', p.sex);
  setVal('cpHeightFt', p.height_ft);
  setVal('cpHeightIn', p.height_in);
  setVal('cpWeightLbs', p.weight_lbs);
  setVal('cpExperienceLevel', p.experience_level);
  setVal('cpEnvironment', p.environment);
  setVal('cpSplitPreference', p.split_preference);
  setVal('cpGoalType', p.goal_type);
  setVal('cpGoalDetail', p.goal_detail);
  setVal('cpPhase', p.phase);
  setVal('cpPhaseStartDate', p.phase_start_date);
  setVal('cpPhaseNotes', p.phase_notes);
  setVal('cpSpecialInstructions', p.special_instructions);
  setVal('cpModelCoach',   p.model_coach   || DEFAULT_MODELS.coach);
  setVal('cpModelPlan',    p.model_plan    || DEFAULT_MODELS.plan);
  setVal('cpModelAnalyze', p.model_analyze || DEFAULT_MODELS.analyze);
  renderInjuryList(Array.isArray(p.injuries) ? p.injuries : []);
}
```

- [ ] **Step 3: Update the save handler to write the three new fields**

Find the save handler's `profile` object construction (~line 1032-1047):

```js
  var profile = {
    sex: trimOrNull(getVal('cpSex')),
    height_ft: parseIntOrNull(getVal('cpHeightFt')),
    height_in: parseIntOrNull(getVal('cpHeightIn')),
    weight_lbs: parseNumOrNull(getVal('cpWeightLbs')),
    experience_level: trimOrNull(getVal('cpExperienceLevel')),
    environment: trimOrNull(getVal('cpEnvironment')),
    split_preference: trimOrNull(getVal('cpSplitPreference')),
    goal_type: trimOrNull(getVal('cpGoalType')),
    goal_detail: trimOrNull(getVal('cpGoalDetail')),
    phase: trimOrNull(getVal('cpPhase')),
    phase_start_date: trimOrNull(getVal('cpPhaseStartDate')),
    phase_notes: trimOrNull(getVal('cpPhaseNotes')),
    injuries: readInjuryListFromDom(),
    special_instructions: trimOrNull(getVal('cpSpecialInstructions')),
  };
```

Add three lines after `special_instructions:`:

```js
  var profile = {
    sex: trimOrNull(getVal('cpSex')),
    height_ft: parseIntOrNull(getVal('cpHeightFt')),
    height_in: parseIntOrNull(getVal('cpHeightIn')),
    weight_lbs: parseNumOrNull(getVal('cpWeightLbs')),
    experience_level: trimOrNull(getVal('cpExperienceLevel')),
    environment: trimOrNull(getVal('cpEnvironment')),
    split_preference: trimOrNull(getVal('cpSplitPreference')),
    goal_type: trimOrNull(getVal('cpGoalType')),
    goal_detail: trimOrNull(getVal('cpGoalDetail')),
    phase: trimOrNull(getVal('cpPhase')),
    phase_start_date: trimOrNull(getVal('cpPhaseStartDate')),
    phase_notes: trimOrNull(getVal('cpPhaseNotes')),
    injuries: readInjuryListFromDom(),
    special_instructions: trimOrNull(getVal('cpSpecialInstructions')),
    // v3.2.0 model selections. Stored as plain strings; resolveModel on
    // read time handles invalid / retired IDs by falling back to default.
    model_coach:   trimOrNull(getVal('cpModelCoach'))   || null,
    model_plan:    trimOrNull(getVal('cpModelPlan'))    || null,
    model_analyze: trimOrNull(getVal('cpModelAnalyze')) || null,
  };
```

- [ ] **Step 4: Smoke test the full feature**

Hard-reload → hamburger → Coaching Profile.
1. The three dropdowns now show options (Opus 4.7 / Sonnet 4.6 / Haiku 4.5, each with their tier label).
2. Defaults preselected: Coach = Haiku, Plan flows = Sonnet, Analyze = Sonnet.
3. Change Coach to Sonnet, save, close.
4. Open coach panel. Send a message. DevTools Network → `/api/coach-chat` body's `"model":"claude-sonnet-4-6"`.
5. Reopen Coaching Profile. Coach dropdown shows Sonnet (persisted).
6. Change Coach back to Haiku, save.
7. Try Generate / Refine / Swap / Analyze with various model selections — verify each request body's `model:` matches what was selected.
8. Verify: changing model and saving doesn't break any of the other Coaching Profile fields (RPE, height, injuries should all survive a save round-trip).

- [ ] **Step 5: Commit**

```bash
git add js/ui.js
git commit -F /tmp/commit_msg_t6.txt
```

`/tmp/commit_msg_t6.txt`:

```
feat(models): populate + save model picker in Coaching Profile

populateModelSelects fills the three <select>s from AVAILABLE_MODELS
on every form open. populateCoachingProfileForm now calls it first,
then setVals the saved values (or DEFAULT_MODELS fallback). Save
handler reads the three new fields into the persisted profile.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 7: Version bump v3.2.0 + ROADMAP + HANDOFF

Mark the release. Three commits.

**Files:**
- Modify: `js/app.js` — line 10.
- Modify: `ROADMAP.md` — add `Shipped — v3.2.0` section above `Shipped — v3.1.0`.
- Modify: `HANDOFF.md` — update version line + add v3.2.0 milestone paragraph.

- [ ] **Step 1: Bump APP_VERSION**

In `js/app.js` line 10, change:
```js
var APP_VERSION = 'v3.1.0';
```
to:
```js
var APP_VERSION = 'v3.2.0';
```

Commit:
```bash
git add js/app.js
git commit -F /tmp/commit_msg_t7a.txt
```

`/tmp/commit_msg_t7a.txt`:

```
v3.2.0 -- per-user AI model selection

Three configurable model buckets in the Coaching Profile screen:
Coach, Plan flows (plan/refine/swap), Analyze. Selections persist in
coaching_profile.data; client passes the resolved model in each AI
request body; server validates against a hardcoded allowlist
(api/_models.js + js/models.js, kept in sync) and falls back to
bucket default on miss.

When Anthropic ships a new model, edit both _models.js / models.js,
add a row, redeploy. Spec + plan in
docs/superpowers/specs/2026-05-03-ai-model-selection-design.md and
docs/superpowers/plans/2026-05-03-ai-model-selection.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 2: Update ROADMAP.md**

Insert above the `## Shipped — v3.1.0 (2026-05-02)` section header:

```markdown
## Shipped — v3.2.0 (2026-05-03)

Live at www.sebvel.app as of `v3.2.0`. Per-user AI model selection — Coach, Plan flows, and Analyze each get an independent dropdown in the Coaching Profile screen, backed by a hardcoded allowlist mirrored on client (`js/models.js`) and server (`api/_models.js`).

- **Per-user AI model selection (`v3.2.0`).** New "AI models" section appended to the Coaching Profile form (hamburger → Coaching Profile). Three labelled `<select>` rows: Coach (default Haiku 4.5), Plan flows (default Sonnet 4.6, covers plan / refine / swap modes), Analyze (default Sonnet 4.6). Selections persist as `model_coach` / `model_plan` / `model_analyze` keys inside the existing `coaching_profile.data` JSONB blob — no schema migration. Each AI POST body now includes `model:` resolved via `coachingProfile.model_<bucket> || DEFAULT_MODELS[bucket]`. Server (`api/coach-chat`, `api/generate-plan`) reads the field, validates against `AVAILABLE_MODELS`, falls back to bucket default on miss with a `console.warn` so retired-model selections surface in Vercel logs. Operational pattern for new Anthropic releases: add a row to both `api/_models.js` and `js/models.js`, optionally retire an older entry, push — Vercel deploys client + API together. Spec + plan: [docs/superpowers/specs/2026-05-03-ai-model-selection-design.md](docs/superpowers/specs/2026-05-03-ai-model-selection-design.md), [docs/superpowers/plans/2026-05-03-ai-model-selection.md](docs/superpowers/plans/2026-05-03-ai-model-selection.md).

```

Commit:
```bash
git add ROADMAP.md
git commit -F /tmp/commit_msg_t7b.txt
```

`/tmp/commit_msg_t7b.txt`:

```
docs(roadmap): Shipped — v3.2.0 (per-user AI model selection)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 3: Update HANDOFF.md**

In `HANDOFF.md`:

1. Top of file (line 7): change "Current live version: **`v3.1.0`**" to "**`v3.2.0`**", and "**Through v3.1.0 fully shipped**" to "**Through v3.2.0 fully shipped**".

2. Insert a new milestone paragraph BEFORE the existing v3.1.0 paragraph:

```markdown
**v3.2.0 (2026-05-03) — Per-user AI model selection.** New "AI models" section in the Coaching Profile screen (hamburger → Coaching Profile) with three dropdowns: Coach (default Haiku 4.5), Plan flows (default Sonnet 4.6 — covers plan/refine/swap), Analyze (default Sonnet 4.6). Selections persist in `coaching_profile.data` (`model_coach`, `model_plan`, `model_analyze`) — no schema migration. Each AI POST body sends `model:` resolved from the profile via three new helpers in `data.js` (`modelForCoach`, `modelForPlan`, `modelForAnalyze`); server validates via a shared allowlist (`api/_models.js` + `js/models.js`) and falls back to the bucket default on miss. New model releases: edit both files + redeploy. Spec / plan: `docs/superpowers/specs/2026-05-03-ai-model-selection-design.md` and `docs/superpowers/plans/2026-05-03-ai-model-selection.md`.

```

Commit:
```bash
git add HANDOFF.md
git commit -F /tmp/commit_msg_t7c.txt
```

`/tmp/commit_msg_t7c.txt`:

```
docs: HANDOFF current through v3.2.0

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 4: Final smoke pass**

1. Footer reads `v3.2.0`.
2. Coaching Profile shows the three dropdowns with options + saved values.
3. Each AI surface (coach, plan generation, refine, swap, analyze) sends the user's selected model in its POST body.
4. Server falls back gracefully if a stored model ID is no longer in the allowlist (test by manually editing `coaching_profile.data` in Supabase to set `model_coach` to a fake string — coach panel still works, Vercel logs show fallback warning).

- [ ] **Step 5: Pending user approval — push**

Per project convention, do NOT push without explicit user approval. After all task commits land locally, ask:

> "v3.2.0 ready to push. Confirm and I'll push to origin/main?"

Wait for explicit confirmation before running `git push`.

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Schema (no migration; JSONB fields) | Task 6 (writes the keys via save handler) |
| Allowlist module (server + client) | Task 1 |
| `resolveModel` helper (both files) | Task 1 |
| Client resolver helpers `modelForX` | Task 3 |
| Server-side per-request resolution | Task 2 |
| Five AI call sites carry `model:` | Task 4 |
| Coaching Profile form — HTML section | Task 5 |
| Coaching Profile form — populate + save | Task 6 |
| `populateModelSelects` helper | Task 6 |
| Operational future-model release flow | Captured in Task 1 module comments + ROADMAP/HANDOFF entries (Task 7) |
| Version bump to v3.2.0 | Task 7 |
| ROADMAP + HANDOFF refresh | Task 7 |

All spec sections covered.

**Type / signature consistency:**
- `resolveModel(requestedId, bucket)` — same signature in `api/_models.js` (Task 1) and `js/models.js` (Task 1); used identically by server (Task 2) and client (Task 3).
- `modelForCoach()` / `modelForPlan()` / `modelForAnalyze()` — defined Task 3, called Task 4.
- `populateModelSelects()` — defined Task 6, called from `populateCoachingProfileForm` (Task 6).
- `coachingProfile.model_coach / model_plan / model_analyze` — written in Task 6 save handler, read in Task 3 helpers, populated in Task 6 setVal calls. All consistent.

**Placeholder scan:** No "TBD" / "TODO" / vague phrasing. Every step has explicit code blocks or shell commands. Line-number anchors all back to specific real lines confirmed during planning.

**Operational caveats inside the plan that need user awareness:**
- The four `model: MODEL` sites in `api/generate-plan.js` (Task 2) span ~1100 lines apart. The plan uses distinct variable names (`model`, `modelSwap`, `modelRefine`, `modelAnalyze`) per block to be safe against `var` hoisting collisions. If on inspection the four blocks are clearly in separate function scopes, the implementer can collapse to a single `model` name everywhere — the plan calls this out inline.
- The user's Coaching Profile must be loaded (lazy-loaded on first open) before `modelForX()` returns the saved value. Pre-first-load, all helpers return `DEFAULT_MODELS`. This matches the existing `coachingProfile === null` lazy-load pattern in `openCoachingProfile`.
