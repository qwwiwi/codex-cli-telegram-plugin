#!/usr/bin/env bun
// Entry point of the `brain` command; all logic lives in src/cli/main.ts.

import { runCli } from '../src/cli/main.js'

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: text => { process.stdout.write(text) },
  stderr: text => { process.stderr.write(text) },
})
process.exit(code)
