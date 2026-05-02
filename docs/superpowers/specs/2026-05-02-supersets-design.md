# Supersets — Design

## Problem

Supersets (and giant sets — same mechanic, ≥3 exercises) are a common training tool: chest+back antagonist pairs, isolation finishers, time-saving accessory work. Today the app has no representation of "these N exercises happen as a paired group." The plan JSON is a flat `day.exercises[]` array; the UI renders one card per exercise; the AI prompts have no language to prescribe pairings; and the History view only knows about flat lists. Users wanting supersets either avoid the app for those workouts or fake them by writing notes into adjacent exercise cards.

The schema groundwork is partially there from the v2.5.11 drop-sets migration — `sets.set_type` already accepts `'superset'`/`'giant'` as reserved enum values — but supersets cross *exercise boundaries* (multiple sets, each with their own exercise_id), which the drop-set model doesn't handle.

## Goal

First-class supersets across plan generation, mid-session interaction, and history rendering. Scope = any N (≥2 members). Both AI-prescribed and user-paired. Block-preserved structure across the lifecycle of a workout. No upper bound on members; default UX targets the 2-member and 3-member cases (the 90% real use).

## Non-goals

- **Round-robin / circuit training** (AMRAP, EMOM, station-based work). Different log mechanic — round-as-unit instead of set-as-unit. Same data shape *could* extend with a `kind` discriminator later; for now this design covers classic alternating supersets only.
- **Block-level Swap.** Swap (⇄) operates per-member, not on the whole block. Swapping all members at once for a different antagonist pair is deferred.
- **Per-round rest variation** (different rest after some rounds). Block has one `rest` value; future enhancement.
- **Cardio-in-supersets validation rules.** Allowed today, just no special handling. AI prompt advises against it; no hard constraint.

### In v1 (called out because they're easy to mistake for non-goals)

- **Drop sets inside superset members.** Supported in v1. The orthogonality is small and natural — a member's `sets[]` can contain `set_type:"drop"` entries unchanged, cascade-on-parent-done still walks the member's sets array correctly, and the drop chain counts as one round-step regardless of cascade size. No new logic required; covered by the test plan.

---

## Surface 1 — Plan JSON shape

The `day.exercises[]` array can now contain either a regular exercise *or* a **superset block**. Block shape:

```json
{
  "superset": true,
  "rest": 60,
  "exercises": [
    {"name": "Cable Row",     "sets": [{"weight": 120, "reps_target": 12, "repeat": 3}]},
    {"name": "Lateral Raise", "sets": [{"weight": 20,  "reps_target": 12, "repeat": 3}]},
    {"name": "Face Pull",     "sets": [{"weight": 40,  "reps_target": 15, "repeat": 3}]}
  ]
}
```

- `superset: true` is the discriminator. Validators read it to decide which schema to apply.
- `rest` is the inter-round rest in seconds (block-level). Per-member `rest` fields are not emitted (validator rejects them as ambiguity).
- `exercises[]` contains 2+ regular exercise objects. Each child follows the existing exercise schema — name, sets, optional note. The block-level note (if any) summarizes the superset purpose.
- **Asymmetric set counts allowed.** Default is equal (e.g., all members `repeat: 3`), but a 3-round superset where one member has a 1-set finisher is permitted. The block "has" max-set-count rounds; members with fewer sets simply don't participate in later rounds.
- **`expandSetRepeats` recurses into block children** so the `repeat: N` shorthand works inside a member's sets exactly as it does outside.
- **Drop sets inside members** work unchanged: a member's `sets[]` can contain `set_type: "drop"` entries chained off the most recent non-drop set. The drop chain is internal to the member.

---

## Surface 2 — Schema migration

Single migration, additive only:

```sql
-- supabase/migrations/<timestamp>_workouts_superset_groups.sql
alter table workouts add column superset_groups jsonb not null default '[]';
```

Stored shape: `[{exercise_orders: [2, 3, 4], rest: 60}, ...]`. Each entry represents one superset block in this workout. `exercise_orders` is the contiguous (or non-contiguous, in edge cases) list of `sets.exercise_order` values that are members of the block. `rest` is the block-level rest in seconds.

Written when:
1. **Plan-day workout creation.** When `ensureWorkout(di)` fires (lazy creation on first set-done or notes blur), it walks the plan's `days[di].exercises[]` and computes `superset_groups` from any block entries.
2. **Ad-hoc superset creation.** When a user merges two ad-hoc cards via the ⟷ icon, `superset_groups` is rewritten with the new block.
3. **Mid-session merge / separate.** Same write path as ad-hoc — the column is updated whenever the in-memory grouping changes.

Read at History detail render time. Renders independently of `plan.data`, so historical sessions render correctly even after the plan is deactivated, deleted, or modified post-workout.

**`sets.set_type` enum** stays as-is. Grouping lives at the workout/exercise level, not the set level. The `'superset'`/`'giant'` enum values from the v2.5.11 migration are reserved for future drop-inside-superset combos; v1 doesn't write them.

**Backward compat:** old clients ignore the new column. New clients reading old workouts get `[]` (no supersets) → render as flat list (current behavior).

---

## Surface 3 — In-memory state

Each workout state's `exercises[ek]` (where `ek = 'ex_<i>'`) gets an optional `supersetGroup: 'g0' | 'g1' | ... | null` field. Standalone exercises have `supersetGroup: null`. Members of the same block share the same string key.

`stateFromWorkout(row)` derives `supersetGroup` for each exercise from `row.superset_groups`. Adjacent same-key entries render as one block; a missing or null key renders as a standalone card.

`buildSetPayload` and persistence helpers don't change shape — sets continue to be persisted with their `exercise_order` and `set_order`. The grouping is workout-level metadata, not set-level.

---

## Surface 4 — Mid-session interactions

### Header ⟷ icon

Each editable exercise card gets a chain-link icon in the header next to the existing Swap (⇄) and Delete (✕). Behavior depends on whether the card is in a superset:

**Standalone card → tap ⟷ → "Pair with…"** picker opens, scoped to *other things on this day*. Two optgroups in the picker:
- `Standalone exercises` — each pickable individually. Picking creates a 2-member superset.
- `Existing supersets` — pickable as join targets. Picking adds this card to the block as a new member.

After pick:
- Plan JSON mutation (plan-day): collapse the two flat entries into one block, or append to existing block. Default block-level `rest = 60s`. Persist via the existing plans-update path (`sb.from('plans').update({ data: plan }).eq('id', activePlanId)`) — same write the Swap (⇄) flow uses for in-place plan mutations.
- `workouts.superset_groups` rewrite to match.
- In-memory state: assign `supersetGroup` keys to affected entries.
- Re-render. Toast: *"Superset created."* or *"Added to superset."*

**Card inside a superset → tap ⟷ → "Remove from superset"** — pops the card out as standalone. If the block is now down to 1 member, dissolve the block entirely (the leftover becomes standalone). Plan JSON: split the block; `workouts.superset_groups` rewrite. Toast: *"Removed from superset."* / *"Superset dissolved."*

### Block rendering

Bordered group container (indigo accent, distinguishable from regular cards). Header line: `⟷ Superset · Round N of M · 60s rest`. Members stacked inside as nested mini-cards with `A1` / `A2` / `A3` badges. Same set-row chrome as standalone cards.

- `M` = max-set-count across members.
- `N` = min(completed-set-count across members) + 1, clamped to M. When every round is fully done, displays `M / M ✓`.
- The block's rest value is editable via a small ✎ button on the header (mirrors the existing per-exercise rest edit pattern, scaled up).

### + Add round (block-level)

A `+ Add round` dashed-button at the bottom of the block adds one set to *every member* — symmetric grow path. Inherits set values via the existing carry-forward logic per member.

Per-member `+ Add set` (already on every card) stays available *inside* a block too — for the asymmetric grow path (e.g., adding a single extra set to one member without affecting others).

### Rest timer

Fires after the last-member-of-the-round done-tap. Concretely: track `min(completed-set-count)` across members; when a tap brings that minimum up by one, the round is complete and the rest timer fires using the block's `rest` value.

Out-of-order tolerance: if the user taps A3 first, then A1, then A2, the timer fires on the third tap. The order doesn't matter; only the round-completion event does.

If a member has fewer sets than the block's max round count, it doesn't gate the round — the round-completion check uses `min(completed-set-count)` only across members that have a set at the current round index.

### Cascade-done

None. Each member's set is marked done individually. Drop sets *inside* a member still cascade as before (parent + drop chain → all marked done by the parent's tap), but that's internal to the member; it doesn't span block members.

### Drag-to-reorder

- **Within a block:** members reorder via the existing SortableJS long-press → lift → drop, scoped to a new sort zone inside the block.
- **At day level:** the whole block reorders among other day exercises. Long-press the *block header* (not a member card) to lift the whole block.
- **Cross-group disabled:** dragging a card out of a block (or into one) is not supported. Use the ⟷ icon to unpair / merge instead.

The set-remap two-phase pattern (existing, from v2.2.5) handles the within-block case unchanged. The day-level case treats the block as one entity.

### Brand-new exercise into an existing block

Two-step: tap `+ Add Exercise` → pick from full library → lands as a standalone card → tap ⟷ on the new card → pick the existing superset → joins. This avoids adding picker complexity (no "where does this go?" prompt at every Add Exercise) at the cost of one extra tap for the rare flow.

---

## Surface 5 — AI prescription

### System prompt extension

New `## SUPERSETS` section in `system-prompt-plan.md`, added between `## DROP SETS` and `## CARDIO PRESCRIPTION`. Contents:

- **Format.** The block JSON shape (as in Surface 1). Show a worked example. Note that `repeat` shorthand recurses into member sets.
- **When to prescribe (opportunistic rules).** Antagonist pairs are the natural fit: chest+back, biceps+triceps, quad+hamstring isolation. Accessory finishers on isolation movements (lateral raise + face pull, calf raise + tibialis raise). Time-constrained sessions where the prescribed volume won't fit the target duration.
- **Avoid:** pairing two heavy compound lifts (bench + squat — fatigue compounds across systems and form degrades). Cardio inside supersets unless the user explicitly asked. Beginners still establishing technique.
- **Cadence.** At most 1-2 supersets per training day. Don't spam them. Hypertrophy / accumulation phases are the natural home; cut and pre-cut benefit from time-saving supersets when duration is tight; strength blocks should generally stay non-superset on the main lifts.
- **Member count.** Default 2 members. Tri-sets (3) when there's a clear three-way grouping (push/pull/isolate). Avoid 4+ except on explicit user request.
- **Drop sets inside members.** Allowed and encouraged on isolation members of a superset (e.g., lateral raise as the last member with a triple drop on the final round). The drop format from `## DROP SETS` applies inside the member's `sets[]` array unchanged.

### Validator updates

In `api/generate-plan.js` (`validatePlan`):

```js
function validateExerciseEntry(entry, ctx) {
  if (entry.superset === true) return validateSupersetBlock(entry, ctx);
  return validateRegularExercise(entry, ctx);
}

function validateSupersetBlock(entry, ctx) {
  if (!Array.isArray(entry.exercises) || entry.exercises.length < 2) {
    throw new ValidationError('Superset block must have ≥2 exercises');
  }
  if (!Number.isInteger(entry.rest)) {
    throw new ValidationError('Superset block rest must be an integer (seconds)');
  }
  for (const child of entry.exercises) {
    if (child.rest != null) {
      throw new ValidationError('Superset members may not have their own rest field — use block-level rest');
    }
    if (child.superset === true) {
      throw new ValidationError('Nested supersets not supported');
    }
    validateRegularExercise(child, ctx);
  }
}
```

`expandSetRepeats(plan)` walks `days[].exercises[]`, detects `entry.superset === true`, and recurses into `entry.exercises[]` for the sets-expansion pass.

### Mode coverage

- **Plan mode** — emits blocks. Default mode.
- **Refine mode** — emits blocks. The multi-turn assistant turns may carry blocks; the cache prefix mechanism unchanged.
- **Swap mode** — single-exercise replacement. Operates on one member of a block (the one tapped). Block structure stays intact; one child's `name` (and downstream effects) gets swapped.
- **Analyze mode** — read-only. Sees blocks in the active plan blob via `formatCurrentPlan` and includes them in the analysis context. No blocks emitted.

### Coach Chat live context

`_formatPlanForCoach` (in `js/data.js`) and `formatCurrentPlan` (in `api/generate-plan.js`) walk superset blocks and render them inline as e.g.:

```
Day 1 — Pull: Pull-up 3×8, ⟷ Cable Row 3×12 @120 / Lateral Raise 3×12 @20 / Face Pull 3×15 @40 (60s rest), Tricep Pushdown 3×10
```

The `⟷ ... / ... / ... (Ns rest)` notation tells Haiku and Sonnet that those exercises are paired without needing to expand the structure.

`getLiveContext()` (in `js/data.js`) prefixes a `(superset)` tag on lines that are part of a superset block.

---

## Surface 6 — History rendering

### History detail (`renderHistoryDetail` in `js/ui.js`)

Reads `workouts.superset_groups` (not `plan.data`) to reconstruct block structure. Renders blocks with the same visual treatment as the live tracker — bordered indigo container, `⟷ Superset · Nx rounds · 60s rest` header, members stacked inside with A1/A2/A3 badges. Per-set chrome follows whatever is current for History detail in v3.0.3+ (sets, RPE, notes are editable in-place); block-level structure (member add/remove, block-level rest changes) stays read-only — those are plan-time / live-session edits, not historical-detail edits.

This decoupling from plan.data is intentional: a workout completed today against superset block `A=[Cable Row, Lateral Raise]` should still render that block tomorrow even if the user merges another exercise into the block in the active plan, deactivates the plan, or deletes it. Historical truth is the workout's `superset_groups`, not the current plan structure.

Asymmetric set counts render naturally: members with fewer sets just have shorter set-row lists; the block header still says "N rounds" using max-set-count.

### View Recent (`openExerciseHistory` per-exercise modal)

Stays per-exercise — the user is asking "what have I done on Cable Row recently?" — the answer is set-level history. Add a small `[superset]` tag near the date for sessions where this exercise was a superset member, just as context. No restructuring of the modal's render path.

### Recent workouts list on the no-plan empty state

No change. The list shows date + day name + set count; superset structure is incidental at that aggregation level.

---

## Surface 7 — Templates

Templates serialize the full `plan.data` blob. Superset blocks survive the round trip naturally — saving a plan as a template captures any blocks; using a template (`createAdHocFromTemplate`) reads them back and creates the corresponding ad-hoc structure.

For ad-hoc creation from a template containing a superset: ad-hoc workouts get their own row in the workouts table with `plan_id = null`, and `superset_groups` is populated from the template's blocks at workout creation time. The structure is preserved end-to-end.

---

## Risks / open questions

- **Mid-session merge with already-logged sets.** If a user has logged sets on Cable Row (3 sets done) and then merges Cable Row + Lateral Raise into a superset, the block now exists with one member at 3 rounds and another at 0 rounds. The round indicator says "Round 1 of 3" because Lateral Raise's `min(completed)` is 0. This is intentional — the user can continue logging Lateral Raise sets and the round indicator advances naturally. Worth noting in the test plan.

- **Validator strictness on per-member rest.** Decision: reject members that emit their own `rest` field (treat as ambiguity). Alternative: warn-and-strip. Picking reject for cleanliness — the AI will quickly learn not to emit it after one rejection.

- **Block-level edits in History detail.** Per-set values (weight, reps, RPE, notes) are editable in History detail per v3.0.3. Block *structure* edits (member add/remove, block-level rest changes) stay read-only in History detail — those are plan-time or live-session concerns. Users can still use the existing Bring-to-today / Discard recovery actions to recover-and-edit structure if needed.

- **Coach Chat token cost.** Adding superset rendering to the plan-format helpers adds maybe 20-50 tokens per superset to the Coach Chat user message. Negligible for typical plans (1-2 supersets per day, 5 days = ~250 tokens). No cache invalidation since this is dynamic content.

- **AI cache invalidation.** `system-prompt-plan.md` gets a new `## SUPERSETS` section. One-time Anthropic cache invalidation on first call after deploy (~35-45s); warm thereafter.

---

## Test plan (manual browser smoke test)

### Plan-time tests

1. **AI prescribes a 2-member superset.** Generate a plan with Notes hinting at hypertrophy / antagonist work. Verify the response contains a `{superset: true, rest, exercises}` block somewhere in `days[].exercises[]`. Validator passes.

2. **AI prescribes a 3-member tri-set.** Generate with Notes asking for accessory finishers. Verify a 3-member block emits correctly.

3. **AI emits invalid block (per-member rest).** Hard to force, but if it happens validator should reject with a clear error message.

### Mid-session tests

4. **Manual merge: standalone + standalone.** Plan-day with no supersets. Tap ⟷ on Card B. Picker shows other-on-day standalone exercises. Pick Card C. Verify both collapse into one block, plan.data is updated, `workouts.superset_groups` is written, render shows the block.

5. **Manual merge: join existing block.** Plan-day already has a 2-member superset. Tap ⟷ on a standalone card. Picker shows Standalone + Existing supersets optgroups. Pick the existing superset. Verify card joins as a 3rd member.

6. **Manual separate: pop one member.** 3-member superset. Tap ⟷ on the middle member. Member becomes standalone; block now has 2 members; the leftover stays a block.

7. **Manual separate: dissolve block.** 2-member superset. Tap ⟷ on one member. Both members become standalone; block dissolves. Plan.data and `workouts.superset_groups` reflect the change.

8. **+ Add round.** 3-member superset, all at 3 rounds. Tap +Add round at block bottom. Each member gains one set (4 rounds total). Carry-forward applies per member.

9. **Per-member + Add set (asymmetric).** 3-member superset. Tap +Add set on one member's card. Only that member gains a set; round indicator now reflects max=N+1, but the round-completion logic uses min across-members.

10. **Rest timer — last of round.** 3-member superset, round 1. Mark Cable Row set 1 done. No timer. Mark Lateral Raise set 1 done. No timer. Mark Face Pull set 1 done. **Timer fires** (block's rest, e.g., 60s).

11. **Rest timer — out of order.** 3-member superset, round 2. Mark Face Pull set 2 done first. No timer. Cable Row set 2. No timer. Lateral Raise set 2. **Timer fires** on the third tap.

12. **Drop set inside a superset member.** Plan with a superset where one member has prescribed drops on the last set. Verify drops render with the indented `→` look inside the member card. Marking the parent done cascades-marks the drops; round-completion check counts the parent as one round step.

13. **Drag-to-reorder within a block.** Long-press a member card; lift; drop within the block. Verify reorder persists and renders correctly.

14. **Drag-to-reorder block at day level.** Long-press the block header; lift; drop the whole block among day exercises. Verify the block stays intact and reorders correctly.

15. **Cross-group drag fails.** Try to drag a member out of a block (or a standalone into a block). Verify SortableJS ignores the cross-group drop.

### Swap tests

16. **Swap (⇄) inside a block.** 3-member superset. Tap ⇄ on a member. Picker opens. Pick a substitute. Verify only that member's name changes; block stays at 3 members.

### Ad-hoc tests

17. **Build an ad-hoc superset from scratch.** Start a blank session. Add 3 exercises. Merge first two via ⟷. Add a third member by tapping ⟷ on the standalone third card. Log a few rounds. Verify `workouts.superset_groups` is populated and history detail renders the block.

### History tests

18. **Open History detail for a workout with a superset.** From the History modal week view, tap a past workout. Verify the block renders with the same visual treatment as live tracker (read-only).

19. **Open History detail after modifying the plan.** Complete a workout with a superset block. Then mid-session in a *later* workout, dissolve that block in the plan. Open History detail for the original workout — the original block structure should still render (because it reads `workouts.superset_groups`, not current plan).

20. **Open History detail after deactivating the plan.** Complete a workout with a superset. End the plan via Plans modal → End. Open History detail. Block still renders.

### View Recent / Coach Chat tests

21. **View Recent for an exercise that's been a superset member.** Open per-exercise modal for Cable Row. Verify a `[superset]` tag near the date for sessions where it was paired.

22. **Coach Chat sees the superset.** Open chat panel mid-session in a plan with a superset. Send a message asking about the day's plan. Verify Haiku's reply references the paired structure or doesn't get confused by it.

### Template tests

23. **Save a plan with a superset as a template.** Verify the template stores the block.

24. **Use a template containing a superset.** Creates an ad-hoc with the block structure preserved. Logging works as expected.
