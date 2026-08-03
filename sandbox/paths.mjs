import path from 'node:path';

export class JailError extends Error {
  constructor(message = 'Path escapes workspace jail') {
    super(message);
    this.name = 'JailError';
    this.code = 'JAIL';
  }
}

/**
 * Resolve `userPath` under `workspace`. Rejects escapes outside the root.
 * Empty / missing userPath → workspace root.
 * @param {string} workspace
 * @param {string | null | undefined} [userPath]
 * @returns {string}
 */
export function resolveJailPath(workspace, userPath) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new JailError('Workspace root is required');
  }
  const root = path.resolve(workspace);

  let rel = userPath == null || userPath === '' ? '.' : String(userPath);
  if (rel.includes('\0')) {
    throw new JailError('Path contains null byte');
  }

  rel = rel.replace(/\\/g, '/');

  const resolved = path.resolve(root, rel);
  if (resolved === root) return resolved;
  if (resolved.startsWith(root + path.sep)) return resolved;
  throw new JailError('Path escapes workspace jail');
}

/**
 * @param {string} workspace
 * @param {string} absolutePath
 */
export function isInsideJail(workspace, absolutePath) {
  const root = path.resolve(workspace);
  const abs = path.resolve(absolutePath);
  return abs === root || abs.startsWith(root + path.sep);
}
