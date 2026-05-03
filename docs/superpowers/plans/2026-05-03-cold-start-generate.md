# Cold-start plan generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the empty-state "Generate a plan" CTA actually work by removing the server-side `activePlan` and `history` bails in plan-mode, null-guarding the `formatCurrentPlan` helper, and injecting a `COLD START` marker into the user message when both are absent. Plus a one-line UX fix to the analyze "no history" error message.

**Architecture:** Single-file server change (`api/generate-plan.js`) — no schema, no client work. Two bail-outs deleted in plan-mode; one helper gets a defensive null-guard at its top; one conditional block added to `buildUserMessage` for the cold-start signal. Analyze handler keeps its bail but reports the chosen window in the message. APP_VERSION bumps to `v3.3.0` in a separate commit; ROADMAP and HANDOFF refresh in two more commits.

**Tech Stack:** Vercel Node serverless (ESM, `package.json` `"type": "module"`). No automated test framework — verification is manual browser smoke testing per project convention.

**Spec:** [docs/superpowers/specs/2026-05-03-cold-start-generate-design.md](../specs/2026-05-03-cold-start-generate-design.md)

**Version target:** **`v3.3.0`** — minor bump per project convention (new functional path: cold-start generation).

**Workflow rules:**
- Subagent writes + commits per-task; user smoke-tests asynchronously.
- Working on `main`. No worktree.
- Never push without explicit user approval.
- Never amend; always new commits.

---

## File map

| File | Change |
|---|---|
| `api/generate-plan.js` | Delete 2 bails in plan-mode (~lines 185-189). Null-guard `formatCurrentPlan` (~line 615). Add COLD START marker to `buildUserMessage` (~line 572). Update analyze error message (~line 845). |
| `js/app.js` | Bump `APP_VERSION` from `v3.2.1` → `v3.3.0` (Task 2). |
| `ROADMAP.md` | Add `Shipped — v3.3.0` section above `Shipped — v3.2.0` (Task 3). |
| `HANDOFF.md` | Update version line + add v3.3.0 milestone paragraph (Task 4). |

No client-side code changes. No new files. No schema migration.

---

### Task 1: Server-side cold-start support + analyze message fix

Single commit covering all four code edits in `api/generate-plan.js`. After this task: cold-start generate works end-to-end on the server side; analyze error message reflects the chosen window.

**Files:**
- Modify: `api/generate-plan.js` — four edits described below.

- [ ] **Step 1: Null-guard `formatCurrentPlan`**

Find the existing function definition at `api/generate-plan.js:615-616`:

```js
function formatCurrentPlan(activePlan) {
  const d = activePlan.data || {};
```

Insert the null guard as the first line of the body, before the existing `const d = ...`:

```js
function formatCurrentPlan(activePlan) {
  if (!activePlan) return '';
  const d = activePlan.data || {};
```

Resulting full function header (line 615-617 after the edit):
```js
function formatCurrentPlan(activePlan) {
  if (!activePlan) return '';
  const d = activePlan.data || {};
```

- [ ] **Step 2: Delete the two plan-mode bails**

Find the existing block at `api/generate-plan.js:184-190` (just after the `console.log('[generate-plan] data fetch:'...)` line):

```js
    console.log('[generate-plan] data fetch:', Date.now() - t0, 'ms', '· history_weeks:', userInputs.historyWeeks, '· training_days:', userInputs.trainingDays, '· include_photos:', userInputs.includePhotos, '· coach_msgs:', coachHistory.length, '· profile:', coachingProfile ? 'yes' : 'no');

    if (!activePlan) {
      return jsonError(res, 400, 'No active plan. Import a plan before generating.');
    }
    if (!history.length) {
      return jsonError(res, 400, 'No workout history found. Log at least one week of training before generating a plan.');
    }

    const t1 = Date.now();
```

Replace with (the two bail blocks deleted; everything else stays):

```js
    console.log('[generate-plan] data fetch:', Date.now() - t0, 'ms', '· history_weeks:', userInputs.historyWeeks, '· training_days:', userInputs.trainingDays, '· include_photos:', userInputs.includePhotos, '· coach_msgs:', coachHistory.length, '· profile:', coachingProfile ? 'yes' : 'no');

    const t1 = Date.now();
```

(One blank line between `console.log` and `const t1`. The two `if (...)` bail blocks are entirely removed.)

- [ ] **Step 3: Add the COLD START marker to `buildUserMessage`**

Find the existing block at `api/generate-plan.js:570-573`:

```js
  let dynText = '';
  dynText += formatCoachingProfile(coachingProfile);
  dynText += formatCurrentPlan(activePlan);
  dynText += formatVerbatimHistory(verbatim, activePlan, verbatimWeeks);
```

Replace with (inserts the conditional COLD START marker between `formatCoachingProfile` and `formatCurrentPlan`):

```js
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
```

- [ ] **Step 4: Update the analyze error message**

Find the existing block at `api/generate-plan.js:845-847` (inside `handleAnalyze`, immediately after the `Promise.all` data fetch + console.log):

```js
  if (!history.length) {
    return jsonError(res, 400, 'No workout history found. Log at least one week of training before requesting an analysis.');
  }
```

Replace with (uses a template literal that embeds the actual `historyWeeks` value):

```js
  if (!history.length) {
    return jsonError(res, 400, `No workouts in the last ${historyWeeks} weeks. Try a wider history window or generate a fresh plan first.`);
  }
```

(The grammar is acceptable for both 1 and N weeks since `historyWeeks` is always >= 1 — no need to handle pluralization.)

- [ ] **Step 5: Verify**

Run:
- `git diff --stat` — should show only `api/generate-plan.js` modified.
- `node --check api/generate-plan.js` — SYNTAX OK.
- `grep -c "COLD START" api/generate-plan.js` — exactly 1.
- `grep -c "if (!activePlan) return ''" api/generate-plan.js` — exactly 1 (the new guard at top of `formatCurrentPlan`).
- `grep -c "Import a plan before generating" api/generate-plan.js` — 0 (the bail message is fully removed; the analogous message in handleRefine at ~line 1287 says "Refinement requires" not "Import a plan", so it doesn't match this string).
- `grep -c "No workout history found" api/generate-plan.js` — 0 (analyze message updated).
- `grep -c "No workouts in the last" api/generate-plan.js` — exactly 1 (new analyze message).

If any count is off, STOP and report BLOCKED.

- [ ] **Step 6: Commit**

Write `/tmp/commit_msg_t1.txt`:

```
feat(api): cold-start plan generation + analyze window message

Plan-mode no longer bails when activePlan is null or history is empty.
formatCurrentPlan gains a defensive null guard at its top so any
caller can pass null safely. buildUserMessage prepends a COLD START
marker to the dynamic text when BOTH activePlan and history are
absent, explicitly telling the planner it's building a first plan
from CLIENT PROFILE + USER INPUTS only. When only one is missing
(post-End-plan with history; brand-new with profile), the marker is
omitted and the model infers from absent sections.

Analyze handler keeps its no-history bail but the message now names
the actual window: "No workouts in the last 4 weeks. Try a wider
history window or generate a fresh plan first." — clearer than the
prior "Log at least one week of training" line, which misled users
who had years of history outside the chosen window.

Refine and Swap unchanged — both fundamentally require an active plan
to evolve from / operate within. System prompts unchanged — the rules
were never hard-conditional on a prior plan being present.

Spec: docs/superpowers/specs/2026-05-03-cold-start-generate-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Then:
```bash
git add api/generate-plan.js
git commit -F /tmp/commit_msg_t1.txt
```

Run `git log -1 --stat` to confirm: 1 file modified, ~10 insertions / ~6 deletions (rough count).

---

### Task 2: Bump APP_VERSION to v3.3.0

Standalone version-marker commit. After this task: footer reads `v3.3.0`.

**Files:**
- Modify: `js/app.js` line 10.

- [ ] **Step 1: Update APP_VERSION**

Find at `js/app.js:10`:
```js
var APP_VERSION = 'v3.2.1';
```

Replace with:
```js
var APP_VERSION = 'v3.3.0';
```

- [ ] **Step 2: Verify**

- `git diff --stat` — only `js/app.js`.
- `grep -n "APP_VERSION" js/app.js` — line 10 shows `'v3.3.0'`.

- [ ] **Step 3: Commit**

Write `/tmp/commit_msg_t2.txt`:

```
v3.3.0 -- cold-start plan generation

Empty-state "Generate a plan" CTA now actually works. Plan-mode no
longer requires an active plan or non-empty history; the planner
receives a COLD START marker when both are absent so it explicitly
builds a first plan from CLIENT PROFILE + USER INPUTS. Analyze error
message clarified to name the chosen window. Refine and Swap remain
plan-anchored.

Spec + plan in
docs/superpowers/specs/2026-05-03-cold-start-generate-design.md and
docs/superpowers/plans/2026-05-03-cold-start-generate.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Then:
```bash
git add js/app.js
git commit -F /tmp/commit_msg_t2.txt
```

---

### Task 3: ROADMAP — add v3.3.0 Shipped section

**Files:**
- Modify: `ROADMAP.md` — insert new section above `## Shipped — v3.2.0 (2026-05-03)`.

- [ ] **Step 1: Insert the v3.3.0 Shipped section**

Open `/Users/sebastianvelez/workout-tracker/ROADMAP.md`. Find the line:
```
## Shipped — v3.2.0 (2026-05-03)
```

Insert this new section IMMEDIATELY ABOVE that line, with a blank line separating it from the lines above and below:

```markdown
## Shipped — v3.3.0 (2026-05-03)

Live at www.sebvel.app as of `v3.3.0`. Empty-state "Generate a plan" CTA now actually works. Pre-v3.3.0 the server-side plan-mode handler bailed with `400 "No active plan. Import a plan before generating."` when there was no active plan, and again with `400 "No workout history found"` when no logged history existed — both predating the v3.0.0 no-plan UX. v3.3.0 closes the design gap by removing both bails.

- **Cold-start plan generation (`v3.3.0`).** Plan-mode no longer requires `activePlan` or non-empty history. `formatCurrentPlan` gains a defensive null guard at its top so callers can pass null safely. `buildUserMessage` prepends a `COLD START` marker to the dynamic text when BOTH `activePlan` and `history` are absent, explicitly telling the planner it's building a first plan from CLIENT PROFILE + USER INPUTS only. When only one is missing (post-End-plan with prior history; or brand-new with profile only), the marker is omitted and the model infers from absent sections. **Analyze error message clarified**: the no-history bail message now names the actual window — `"No workouts in the last N weeks. Try a wider history window or generate a fresh plan first."` — replacing the prior `"Log at least one week of training before requesting an analysis"` which misled users with years of history outside the chosen window. Refine and Swap remain plan-anchored (refine evolves a plan in flight; swap operates on a single exercise within an existing slot — both correctly reject when there's no active plan). System prompts unchanged. Spec + plan: [docs/superpowers/specs/2026-05-03-cold-start-generate-design.md](docs/superpowers/specs/2026-05-03-cold-start-generate-design.md), [docs/superpowers/plans/2026-05-03-cold-start-generate.md](docs/superpowers/plans/2026-05-03-cold-start-generate.md).

```

- [ ] **Step 2: Verify**

- `git diff --stat` — only `ROADMAP.md`.
- `grep -c "Shipped — v3.3.0" ROADMAP.md` — exactly 1.
- `grep -c "## Shipped — v3.2.0" ROADMAP.md` — still 1 (untouched).

- [ ] **Step 3: Commit**

Write `/tmp/commit_msg_t3.txt`:

```
docs(roadmap): Shipped — v3.3.0 (cold-start plan generation)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Then:
```bash
git add ROADMAP.md
git commit -F /tmp/commit_msg_t3.txt
```

---

### Task 4: HANDOFF — refresh through v3.3.0

**Files:**
- Modify: `HANDOFF.md` — update the version line at the top + add v3.3.0 milestone paragraph.

- [ ] **Step 1: Update the top-of-file version line**

In `/Users/sebastianvelez/workout-tracker/HANDOFF.md`, find the line containing:
```
Current live version: **`v3.2.1`**
```

Change BOTH occurrences of `v3.2.1` on that line to `v3.3.0`:
- The bold backticked version `**\`v3.2.1\`**` → `**\`v3.3.0\`**`.
- The "Through v3.2.1 fully shipped" phrase → "Through v3.3.0 fully shipped".

Don't touch the rest of the paragraph.

- [ ] **Step 2: Insert the v3.3.0 milestone paragraph**

Find the existing `**v3.2.1 (2026-05-03) — Gate \`temperature\` for Opus 4.7.**` paragraph. Insert this new paragraph IMMEDIATELY ABOVE it (with a blank line between):

```markdown
**v3.3.0 (2026-05-03) — Cold-start plan generation.** Closes a v3.0.x design gap: the empty-state "Generate a plan" CTA can finally succeed. Plan-mode in `api/generate-plan.js` previously bailed with `400 "Import a plan before generating"` when there was no active plan, and again on no-history. Both bails are removed in v3.3.0. `formatCurrentPlan` is null-guarded; `buildUserMessage` injects a `COLD START` marker when both activePlan and history are empty so the planner explicitly builds a first plan from CLIENT PROFILE + USER INPUTS. Analyze keeps its no-history bail but the message now reads `"No workouts in the last N weeks. Try a wider history window or generate a fresh plan first."` (substitutes the chosen window). Refine and Swap unchanged — both fundamentally need an existing plan to operate on. Spec / plan: `docs/superpowers/specs/2026-05-03-cold-start-generate-design.md` and `docs/superpowers/plans/2026-05-03-cold-start-generate.md`.
```

- [ ] **Step 3: Verify**

- `git diff --stat` — only `HANDOFF.md`.
- `grep -n "Current live version:" HANDOFF.md` — line shows `v3.3.0`.
- `grep -c "v3.3.0" HANDOFF.md` — at least 4 (top line `v3.3.0` × 2 + new paragraph header + spec/plan path references).
- `grep -c "v3.2.1" HANDOFF.md` — same count as before this edit (the v3.2.1 paragraph stays).

- [ ] **Step 4: Commit**

Write `/tmp/commit_msg_t4.txt`:

```
docs: HANDOFF current through v3.3.0

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Then:
```bash
git add HANDOFF.md
git commit -F /tmp/commit_msg_t4.txt
```

---

## Final verification (after all 4 tasks)

- `git log --oneline -5` — should show: HANDOFF / ROADMAP / v3.3.0 version / feat(api) cold-start / 331496e (spec).
- `git status` — clean.
- `grep -n "APP_VERSION" js/app.js` — `v3.3.0`.
- `grep -n "Current live version:" HANDOFF.md` — `v3.3.0`.
- `grep -c "Shipped — v3.3.0" ROADMAP.md` — 1.
- `node --check api/generate-plan.js` — SYNTAX OK.

## Smoke-test checklist (USER, post-deploy)

1. **No-plan + history**: end your active plan → empty state appears → tap "Generate a plan" → submit form → review screen renders a plan based on your history → accept → plan activates.
2. **Cold start (no plan + no history in window)**: end plan + choose `historyWeeks = 1` after a no-workout week → Generate → succeeds → review screen renders a starter plan → accept → plan activates. Vercel logs show `[generate-plan] data fetch:` for the request; the COLD START marker isn't directly logged but its presence is implied by the successful response.
3. **History-window-empty analyze**: have history but no workouts in the last 4 weeks → Analyze with default 4 weeks → toast reads `"No workouts in the last 4 weeks. Try a wider history window or generate a fresh plan first."`.
4. **Existing flow with active plan**: regression check — generate a successor plan from an active plan + history → still works → no COLD START marker in the prompt (verified by successful generation, since the marker is gated by both nulls).
5. **Refine still bails**: try Refine without an active plan via DevTools — still returns the existing 400 (Refine UI normally only renders post-generate, so this is a sanity check, not a user-visible path).

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Server: remove plan-mode activePlan + history bails | Task 1 Step 2 |
| Server: null-guard `formatCurrentPlan` | Task 1 Step 1 |
| Server: COLD START marker in `buildUserMessage` | Task 1 Step 3 |
| Server: analyze error message UX fix | Task 1 Step 4 |
| No frontend changes | (confirmed in spec; no task needed) |
| What stays unchanged: Refine, Swap, Coach, system prompts | (confirmed in spec; no task needed) |
| Cache implications | (no code change; verified in spec) |
| Version bump v3.3.0 | Task 2 |
| ROADMAP refresh | Task 3 |
| HANDOFF refresh | Task 4 |

All spec sections covered. All four code edits in Task 1 are line-numbered against the current file (verified during planning).

**Type / signature consistency:**

- `formatCurrentPlan(activePlan)` — signature unchanged; new internal guard handles null.
- `buildUserMessage(...)` — signature unchanged; new conditional block uses already-destructured `activePlan` and `history` parameters.
- Analyze handler `historyWeeks` variable already in scope ([line 821](../../api/generate-plan.js#L821) in the current code) — template literal uses the existing local.

**Placeholder scan:** No "TBD" / "TODO" / vague phrasing. Every step has explicit code blocks or shell commands. Line references all back to specific real lines confirmed during planning.

**Caveats:**

- The Step 5 verification grep for `"Import a plan before generating"` returns 0 only if no other code path uses that exact string. The `handleRefine` bail at line 1287 says "Refinement requires" instead, so the grep is accurate. Confirmed via grep during planning.
- The COLD START marker condition `!activePlan && history.length === 0` could in principle return true when only history is empty in the user's window even if they have an active plan — but in v3.3.0, the only path that calls `buildUserMessage` is plan-mode, which now always passes through both vars. If `activePlan` is non-null (user has plan + window-empty history), the marker is correctly NOT emitted. Verified by reading the conditional.
