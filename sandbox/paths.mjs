import fs from 'node:fs';
import path from 'node:path';

export class JailError extends Error {
  constructor(message = 'Path escapes workspace jail') {
    super(message);
    this.name = 'JailError';
    this.code = 'JAIL';
  }
}

/**
 * @param {string} rootReal absolute realpath of workspace root
 * @param {string} candidate absolute path (may include non-existing tail)
 */
function assertInsideRoot(rootReal, candidate) {
  if (candidate === rootReal) return;
  if (candidate.startsWith(rootReal + path.sep)) return;
  throw new JailError('Path escapes workspace jail');
}

/**
 * Resolve workspace root to a real absolute path. Workspace must exist.
 * @param {string} workspace
 * @returns {string}
 */
export function resolveWorkspaceRoot(workspace) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new JailError('Workspace root is required');
  }
  const resolved = path.resolve(workspace);
  let rootReal;
  try {
    rootReal = fs.realpathSync(resolved);
  } catch {
    throw new JailError('Workspace root does not exist');
  }
  const st = fs.statSync(rootReal);
  if (!st.isDirectory()) {
    throw new JailError('Workspace root is not a directory');
  }
  return rootReal;
}

/**
 * Resolve `userPath` under `workspace`. Rejects lexical escapes **and**
 * symlink targets that leave the real workspace root.
 * Empty / missing userPath → workspace root.
 * @param {string} workspace
 * @param {string | null | undefined} [userPath]
 * @returns {string} absolute path suitable for open/stat (real for existing
 *   components; non-existing leaf kept under the real parent)
 */
export function resolveJailPath(workspace, userPath) {
  const rootReal = resolveWorkspaceRoot(workspace);

  let rel = userPath == null || userPath === '' ? '.' : String(userPath);
  if (rel.includes('\0')) {
    throw new JailError('Path contains null byte');
  }

  rel = rel.replace(/\\/g, '/');

  // Lexical resolve against the real root (absolute user paths still resolve
  // via path.resolve and are then checked).
  const lexical = path.resolve(rootReal, rel);
  assertInsideRoot(rootReal, lexical);

  // Walk up until an existing filesystem node is found, then realpath it so
  // symlinks cannot point outside the jail.
  /** @type {string[]} */
  const missing = [];
  let cursor = lexical;
  for (;;) {
    try {
      fs.lstatSync(cursor);
      break;
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? /** @type {{ code?: string }} */ (err).code
          : undefined;
      if (code !== 'ENOENT') {
        throw new JailError('Path is not accessible');
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new JailError('Path escapes workspace jail');
      }
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }

  let realExisting;
  try {
    realExisting = fs.realpathSync(cursor);
  } catch {
    throw new JailError('Path is not accessible');
  }
  assertInsideRoot(rootReal, realExisting);

  const finalPath =
    missing.length === 0 ? realExisting : path.join(realExisting, ...missing);
  assertInsideRoot(rootReal, finalPath);
  return finalPath;
}

/**
 * @param {string} workspace
 * @param {string} absolutePath
 */
export function isInsideJail(workspace, absolutePath) {
  try {
    const rootReal = resolveWorkspaceRoot(workspace);
    const absResolved = path.resolve(absolutePath);
    try {
      const absReal = fs.realpathSync(absResolved);
      return absReal === rootReal || absReal.startsWith(rootReal + path.sep);
    } catch {
      return (
        absResolved === rootReal || absResolved.startsWith(rootReal + path.sep)
      );
    }
  } catch {
    return false;
  }
}
