import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserTestFiles, manifestLine } from './test-inventory';

interface BrowserTest {
  expectedStatus: string;
  status: string;
  results: { status: string }[];
}
interface BrowserSuite {
  suites?: BrowserSuite[];
  specs?: { file: string; title: string; ok: boolean; tests: BrowserTest[] }[];
}
interface BrowserReport {
  config: { rootDir: string };
  suites: BrowserSuite[];
  stats: { skipped: number; unexpected: number; flaky: number };
}
const report = JSON.parse(readFileSync('.context/browser-results.json', 'utf8')) as BrowserReport;
if (report.stats.skipped || report.stats.unexpected || report.stats.flaky) {
  throw new Error('Skipped, failed or flaky browser tests cannot satisfy the test manifest');
}
const actual: string[] = [];
function visit(suite: BrowserSuite): void {
  for (const spec of suite.specs ?? []) {
    if (
      !spec.ok ||
      spec.tests.length !== 1 ||
      spec.tests.some(
        (test) =>
          test.expectedStatus !== 'passed' ||
          test.status !== 'expected' ||
          !test.results.length ||
          test.results.some((result) => result.status !== 'passed'),
      )
    ) {
      throw new Error(`Browser test was not executed successfully: ${spec.file}: ${spec.title}`);
    }
    actual.push(manifestLine(resolve(report.config.rootDir, spec.file), spec.title));
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites) visit(suite);
const files = browserTestFiles();
const expected = readFileSync('tests/manifest.txt', 'utf8')
  .trim()
  .split('\n')
  .filter((line) => files.includes(line.split('\t')[0]))
  .sort();
if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) {
  throw new Error('Executed browser tests differ from tests/manifest.txt');
}
console.log(`Executed browser test manifest matches (${actual.length} tests, no skips)`);
