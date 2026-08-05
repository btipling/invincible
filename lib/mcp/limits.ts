/** Per-user MCP config limits (parent #116 / phase #117). */

export const MAX_MCP_SERVERS_PER_USER = 5;

export const MCP_NAME_MIN = 1;
export const MCP_NAME_MAX = 80;

/** slug: ^[a-z][a-z0-9_]{0,31}$ */
export const MCP_SLUG_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** auth header name: printable token, no CR/LF — ^[A-Za-z0-9-]+$ ≤64 */
export const MCP_HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
export const MCP_HEADER_NAME_MAX = 64;
