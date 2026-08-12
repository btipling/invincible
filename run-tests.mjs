import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const bin = new URL('./node_modules/vitest/vitest.mjs', import.meta.url).pathname;
const outFile = '/tmp/vitest-full.json';
let summary = '';
try {
  execFileSync(process.execPath, [bin, 'run', '--reporter=json', '--outputFile=' + outFile], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 600000,
  });
  summary += 'vitest exit 0\n';
} catch (e) {
  summary += `vitest FAILED (status ${e.status ?? 'unknown'})\n`;
}
const data = JSON.parse((await import('node:fs')).readFileSync(outFile, 'utf8'));
const files = data.testResults ?? [];
let pass = 0, fail = 0, skip = 0;
for (const f of files) {
  for (const a of f.assertionResults ?? []) {
    if (a.status === 'passed') pass++;
    else if (a.status === 'failed') fail++;
    else skip++;
  }
}
writeFileSync('/tmp/vitest-summary.txt', summary + `files=${files.length} testCases passed=${pass} failed=${fail} skipped=${skip}\n`);
console.log(summary + `files=${files.length} testCases passed=${pass} failed=${fail} skipped=${skip}`);
