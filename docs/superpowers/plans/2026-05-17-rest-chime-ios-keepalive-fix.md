# iOS Rest-Chime Keep-Alive Fix + Diagnostics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rest chime fire while the iOS home-screen app is locked/backgrounded by holding the AudioContext alive with a looping HTMLMediaElement, and add gated on-device diagnostics so the next device test yields evidence.

**Architecture:** Keep the scheduled-oscillator chime unchanged. Replace the silent Web-Audio buffer keep-alive with a looping low-amplitude `<audio>` element (runtime data-URI WAV) routed through the AudioContext via a single persistent MediaElementSource, primed in the existing first-gesture unlock. Add a `localStorage`-gated diagnostic readout.

**Tech Stack:** Vanilla browser JS, no build, no test framework. Gate: `node --check`. Functional verification is manual on-device (instrumented).

Spec: `docs/superpowers/specs/2026-05-17-rest-chime-ios-keepalive-fix-design.md`

---

## File Structure

- Modify `js/ui.js`: module state (line ~20), new `buildKeepAliveDataUri()` + `ensureKeepAliveEl()`, rewritten `startRestKeepAlive`/`stopRestKeepAlive` (~7878-7901), `wireAudioUnlock` priming (~7903-7922), diagnostics helpers + capture points in `scheduleRestChime` (~7861) and the `visibilitychange` handler (~7113/9113).
- Modify `index.html`: add `#rtDebug` element next to `#versionFooter` (line ~4084).
- Modify `js/app.js:10`: version bump to v3.6.28.

---

## Task 1: Replace buffer-source keep-alive with a looping media element

**Files:** Modify `js/ui.js`

- [ ] **Step 1: Swap the module-state declaration**

Find (js/ui.js ~line 20):

```javascript
var restKeepAlive = null;   // silent looping source that keeps the ctx alive bg
```

Replace with:

```javascript
var restKeepAliveEl = null;   // looping <audio> keep-alive (holds iOS audio session)
var restKeepAliveNode = null; // its single MediaElementSourceNode (one per element, ever)
```

- [ ] **Step 2: Replace `startRestKeepAlive` and `stopRestKeepAlive`**

Find this exact block:

```javascript
// Start a continuous near-silent looping source. iOS keeps the AudioContext
// running (so the scheduled chime fires on time when locked) only while there
// is active audio output. Idempotent. Stopped at rest end/skip to save battery.
function startRestKeepAlive() {
  try {
    var ctx = ensureRestAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    if (restKeepAlive) return;
    // createBuffer() returns a zero-filled (digitally silent) buffer, so no
    // gain node is needed — connect the looping source straight to output.
    var buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // 1s of silence
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(ctx.destination);
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

Replace with:

```javascript
// Build a tiny in-memory WAV (mono, 8kHz, 1s, 16-bit) carrying a very
// low-amplitude 60Hz sine (~-60 dBFS, inaudible). NOT digital silence: iOS
// ignores silent media for background-audio purposes. 60 full cycles over
// exactly 1s means the loop boundary is sample-continuous (no click). Returned
// as a self-contained data: URI so no binary asset ships in the repo.
function buildKeepAliveDataUri() {
  var sr = 8000, n = sr; // 1 second
  var dataLen = n * 2;
  var buf = new ArrayBuffer(44 + dataLen);
  var dv = new DataView(buf);
  function ws(off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
  ws(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);  // PCM
  dv.setUint16(22, 1, true);  // mono
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); // byteRate
  dv.setUint16(32, 2, true);  // blockAlign
  dv.setUint16(34, 16, true); // bits
  ws(36, 'data'); dv.setUint32(40, dataLen, true);
  var off = 44;
  for (var i = 0; i < n; i++) {
    dv.setInt16(off, Math.round(32 * Math.sin(2 * Math.PI * 60 * i / sr)), true);
    off += 2;
  }
  var bytes = new Uint8Array(buf), bin = '';
  for (var j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

// Lazily create the single persistent keep-alive <audio> element and route it
// through the AudioContext (createMediaElementSource is one-per-element for
// the element's lifetime, so it must persist and be reused).
function ensureKeepAliveEl() {
  if (restKeepAliveEl) return restKeepAliveEl;
  try {
    var el = document.createElement('audio');
    el.loop = true;
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.src = buildKeepAliveDataUri();
    el.style.display = 'none';
    document.body.appendChild(el);
    var ctx = ensureRestAudioCtx();
    restKeepAliveNode = ctx.createMediaElementSource(el);
    restKeepAliveNode.connect(ctx.destination);
    restKeepAliveEl = el;
  } catch (e) { /* best effort; leave restKeepAliveEl null to retry later */ }
  return restKeepAliveEl;
}

// Play the looping keep-alive element. An actively-playing HTMLMediaElement is
// what keeps iOS from suspending the AudioContext in the background, so the
// scheduled chime oscillator fires on time while locked. Idempotent.
function startRestKeepAlive() {
  try {
    var ctx = ensureRestAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    var el = ensureKeepAliveEl();
    if (!el || !el.paused) return;
    try { el.currentTime = 0; } catch (_) {}
    var p = el.play();
    if (p && p.catch) p.catch(function () {});
  } catch (e) { /* best effort */ }
}

// Pause (not teardown) — the single MediaElementSource must persist for reuse.
function stopRestKeepAlive() {
  if (restKeepAliveEl && !restKeepAliveEl.paused) {
    try { restKeepAliveEl.pause(); } catch (_) {}
  }
}
```

- [ ] **Step 3: Update the stale "silent keep-alive" comment in `startRestTimer`**

Find:

```javascript
  // Audio-thread completion chime (fires even when JS is frozen / phone
  // locked) + silent keep-alive that holds the AudioContext open in the
  // background. stopRestTimer() above already cleared any prior rest; this
  // schedules fresh for the current one.
```

Replace with:

```javascript
  // Audio-thread completion chime (fires even when JS is frozen / phone
  // locked) + a looping <audio> keep-alive that holds the iOS audio session
  // (and thus the AudioContext) open in the background. stopRestTimer() above
  // already cleared any prior rest; this schedules fresh for the current one.
```

- [ ] **Step 4: Syntax check** — Run `node --check js/ui.js` from /Users/sebastianvelez/workout-tracker. Expect no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add js/ui.js
git commit -m "fix(rest-timer): HTMLMediaElement keep-alive so iOS keeps the AudioContext alive"
```
Append a blank line then: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

**Guardrails:** Do not modify `scheduleRestChime`, `cancelRestChime`, `restComplete`, `skipRest`, `ensureRestAudioCtx`, the +15/−15/mute handlers, or `wireAudioUnlock` in this task. If an anchor drifted, locate the unique anchor and proceed; report deviations.

---

## Task 2: Prime the element on first gesture + add the diagnostic surface

**Files:** Modify `js/ui.js`, `index.html`

- [ ] **Step 1: Prime the keep-alive element inside `wireAudioUnlock`**

Find this exact block in `js/ui.js`:

```javascript
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.001);
    } catch(_) {}
```

Replace with:

```javascript
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.001);
      // Prime the keep-alive media element within this user gesture so iOS
      // marks it user-activated for later gesture-initiated plays.
      var kel = ensureKeepAliveEl();
      if (kel) {
        var pp = kel.play();
        if (pp && pp.then) pp.then(function () { try { kel.pause(); } catch (_) {} }).catch(function () {});
      }
    } catch(_) {}
```

- [ ] **Step 2: Add diagnostics helpers + state in `js/ui.js`**

Immediately ABOVE `function ensureRestAudioCtx() {` (the line with its preceding comment `// Lazily create (and return) the shared rest AudioContext.`), insert:

```javascript
// ---- Rest-chime on-device diagnostics (gated; off by default) ----
// Enable on the device with: localStorage.setItem('rtDebug','1') then reload.
// Writes a compact readout to #rtDebug so a locked-screen test produces
// evidence (AudioContext state + clock progression) instead of pass/fail.
var rtDiag = {};
function getRtDebug() {
  try { return localStorage.getItem('rtDebug') === '1'; } catch (_) { return false; }
}
function rtDiagRender() {
  if (!getRtDebug()) return;
  try {
    var el = document.getElementById('rtDebug');
    if (!el) return;
    var d = rtDiag;
    var ctxAdv = (d.retCtxTime != null && d.schedCtxTime != null)
      ? (d.retCtxTime - d.schedCtxTime).toFixed(2) : '-';
    var wallAdv = (d.retWall != null && d.schedWall != null)
      ? ((d.retWall - d.schedWall) / 1000).toFixed(2) : '-';
    el.textContent =
      'rt sched: state=' + (d.schedCtxState || '-') +
      ' ctxT=' + (d.schedCtxTime != null ? d.schedCtxTime.toFixed(2) : '-') +
      ' when=' + (d.whenSec != null ? d.whenSec.toFixed(1) : '-') + '\n' +
      'rt rang: ' + (d.rang ? 'yes' : 'no') + '\n' +
      'rt ret:  state=' + (d.retCtxState || '-') +
      ' ctxT=' + (d.retCtxTime != null ? d.retCtxTime.toFixed(2) : '-') +
      ' elPaused=' + (d.elPaused == null ? '-' : d.elPaused) +
      ' elT=' + (d.elTime != null ? d.elTime.toFixed(2) : '-') + '\n' +
      'rt adv:  ctx=' + ctxAdv + 's wall=' + wallAdv + 's';
    el.style.display = 'block';
  } catch (_) {}
}
```

- [ ] **Step 3: Add the `#rtDebug` element in `index.html`**

Find (index.html ~line 4084):

```html
<div class="version-footer" id="versionFooter"></div>
```

Replace with:

```html
<div class="version-footer" id="versionFooter"></div>
<div class="version-footer" id="rtDebug" style="display:none;left:8px;right:auto;text-align:left;white-space:pre;font-size:10px;line-height:1.3;"></div>
```

- [ ] **Step 4: Syntax check** — `node --check js/ui.js` — expect exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add js/ui.js index.html
git commit -m "feat(rest-timer): gesture-prime keep-alive + gated on-device diagnostics surface"
```
Append a blank line then: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

**Guardrails:** `ensureKeepAliveEl` is defined in Task 1 — assume it exists. Do not modify scheduling/keep-alive logic here. Indentation in Step 1 must match the surrounding 6-space try block.

---

## Task 3: Wire diagnostic capture points

**Files:** Modify `js/ui.js`

- [ ] **Step 1: Capture at chime schedule time**

Find, inside `scheduleRestChime`:

```javascript
    osc.start(t0);
    osc.stop(t0 + 0.25);
    restChimeNode = osc;
  } catch (e) { /* audio is a nice-to-have; vibrate + UI still fire */ }
```

Replace with:

```javascript
    osc.start(t0);
    osc.stop(t0 + 0.25);
    restChimeNode = osc;
    if (getRtDebug()) {
      rtDiag = { schedWall: Date.now(), schedCtxState: ctx.state,
                 schedCtxTime: ctx.currentTime, whenSec: whenSec, rang: false };
      rtDiagRender();
    }
  } catch (e) { /* audio is a nice-to-have; vibrate + UI still fire */ }
```

- [ ] **Step 2: Capture when the chime actually rings**

Find, inside `scheduleRestChime` (the onended handler):

```javascript
    osc.onended = function() {
      try { gain.disconnect(); } catch (_) {}
      if (restChimeNode === osc) restChimeNode = null;
    };
```

Replace with:

```javascript
    osc.onended = function() {
      try { gain.disconnect(); } catch (_) {}
      if (restChimeNode === osc) restChimeNode = null;
      if (getRtDebug()) { rtDiag.rang = true; rtDiag.rangWall = Date.now(); rtDiagRender(); }
    };
```

- [ ] **Step 3: Capture on return-from-background**

Find this exact block:

```javascript
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && restInterval && restRemainingMs() <= 0) {
    restComplete();
  }
});
```

Replace with:

```javascript
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  if (getRtDebug() && restInterval) {
    rtDiag.retWall = Date.now();
    rtDiag.retCtxState = restAudioCtx ? restAudioCtx.state : 'no-ctx';
    rtDiag.retCtxTime = restAudioCtx ? restAudioCtx.currentTime : null;
    rtDiag.elPaused = restKeepAliveEl ? restKeepAliveEl.paused : 'no-el';
    rtDiag.elTime = restKeepAliveEl ? restKeepAliveEl.currentTime : null;
    rtDiagRender();
  }
  if (restInterval && restRemainingMs() <= 0) {
    restComplete();
  }
});
```

- [ ] **Step 4: Syntax check** — `node --check js/ui.js` — expect exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add js/ui.js
git commit -m "feat(rest-timer): wire diagnostic capture into schedule/ring/return paths"
```
Append a blank line then: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

**Guardrails:** The diagnostic capture in Step 3 MUST run before the `restComplete()` call (which tears down `restInterval`/state). All capture is guarded by `getRtDebug()` so it's a no-op when off. Do not change the completion condition logic itself (`restInterval && restRemainingMs() <= 0`).

---

## Task 4: Version bump + final holistic review

**Files:** Modify `js/app.js`

- [ ] **Step 1: Bump version**

Find (js/app.js:10):

```javascript
var APP_VERSION = 'v3.6.27';
```

Replace with:

```javascript
var APP_VERSION = 'v3.6.28';
```

- [ ] **Step 2: Syntax check** — `node --check js/app.js && node --check js/ui.js` — expect exit 0.

- [ ] **Step 3: Commit**

```bash
git add js/app.js
git commit -m "v3.6.28 -- iOS rest-chime keep-alive via looping media element + diagnostics"
```
Append a blank line then: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

- [ ] **Step 4: Final holistic review** (controller dispatches; not a code step) — full-feature review of the keep-alive rework + diagnostics, focusing on: MediaElementSource one-per-element correctness, idempotency across adjust/back-to-back, diagnostics never throwing into live paths and being a true no-op when off, loop seamlessness, autoplay-policy handling.

---

## Self-Review

**Spec coverage:**
- HTMLMediaElement keep-alive via data-URI WAV, routed through ctx, one MediaElementSource → Task 1. ✓
- Rework start/stop, module state, stale comment → Task 1. ✓
- Gesture priming in wireAudioUnlock → Task 2 Step 1. ✓
- Gated diagnostics: helpers + #rtDebug element + capture at schedule/onended/visibilitychange (capture before restComplete) → Tasks 2-3. ✓
- Version bump v3.6.28 → Task 4. ✓
- node --check gate each task; manual instrumented verification → spec testing section. ✓

**Placeholder scan:** none — every step has complete code/commands.

**Type/name consistency:** `restKeepAliveEl`, `restKeepAliveNode`, `buildKeepAliveDataUri`, `ensureKeepAliveEl`, `startRestKeepAlive`, `stopRestKeepAlive`, `rtDiag`, `getRtDebug`, `rtDiagRender` used consistently across tasks. `ensureKeepAliveEl` defined Task 1, consumed Task 2. `rtDiag`/`getRtDebug`/`rtDiagRender` defined Task 2, consumed Task 3. `restKeepAliveEl`/`restAudioCtx` referenced in Task 3 are defined in Task 1 / pre-existing. ✓
