# Hydration Cache — Design

**Status:** Approved by user 2026-04-21 (pre-implementation).
**Scope:** Perceived-speed improvement for app warm boot. Paint the last-seen tracker view synchronously from `localStorage`, then reconcile against Supabase in the background.

## Why

Today's warm boot shows the `#emptyState` "Import a plan" shell (or a blank plan title) for ~1-3s between page load and [hydrate()](js/app.js#L20) completing. The gap is six sequential awaits: `sb.auth.getUser()`, the `plans` query, `loadExerciseLibrary` / `loadRecentExercises` / `loadLocations` / `loadSuggestedDayIndex` / `loadDaysWithHistory`, and the today's-workouts query. For a single-user PWA that the same person opens every day, this gap is a recurring friction — the app feels slow at the moment it's expected to be instant.

The fix is client-side persistence of the last-painted state. The server remains the source of truth; the cache is a painting shortcut.

## Design

### What gets cached

Single `localStorage` key: `wt.hydration.v1`. Value is a JSON-serialized blob:

```js
{
  schemaVersion: 1,        // bumped only on shape changes, NOT on APP_VERSION bumps
  userId: "<uuid>",        // gate — cache paints only if current Supabase session matches
  appVersion: "v2.4.0",    // informational; for telemetry / future debugging only
  savedAt: "<iso-ts>",     // age check (> 7d → ignore)
  activePlanId: "<uuid>",
  plan: { /* plan JSON from planCache[activePlanId] */ },
  planTitle: "<string>",   // pre-derived so paint is fully synchronous
  planWeek: "<string>",    // ditto — planWeekLabel(plan) result
  currentDay: 0,           // 0..N-1 or "ah_<workoutId>" for ad-hoc
  daysWithHistory: { 0: true, 2: true, ... },
  todayPlanStates: { 0: { /* state shape */ }, 2: { /* ... */ } },
  todayAdHocs: [ { /* state shape */ }, ... ]
}
```

Weight unit is intentionally NOT cached here — it's already persisted in `localStorage['weightUnit']` and read fresh via `getWeightUnit()` on every render. No point mirroring it.

Approx payload size: 5-50 KB depending on how many sets are logged today. Well under the 5 MB per-origin localStorage cap.

### When we write

Single internal helper `saveHydrationSnapshot()` in [js/data.js](js/data.js). Called from:

| Trigger | Why |
|---|---|
| `visibilitychange` listener, if `document.hidden` | Catches "swipe the PWA away" / "switch apps on iOS" — the common close gesture |
| `beforeunload` listener | Backup for desktop tab close / browser quit |
| End of `hydrate()` (after first successful reconcile) | Guarantees a snapshot exists even if the user never interacts |
| `savePlanAsActive` (after in-memory state updates) | Active plan changed — cache must reflect new plan immediately so next boot doesn't flash the old one |
| `activateExistingPlan` | Same reason |

Plan-delete is NOT a write trigger. Deleting a non-active plan doesn't invalidate the cache (its `activePlanId` still points at a live plan). Deleting the currently-active plan is an edge the server-reconcile path already handles (hydrate finds no active plan → clears cache and shows empty state).

**Guard:** `saveHydrationSnapshot()` no-ops when `hydratedForUser !== userId` or `userId == null`. Prevents capturing partially-populated state during hydrate or right after sign-out.

No per-set-done or per-keystroke write. Mutations are already persisting to Supabase via their existing code paths; on next boot the server is the source of truth and the cache is only the painting shortcut. In the worst case (OS hard-kills the PWA without firing `visibilitychange`), the user sees the pre-mutation cached state for ~1-2s while hydrate swaps in the fresh server state — no data is lost.

`localStorage.setItem` is synchronous, sub-millisecond for a 50 KB JSON blob, and all listeners are already on the main thread. No debounce needed because writes only fire at ~lifecycle boundaries, not per-mutation.

### When we read + paint

New `paintFromCache()` IIFE in [js/app.js](js/app.js), runs immediately after `paintVersion()` and **before** any auth or network call:

1. Read `wt.hydration.v1`. If absent, corrupt, or `JSON.parse` throws → no-op.
2. If `schemaVersion !== 1` → no-op (cache from an older shape; new code path might crash on it).
3. If `Date.now() - new Date(savedAt) > 7 days` → no-op (stale; the user forgot the app).
4. Otherwise, populate the in-memory globals synchronously:
   - `activePlanId`, `plan`
   - `planCache[activePlanId] = plan`
   - `currentDay`, `daysWithHistory`
   - `todayPlanStates`, `todayAdHocs`
5. Paint the DOM:
   - Hide `#emptyState`.
   - Set `#planTitle` textContent + `#planWeek` textContent (with the refreshing pill appended — see UX).
   - Call `buildTabs()` + `buildDay(currentDay)`.
6. Set `window.__hydratedFromCache = true` so `hydrate()` knows to reconcile rather than cold-render.

The cache read + paint completes in <10 ms end-to-end, dominated by `buildDay`. User sees their last view effectively instantly.

### UX during reconcile

A subtle "Refreshing…" pill renders next to `#planWeek` when `__hydratedFromCache` is set. CSS: small pill (~10px font, `var(--text3)` color, `var(--surface)` background, thin border, 4px horizontal padding, 10px border-radius). The pill is non-interactive and carries no icon — a text label only, signaling "this is from memory, still verifying."

Pill removal:
- Successful `hydrate()` → pill removed after the reconcile swap.
- Failed `hydrate()` (network error, auth expired) → pill stays. The user still sees their last state; attempting an action that hits the network will surface a toast via the existing error paths.

### Reconciliation in hydrate()

`hydrate()`'s behavior is unchanged up through its data fetches. After it's loaded fresh state into the globals, it checks `window.__hydratedFromCache`:

- **Cache was painted and userId matches current session:** overwrite the cached state (already done by the normal hydrate flow), re-run `buildTabs()` + `buildDay(currentDay)`, remove the refreshing pill, clear `__hydratedFromCache`.
- **Cache was painted but userId mismatch** (different account now signed in): clear the cache via `clearHydrationSnapshot()`, proceed normally. Remove pill.
- **Cache was painted but the server says no active plan** (plan was deleted from another device): clear cache, show `#emptyState`, remove pill, call `openStartScreen()`.
- **Cache was not painted (cold boot):** no reconcile needed; run normal render.

At end of successful hydrate, call `saveHydrationSnapshot()` to refresh the cache with current server truth.

### Invalidation

| Trigger | Action |
|---|---|
| `applySession(null)` — sign-out | `clearHydrationSnapshot()` |
| `schemaVersion` mismatch on read | Ignore on read; normal hydrate writes fresh one at end |
| Cache > 7 days old on read | Ignore on read; normal hydrate writes fresh one at end |
| `userId` mismatch on reconcile | `clearHydrationSnapshot()` |
| Plan activated (`savePlanAsActive`, `activateExistingPlan`) | Overwrite via `saveHydrationSnapshot()` |
| Active plan 404 on reconcile (deleted elsewhere) | `clearHydrationSnapshot()` |

**Deliberately not invalidating on `APP_VERSION` bump.** Releases ship constantly; most don't change cache shape. When shape does change, the `schemaVersion` bump in the same commit invalidates automatically.

### Cold-cache behavior

Unchanged from today. The HTML still defaults `#emptyState` to visible, `body.unauthed` hides it during auth resolution, and hydrate decides empty vs. tracker. The feature is a purely additive optimistic-paint layer — new users, signed-out users, and users on fresh devices see exactly what they see today.

### Edge cases

- **Two users on one device.** If cached `userId` doesn't match `sb.auth.getUser()`'s result, cache is ignored on read (no paint) and cleared on reconcile. Never paints wrong user's data.
- **Mid-session cache, opened days later (midnight roll).** `sessionTodayStart` is recalculated fresh in `hydrate()`. Cached `todayPlanStates` may represent yesterday. During the reconcile window, user briefly sees "yesterday's 6 sets" — the pill signals this, and fresh hydrate swaps in an empty or different today-state within ~1-2s. Acceptable per Q2 decision.
- **Plan deleted on another device.** Cached plan paints briefly. Hydrate's `plans` query with `is_active=true` returns null → cache cleared, `#emptyState` swapped in, `openStartScreen()` called. Bounded to one reconcile flash.
- **Corrupt cache JSON.** `JSON.parse` throws → `paintFromCache()` catches, clears the key, no-ops. Normal hydrate follows.
- **Schema drift on future features.** Any addition / removal / rename of cached fields bumps `SCHEMA_VERSION` in the same commit as the shape change. Old caches are ignored; fresh ones written.

### Write-safety for the `plan` blob

`planCache[activePlanId]` stores the already-`ensureStartDate`-normalized plan. Mirror that into the cache so `paintFromCache()` doesn't need to re-run `ensureStartDate` synchronously. On read, trust the cached blob as-is (it was normalized at write time).

Swap flows (`handleSwap` accept, drag-to-reorder) that mutate `plan.data` in place and write back to Supabase do NOT trigger a cache write — they rely on the next `visibilitychange` / `beforeunload` / `hydrate` end to persist. The mutation IS in memory (so a mid-session re-render sees it), and it WILL persist via Supabase before the next boot (since both flows `await` the write). If the user force-quits between swap and hide-event without Supabase confirming, they'd see pre-swap state on next open, then hydrate reconciles to post-swap. Acceptable — rare case, bounded to one flash.

## File layout

Three files touched:

- [js/data.js](js/data.js): add `saveHydrationSnapshot()`, `readHydrationSnapshot()`, `clearHydrationSnapshot()`, plus top-level `visibilitychange` + `beforeunload` listeners. Hook `savePlanAsActive` / `activateExistingPlan` / plan-delete into it.
- [js/app.js](js/app.js): new `paintFromCache()` IIFE after `paintVersion()`. Reconcile logic at the end of `hydrate()`. Bumps `APP_VERSION` to `v2.4.0`.
- [js/auth.js](js/auth.js): `applySession(null)` path calls `clearHydrationSnapshot()`.
- [index.html](index.html): small CSS block for `.refreshing-pill`.

No schema changes. No new migrations. No new dependencies.

Constants:
- `HYDRATION_CACHE_KEY = 'wt.hydration.v1'`
- `HYDRATION_SCHEMA_VERSION = 1`
- `HYDRATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000`

## Manual test plan

1. **Happy path warm boot.** Fresh install → sign in → log a few sets → `visibilitychange`-hide (swipe app away). Reopen. Expect: instant paint of last state (plan title, week, focused day, logged sets with checkmarks), "Refreshing…" pill visible next to week label, pill disappears within ~2s, content unchanged after swap.
2. **Cold boot (no cache).** Clear `localStorage` → reload. Expect: current behavior unchanged — `#emptyState` briefly visible during auth, then tracker renders.
3. **Multi-account switch.** Sign out as user A (cache cleared) → sign in as user B on same device. Expect: no flash of A's data; normal cold hydrate for B. Swipe + reopen as B → B's data paints instantly.
4. **Offline reconcile failure.** Log a set → swipe away → airplane mode on → reopen. Expect: last state paints from cache, pill stays (hydrate fails), existing error-toast paths trigger on any network action.
5. **Plan deleted elsewhere.** Activate plan A → swipe away → in Supabase dashboard or another device, flip `is_active=false` on plan A → reopen. Expect: brief flash of plan A, then empty state, `openStartScreen()` opens.
6. **Plan activation updates cache.** In the Plans modal, activate a different plan → swipe away → reopen. Expect: new plan paints instantly, not the old one.
7. **Stale cache (>7d).** Manually edit `wt.hydration.v1`'s `savedAt` to 8 days ago → reload. Expect: cache ignored on read, cold-boot path runs.
8. **Corrupt cache.** Manually set `wt.hydration.v1` to invalid JSON → reload. Expect: cache cleared silently, cold-boot path runs.
9. **Schema bump.** Manually edit `wt.hydration.v1`'s `schemaVersion` to 99 → reload. Expect: cache ignored, cold-boot path runs, fresh cache written at hydrate end (back to schemaVersion=1).
10. **Midnight roll.** Start a session late at night → swipe away → reopen after midnight. Expect: yesterday's sets briefly visible with pill, then swapped for today's empty/different state.
11. **Ad-hoc session persistence.** Create an ad-hoc → log a set → swipe away → reopen. Expect: ad-hoc tab focused instantly with logged set visible.

## Out of scope

- Offline logging (writing to a queue + syncing later). The cache paints what was last visible; mutations during the reconcile window still require network.
- Service worker / PWA offline shell.
- IndexedDB migration. `localStorage` suffices for the 5-50 KB blob.
- Cross-tab synchronization via `storage` events. PWA usage is single-tab in practice.

## Rollout

Single commit bundling all four file changes + `APP_VERSION` bump to `v2.4.0`. No migration, no feature flag. If it regresses, revert-commit restores the prior behavior (cold boot). Cache key is namespaced so a future `wt.hydration.v2` can coexist during any future rollout that needs migration.
