// js/models.js — Browser-globals copy of the model allowlist + helper.
// MIRRORS api/_models.js byte-for-byte in the data sections; only the
// wrapper differs (var globals here vs ESM exports there). Kept in two
// physical files because the project has no build step; the operational
// checklist for new model releases is "edit both files + redeploy."

var AVAILABLE_MODELS = [
  { id: 'claude-opus-4-7',           label: 'Opus 4.7',   tier: 'most capable', supportsTemperature: false },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', tier: 'balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  tier: 'fast' },
];

var DEFAULT_MODELS = {
  coach:   'claude-haiku-4-5-20251001',
  plan:    'claude-sonnet-4-6',
  analyze: 'claude-sonnet-4-6',
};

function resolveModel(requestedId, bucket) {
  if (requestedId && AVAILABLE_MODELS.some(function(m) { return m.id === requestedId; })) {
    return requestedId;
  }
  return DEFAULT_MODELS[bucket];
}

// modelSupportsTemperature: gate the optional `temperature` field per model
// (v3.2.1). Anthropic deprecated `temperature` on Opus 4.7 — the API
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
