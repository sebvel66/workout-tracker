# Rest Timer Backgrounding — Design

**Status:** Approved by user 2026-04-19 (pre-implementation).
**Scope:** Bug fix + small UX addition for the between-sets rest timer. Unrelated to the three-feature sequence (hamburger menu, session notes, gym profiles) already shipped.

## Why

The rest timer between sets freezes when the PWA loses focus. Root cause: it counts down a `restSeconds` variable via `setInterval(..., 1000)`, and iOS suspends the interval when the app is backgrounded (locked phone, switched to another app). The user returns to find the timer showing the same number it did when they left — with no vibrate, no completion, no indication that the rest period ended.

The session timer ([index.html:3839-3855](index.html#L3839-L3855)) already handles backgrounding correctly by computing elapsed time from `Date.now() - startedAt` each tick rather than decrementing a counter. Same pattern, applied to the rest timer, is the minimal correct fix.

The Notification API was considered and rejected for this feature: iOS PWAs suspend JS when backgrounded, so a `setTimeout` inside the page can't fire a notification at the deadline. Reliable background notifications require a service-worker + Web Push architecture — that's a feature-of-its-own-scale and not warranted by a rest-timer fix. See the brainstorming session notes for full reasoning.

## Design

### State fields

Replacing the current `restSeconds` + `restInterval`:

- `restInterval` — kept. Re-rendering interval (now 250ms instead of 1000ms for smoother catch-up after backgrounding).
- `restTargetMs` — absolute `Date.now()` value marking the deadline. Set on start; shifted by ±15s adjusts.
- `restCompleted` — boolean flag to make `restComplete()` idempotent so the tick and the visibilitychange catch-up can't fire it twice.
- `restAudioCtx` — lazy-created `AudioContext` reused across timer instances.

### Core helper

```js
function restRemainingMs() {
  if (!restTargetMs) return 0;
  return Math.max(0, restTargetMs - Date.now());
}
```

All display and completion logic reads through this. No counter state.

### `startRestTimer(sec)`

1. Clamp `sec` to a number > 0 (existing fallback of 90).
2. Call `stopRestTimer()` to clear any prior state.
3. `restTargetMs = Date.now() + sec * 1000`; `restCompleted = false`.
4. Show the overlay + timer UI (same as current).
5. Render once via `updateRestDisplay()`, then start the interval:
   ```js
   restInterval = setInterval(function() {
     if (restRemainingMs() <= 0) { restComplete(); return; }
     updateRestDisplay();
   }, 250);
   ```

### `stopRestTimer()`

User-initiated stop (or called from `restComplete()` after vibrate/beep). Clears interval, hides overlay, resets timer state (`restTargetMs = 0`, `restCompleted = false`). No vibrate, no beep in this path — those are `restComplete()`'s responsibility.

### `restComplete()`

Deadline-reached handler. Idempotent.

```js
function restComplete() {
  if (restCompleted) return;
  restCompleted = true;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  restBeep();
  stopRestTimer();
}
```

`stopRestTimer()` is called last so the UI dismisses after the haptic/audio fires.

### `updateRestDisplay()`

Rewritten to derive from `restRemainingMs()`:

```js
function updateRestDisplay() {
  var total = Math.ceil(restRemainingMs() / 1000);
  var m = Math.floor(total / 60), s = total % 60;
  document.getElementById('restTime').textContent = m + ':' + (s < 10 ? '0' : '') + s;
}
```

`Math.ceil` keeps the display showing e.g. `0:01` for the last second rather than flashing `0:00` early.

### ±15s adjust

Current handlers operate on `restSeconds`:

```js
if (restInterval) { restSeconds += 15; updateRestDisplay(); }
```

Rewritten to operate on `restTargetMs`, clamped so the deadline is at least 5 seconds out from now (preserving the existing 5s floor):

```js
// + 15s
if (restInterval) {
  restTargetMs += 15000;
  updateRestDisplay();
}
// - 15s
if (restInterval) {
  restTargetMs = Math.max(Date.now() + 5000, restTargetMs - 15000);
  updateRestDisplay();
}
```

### `visibilitychange` catch-up

Attached on script init (same spot as other one-time listeners):

```js
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && restInterval && restRemainingMs() <= 0) {
    restComplete();
  }
});
```

Returning to the app after the deadline has passed → immediate rest-complete fires (vibrate + beep + overlay hide). Returning before the deadline → the existing tick interval resumes rendering the correct remaining time.

### `restBeep()` — new

Single 880Hz sine-wave chime, ~250ms, gentle attack/release envelope so there's no click:

```js
function restBeep() {
  try {
    if (!restAudioCtx) restAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var ctx = restAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch(e) { /* audio is nice-to-have; swallow */ }
}
```

Audio-context autoplay policy is already satisfied because the user tapped to start the rest timer — that gesture unlocks audio in iOS / Chrome. The single lazy-created context is reused across rest periods so we don't exhaust the 6-context-per-page limit browsers impose.

The try/catch wraps the entire body because audio is a secondary cue; vibrate + UI completion are the primary signals, and we never want audio failure to break the completion path.

## Scope boundary

Touches `index.html` only.

- Rewritten: `startRestTimer`, `stopRestTimer`, `updateRestDisplay`, both ±15s adjust handlers.
- Added: `restRemainingMs`, `restComplete`, `restBeep`, one top-level `visibilitychange` listener.
- State declarations at the top of the script: `restInterval` / `restSeconds` section replaced with `restInterval`, `restTargetMs`, `restCompleted`, `restAudioCtx`.

`APP_VERSION` bump to `v2.0.14`.

## Out of scope

- Service worker + Web Push for true-background notifications.
- Wake Lock (keep screen on during rest) — easy follow-up if it becomes annoying in practice.
- Cross-tab synchronization (multi-tab rest timer is out of scope).
- Rest-timer persistence across page reloads (timer state is in-memory only; reload cancels the current rest).

## Risks & mitigations

- **Risk:** the 250ms tick interval costs more CPU than the 1s interval. Mitigation: the callback is cheap (one DOM read, one DOM write, one subtraction) and only runs while the rest timer is visible. Negligible.
- **Risk:** `AudioContext` fails to construct on some browsers. Mitigation: `restBeep()` is wrapped in try/catch; vibrate + UI still fire.
- **Risk:** the user changes their system clock mid-rest, shifting `Date.now()`. Mitigation: not a real risk — the clock would have to move backwards by >5 seconds to cause misbehavior, which would also break every other timestamp-based feature in the app.
- **Risk:** `restCompleted` is checked without locking; the tick and visibilitychange could both read `false` in the same microtask. Mitigation: JS is single-threaded; the flag is set synchronously before any awaitable work runs, so the second caller reads `true`. Idempotency holds.
- **Risk:** backgrounding during the final 250ms produces a race where the interval fires once with `remaining <= 0`, then visibilitychange fires with remaining <= 0. Mitigation: `restCompleted` flag makes this a no-op.

## Verification

After implementation:

- **Foreground countdown correct.** Start timer at 90s, watch it tick down continuously — no drift, no freeze, no visual jitter.
- **Brief backgrounding.** Start timer at 90s, lock phone for ~10s, unlock within the rest period — display immediately shows ~80s remaining (or whatever is correct), timer resumes ticking.
- **Backgrounded past deadline.** Start timer at 30s, lock phone for ~60s, unlock — rest-complete fires on return: overlay hides, phone vibrates, audible beep. Does **not** double-fire.
- **Manual stop mid-timer.** Tap the overlay or Skip button → overlay hides, no vibrate, no beep.
- **±15s adjust.** Mid-timer, tap +15s three times → deadline shifts visibly. Tap -15s repeatedly → clamps at 5s minimum; additional -15s taps at the floor are no-ops.
- **Audio beep is gentle.** A single 880Hz tone, ~¼ second, with smooth attack/release (no click).
- **Multiple rest periods in a single session.** Logging several sets' rest cues back-to-back reuses the same `restAudioCtx` without errors.
- `APP_VERSION` bumped to `v2.0.14`.
