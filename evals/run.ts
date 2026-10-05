import { runEval } from '../src/evals/runner.ts';

runEval().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
