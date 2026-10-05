#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { run } from './cli/run.ts';

// The tenant's credentials, as `--env-file=.env` gave the pnpm scripts this
// replaces. A variable already set in the environment wins (specs/033).
if (existsSync('.env')) process.loadEnvFile('.env');

run(process.argv).then(
  code => {
    if (code !== undefined) process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
