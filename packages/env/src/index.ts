/**
 * Loads the repo-root `.env`, whatever directory the caller was started from.
 *
 * `dotenv/config` resolves `.env` against the current working directory. Run
 * something through `pnpm --filter <pkg> run <script>` and the cwd becomes
 * that package: the root `.env` is never found, every variable arrives as
 * `undefined`, and the error you get is "Cannot read properties of undefined"
 * with nothing in it about configuration. That cost real time in SPIKE A and
 * again in STEP 12.
 *
 * It lives in its own package because scripts, the API and the agent runner
 * all need it, and none of them can import from the others. Naming the path
 * explicitly removes the whole class of problem, once.
 */
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Walks up from this file until it finds the workspace root.
 *
 * Anchored on `pnpm-workspace.yaml` rather than a fixed number of `..`
 * segments, so moving this package does not silently break it.
 */
export function findRepoRoot(startDir = import.meta.dirname): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not find the workspace root (no pnpm-workspace.yaml above ${startDir}).`,
  );
}

export const ROOT_ENV_PATH = join(findRepoRoot(), '.env');

/** Idempotent: dotenv never overwrites a variable that is already set. */
export function loadRootEnv(): string {
  config({ path: ROOT_ENV_PATH, quiet: true });
  return ROOT_ENV_PATH;
}

loadRootEnv();
