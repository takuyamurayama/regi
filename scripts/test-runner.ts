import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifestLine, testFiles, unitFiles } from './test-inventory';

const suite = process.argv[2] ?? 'all';
if (!['unit', 'integration', 'all'].includes(suite))
  throw new Error(`Unknown test suite: ${suite}`);
const files = testFiles().filter((file) =>
  suite === 'all' ? true : suite === 'unit' ? unitFiles.has(file) : !unitFiles.has(file),
);
if (suite === 'unit' && files.length !== unitFiles.size)
  throw new Error('Required unit test file missing');
if (!files.length) throw new Error('Test suite is empty');
mkdirSync('.context', { recursive: true });
const resultsPath = resolve(`.context/test-results-${suite}.jsonl`);
const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    `--test-reporter=${resolve('scripts/test-manifest-reporter.mjs')}`,
    '--test-reporter-destination=stdout',
    `--test-reporter-destination=${resultsPath}`,
    ...files,
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

interface TestResult {
  type: string;
  file: string;
  name: string;
  skip: boolean;
  todo: boolean;
}
const results = readFileSync(resultsPath, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as TestResult);
if (results.some((record) => record.type !== 'test:pass' || record.skip || record.todo)) {
  throw new Error('Skipped, TODO or failed test cannot satisfy the test manifest');
}
const actual = results.map((record) => manifestLine(record.file, record.name)).sort();
const expected = readFileSync('tests/manifest.txt', 'utf8')
  .trim()
  .split('\n')
  .filter((line) => files.includes(line.split('\t')[0]))
  .sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`Executed ${suite} tests differ from tests/manifest.txt; inspect ${resultsPath}`);
}
console.log(`Executed ${suite} test manifest matches (${actual.length} tests, no skips)`);
