/**
 * Loads the repo-root `.env`, whatever directory the script was started from.
 *
 * `dotenv/config` resolves `.env` against the current working directory. Run a
 * script through `pnpm --filter <pkg> run <script>` and the cwd becomes that
 * package, the root `.env` is never found, and every variable arrives as
 * `undefined` — with an error message that says "Cannot read properties of
 * undefined" and nothing about configuration. That cost real time in SPIKE A.
 *
 * Naming the path explicitly removes the whole class of problem.
 */
import { config } from 'dotenv';
import { join } from 'node:path';

export const ROOT_ENV_PATH = join(import.meta.dirname, '..', '.env');

config({ path: ROOT_ENV_PATH, quiet: true });
