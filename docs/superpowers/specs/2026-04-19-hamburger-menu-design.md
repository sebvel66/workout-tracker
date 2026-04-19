# Hamburger Menu — Design

**Status:** Approved by user 2026-04-19 (pre-implementation).
**Scope:** First of three sequenced features (hamburger menu → session notes → gym profiles). This spec covers only the hamburger menu.

## Why

The header's `.header-actions` cluster is getting crowded (History, Import, Export), and more actions are coming (Gym Profiles in Feature 3, Settings later). The current sign-out button is also awkwardly placed inline with the version tag at [index.html:909](index.html#L909). Consolidating secondary actions behind a single `☰` menu clears header space, gives new actions a coherent home, and removes the cramped sign-out placement.

This is a pure UI refactor: no DB schema changes, no behavior changes to Import / Export / History / Sign Out themselves — only the entry point changes.

## Design

### Trigger

A new `☰` button in the header, replacing the three current action buttons (`btnHistory`, `btnImport`, `btnExport`). Uses the existing `.header-btn` style so it sits visually flush with what was there before.

### Container

A bottom-sheet modal following the existing `historyModal` pattern at [index.html:1083](index.html#L1083):

- `.modal-overlay` wrapper with the existing dim-backdrop + tap-to-close behavior.
- `.menu-modal` sheet inside, matching `.history-modal`'s visual treatment: `border-radius: 20px 20px 0 0`, `max-width: 500px`, `padding-bottom: calc(16px + var(--safe-bottom))`, `animation: slideUp 0.3s ease`.
- Header row inside the sheet mirroring `.history-header`: "Menu" title on the left, ✕ close button on the right.
- This keeps visual language consistent with the other bottom-sheet modals already in the app (History browser, Exercise Picker, Import, Export, History Detail).

### Contents (initial, in order)

1. **Import Plan** — triggers the existing Import flow (currently bound to `btnImport`).
2. **Export Data** — opens the existing Export modal (currently `openExportModal`).
3. **History** — opens the existing History browser (currently `openHistory`).
4. **Sign Out** — calls `sb.auth.signOut()` (currently the `btnSignOut` handler at [index.html:3624](index.html#L3624)).

**Gym Profiles** and **Settings** rows are intentionally omitted from the initial menu. They will be added by Feature 3 (Gym Profiles) and a later Settings feature respectively. No placeholder rows — the menu grows as features land, rather than shipping dead UI.

### Visual

- Each menu row is a full-width tappable button: ~48–52 px tall, left-aligned text, `border-bottom: 1px solid var(--border)`, `background: transparent`, tap-highlight via `background: var(--surface2)` on `:active` (matches `.history-row:active`).
- Plain text labels, no icons. Consistent with the app's minimal aesthetic.
- The **Sign Out** row uses `color: var(--danger)` so it reads as destructive without being visually loud.
- Menu sheet "Menu" header uses the same typography as `.history-title` so the two sheets feel like siblings.

### Interaction

- Tap a menu row → the menu sheet closes → the target action fires. For actions that open their own modal (Import, Export, History), this produces a natural close→open animation chain. Order matters: closing first avoids stacked overlays.
- Close the menu via: tap outside the sheet (existing overlay-click behavior), tap the ✕ close button, or select any menu row.
- No keyboard shortcuts in scope (mobile-first PWA).

## Implementation surface

Touches `index.html` only. Approximate surface:

- **HTML (~20 lines):** new `<div class="modal-overlay" id="menuOverlay">` block with `.menu-modal` sheet and four row buttons.
- **CSS (~40 lines):** `.menu-modal`, `.menu-row`, `.menu-row.danger`, reuse existing `slideUp` keyframes and `.modal-overlay` base. No new animation primitives.
- **Header swap:** remove `btnHistory`, `btnImport`, `btnExport`, and the inline `btnSignOut` span at [index.html:909](index.html#L909). Add a single `<button class="header-btn" id="btnMenu" type="button">☰</button>` in `.header-actions`.
- **JS (~30 lines):** `openMenu` / `closeMenu` function pair; overlay-click close handler; row click handlers that call `closeMenu()` then invoke the existing target function. Remove the obsolete inline sign-out button's click handler (moving it to the menu row).

No behavior changes to Import, Export, History, or sign-out logic. `handleImport`, `openExportModal`, `openHistory`, `sb.auth.signOut()` are invoked unchanged.

## Out of scope

- Settings content (deferred until it exists).
- Gym Profiles row (Feature 3).
- Keyboard navigation, focus trapping, ARIA roles beyond existing modal patterns.
- Animating the menu's own button states beyond existing tap-highlight patterns.
- Touching any modal other than the ones currently triggered from the header.

## Risks & mitigations

- **Risk:** removing the inline `.signout-btn` leaves an orphan CSS class. Mitigation: delete the `.signout-btn` rule block as part of this commit.
- **Risk:** close→open animation chain feels laggy on slow devices. Mitigation: the existing modals all use `slideUp 0.3s`, so close→open ≈ 0.6s worst case — acceptable for mobile. If it feels bad in testing, fall back to immediate-open (skip the menu close animation) without rework.
- **Risk:** `btnExport` currently has `.primary` styling (green CTA); removing it downgrades Export's visual weight. Judgment call: Export becomes a secondary action in the menu like the others. The user explicitly listed it in the menu; accept the visual flattening.

## Verification

After implementation:

- Tap `☰` → menu sheet slides up.
- Each row triggers its target modal/action identically to the current behavior.
- Tap outside → menu closes.
- Sign Out → signs out exactly as before.
- Header visually cleaner: plan title + week + version on the left, single `☰` on the right.
- No references to `btnHistory` / `btnImport` / `btnExport` / `.signout-btn` / `btnSignOut` remain *outside* the new menu wiring.
- `APP_VERSION` bumped to `v2.0.11`.
