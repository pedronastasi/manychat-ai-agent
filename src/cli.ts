#!/usr/bin/env node
import { run } from './cli/run.ts';

run(process.argv).then(
  code => {
    if (code !== undefined) process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
