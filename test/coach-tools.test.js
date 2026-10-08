// test/coach-tools.test.js — plain-node tests (no framework) for the coach
// write/validate layer. Run: `npm test` (or `node test/coach-tools.test.js`).
//
// Exercises the strict plan validator + the tool handlers against a MOCKED
// Supabase fetch — no live DB, no network. Asserts the guarantees the feature
// depends on: unknown-name/superset-rest rejection, repeat expansion, the
// confirm gate on every write tool, delete refusing referenced plans, and the
// happy-path writes (PATCH/POST + repeat expansion + action records).

import assert from 'node:assert';
import { validatePlanStrict, makeLib, expandSetRepeatsInPlan } from '../api/_plan-validate.js';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://mock.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-key';

// Import AFTER env is set (the module reads process.env at call time anyway).
const { executeCoachTool, COACH_TOOLS, WRITE_TOOLS } = await import('../api/_coach-tools.js');

// ---- tiny harness ----
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    failed++;
    console.log('  ✗', name);
    console.log('      ' + (err && err.message));
  }
}
function section(title) { console.log('\n' + title); }

// ---- shared fixtures ----
const LIB_ROWS = [
  { name: 'Dumbbell Bench Press', muscle_group: 'chest', movement_pattern: 'horizontal press', weight_mode: 'per_side', secondary_muscles: ['triceps', 'shoulders'] },
  { name: 'Lateral Raise', muscle_group: 'shoulders', movement_pattern: 'isolation', weight_mode: 'per_side', secondary_muscles: [] },
  { name: 'Face Pull', muscle_group: 'shoulders', movement_pattern: 'isolation', weight_mode: 'total', secondary_muscles: ['traps'] },
  { name: 'Plank', muscle_group: 'core', movement_pattern: 'isometric', weight_mode: 'none', secondary_muscles: [] },
];
const LIB = makeLib(LIB_ROWS);

const GOOD_PLAN = {
  title: 'Upper', days: [{
    name: 'Day 1', exercises: [
      { name: 'Dumbbell Bench Press', rest: 120, sets: [{ weight: 70, reps_target: 10, reps_range: '8-10', repeat: 3 }] },
      { superset: true, rest: 60, exercises: [
        { name: 'Lateral Raise', sets: [{ weight: 20, reps_target: 12 }] },
        { name: 'Face Pull', sets: [{ weight: 40, reps_target: 15 }] },
      ] },
      { name: 'Plank', rest: 60, sets: [{ duration_seconds: 45, repeat: 3 }] },
    ],
  }],
};
const clone = (o) => JSON.parse(JSON.stringify(o));

// Mocked PostgREST. Returns a fetch fn + a `writes` log. `state` seeds reads.
// Routing uses tokens specific enough not to collide (e.g. "&id=eq." vs the
// "user_id=eq." that every URL carries).
function mockSupabase(state) {
  state = state || {};
  const writes = [];
  const today = new Date().toISOString().slice(0, 10);
  const fetchFn = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (method !== 'GET') {
      writes.push({ method, url: u, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'NEW_ID' }]) };
    }
    let data = [];
    if (u.includes('/exercises?')) data = LIB_ROWS;
    else if (u.includes('/plans?') && u.includes('is_active=eq.true')) data = state.activePlan || [];
    else if (u.includes('/plans?') && u.includes('&id=eq.')) data = state.planById || [];
    else if (u.includes('/plans?')) data = state.planList || [];
    else if (u.includes('/workouts?') && u.includes('select=plan_id')) data = state.workoutsByPlan || [];
    else if (u.includes('/workouts?') && u.includes('plan_id=eq.')) data = state.planRefs || [];
    else if (u.includes('/workouts?')) data = state.workouts || [];
    else if (u.includes('/coaching_profile?')) data = state.profile || [];
    else data = [];
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  return { fetchFn, writes, today };
}
function withFetch(mock, fn) {
  globalThis.fetch = mock.fetchFn;
  return fn();
}

// ============================= tests =============================
section('validatePlanStrict');
await test('rejects an unknown exercise name', () => {
  const p = { title: 'P', days: [{ name: 'D', exercises: [{ name: 'Bogus Machine', sets: [{ weight: 50, reps_target: 10 }] }] }] };
  assert.match(validatePlanStrict(p, LIB) || '', /not in the exercise library/);
});
await test('rejects a superset member carrying its own rest', () => {
  const p = { title: 'P', days: [{ name: 'D', exercises: [{ superset: true, rest: 60, exercises: [
    { name: 'Dumbbell Bench Press', sets: [{ weight: 70, reps_target: 10 }] },
    { name: 'Face Pull', rest: 30, sets: [{ weight: 40, reps_target: 12 }] },
  ] }] }] };
  assert.match(validatePlanStrict(p, LIB) || '', /may not carry their own rest/);
});
await test('rejects a timed exercise set without duration_seconds', () => {
  const p = { title: 'P', days: [{ name: 'D', exercises: [{ name: 'Plank', sets: [{ reps_target: 10 }] }] }] };
  assert.match(validatePlanStrict(p, LIB) || '', /duration_seconds/);
});
await test('rejects nonzero weight on a weight_mode=none exercise', () => {
  const p = { title: 'P', days: [{ name: 'D', exercises: [{ name: 'Plank', sets: [{ duration_seconds: 45, weight: 25 }] }] }] };
  assert.match(validatePlanStrict(p, LIB) || '', /no-load/);
});
await test('rejects a non-integer rest on a regular exercise', () => {
  const p = { title: 'P', days: [{ name: 'D', exercises: [{ name: 'Lateral Raise', rest: '90s', sets: [{ weight: 20, reps_target: 12 }] }] }] };
  assert.match(validatePlanStrict(p, LIB) || '', /rest must be an integer/);
});
await test('accepts a valid plan', () => {
  assert.strictEqual(validatePlanStrict(clone(GOOD_PLAN), LIB), null);
});

section('expandSetRepeatsInPlan');
await test('expands repeat:3 into 3 sets and strips repeat', () => {
  const p = clone(GOOD_PLAN);
  expandSetRepeatsInPlan(p);
  assert.strictEqual(p.days[0].exercises[0].sets.length, 3);
  assert.ok(!('repeat' in p.days[0].exercises[0].sets[0]));
});
await test('expands timed repeat and leaves superset members intact', () => {
  const p = clone(GOOD_PLAN);
  expandSetRepeatsInPlan(p);
  assert.strictEqual(p.days[0].exercises[2].sets.length, 3);        // Plank repeat:3
  assert.strictEqual(p.days[0].exercises[1].exercises[0].sets.length, 1); // Lateral Raise, no repeat
});

section('confirm gate');
for (const name of [...WRITE_TOOLS]) {
  await test(`${name} is refused without confirm`, async () => {
    await withFetch(mockSupabase({}), async () => {
      const r = await executeCoachTool(name, {}, { userId: 'u1', actions: [], confirm: false });
      assert.strictEqual(r.ok, false);
      assert.match(r.content, /REFUSED/);
    });
  });
}
await test('COACH_TOOLS exposes all 4 read + 7 write tools', () => {
  assert.strictEqual(COACH_TOOLS.length, 11);
});

section('read tools');
await test('get_active_plan returns {id,title,week,start_date,data}', async () => {
  const m = mockSupabase({ activePlan: [{ id: 'act1', title: 'Upper/Lower', week: 'W5', data: { start_date: '2026-10-05', days: [] } }] });
  await withFetch(m, async () => {
    const r = await executeCoachTool('get_active_plan', {}, { userId: 'u1', actions: [] });
    const v = JSON.parse(r.content);
    assert.strictEqual(v.id, 'act1');
    assert.strictEqual(v.start_date, '2026-10-05');
  });
});
await test('list_plans tallies workout_count per plan', async () => {
  const m = mockSupabase({
    planList: [{ id: 'act1', title: 'A', is_active: true, is_template: false }, { id: 'p2', title: 'B', is_active: false, is_template: true }],
    workoutsByPlan: [{ plan_id: 'act1' }, { plan_id: 'act1' }, { plan_id: 'p2' }, { plan_id: null }],
  });
  await withFetch(m, async () => {
    const r = await executeCoachTool('list_plans', {}, { userId: 'u1', actions: [] });
    const v = JSON.parse(r.content);
    assert.strictEqual(v.find((p) => p.id === 'act1').workout_count, 2);
    assert.strictEqual(v.find((p) => p.id === 'p2').workout_count, 1);
  });
});
await test('get_plan with no id errors cleanly', async () => {
  await withFetch(mockSupabase({}), async () => {
    const r = await executeCoachTool('get_plan', {}, { userId: 'u1', actions: [] });
    assert.strictEqual(r.ok, false);
    assert.match(r.content, /plan_id is required/);
  });
});

section('update_plan');
await test('writes PATCH + expands repeat + records action (on confirm)', async () => {
  const m = mockSupabase({ planById: [{ id: 'p1', is_template: false, is_active: true }] });
  await withFetch(m, async () => {
    const actions = [];
    const r = await executeCoachTool('update_plan', { plan_id: 'p1', plan: clone(GOOD_PLAN), summary: 'bumped bench' }, { userId: 'u1', actions, confirm: true });
    assert.strictEqual(r.ok, true);
    const patch = m.writes.find((w) => w.method === 'PATCH' && w.url.includes('id=eq.p1'));
    assert.ok(patch, 'expected a PATCH to the plan row');
    assert.strictEqual(patch.body.data.days[0].exercises[0].sets.length, 3); // repeat expanded before write
    assert.strictEqual(actions[0].type, 'update_plan');
    assert.strictEqual(actions[0].summary, 'bumped bench');
  });
});
await test('rejects an unknown name even with confirm, and writes nothing', async () => {
  const m = mockSupabase({ planById: [{ id: 'p1', is_template: false, is_active: true }] });
  await withFetch(m, async () => {
    const bad = { title: 'X', days: [{ name: 'D', exercises: [{ name: 'Nope', sets: [{ reps_target: 5 }] }] }] };
    const r = await executeCoachTool('update_plan', { plan_id: 'p1', plan: bad }, { userId: 'u1', actions: [], confirm: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.content, /not in the exercise library/);
    assert.strictEqual(m.writes.length, 0);
  });
});
await test('strips start_date/week when the target is a template', async () => {
  const m = mockSupabase({ planById: [{ id: 't1', is_template: true, is_active: false }] });
  await withFetch(m, async () => {
    const blob = clone(GOOD_PLAN); blob.start_date = '2026-10-05'; blob.week = 'W5';
    const r = await executeCoachTool('update_plan', { plan_id: 't1', plan: blob }, { userId: 'u1', actions: [], confirm: true });
    assert.strictEqual(r.ok, true);
    const patch = m.writes.find((w) => w.method === 'PATCH');
    assert.ok(!('start_date' in patch.body.data), 'start_date should be stripped for a template');
    assert.ok(!('week' in patch.body.data), 'week should be stripped for a template');
  });
});

section('delete_plan');
await test('refuses a referenced plan without force (no write)', async () => {
  const m = mockSupabase({ planById: [{ id: 'p1', title: 'Old', is_template: false, is_active: false }], planRefs: [{ id: 'w1' }, { id: 'w2' }] });
  await withFetch(m, async () => {
    const r = await executeCoachTool('delete_plan', { plan_id: 'p1' }, { userId: 'u1', actions: [], confirm: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.content, /2 logged workouts/);
    assert.strictEqual(m.writes.length, 0);
  });
});
await test('deletes a referenced plan WITH force (log preserved by FK)', async () => {
  const m = mockSupabase({ planById: [{ id: 'p1', title: 'Old', is_template: false, is_active: false }], planRefs: [{ id: 'w1' }] });
  await withFetch(m, async () => {
    const r = await executeCoachTool('delete_plan', { plan_id: 'p1', force: true }, { userId: 'u1', actions: [], confirm: true });
    assert.strictEqual(r.ok, true);
    assert.ok(m.writes.some((w) => w.method === 'DELETE'));
  });
});
await test('deletes an unreferenced template directly', async () => {
  const m = mockSupabase({ planById: [{ id: 't1', title: 'Tmpl', is_template: true, is_active: false }], planRefs: [] });
  await withFetch(m, async () => {
    const actions = [];
    const r = await executeCoachTool('delete_plan', { plan_id: 't1' }, { userId: 'u1', actions, confirm: true });
    assert.strictEqual(r.ok, true);
    assert.ok(m.writes.some((w) => w.method === 'DELETE'));
    assert.strictEqual(actions[0].type, 'delete_plan');
  });
});

section('set_active_plan');
await test('flips previous active (PATCH) + inserts new (POST) + stamps start_date/week', async () => {
  const m = mockSupabase({});
  await withFetch(m, async () => {
    const r = await executeCoachTool('set_active_plan', { plan: clone(GOOD_PLAN), start_date: '2026-10-11' }, { userId: 'u1', actions: [], confirm: true });
    assert.strictEqual(r.ok, true);
    assert.ok(m.writes.some((w) => w.method === 'PATCH'));
    const post = m.writes.find((w) => w.method === 'POST');
    assert.ok(post, 'expected an insert');
    assert.strictEqual(post.body.data.start_date, '2026-10-11');
    assert.match(post.body.week, /–/); // en-dash week label
  });
});

section('update_coaching_profile');
await test('shallow-merges the patch over existing data', async () => {
  const m = mockSupabase({ profile: [{ data: { phase: 'accumulation', weight_lbs: 170 } }] });
  await withFetch(m, async () => {
    const r = await executeCoachTool('update_coaching_profile', { patch: { phase: 'cut', coaching_rules: 'be meaner' } }, { userId: 'u1', actions: [], confirm: true });
    assert.strictEqual(r.ok, true);
    const up = m.writes.find((w) => w.method === 'POST');
    assert.strictEqual(up.body.data.phase, 'cut');
    assert.strictEqual(up.body.data.weight_lbs, 170);        // preserved
    assert.strictEqual(up.body.data.coaching_rules, 'be meaner');
  });
});
await test('rejects a disallowed profile field', async () => {
  await withFetch(mockSupabase({}), async () => {
    const r = await executeCoachTool('update_coaching_profile', { patch: { bogus: 1 } }, { userId: 'u1', actions: [], confirm: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.content, /bogus/);
  });
});

// ============================= summary =============================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
