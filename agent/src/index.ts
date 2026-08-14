#!/usr/bin/env node
import { parseArgs, execute } from './cli.js';

try {
  const command = parseArgs(process.argv);
  const exitCode = await execute(command);
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
