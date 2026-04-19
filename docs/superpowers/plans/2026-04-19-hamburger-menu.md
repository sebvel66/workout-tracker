# Hamburger Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three header action buttons (History, Import, Export) plus the inline sign-out button with a single `☰` button that opens a bottom-sheet menu containing those same actions.

**Architecture:** Pure UI refactor inside `index.html`. New modal follows the existing `historyModal` pattern at lines 1080-1090 — same `.modal-overlay` wrapper, same slide-up animation, same open/close affordances. No schema changes, no behavior changes to Import/Export/History/Sign Out themselves.

**Tech Stack:** Single-file HTML/CSS/JS app. No build step, no test runner — verification is manual browser testing. Supabase client for auth only (no DB changes here).

**Reference spec:** [docs/superpowers/specs/2026-04-19-hamburger-menu-design.md](../specs/2026-04-19-hamburger-menu-design.md)

---

## Testing approach

This project has no automated test framework. Verification is a browser smoke-test checklist run at the end of the task. Each implementation step is small enough that regressions are immediately visible; the full checklist runs before commit.

---

## Task 1: Build the hamburger menu

**Files:**
- Modify: `index.html` (CSS block ~line 446, header markup ~line 909-914, modal markup ~line 1090, event listeners ~line 1192-1211, sign-out handler ~line 3623-3625, `APP_VERSION` line 1122)

### Step 1: Add `.menu-modal` CSS

- [ ] **Open `index.html` and locate the `.history-modal` CSS block at line 460.**

- [ ] **Insert the new menu CSS immediately before the `/* History browser */` comment at line 459.**

Content to insert (places the menu styles adjacent to the other bottom-sheet modal styles, using identical spacing/radius to visually match):

```css
/* Hamburger menu (bottom-sheet, same pattern as history modal) */
.menu-modal {
  background: var(--surface);
  border-radius: 20px 20px 0 0;
  padding-bottom: calc(16px + var(--safe-bottom));
  width: 100%; max-width: 500px;
  display: flex; flex-direction: column;
  animation: slideUp 0.3s ease;
}
.menu-header {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 14px 12px; border-bottom: 1px solid var(--border);
}
.menu-title { font-size: 16px; font-weight: 700; flex: 1; text-align: center; }
.menu-close {
  background: transparent; border: none; color: var(--text2);
  font-size: 22px; cursor: pointer; padding: 0 6px; line-height: 1;
  width: 32px; text-align: center;
  -webkit-tap-highlight-color: transparent;
}
.menu-body { display: flex; flex-direction: column; }
.menu-row {
  display: block; width: 100%;
  padding: 14px 16px;
  border: none; border-bottom: 1px solid var(--border);
  background: transparent; color: var(--text);
  font-family: 'Outfit', sans-serif;
  font-size: 15px; font-weight: 500;
  text-align: left; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.menu-row:active { background: var(--surface2); }
.menu-row:last-child { border-bottom: none; }
.menu-row.danger { color: var(--danger); }

```

### Step 2: Remove the obsolete `.signout-btn` CSS rule

- [ ] **Delete lines 446-450 (the `.signout-btn { ... }` rule block) entirely, including the blank line after.**

The class is no longer used anywhere after this task completes.

### Step 3: Swap header buttons

- [ ] **Replace the header-top inner div at lines 906-915.**

**Find this exact block:**

```html
    <div>
      <div class="header-title" id="planTitle">Workout Tracker</div>
      <div class="header-week" id="planWeek">No plan loaded</div>
      <div class="version"><button class="signout-btn" id="btnSignOut" type="button">sign out</button></div>
    </div>
    <div class="header-actions">
      <button class="header-btn" id="btnHistory" type="button">History</button>
      <button class="header-btn" id="btnImport">Import</button>
      <button class="header-btn primary" id="btnExport">Export</button>
    </div>
```

**Replace with:**

```html
    <div>
      <div class="header-title" id="planTitle">Workout Tracker</div>
      <div class="header-week" id="planWeek">No plan loaded</div>
    </div>
    <div class="header-actions">
      <button class="header-btn" id="btnMenu" type="button" aria-label="Menu">☰</button>
    </div>
```

This removes three header buttons + the inline sign-out span, and adds a single `☰` button that will trigger the menu.

### Step 4: Add the menu overlay HTML

- [ ] **Insert the new menu overlay markup immediately after the closing `</div>` of `#historyOverlay` at line 1090, before the `<div class="version-footer">` at line 1092.**

Content to insert:

```html

<div class="modal-overlay" id="menuOverlay">
  <div class="menu-modal">
    <div class="menu-header">
      <div style="width:32px"></div>
      <div class="menu-title">Menu</div>
      <button class="menu-close" id="btnMenuClose" type="button">×</button>
    </div>
    <div class="menu-body">
      <button class="menu-row" id="menuImport" type="button">Import Plan</button>
      <button class="menu-row" id="menuExport" type="button">Export Data</button>
      <button class="menu-row" id="menuHistory" type="button">History</button>
      <button class="menu-row danger" id="menuSignOut" type="button">Sign Out</button>
    </div>
  </div>
</div>
```

The `<div style="width:32px">` spacer on the left balances the `×` button on the right so the centered title stays visually centered (matches the history-header pattern at line 1084).

### Step 5: Add `openMenu` / `closeMenu` JS functions

- [ ] **Locate `async function openHistory()` at line 2818 and `function closeHistory()` at line 2827.**

- [ ] **Insert two new functions immediately before `openHistory` at line 2818:**

```javascript
function openMenu() {
  document.getElementById('menuOverlay').classList.add('show');
}

function closeMenu() {
  document.getElementById('menuOverlay').classList.remove('show');
}

```

### Step 6: Rewire event listeners

- [ ] **Locate the event-listeners block starting at line 1192.**

- [ ] **Find the existing `btnImport`, `btnExport`, `btnHistory` listeners at lines 1193-1195 and 1202:**

```javascript
document.getElementById('btnImport').addEventListener('click', function() {
  document.getElementById('importModal').classList.add('show');
});
document.getElementById('btnExport').addEventListener('click', openExportModal);
```

and

```javascript
document.getElementById('btnHistory').addEventListener('click', openHistory);
```

- [ ] **Replace `btnImport` / `btnExport` listeners (lines 1193-1196) with the new menu wiring.** Remove the `btnImport`, `btnExport` direct handlers; add `btnMenu` + all four menu-row handlers. The existing `btnExportCancel`, `btnExportRun`, `exportOverlay` handlers (lines 1197-1201) remain unchanged.

**Find this exact block (lines 1193-1196):**

```javascript
document.getElementById('btnImport').addEventListener('click', function() {
  document.getElementById('importModal').classList.add('show');
});
document.getElementById('btnExport').addEventListener('click', openExportModal);
```

**Replace with:**

```javascript
document.getElementById('btnMenu').addEventListener('click', openMenu);
document.getElementById('btnMenuClose').addEventListener('click', closeMenu);
document.getElementById('menuOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeMenu();
});
document.getElementById('menuImport').addEventListener('click', function() {
  closeMenu();
  document.getElementById('importModal').classList.add('show');
});
document.getElementById('menuExport').addEventListener('click', function() {
  closeMenu();
  openExportModal();
});
document.getElementById('menuHistory').addEventListener('click', function() {
  closeMenu();
  openHistory();
});
document.getElementById('menuSignOut').addEventListener('click', function() {
  closeMenu();
  sb.auth.signOut();
});
```

- [ ] **Delete the now-obsolete `btnHistory` listener at line 1202:**

```javascript
document.getElementById('btnHistory').addEventListener('click', openHistory);
```

### Step 7: Delete the standalone sign-out declaration and handler

Two references to `btnSignOut` exist in the code outside the header markup (which Step 3 already removed): a `var btnSignOut` declaration at line 3534 and an addEventListener call at lines 3623-3625. Both must go.

- [ ] **Delete the variable declaration at line 3534:**

```javascript
var btnSignOut = document.getElementById('btnSignOut');
```

- [ ] **Delete the handler at lines 3623-3625:**

```javascript
btnSignOut.addEventListener('click', function() {
  sb.auth.signOut();
});
```

Sign-out is now wired through `menuSignOut` inside the menu (Step 6).

- [ ] **Verify no references to `btnSignOut` remain anywhere in `index.html`.**

Run: Grep tool for `btnSignOut` in `index.html`.
Expected: zero matches. If any remain, remove them.

### Step 8: Bump APP_VERSION

- [ ] **Locate line 1122 and bump the version.**

**Find:**

```javascript
var APP_VERSION = 'v2.0.10';
```

**Replace with:**

```javascript
var APP_VERSION = 'v2.0.11';
```

### Step 9: Manual browser verification

- [ ] **Serve the app locally and hard-reload (Cmd+Shift+R).**

Run: `python3 -m http.server 8000` in the project root, then open `http://localhost:8000` in a browser.

- [ ] **Sign in and verify the header.**

Expected:
- Left side: plan title + week (no sign-out text below it anymore).
- Right side: a single `☰` button.
- Version `v2.0.11` visible in the bottom-right.
- No console errors.

- [ ] **Tap `☰`.**

Expected:
- Bottom sheet slides up from the bottom.
- Four rows visible, top to bottom: "Import Plan", "Export Data", "History", "Sign Out".
- "Sign Out" row is in red (`var(--danger)`).
- Header says "Menu" with an `×` on the right.

- [ ] **Tap "History".**

Expected: menu closes, History browser opens with the user's workouts. Close History.

- [ ] **Tap `☰`, then "Import Plan".**

Expected: menu closes, Import modal opens. Close Import.

- [ ] **Tap `☰`, then "Export Data".**

Expected: menu closes, Export modal opens. Close Export.

- [ ] **Tap `☰`, then tap outside the sheet (on the dimmed backdrop).**

Expected: menu closes without triggering any action.

- [ ] **Tap `☰`, then tap the `×` close button inside the sheet.**

Expected: menu closes without triggering any action.

- [ ] **Tap `☰`, then "Sign Out".**

Expected: menu closes, user is signed out, auth overlay returns.

- [ ] **Sign back in to confirm nothing in the auth or hydrate flow broke.**

Expected: normal hydration, workout state loads, no console errors.

### Step 10: Commit

- [ ] **Stage and commit with a focused message.**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Consolidate header actions behind a hamburger menu

Replaces the three header action buttons (History, Import, Export)
and the inline sign-out affordance with a single ☰ button that opens
a bottom-sheet menu reusing the existing history-modal pattern
(slideUp animation, 20px top radius, safe-area padding).

Menu contents: Import Plan, Export Data, History, Sign Out. Gym
Profiles (Feature 3) and Settings rows deliberately omitted until
their respective features land — no placeholder UI.

Pure UI refactor: no schema changes, no behavior changes to Import
/ Export / History / Sign Out. Entry point moves only.

Bumps APP_VERSION to v2.0.11.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Confirm working tree is clean and the branch is one commit ahead of `origin/main`.**

Run: `git status && git log --oneline -2`
Expected: "nothing to commit, working tree clean" and the new commit visible as HEAD.

---

## Self-review

After the task above is complete, run the spec coverage check:

| Spec requirement | Task step |
|---|---|
| `☰` button replaces 3 header buttons | Step 3 |
| Bottom-sheet matches history-modal pattern | Step 1 (CSS) + Step 4 (HTML) |
| 4 rows (Import, Export, History, Sign Out) | Step 4 |
| Sign Out visually distinct (danger color) | Step 1 (`.menu-row.danger`) + Step 4 (`class="menu-row danger"`) |
| Tap row → close menu → fire action | Step 6 (handlers call `closeMenu()` first) |
| Close via overlay-click, ×, or row-tap | Step 6 (all three wired) |
| `.signout-btn` CSS rule removed | Step 2 |
| Inline `btnSignOut` markup removed | Step 3 |
| Bare `btnSignOut` handler removed | Step 7 |
| No references to `btnHistory`/`btnImport`/`btnExport`/`btnSignOut`/`.signout-btn` remain | Step 7 (grep check) + full-file review during verification |
| `APP_VERSION` bumped to `v2.0.11` | Step 8 |
| Manual smoke test | Step 9 |
| Single focused commit | Step 10 |
