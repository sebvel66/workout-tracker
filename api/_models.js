// api/_models.js — Allowlist of AI models the user may select per bucket
// (Coach / Plan flows / Analyze). Server-side ESM copy; the browser
// globals copy lives at js/models.js and MUST be kept in sync byte-for-
// byte in the data sections (only the module wrapper differs).
//
// When Anthropic ships a new model: add a row to AVAILABLE_MODELS in
// BOTH files, then redeploy. Optionally retire an older entry by
// deleting its row — users with that model selected fall back to the
// bucket default automatically (resolveModel below).

export const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-8',           label: 'Opus 4.8',   tier: 'most capable', supportsTemperature: false },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', tier: 'balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  tier: 'fast' },
];

export const DEFAULT_MODELS = {
  coach:   'claude-haiku-4-5-20251001',
  plan:    'claude-sonnet-4-6',
  analyze: 'claude-sonnet-4-6',
};

// MODEL_ALIASES: retired model ids that should silently upgrade to a current
// model instead of falling back to the bucket default. When you remove a row
// from AVAILABLE_MODELS, add an entry here pointing the old id at its successor
// so users with the old id saved in their coaching_profile land on the new
// model rather than the generic default. Resolved before the allowlist check.
export const MODEL_ALIASES = {
  'claude-opus-4-7': 'claude-opus-4-8',
};

// resolveModel: upgrade requestedId through MODEL_ALIASES, then return it if
// it's in AVAILABLE_MODELS, else fall back to the bucket's default. Falsy /
// unknown input always falls back. Used both server-side (validation) and
// client-side (load-time resolution before the dropdown render).
export function resolveModel(requestedId, bucket) {
  const id = (requestedId && MODEL_ALIASES[requestedId]) || requestedId;
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
export function modelSupportsTemperature(modelId) {
  const entry = AVAILABLE_MODELS.find(function(m) { return m.id === modelId; });
  return entry ? entry.supportsTemperature !== false : true;
}
