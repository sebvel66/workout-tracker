# Background-Resilient Rest Chime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rest-end chime fire on time when the installed PWA is backgrounded or the phone is locked (still in memory), instead of only when foregrounded.

**Architecture:** Schedule the chime on the Web Audio clock at rest start (audio thread keeps running while JS timers are frozen) and hold the AudioContext open in the background with a continuous near-silent looping source. Sound becomes solely scheduled-driven; the JS `setInterval` is kept only for the visual countdown.

**Tech Stack:** Vanilla browser JS (no build step). All changes in `js/ui.js`. Syntax gate: `node --check`. Functional verification is manual on the installed iOS PWA (no automated audio/background test is feasible).

---

## File Structure

- Modify: `js/ui.js` — rest-timer section (state vars ~15-18, `startRestTimer`/`stopRestTimer`/`restComplete`/`restBeep` ~7680-7790, +15/−15/Skip listeners ~8842-8930, sound-toggle handler ~8377).
- Modify: `js/app.js:10` — bump `APP_VERSION`.
- Modify: `docs/superpowers/specs/2026-05-16-background-rest-chime-design.md` — already aligned; no change needed.

No new files, no assets, no backend.

---

## Task 1: Add audio-context helper + scheduled-chime / keep-alive primitives

**Files:**
- Modify: `js/ui.js` (state vars near line 18; new functions added just above `restBeep`, ~line 7766)

- [ ] **Step 1: Add module-level state for the scheduled nodes**

In `js/ui.js`, find (near line 18):

```javascript
var restAudioCtx = null;
```

Replace with:

```javascript
var restAudioCtx = null;
var restChimeNode = null;   // scheduled completion oscillator (audio-thread timed)
var restKeepAlive = null;   // silent looping source that keeps the ctx alive bg
```

- [ ] **Step 2: Add `ensureRestAudioCtx()` helper**

In `js/ui.js`, immediately above the `wireAudioUnlock` IIFE (the line
`(function wireAudioUnlock() {`, ~line 7740), insert:

```javascript
// Lazily create (and return) the shared rest AudioContext. Browsers cap a
// page at ~6 contexts, so we create exactly one and reuse it across rest
// periods, the iOS unlock, the scheduled chime, and the keep-alive source.
function ensureRestAudioCtx() {
  if (!restAudioCtx) restAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return restAudioCtx;
}

// Schedule the completion chime on the Web Audio clock so it fires on the
// audio thread even when JS timers are frozen (screen locked / backgrounded).
// whenSec is seconds from now. Same 880Hz / ~0.25s envelope as restBeep().
// Gated on getRestTimerSound() at schedule time; rescheduled on adjust/unmute.
function scheduleRestChime(whenSec) {
  cancelRestChime();
  if (!getRestTimerSound()) return;
  try {
    var ctx = ensureRestAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    var t0 = ctx.currentTime + Math.max(0, whenSec);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.15, t0 + 0.01);
    gain.gain.linearRampToValueAtTime(0, t0 + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.25);
    restChimeNode = osc;
  } catch (e) { /* audio is a nice-to-have; vibrate + UI still fire */ }
}

// Cancel a pending scheduled chime (Skip, adjust-before-reschedule, mute,
// superseded by a new rest). No-op if it already rang or was never set.
function cancelRestChime() {
  if (restChimeNode) {
    try { restChimeNode.stop(); } catch (_) {}
    try { restChimeNode.disconnect(); } catch (_) {}
    restChimeNode = null;
  }
}

// Start a continuous near-silent looping source. iOS keeps the AudioContext
// running (so the scheduled chime fires on time when locked) only while there
// is active audio output. Idempotent. Stopped at rest end/skip to save battery.
function startRestKeepAlive() {
  try {
    var ctx = ensureRestAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    if (restKeepAlive) return;
    var buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // 1s of silence
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    var g = ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(g);
    g.connect(ctx.destination);
    src.start();
    restKeepAlive = src;
  } catch (e) { /* best effort */ }
}

function stopRestKeepAlive() {
  if (restKeepAlive) {
    try { restKeepAlive.stop(); } catch (_) {}
    try { restKeepAlive.disconnect(); } catch (_) {}
    restKeepAlive = null;
  }
}
```

- [ ] **Step 3: Syntax-check**

Run: `node --check js/ui.js`
Expected: no output, exit 0 (file parses).

- [ ] **Step 4: Commit**

```bash
git add js/ui.js
git commit -m "feat(rest-timer): add scheduled-chime + keep-alive audio primitives"
```

---

## Task 2: Drive sound from the schedule — wire start / skip / complete

**Files:**
- Modify: `js/ui.js` — `startRestTimer` (~7686), `restComplete` (~7727), Skip listener (~8843)

- [ ] **Step 1: Schedule the chime + start keep-alive in `startRestTimer`**

In `js/ui.js`, find the tail of `startRestTimer` (the existing block; the
`updateRestDisplay();` call followed by the comment and `setInterval`):

```javascript
  updateRestDisplay();
  // 250ms tick so catch-up after backgrounding feels snappy; the callback
  // itself is cheap (one DOM read, one Date.now(), one DOM write).
  restInterval = setInterval(function() {
```

Replace with:

```javascript
  updateRestDisplay();
  // Audio-thread completion chime (fires even when JS is frozen / phone
  // locked) + silent keep-alive that holds the AudioContext open in the
  // background. stopRestTimer() above already cleared any prior rest; this
  // schedules fresh for the current one.
  startRestKeepAlive();
  scheduleRestChime(restRemainingMs() / 1000);
  // 250ms tick — visual countdown only. It is fine for this to freeze when
  // backgrounded; the chime no longer depends on it.
  restInterval = setInterval(function() {
```

- [ ] **Step 2: Stop beeping from `restComplete`; stop keep-alive instead**

In `js/ui.js`, find `restComplete`:

```javascript
function restComplete() {
  if (restCompleted) return;
  restCompleted = true;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  restBeep();
  stopRestTimer();
}
```

Replace with:

```javascript
function restComplete() {
  if (restCompleted) return;
  restCompleted = true;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  // Sound is now solely the scheduled chime (foreground + background alike),
  // so we do NOT beep here — that would double up in the foreground. The
  // scheduled chime's t0 is ~now at natural completion, so it rings as this
  // runs. Chime is intentionally NOT cancelled here (only on skip/mute);
  // cancelling at completion could race ahead of it ringing.
  stopRestKeepAlive();
  stopRestTimer();
}
```

- [ ] **Step 3: Add a dedicated Skip wrapper and rewire the Skip button**

In `js/ui.js`, find the Skip listener:

```javascript
document.getElementById('btnStopRest').addEventListener('click', stopRestTimer);
```

Replace with:

```javascript
// Skip must silence the pending chime + keep-alive. This is kept OUT of the
// shared stopRestTimer() because natural completion also calls that and must
// let the (already-due) chime ring.
function skipRest() {
  cancelRestChime();
  stopRestKeepAlive();
  stopRestTimer();
}
document.getElementById('btnStopRest').addEventListener('click', skipRest);
```

- [ ] **Step 4: Syntax-check**

Run: `node --check js/ui.js`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add js/ui.js
git commit -m "feat(rest-timer): drive completion sound from the scheduled chime"
```

---

## Task 3: Reschedule on adjust (+15 / −15) and on sound toggle

**Files:**
- Modify: `js/ui.js` — `btnRestPlus`/`btnRestMinus` listeners (~8919-8927), `menuRestTimerSound` listener (~8377)

- [ ] **Step 1: Reschedule the chime on +15s**

In `js/ui.js`, find:

```javascript
document.getElementById('btnRestPlus').addEventListener('click', function() {
  if (!restInterval) return;
  restTargetMs += 15000;
  updateRestDisplay();
});
```

Replace with:

```javascript
document.getElementById('btnRestPlus').addEventListener('click', function() {
  if (!restInterval) return;
  restTargetMs += 15000;
  scheduleRestChime(restRemainingMs() / 1000); // cancels + reschedules
  updateRestDisplay();
});
```

- [ ] **Step 2: Reschedule the chime on −15s**

In `js/ui.js`, find:

```javascript
document.getElementById('btnRestMinus').addEventListener('click', function() {
  if (!restInterval) return;
  // Clamp so the deadline stays at least 5 seconds out from now. Preserves
  // the pre-existing 5s floor; additional -15s taps at the floor are no-ops.
  restTargetMs = Math.max(Date.now() + 5000, restTargetMs - 15000);
  updateRestDisplay();
});
```

Replace with:

```javascript
document.getElementById('btnRestMinus').addEventListener('click', function() {
  if (!restInterval) return;
  // Clamp so the deadline stays at least 5 seconds out from now. Preserves
  // the pre-existing 5s floor; additional -15s taps at the floor are no-ops.
  restTargetMs = Math.max(Date.now() + 5000, restTargetMs - 15000);
  scheduleRestChime(restRemainingMs() / 1000); // cancels + reschedules
  updateRestDisplay();
});
```

- [ ] **Step 3: Cancel/reschedule on the rest-timer-sound toggle**

In `js/ui.js`, find the sound-toggle handler:

```javascript
document.getElementById('menuRestTimerSound').addEventListener('click', function() {
  var next = !getRestTimerSound();
  setRestTimerSound(next);
  closeMenu();
  // Preview the chime on flip-to-on so the user hears what they just enabled.
  if (next) restBeep();
  showToast('Rest timer sound ' + (next ? 'on' : 'off'), null);
});
```

Replace with:

```javascript
document.getElementById('menuRestTimerSound').addEventListener('click', function() {
  var next = !getRestTimerSound();
  setRestTimerSound(next);
  closeMenu();
  // Preview the chime on flip-to-on so the user hears what they just enabled.
  if (next) restBeep();
  // If a rest is in progress, keep the scheduled chime consistent with the
  // new setting: off -> cancel the pending chime; on -> (re)schedule it,
  // since the scheduled chime is now the only sound source.
  if (restInterval) {
    if (next) scheduleRestChime(restRemainingMs() / 1000);
    else cancelRestChime();
  }
  showToast('Rest timer sound ' + (next ? 'on' : 'off'), null);
});
```

- [ ] **Step 4: Syntax-check**

Run: `node --check js/ui.js`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add js/ui.js
git commit -m "feat(rest-timer): reschedule chime on adjust and sound toggle"
```

---

## Task 4: DRY the existing AudioContext creation, bump version

**Files:**
- Modify: `js/ui.js` — `wireAudioUnlock` IIFE (~7740) and `restBeep` (~7773)
- Modify: `js/app.js:10`

- [ ] **Step 1: Use the helper in `wireAudioUnlock`**

In `js/ui.js`, inside the `unlock()` function, find:

```javascript
      if (!restAudioCtx) restAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = restAudioCtx;
```

Replace with:

```javascript
      var ctx = ensureRestAudioCtx();
```

- [ ] **Step 2: Use the helper in `restBeep`**

In `js/ui.js`, inside `restBeep`, find:

```javascript
    if (!restAudioCtx) restAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var ctx = restAudioCtx;
```

Replace with:

```javascript
    var ctx = ensureRestAudioCtx();
```

- [ ] **Step 3: Bump APP_VERSION**

In `js/app.js`, line 10, find:

```javascript
var APP_VERSION = 'v3.6.24';
```

Replace with:

```javascript
var APP_VERSION = 'v3.6.25';
```

- [ ] **Step 4: Syntax-check both files**

Run: `node --check js/ui.js && node --check js/app.js`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add js/ui.js js/app.js
git commit -m "refactor(rest-timer): share ensureRestAudioCtx; v3.6.25"
```

---

## Task 5: Manual verification on the installed iOS PWA

No automated test can exercise audio scheduling under background/lock. Verify
manually on the installed (home-screen, standalone) PWA. Record pass/fail for
each; do not claim completion until all pass.

- [ ] **Step 1: Background fire** — Start a workout, start a rest (~20s), lock
  the phone immediately. Expected: chime sounds at 0:00 with the screen off.

- [ ] **Step 2: App-switch fire** — Start a rest, switch to another app.
  Expected: chime sounds on time while the other app is foreground.

- [ ] **Step 3: Adjust then lock** — Start a rest, tap +15s, lock the phone.
  Expected: chime fires 15s later than the original deadline (at the adjusted
  time), not the original.

- [ ] **Step 4: −15s clamp** — Start a short rest, tap −15s repeatedly past
  the 5s floor, lock. Expected: chime fires ~5s out, once.

- [ ] **Step 5: Skip** — Start a rest, tap Skip, lock the phone past the
  original deadline. Expected: no chime.

- [ ] **Step 6: Mute mid-rest** — Start a rest, open the menu, turn Rest timer
  sound off, lock. Expected: no chime. Then repeat but turn it back **on**
  mid-rest and lock. Expected: chime fires at the deadline.

- [ ] **Step 7: Foreground single-beep** — Start a rest, watch it to 0:00 in
  the foreground. Expected: exactly one chime (no double-beep), vibrate + the
  pill disappearing as before.

- [ ] **Step 8: Back-to-back rests** — Start a rest, then start a new rest
  before the first ends; lock. Expected: only the second rest's chime fires,
  at the second rest's deadline.

- [ ] **Step 9: Return-after-background UI** — Start a rest, lock until after
  the deadline (confirm chime), then reopen the app. Expected: the rest pill
  is gone, no second chime, app state consistent.

- [ ] **Step 10: Final commit (only if all above pass)** — no code change;
  this gate just confirms the feature is verified before any push. If a step
  fails, stop and debug with superpowers:systematic-debugging.

---

## Self-Review

**Spec coverage:**
- Approach (schedule on Web Audio clock + silent keep-alive) → Task 1, Task 2 Step 1. ✓
- `scheduleRestChime` / keep-alive / cancel primitives → Task 1. ✓
- `startRestTimer` schedules + starts keep-alive → Task 2 Step 1. ✓
- Skip / `stopRestTimer` cancels chime + keep-alive (via dedicated `skipRest`, not in shared `stopRestTimer`) → Task 2 Step 3. ✓
- +15 / −15 reschedule → Task 3 Steps 1-2. ✓
- Sound toggled off cancels / back on reschedules → Task 3 Step 3. ✓
- `restComplete` no longer beeps, stops keep-alive, chime not cancelled at completion → Task 2 Step 2. ✓
- `restBeep` retained for flip-to-on preview → unchanged in Task 3 Step 3 / Task 4. ✓
- Foreground exactly-one-chime, no cancel-before-ring race → Task 2 Steps 2-3 design. ✓
- Version bump v3.6.25 → Task 4 Step 3. ✓
- Manual verification matrix (incl. force-quit out of scope) → Task 5. ✓

**Placeholder scan:** none — every code step shows full code; commands have expected output.

**Type/name consistency:** `ensureRestAudioCtx`, `scheduleRestChime`, `cancelRestChime`, `startRestKeepAlive`, `stopRestKeepAlive`, `skipRest`, `restChimeNode`, `restKeepAlive` used consistently across Tasks 1-4. `scheduleRestChime` self-cancels (calls `cancelRestChime` first) so adjust/toggle call sites pass only the new time. ✓
