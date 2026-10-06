/**
 * `pnpm insights:<command>` (specs/031). A tenant project runs the same
 * commands as `agent insights <command>`.
 */
import { runInsights } from './learning/commands.ts';

runInsights(process.argv.slice(2)).then(
  code => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
