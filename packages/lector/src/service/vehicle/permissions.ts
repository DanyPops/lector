/**
 * Lector's permission taxonomy: one real scope, named once so operation modules don't each
 * duplicate the string. Not split into finer scopes yet -- dispatch() has no per-call
 * principal/auth model, so every call is trusted equally and a finer scope would have no caller
 * to grant it differently.
 */
export const WORKSPACE_READ_PERMISSION = "workspace:read";
