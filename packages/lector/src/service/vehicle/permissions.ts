/**
 * Lector's permission taxonomy. repo.fetch/evictCache write to and delete from disk, so they need
 * a real scope distinct from a pure read -- the first caller to actually need that distinction.
 * dispatch() still has no per-call principal/auth model, so both scopes are granted identically
 * today; the split exists so a real auth model can later grant them differently.
 */
export const WORKSPACE_READ_PERMISSION = "workspace:read";
export const WORKSPACE_WRITE_PERMISSION = "workspace:write";
