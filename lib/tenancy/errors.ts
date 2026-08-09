/** Parent #54 locked 401 body for APIs when tenancy is on and session missing. */
export const AUTH_REQUIRED_ERROR = 'Authentication required.';

/**
 * Parent #54 locked 403 for grant / resolve failures (phase 3 usage).
 * Defined early so host constants stay stable.
 */
export const SANDBOX_FORBIDDEN_ERROR = 'Sandbox access denied.';
export const SANDBOX_SELECTION_REQUIRED_ERROR =
  'Multiple sandboxes available — choose one under Settings → Sandbox.';

/** Parent #102 / phase #103 — no grant, disabled secret, or empty catalog. */
export const INFERENCE_FORBIDDEN_ERROR = 'Inference access denied.';

/** Parent #102 — invalid / missing model id for tenancy-on inference. */
export const INFERENCE_MODEL_REQUIRED_ERROR = 'A valid model is required.';

/** Parent #102 — decrypt / DB failure fail-soft (no crypto details). */
export const INFERENCE_UNAVAILABLE_ERROR = 'Inference temporarily unavailable.';

/** Parent #298 / phase #301 — Workspace instance missing, stopped, or error. */
export const WORKSPACE_INSTANCE_REQUIRED_ERROR =
  'Workspace instance is not running. Create or Start it under Settings → Sandbox.';

/** Parent #298 / phase #302 — tenancy-off hop-B without host attach name. */
export const BUILTIN_HTTP_INSTANCE_REQUIRED_ERROR =
  'Builtin HTTP is enabled but no instance name is configured. Set BUILTIN_HTTP_INSTANCE_NAME or disable BUILTIN_HTTP_FETCH.';
