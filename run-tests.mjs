import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const bin = new URL('./node_modules/vitest/vitest.mjs', import.meta.url).pathname;
const outFile = '/tmp/vitest-full.json';
let summary = '';
let exitStatus = null;
try {
  exitStatus = execFileSync(process.execPath, [bin, 'run', '--reporter=json', '--outputFile=' + outFile], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 600000,
  });
  summary += 'vitest exit 0\n';
} catch (e) {
  exitStatus = e?.status ?? e?.code;
  summary += `vitest FAILED (status ${exitStatus ?? 'unknown'})\n`;
}

// Read the report. Fail closed: a missing/unreadable/invalid JSON report means we
// cannot prove green, so treat it as a failure regardless of vitest's exit code.
let data;
try {
  data = JSON.parse(readFileSync(outFile, 'utf8'));
} catch {
  writeFileSync('/tmp/vitest-summary.txt', summary + 'REPORT MISSING/UNREADABLE — cannot confirm green\n');
  console.log(summary + 'REPORT MISSING/UNREADABLE — cannot confirm green');
  // Fail closed: we cannot prove green, so always exit non-zero. Do not reuse
  // exitStatus here — under stdio:'ignore' its success value can be a Buffer/null,
  // and it does not represent "vitest ran cleanly" on this path regardless.
  process.exit(1);
}

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

// Canonical exit status: non-zero if vitest failed OR any test failed. A readable
// JSON report is not a licence to exit 0 when failed>0. Shell `&&` chains and CI
// wrappers must be able to trust this as the full-suite green gate.
const code = summary.startsWith('vitest exit 0') && fail === 0 ? 0 : 1;
process.exit(code);
