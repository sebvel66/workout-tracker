// js/models.js — Browser-globals copy of the model allowlist + helper.
// MIRRORS api/_models.js byte-for-byte in the data sections; only the
// wrapper differs (var globals here vs ESM exports there). Kept in two
// physical files because the project has no build step; the operational
// checklist for new model releases is "edit both files + redeploy."

// The 5.5 generation runs ADAPTIVE THINKING (on by default) and REJECTS
// temperature/top_p/top_k — so every 5-gen row carries supportsTemperature:false
// (the modelSupportsTemperature gate then omits the temperature field). Older
// rows kept for selection; Sonnet 4.6 / Haiku 4.5 still accept temperature.
var AVAILABLE_MODELS = [
  { id: 'claude-fable-5-1',          label: 'Fable 5.1',  tier: 'frontier',     supportsTemperature: false },
  { id: 'claude-opus-5-5',           label: 'Opus 5.5',   tier: 'most capable', supportsTemperature: false },
  { id: 'claude-sonnet-5-5',         label: 'Sonnet 5.5', tier: 'balanced',     supportsTemperature: false },
  { id: 'claude-haiku-5-5',          label: 'Haiku 5.5',  tier: 'fast',         supportsTemperature: false },
  { id: 'claude-opus-4-8',           label: 'Opus 4.8',   tier: 'legacy',       supportsTemperature: false },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', tier: 'legacy' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  tier: 'legacy' },
];

var DEFAULT_MODELS = {
  coach:   'claude-haiku-5-5',
  plan:    'claude-opus-5-5',
  analyze: 'claude-opus-5-5',
};

// MODEL_ALIASES: retired model ids that should silently upgrade to a current
// model instead of falling back to the bucket default. When you remove a row
// from AVAILABLE_MODELS, add an entry here pointing the old id at its successor
// so users with the old id saved in their coaching_profile land on the new
// model rather than the generic default. Resolved before the allowlist check.
var MODEL_ALIASES = {
  'claude-opus-4-7': 'claude-opus-4-8',
};

function resolveModel(requestedId, bucket) {
  var id = (requestedId && MODEL_ALIASES[requestedId]) || requestedId;
  if (id && AVAILABLE_MODELS.some(function(m) { return m.id === id; })) {
    return id;
  }
  return DEFAULT_MODELS[bucket];
}

// modelSupportsTemperature: gate the optional `temperature` field per model
// (v3.2.1). Anthropic deprecated `temperature` on Opus 4.7/4.8 — the API
// returns 400 invalid_request_error if it's included. Same is true for
// `top_p`, `top_k`, and `thinking: { type: 'enabled', budget_tokens }` on
// the same models; if a future code path adds any of those, gate them on
// the same flag (or add per-parameter flags). Default = supports.
function modelSupportsTemperature(modelId) {
  var entry = null;
  for (var i = 0; i < AVAILABLE_MODELS.length; i++) {
    if (AVAILABLE_MODELS[i].id === modelId) { entry = AVAILABLE_MODELS[i]; break; }
  }
  return entry ? entry.supportsTemperature !== false : true;
}
