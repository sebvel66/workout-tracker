// js/models.js — Browser-globals copy of the model allowlist + helper.
// MIRRORS api/_models.js byte-for-byte in the data sections; only the
// wrapper differs (var globals here vs ESM exports there). Kept in two
// physical files because the project has no build step; the operational
// checklist for new model releases is "edit both files + redeploy."

var AVAILABLE_MODELS = [
  { id: 'claude-opus-4-7',           label: 'Opus 4.7',   tier: 'most capable' },
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
