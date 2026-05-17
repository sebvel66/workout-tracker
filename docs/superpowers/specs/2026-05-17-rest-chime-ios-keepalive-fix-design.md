# Rest chime — iOS keep-alive fix + on-device diagnostics — design

Date: 2026-05-17
Status: approved
Target version: v3.6.28 (follow-up patch; v3.6.27 taken by the unrelated form-video feature)
Supersedes the keep-alive mechanism from `2026-05-16-background-rest-chime-design.md`.

## Problem (root cause, confirmed)

v3.6.26 shipped correctly (verified live on production: `restComplete()` no
longer beeps; all scheduled-chime functions present; `cache-control:
max-age=0, must-revalidate` so the device runs current code). Yet the chime
still only plays on app return.

Since the deployed `restComplete()` produces no sound, the only sound path is
the Web-Audio oscillator scheduled at `ctx.currentTime + whenSec` in
`scheduleRestChime()`. It fires *exactly on app return* — the fingerprint of a
**suspended AudioContext**: a suspended context freezes `currentTime`, so the
scheduled `osc.start(t0)` cannot fire until the context resumes on foreground.

**Root cause:** on iOS the silent Web-Audio `AudioBufferSourceNode` keep-alive
does NOT prevent the OS from suspending the `AudioContext` when the
home-screen web view is backgrounded / locked. iOS only sustains background
audio for an actively-playing **HTMLMediaElement** that has engaged the media
session. A Web-Audio-only graph — especially the digitally-silent zero buffer
introduced in the v3.6.26 code-quality refactor — does not qualify.

## Approach

Keep `scheduleRestChime()` / `cancelRestChime()` and the whole scheduled-
oscillator design unchanged — it is correct. Replace ONLY the keep-alive
mechanism with a looping HTMLMediaElement routed through the AudioContext, so
the context is not suspended while locked and the scheduled oscillator fires
on time. Add gated on-device diagnostics so the next device test produces
evidence (context state / clock progression) rather than a binary pass/fail.

## Scope

In scope (all in `js/ui.js` unless noted):
- Rework `startRestKeepAlive()` / `stopRestKeepAlive()` internals and the
  `restKeepAlive*` module state.
- New helper to build the keep-alive media element from a runtime-generated
  data-URI WAV (no binary asset committed).
- Prime the media element in the existing `wireAudioUnlock` first-gesture path.
- Diagnostics: a `localStorage`-gated readout written to a new
  `#rtDebug` element added to `index.html`.
- Version bump to v3.6.28 (`js/app.js`).

Out of scope (unchanged): `scheduleRestChime`, `cancelRestChime`,
`restComplete`, `skipRest`, the +15/−15/mute handlers, `restRemainingMs`,
`ensureRestAudioCtx`, the existing oscillator unlock in `wireAudioUnlock`.
Web Push / manifest / service worker — explicitly the fallback only if device
evidence shows iOS still suspends the context with the media element playing.
The abandoned-final-rest battery edge (memory:
`project-rest-chime-keepalive-followup`) is unchanged by this work.

## Component design

### 1. Keep-alive media element (replaces the buffer-source keep-alive)

Module state (replace the current `var restKeepAlive = null;`):
- `var restKeepAliveEl = null;` — the persistent `<audio>` element.
- `var restKeepAliveNode = null;` — the single `MediaElementAudioSourceNode`
  (the Web Audio API permits only one per element, ever).

Helper `ensureKeepAliveEl()`:
- If `restKeepAliveEl` exists, return it.
- Build a tiny WAV in memory: mono, 8000 Hz, 1.0 s, 16-bit PCM, filled with a
  **very low amplitude** signal (≈ −60 dBFS, e.g. a low-frequency sine at
  amplitude `32` of the int16 range, NOT zero — iOS ignores digital silence).
  Base64-encode to a `data:audio/wav;base64,...` URI. (Self-contained; no
  asset file added to the repo.)
- Create `audio` element: `loop = true`, `preload = 'auto'`,
  `playsinline = true`, `setAttribute('playsinline','')`, `muted = false`,
  `src = dataUri`. Append hidden to `document.body`.
- `ensureRestAudioCtx()`, then create
  `restKeepAliveNode = ctx.createMediaElementSource(el)` and
  `restKeepAliveNode.connect(ctx.destination)` exactly once.
- Store and return the element.

`startRestKeepAlive()`:
- `try`: `ensureRestAudioCtx()`; if suspended, `ctx.resume()`;
  `var el = ensureKeepAliveEl()`; if `!el.paused` return (idempotent);
  `el.currentTime = 0` (best-effort, in try); `var p = el.play();` if `p`,
  `p.catch(function(){})`. All wrapped so a play rejection is non-fatal.

`stopRestKeepAlive()`:
- If `restKeepAliveEl` and `!restKeepAliveEl.paused`,
  `try { restKeepAliveEl.pause(); } catch(_) {}`. Do NOT null the element or
  disconnect the node (the single MediaElementSource must persist for reuse).

Lifecycle is otherwise identical to today: `startRestTimer` calls
`startRestKeepAlive()`; `restComplete`/`skipRest` call `stopRestKeepAlive()`;
idempotent across adjust and back-to-back rests.

### 2. Autoplay priming in `wireAudioUnlock`

Inside the existing first-gesture `unlock()` (after the existing oscillator
unlock, same try/catch spirit): `var el = ensureKeepAliveEl();` then
`el.play().then(function(){ el.pause(); }).catch(function(){});` — a
play→pause within the user gesture so iOS marks the element user-activated
for later (gesture-initiated) `startRestKeepAlive` plays. Idempotent via the
existing `unlocked` guard.

### 3. On-device diagnostics (gated)

Enabled only when `localStorage.getItem('rtDebug') === '1'`. A
`getRtDebug()` helper reads the flag.

`index.html`: add `<div class="version-footer" id="rtDebug"
style="display:none;left:8px;right:auto;white-space:pre;font-size:10px;
line-height:1.3;text-align:left;"></div>` adjacent to the existing
`<div class="version-footer" id="versionFooter"></div>` (line ~4084).
(Reuses the existing `.version-footer` styling; overrides position to the
bottom-left so it doesn't overlap the version tag.)

Module state: `var rtDiag = {};`. A `rtDiagRender()` function: if
`!getRtDebug()` return; build a compact multi-line string from `rtDiag` and
write it to `#rtDebug.textContent`, and set its `display` to `block`.

Capture points:
- In `scheduleRestChime`, right after a chime is actually scheduled
  (`restChimeNode = osc;`): record `rtDiag.schedWall = Date.now()`,
  `rtDiag.schedCtxState = ctx.state`, `rtDiag.schedCtxTime = ctx.currentTime`,
  `rtDiag.whenSec = whenSec`, clear `rtDiag.rang`. Call `rtDiagRender()`.
- In the chime `osc.onended`: `rtDiag.rangWall = Date.now()`,
  `rtDiag.rang = true`. `rtDiagRender()`.
- In the `visibilitychange` handler, when becoming visible AND a rest is/was
  active: record `rtDiag.retWall = Date.now()`, `rtDiag.retCtxState =
  restAudioCtx ? restAudioCtx.state : 'no-ctx'`, `rtDiag.retCtxTime =
  restAudioCtx ? restAudioCtx.currentTime : 0`, `rtDiag.elPaused =
  restKeepAliveEl ? restKeepAliveEl.paused : 'no-el'`, `rtDiag.elTime =
  restKeepAliveEl ? restKeepAliveEl.currentTime : 0`. Compute
  `ctxAdvanced = retCtxTime - schedCtxTime` and `wallAdvanced =
  (retWall - schedWall)/1000`. `rtDiagRender()`. This capture must run
  BEFORE the existing `restComplete()` call (which tears down state).

All diagnostic code must be a no-op when the flag is off (cheap guard first)
and must never throw into the audio/visibility paths (wrap in try/catch or
guard every field access).

Readout interpretation (documented for the tester):
- `ctxAdvanced ≈ wallAdvanced` and chime heard while locked → context stayed
  alive; fix works.
- `ctxAdvanced ≪ wallAdvanced` (clock froze) and/or `retCtxState:suspended`,
  chime only on return → iOS still suspended despite the media element →
  escalate to the Web Push fallback with this readout as evidence.

## Error handling

Every new audio operation wrapped in try/catch like the existing code; audio
is best-effort (vibrate + UI still fire). `el.play()` returns a promise that
can reject (autoplay policy) — always `.catch()`. Diagnostics never throw into
the live paths.

## Testing / verification

No automated test is feasible (device/OS background behavior). Code gate:
`node --check js/ui.js && node --check js/app.js`. Manual, on the installed
iOS home-screen app, with `localStorage.setItem('rtDebug','1')` set (tester
instruction: open the app, in the URL/console or via a one-liner set the
flag, reload):

1. Start rest, lock phone, wait past deadline → chime sounds **while
   locked**; on return `#rtDebug` shows `ctxAdvanced ≈ wallAdvanced`,
   `rang:true`. PASS.
2. If no chime while locked and `#rtDebug` shows `retCtxState:suspended` /
   `ctxAdvanced ≪ wallAdvanced` → documented FAIL → Web Push fallback.
3. Foreground full rest → exactly one chime (regression check).
4. Skip / +15 / −15 / mute mid-rest → unchanged behavior (regression).
5. Back-to-back rests → keep-alive element reused, no duplicate audio, only
   the latest chime fires (regression).
6. Flag off (default) → `#rtDebug` hidden, zero behavior change.

## Version / workflow

Bump `APP_VERSION` (`js/app.js:10`) to v3.6.28. `node --check` gate before
each commit; small focused commits; no push without explicit approval.
