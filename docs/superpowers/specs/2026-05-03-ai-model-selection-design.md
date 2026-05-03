# Per-user AI model selection — design

**Date:** 2026-05-03
**Target version:** v3.2.0
**Status:** approved, ready for implementation plan

## Problem

The app calls Anthropic from two places: `api/coach-chat.js` (currently `claude-haiku-4-5-20251001`) and `api/generate-plan.js` (currently `claude-sonnet-4-6`, serving four modes — `plan` / `refine` / `swap` / `analyze`). Each pins a model via a hardcoded `MODEL` constant. There's no per-user choice. The user wants to pick which model serves which AI surface, with a clean operational path for adopting new Anthropic releases without rebuilding from scratch.

## Goal

Three configurable buckets:

| Bucket | Used by | Today's default |
|---|---|---|
| **Coach** | `api/coach-chat.js` | `claude-haiku-4-5-20251001` (Haiku 4.5) |
| **Plan flows** | `api/generate-plan.js` modes `plan` / `refine` / `swap` | `claude-sonnet-4-6` (Sonnet 4.6) |
| **Analyze** | `api/generate-plan.js` mode `analyze` | `claude-sonnet-4-6` (Sonnet 4.6) |

Each bucket reads its model from the user's `coaching_profile.data` JSONB blob. A hardcoded default applies if the field is unset OR refers to a model no longer in the allowlist.

Plan-and-refine-and-swap share a bucket because they're the same code path and prompt structure (`generate-plan.js`'s mode-switched system prompt), with refine being a multi-turn continuation of plan and swap being a smaller variant of the same generative task. Analyze is its own bucket because it does fundamentally different work — reasoning over logged sets and emitting structured `profile_updates`.

## UX

A new "AI models" section appended to the existing Coaching Profile screen (hamburger menu → Coaching Profile, the existing screen with sex / height / experience / phase / injuries / special instructions). The section sits at the bottom of the form, after Special Instructions and before the Save button.

Layout:

```
─────────────────────────
AI models

Coach          [Haiku 4.5 (fast) ▼]
                 Fast chat replies

Plan flows     [Sonnet 4.6 (balanced) ▼]
                 Plan generation, refinement, swaps

Analyze        [Sonnet 4.6 (balanced) ▼]
                 Post-workout reviews + profile updates

Selections apply on the next request. Switching mid-session may briefly
slow the first request after the change (prompt cache cold).
─────────────────────────
```

Each row uses the existing `.generate-form-row` / `.generate-form-label` / `.generate-form-input` classes to match the rest of the form (the Coaching Profile screen reuses the Generate-modal form styles — see `index.html` ~2884). Section heading uses the existing `.profile-section-label` class. Each `<select>` lists every model in `AVAILABLE_MODELS`. The current saved value (or the default if unset) is the selected option on open.

Save semantics match the rest of the screen: explicit Save button at the bottom of the form. No auto-save, no per-field toast. Cancel + Close discard unsaved edits, same as the existing fields.

No model picker is rendered anywhere else — the coach panel, Generate Plan flow, Refine row, Swap modal, and Analyze flow all run silently against the saved selection.

## Schema

No migration. Three optional string fields appended to the existing `coaching_profile.data` JSONB blob (which is loaded into `js/data.js`'s `coachingProfile` global as a flat object — not nested under `.data`):

```json
{
  ...existing fields...,
  "model_coach":   "claude-haiku-4-5-20251001",
  "model_plan":    "claude-sonnet-4-6",
  "model_analyze": "claude-sonnet-4-6"
}
```

Existing rows without these keys keep working — the resolver falls back to the hardcoded default for each bucket.

## Allowlist module

A single shared declaration of available models + per-bucket defaults. Two physical copies stay in sync, one server-side and one client-side:

- **Server:** `api/_models.js`
- **Client:** `js/models.js`

Both files contain identical content:

```js
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

// Server export (only meaningful in api/_models.js — client uses globals)
if (typeof module !== 'undefined') {
  module.exports = { AVAILABLE_MODELS: AVAILABLE_MODELS, DEFAULT_MODELS: DEFAULT_MODELS, resolveModel: resolveModel };
}
```

The duplication is acceptable: the project has no build step, the client runs in browser, and the API runs in Node serverless on Vercel — sharing requires either a build pipeline or a runtime fetch from the server. Both are over-engineered for a 3-row constant. Keeping two files in sync is the cost; the operational checklist below makes it explicit.

## Resolver helpers (client)

Three helpers in `js/data.js` next to the existing `loadCoachingProfile` / `saveCoachingProfile` functions:

```js
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

Note: `coachingProfile` IS the data blob directly (per `js/data.js:2606`: `coachingProfile = (res.data && res.data.data) || {}`). Field access is `coachingProfile.model_coach`, NOT `coachingProfile.data.model_coach`.

Each AI call site adds the resolved model to its request body. Five call sites total:

| Site | Bucket helper |
|---|---|
| `sendCoachMessage` (or wherever `/api/coach-chat` is fetched) | `modelForCoach()` |
| Generate plan POST (`fireGenerate` or equivalent) | `modelForPlan()` |
| Refine plan POST (`fireRefine`) | `modelForPlan()` |
| Swap exercise POST (`fireSwapFetch`, `js/ui.js` ~4150) | `modelForPlan()` |
| Analyze POST (`fireAnalyze`) | `modelForAnalyze()` |

Each adds `model: modelForX()` to the `JSON.stringify(payload)` body.

## Server-side validation

Both `api/coach-chat.js` and `api/generate-plan.js`:

1. `require('./_models.js')` at the top to import `AVAILABLE_MODELS`, `DEFAULT_MODELS`, `resolveModel`.
2. Replace the existing `const MODEL = '...'` with per-request resolution.
3. Determine the bucket:
   - `api/coach-chat.js` — always `'coach'`.
   - `api/generate-plan.js` — `mode === 'analyze'` → `'analyze'`, everything else → `'plan'`.
4. Call `var model = resolveModel(req.body.model, bucket);` (or equivalent — current files use `req.body` parsed via `await readJsonBody(req)`).
5. Use `model` as the `model:` field in the Anthropic POST body. The constant `MODEL` is removed.
6. Log when fallback fires (`if (req.body.model && req.body.model !== model) { console.warn('model fallback', { requested: req.body.model, resolved: model, bucket: bucket }); }`) so retired-model selections in stored profiles surface in Vercel logs.

## UI rendering

In `js/ui.js`, the Coaching Profile screen render path (`populateCoachingProfileForm`, lines ~927-946) gains three new `setVal` calls:

```js
  setVal('cpModelCoach',   p.model_coach   || DEFAULT_MODELS.coach);
  setVal('cpModelPlan',    p.model_plan    || DEFAULT_MODELS.plan);
  setVal('cpModelAnalyze', p.model_analyze || DEFAULT_MODELS.analyze);
```

The save handler (around `js/ui.js:1032-1047`) gains three new fields in the `profile` object:

```js
    model_coach:   getVal('cpModelCoach')   || null,
    model_plan:    getVal('cpModelPlan')    || null,
    model_analyze: getVal('cpModelAnalyze') || null,
```

(Saving as `null` when the dropdown value is empty would only happen if the dropdown rendered with no options — defensive only. In practice the dropdown always has a selected value.)

## index.html — new form section

In `index.html`, inside the `#coachingProfileBody` → `.generate-inputs` form, after the existing `Special Instructions` row (which sits inside the same `.generate-inputs` wrapper) and before the wrapper closes, add:

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
<div class="profile-section-hint" style="margin-top:6px; font-size:12px; color:var(--text3);">
  Selections apply on the next request. Switching mid-session may briefly slow the first request after the change (prompt cache cold).
</div>
```

`generate-form-row`, `generate-form-label`, `generate-form-input`, `generate-form-hint`, and `profile-section-label` are all existing classes (verified at `index.html:1324, 1348, 2781, 2884-2965`). No new CSS is required.

The empty `<select>` elements are populated at form-open time by a new helper that reads `AVAILABLE_MODELS`:

```js
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

`populateCoachingProfileForm` calls `populateModelSelects()` first (so the options exist), then `setVal` selects the saved value.

No new CSS required — every class used (`.generate-form-row`, `.generate-form-label`, `.generate-form-input`, `.generate-form-hint`, `.profile-section-label`) already exists.

## Operational: future model release

When Anthropic ships a new model (e.g., Sonnet 4.7):

1. Edit **two files** with identical changes:
   - `api/_models.js`
   - `js/models.js`
2. Add a row to `AVAILABLE_MODELS`: `{ id: 'claude-sonnet-4-7', label: 'Sonnet 4.7', tier: 'balanced' }`.
3. (Optional) Retire an older model by deleting its row. Users with that model selected automatically fall back to the bucket default at next request. They can re-select on next Coaching Profile open.
4. (Optional) Update a `DEFAULT_MODELS` value if the new model should become the default for a bucket.
5. `git commit`, `git push`. Vercel auto-deploys client + API together.
6. Users see the new option in Coaching Profile on next page load.

If the same model ID is added to BOTH `api/_models.js` and `js/models.js`, no further work is needed. Forgetting to update one side: the picker shows a model the server rejects (silently falls back to default + logs warning) OR the server accepts a model the picker doesn't expose (no user-visible breakage). The Vercel-log warning is the safety net.

## Out of scope

- Splitting `plan` / `refine` / `swap` into separate selectors.
- Per-call overrides (e.g., "use Opus for this one swap").
- Inline pickers at point-of-use (rejected during brainstorming — repetition implies per-call decisions, but selections are per-user).
- Cost / latency telemetry per bucket.
- Smart fallback mapping (retired model → equivalent successor). Default-fallback only.
- Streaming differences across models. Existing behavior preserved.
- Admin / multi-user pickers (single-user app).

## Version target

**v3.2.0** — first feature on top of v3.1.x. Minor bump per the project's versioning convention (minor for new features, patches for follow-ups within a minor).

## Testing checklist (manual smoke)

- Coaching Profile screen renders the new "AI models" section with three labelled dropdowns.
- Each dropdown lists every entry in `AVAILABLE_MODELS`, formatted as `"<label> (<tier>)"`.
- On a fresh Coaching Profile (no model fields stored), each dropdown defaults to the bucket's `DEFAULT_MODELS` value.
- Changing a dropdown and tapping Save persists; reopening Coaching Profile shows the saved selection.
- Coach panel send: DevTools Network shows `model:` in the POST body matching `modelForCoach()`.
- Generate Plan: POST body's `model` matches `modelForPlan()`.
- Refine + Swap: same.
- Analyze: POST body's `model` matches `modelForAnalyze()`.
- Server-side fallback when an invalid `model` is passed (manually edit the request via DevTools): response succeeds; Vercel log shows the fallback warning.
- A stored `model_coach` whose ID was removed from `AVAILABLE_MODELS`: dropdown defaults to bucket default on next open; first request silently uses default + logs.
- No regression in Coaching Profile save flow for existing fields (sex, height, injuries, etc.).

## Open questions

None.
