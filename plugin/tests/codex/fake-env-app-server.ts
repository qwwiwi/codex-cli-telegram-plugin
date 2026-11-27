// A minimal App Server for the staged Codex probe test: model/list answers with the names of every
// environment variable the process received, so the test can see which credentials leaked into it.
import { createInterface } from 'node:readline'

const emit = (message: object) => process.stdout.write(JSON.stringify(message) + '\n')

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line)
  if (method === 'initialize') emit({ id, result: {} })
  else if (method === 'model/list') emit({ id, result: { data: Object.keys(process.env).map(model => ({ model })) } })
}
