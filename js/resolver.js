// resolver.js — exercise name resolution.
//
// Plan exercise names are display labels ("Pull-ups (BW, full ROM)", "DB Incline
// Bench Press (30°)") and rarely match seed library names exactly. resolveLibraryRow
// generates an ordered list of candidate keys via deterministic transformations
// (paren-strip, hyphen<->space, depluralize) plus an EXERCISE_ALIASES constant,
// and returns the first candidate that's in exerciseLibraryByName — or null.
// Never fabricates a match. See DECISIONS.md (2026-04-19) for the full reasoning.

function normName(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// Plan exercise names are display labels ("Pull-ups (BW, full ROM)",
// "DB Incline Bench Press (30°)") and rarely match seed library names
// exactly. Map raw-normalized plan names to canonical library names so
// plan-logged sets and ad-hoc/imported sets end up on the same
// exercise_id. Add entries here as new plan exercises surface.
var EXERCISE_ALIASES = {
  'barbell hip thrust':                      'hip thrust',
  'cable chest fly':                         'cable fly',
  'cable face pull':                         'face pull',
  'cable rope overhead triceps extension':   'overhead tricep extension (cable)',
  'cable tricep pushdown':                   'tricep pushdown',
  'cable woodchop':                          'woodchop',
  'db flat bench press':                     'dumbbell bench press',
  'db incline bench press':                  'incline dumbbell bench press',
  'db lateral raise':                        'lateral raise',
  'db romanian deadlift':                    'dumbbell romanian deadlift',
  'db shoulder press':                       'dumbbell overhead press',
  'dumbbell bulgarian split squat':          'bulgarian split squat',
  'dumbbell rear delt raise':                'rear delt fly',
  'incline db curl':                         'incline dumbbell curl',
  'lying hamstrings curl':                   'lying leg curl',
  'seated hamstrings curl':                  'seated leg curl',
  'single leg db calf raise':                'single leg calf raise',
  'weighted ab rollout':                     'ab wheel rollout',
};

// Resolve a plan/display exercise name to an existing library row (seed
// or user-custom), or null if no match. Generates an ordered list of
// candidate keys via deterministic transformations and returns the first
// one that's in exerciseLibraryByName. Never fabricates a match.
function resolveLibraryRow(name) {
  var seen = {}, candidates = [];
  function add(s) {
    if (!s) return;
    s = s.trim();
    if (s && !seen[s]) { seen[s] = true; candidates.push(s); }
  }
  function snapshot() { return candidates.slice(); }

  add(normName(name));
  // Strip trailing parenthetical: "foo (bar)" -> "foo".
  snapshot().forEach(function(c) { add(c.replace(/\s*\([^)]*\)\s*$/, '')); });
  // Hyphen -> space. (Library secondary-indexes the reverse, so both ways work.)
  snapshot().forEach(function(c) { if (c.indexOf('-') >= 0) add(c.replace(/-/g, ' ')); });
  // Depluralize: trim -es or -s.
  snapshot().forEach(function(c) {
    if (/es$/.test(c)) add(c.slice(0, -2));
    if (/s$/.test(c))  add(c.slice(0, -1));
  });
  // Alias map: applied to every candidate generated above.
  snapshot().forEach(function(c) { if (EXERCISE_ALIASES[c]) add(EXERCISE_ALIASES[c]); });

  for (var i = 0; i < candidates.length; i++) {
    if (exerciseLibraryByName[candidates[i]]) return exerciseLibraryByName[candidates[i]];
  }
  return null;
}
