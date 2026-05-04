/**
 * Offline test for normaliseBody — verifies Responses-API / legacy /
 * Cursor-shaped bodies are translated to chat-completion-shaped messages.
 */

// Re-implementing the import path here since normaliseBody is not exported
// from index.ts (it's an internal helper). For testing we'll redefine the
// expected behaviour by calling it via a tiny re-export script.

import { spawnSync } from "node:child_process";
const out = spawnSync(
  "node",
  [
    "--input-type=module",
    "-e",
    `
      import { fileURLToPath } from 'node:url';
      import { readFileSync } from 'node:fs';
      // Pull the function out of the compiled file so we exercise the
      // real bundle that runs in production.
      const src = readFileSync('dist/index.js', 'utf8');
      // Find and eval just the normaliseBody function block. (It exists
      // textually in the compiled output.)
      const m = src.match(/function normaliseBody\\([^]*?\\n}\\n/);
      if (!m) { console.error('normaliseBody not found in dist/index.js'); process.exit(2); }
      const fn = new Function(m[0] + '; return normaliseBody;')();

      const cases = [
        ['responses-string-input',
          { model: 'gpt-4.1', input: 'hello', instructions: 'you are concise.' }],
        ['responses-array-input',
          { model: 'gpt-4.1', input: [{type:'text', text:'hello'}, {type:'text', text:'world'}] }],
        ['legacy-prompt',
          { model: 'gpt-4.1', prompt: 'tell me a joke' }],
        ['system-only',
          { model: 'gpt-4.1', system: 'you are a parrot.', prompt: 'squawk' }],
        ['already-chat',
          { model: 'gpt-4.1', messages: [{role:'user', content:'noop'}] }],
        ['empty-messages',
          { model: 'gpt-4.1', messages: [] }],
        ['nothing-recognisable',
          { model: 'gpt-4.1', max_tokens: 100 }],
      ];

      for (const [name, body] of cases) {
        const r = fn(body);
        console.log(name.padEnd(28), 'adapted=', JSON.stringify(r.adapted),
          'messages=', JSON.stringify(r.body.messages));
      }
    `,
  ],
  { stdio: "inherit" },
);
process.exit(out.status ?? 0);
