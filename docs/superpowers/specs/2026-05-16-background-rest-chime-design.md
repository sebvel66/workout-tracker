# Background-resilient rest chime — design

Date: 2026-05-16
Status: approved
Target version: v3.6.25 (follow-up patch within the 3.6 line)

## Problem

The rest-end chime only plays when the web app is open and foregrounded on
the phone. When the phone is locked or another app is in the foreground, the
chime is silent until the user reopens the app.

Root cause: the chime fires from the rest-timer `setInterval` tick
([js/ui.js:7659](../../../js/ui.js#L7659)). When the page is backgrounded or
the device is locked, the browser freezes JS timers and suspends the
AudioContext, so the tick never reaches `restComplete()` → `restBeep()`. The
existing `visibilitychange` catch-up ([js/ui.js:8823](../../../js/ui.js#L8823))
only fires the chime late, when the app is reopened.

This is a browser/OS limitation, not a logic bug. There is no web API that
lets a fully-closed PWA wake up and beep without a server.

## Scope

In scope: chime fires on time when the app is backgrounded or the screen is
locked **while the app is still in memory**. Target environment is the
installed (home-screen / standalone) PWA on iOS, which is the reliable case
for background Web Audio.

Out of scope (accepted limitations):

- App force-quit or OS-evicted from memory → nothing fires. Would require Web
  Push + a server-side timer; explicitly deferred.
- Vibration in the background. `navigator.vibrate` does not run in the
  background on iOS and cannot be scheduled on the audio thread. Background
  case is chime-only.
- No backend changes, no new audio assets.

## Approach

Stop depending on the JS `setInterval` tick to fire the chime. Schedule the
chime on the Web Audio clock at the moment rest starts, and keep the
AudioContext alive in the background with a continuous near-silent source.

The Web Audio scheduler runs on the audio thread, independent of the
(frozen-when-locked) JS event loop, so a scheduled oscillator fires on time
even with the screen off — provided the AudioContext is not suspended. iOS
keeps the context running while there is continuous audio output, which the
silent keep-alive source provides.

Rejected alternative: an `<audio>` element looping a silent file. It can hold
the iOS media session but does not solve the core problem — frozen JS could
not swap the chime in at the target time. The Web Audio approach solves both
the keep-alive and the timed fire in a single context.

## Components

All changes are confined to the rest-timer section of
[js/ui.js](../../../js/ui.js) (~7630–7790, plus the +15/−15/Skip listeners
~8809–8827). Reuses the existing module-level `restAudioCtx`
([js/ui.js:18](../../../js/ui.js#L18)) and `getRestTimerSound()`
([js/data.js:1564](../../../js/data.js#L1564)).

1. **`scheduleRestChime(whenSec)`** — builds the same 880 Hz sine, ~0.25 s
   attack/release envelope as today's `restBeep()`, but starts the oscillator
   at `ctx.currentTime + whenSec` instead of immediately. Gated on
   `getRestTimerSound()` evaluated at schedule time. Stores the created
   oscillator/gain nodes in a module-level handle so they can be cancelled.
   Wrapped in try/catch; audio stays best-effort.

2. **Silent keep-alive source** — a looping `AudioBufferSourceNode` of a tiny
   buffer at effectively zero gain, in the same `restAudioCtx`, started from
   the rest-start user gesture so iOS keeps the context running. Tracked in a
   module-level handle.

3. **`startRestTimer(sec)`** — in addition to its current work: ensure/resume
   `restAudioCtx`, start the keep-alive source, call
   `scheduleRestChime(sec)`, store the handle. The existing `setInterval` is
   kept **only for the visual countdown** (cheap; acceptable that it freezes
   when backgrounded).

4. **Cancel / reschedule on any deadline change:**
   - **Skip / `stopRestTimer()`** → cancel the scheduled chime, stop the
     keep-alive source.
   - **+15 s / −15 s** ([js/ui.js:8809](../../../js/ui.js#L8809),
     [js/ui.js:8814](../../../js/ui.js#L8814)) → cancel and re-schedule the
     chime at the new remaining time (derived from `restRemainingMs()` after
     `restTargetMs` is adjusted).
   - **Mute mid-rest** (rest-timer-sound toggled off,
     [js/ui.js:8317](../../../js/ui.js#L8317)) → cancel the scheduled chime.
     (Re-enabling mid-rest does not reschedule; matches today's fire-time
     gating semantics closely enough and avoids extra complexity.)

5. **`restComplete()`** — unchanged as the foreground path (vibrate + UI +
   `stopRestTimer`). The `restCompleted` guard already makes the foreground
   `setInterval` path idempotent against the audio-thread chime, so no
   double-beep. The `visibilitychange` catch-up remains as the JS-side UI
   fallback.

## Data flow

- **Foreground:** scheduled chime fires on the audio thread; `setInterval`
  also reaches 0 and runs `restComplete()` (vibrate + UI). `restCompleted`
  guard prevents double action.
- **Backgrounded / locked, still in memory:** scheduled chime fires on time;
  no vibration; UI catches up via `visibilitychange` on reopen.
- **Force-quit / evicted:** nothing fires (accepted).

## Error handling

All audio wrapped in try/catch as today. Audio remains a nice-to-have; in the
foreground, vibrate + UI still fire if audio throws. Cancelling a scheduled
node guards against the node already being null / already stopped.

## Testing

No feasible automated audio test. Manual verification on the installed PWA
(iOS home-screen, standalone):

1. Start rest, lock phone → chime fires at 0:00 with screen off.
2. +15 s / −15 s, then lock → chime fires at the adjusted time.
3. Skip → no chime.
4. Mute rest sound mid-rest → no chime.
5. Foreground through the whole rest → exactly one chime (no double-beep),
   vibrate + UI fire as before.
6. Regression: rapid back-to-back rests / starting a new rest before the old
   one ends → only the current rest's chime fires.

## Version / workflow

Bump `APP_VERSION` ([js/app.js:10](../../../js/app.js#L10)) to v3.6.25. Test
manually before commit; small focused commit; do not push without explicit
approval.
