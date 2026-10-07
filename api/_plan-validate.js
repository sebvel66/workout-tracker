// api/_plan-validate.js — strict plan-blob validation + set-repeat expansion
// for the coach write tools (v3.8.0).
//
// Stricter than generate-plan.js's validatePlan: in addition to the
// structural checks (title, non-empty days/exercises/sets, superset blocks
// with >=2 members + integer block rest + no member rest + no nesting) it
// also enforces, using the client's exercise library:
//   - every exercise name resolves to a library row (exact, or trim/lowercase
//     tolerant) — rejects typos / non-library names the coach must fix;
//   - integer `rest` on regular exercises when present;
//   - timed exercises (movement_pattern isometric OR muscle_group cardio) carry
//     an integer `duration_seconds` on every set;
//   - weight is numeric when present, and 0/absent for weight_mode 'none'.
//
// Pure module: no network, no env. The caller fetches the library and passes
// a `lib` with resolve(name) -> row|null. Testable in isolation.

// Build a `lib` resolver from an array of exercise rows
// ({ name, muscle_group, movement_pattern, weight_mode, ... }).
export function makeLib(exerciseRows) {
  const byExact = new Map();
  const byNorm = new Map();
  for (const r of exerciseRows || []) {
    if (!r || !r.name) continue;
    byExact.set(r.name, r);
    const n = String(r.name).trim().toLowerCase();
    if (!byNorm.has(n)) byNorm.set(n, r);
  }
  return {
    resolve(name) {
      if (name == null) return null;
      if (byExact.has(name)) return byExact.get(name);
      const n = String(name).trim().toLowerCase();
      return byNorm.get(n) || null;
    },
  };
}

function isTimedRow(row) {
  return !!row && (row.movement_pattern === 'isometric' || row.muscle_group === 'cardio');
}

function validateRegularExercise(e, dayIdx, exIdx, lib, inSuperset) {
  const label = `day ${dayIdx + 1} exercise ${exIdx + 1}`;
  if (!e || typeof e !== 'object') return `${label}: not an object`;
  if (!e.name || typeof e.name !== 'string') return `${label}: missing name`;
  const row = lib.resolve(e.name);
  if (!row) return `${label} "${e.name}": not in the exercise library — use an exact library name`;
  if (!inSuperset && e.rest != null && !Number.isInteger(e.rest)) {
    return `${label} "${e.name}": rest must be an integer number of seconds`;
  }
  if (!Array.isArray(e.sets) || !e.sets.length) return `${label} "${e.name}": missing or empty sets`;
  const timed = isTimedRow(row);
  const mode = row.weight_mode || 'total';
  for (let si = 0; si < e.sets.length; si++) {
    const s = e.sets[si] || {};
    const setLabel = `${label} "${e.name}" set ${si + 1}`;
    // Weight rules apply regardless of timed-ness: a weighted dead hang has a
    // numeric added load; a weight_mode 'none' movement never carries load.
    if (s.weight != null && typeof s.weight !== 'number') {
      return `${setLabel}: weight must be a number (not a string)`;
    }
    if (mode === 'none' && typeof s.weight === 'number' && s.weight !== 0) {
      return `${setLabel}: "${e.name}" is a no-load exercise (weight_mode none) — weight must be 0 or omitted`;
    }
    if (timed) {
      if (!Number.isInteger(s.duration_seconds)) {
        return `${setLabel}: timed exercise (${row.muscle_group === 'cardio' ? 'cardio' : 'isometric'}) needs an integer duration_seconds`;
      }
    } else {
      const hasReps = Number.isFinite(s.reps_target)
        || (typeof s.reps_range === 'string' && s.reps_range.trim());
      if (!hasReps) return `${setLabel}: needs reps_target or reps_range`;
    }
  }
  return null;
}

function validateSupersetBlock(block, dayIdx, exIdx, lib) {
  const label = `day ${dayIdx + 1} block ${exIdx + 1}`;
  if (!Array.isArray(block.exercises) || block.exercises.length < 2) {
    return `${label}: superset block must have at least 2 exercises`;
  }
  if (!Number.isInteger(block.rest)) {
    return `${label}: superset block rest must be an integer number of seconds`;
  }
  for (let ci = 0; ci < block.exercises.length; ci++) {
    const child = block.exercises[ci];
    if (!child) return `${label} member ${ci + 1}: missing entry`;
    if (child.rest != null) {
      return `${label} member ${ci + 1}: superset members may not carry their own rest — use block-level rest`;
    }
    if (child.superset === true) {
      return `${label} member ${ci + 1}: nested supersets are not supported`;
    }
    const childErr = validateRegularExercise(child, dayIdx, exIdx, lib, true);
    if (childErr) return childErr;
  }
  return null;
}

// Returns an error string the model can read + fix, or null when valid.
export function validatePlanStrict(plan, lib) {
  if (!plan || typeof plan !== 'object') return 'plan is not an object';
  if (!plan.title || typeof plan.title !== 'string') return 'missing title';
  if (!Array.isArray(plan.days) || !plan.days.length) return 'missing or empty days';
  for (let i = 0; i < plan.days.length; i++) {
    const d = plan.days[i];
    if (!d || typeof d !== 'object') return `day ${i + 1}: not an object`;
    if (!d.name) return `day ${i + 1}: missing name`;
    if (!Array.isArray(d.exercises) || !d.exercises.length) return `day ${i + 1}: missing or empty exercises`;
    for (let j = 0; j < d.exercises.length; j++) {
      const e = d.exercises[j];
      if (e && e.superset === true) {
        const blockErr = validateSupersetBlock(e, i, j, lib);
        if (blockErr) return blockErr;
      } else {
        const exErr = validateRegularExercise(e, i, j, lib, false);
        if (exErr) return exErr;
      }
    }
  }
  return null;
}

// Expand `"repeat": N` shorthand into N identical set objects (repeat stripped),
// clamped to [1, 10], recursing into superset members. Mutates + returns the
// blob. Mirrors expandSetRepeatsInPlan in js/data.js so the DB row is the
// canonical expanded shape regardless of source. Idempotent on expanded blobs.
export function expandSetRepeatsInPlan(planBlob) {
  if (!planBlob || !Array.isArray(planBlob.days)) return planBlob;
  function expandOne(ex) {
    if (!ex || !Array.isArray(ex.sets)) return;
    const out = [];
    for (let i = 0; i < ex.sets.length; i++) {
      const s = ex.sets[i] || {};
      const raw = typeof s.repeat === 'number' ? s.repeat : parseInt(s.repeat, 10);
      const n = Math.min(10, Math.max(1, Number.isFinite(raw) ? raw : 1));
      const clean = Object.assign({}, s);
      delete clean.repeat;
      for (let k = 0; k < n; k++) out.push(Object.assign({}, clean));
    }
    ex.sets = out;
  }
  for (let di = 0; di < planBlob.days.length; di++) {
    const day = planBlob.days[di];
    if (!day || !Array.isArray(day.exercises)) continue;
    for (let ei = 0; ei < day.exercises.length; ei++) {
      const entry = day.exercises[ei];
      if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
        for (let mi = 0; mi < entry.exercises.length; mi++) expandOne(entry.exercises[mi]);
      } else {
        expandOne(entry);
      }
    }
  }
  return planBlob;
}
