import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

interface Diagnostic {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
}
interface LintResult {
  filePath: string;
  messages: Diagnostic[];
}
const baseline = JSON.parse(readFileSync('eslint-baseline.json', 'utf8')) as Record<
  string,
  Record<string, number>
>;
const result = spawnSync(
  process.execPath,
  ['node_modules/eslint/bin/eslint.js', '.', '--format', 'json'],
  {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  },
);
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
if (!result.stdout) process.exit(result.status ?? 1);
mkdirSync('.context', { recursive: true });
writeFileSync('.context/lint-results.json', result.stdout);
const findings = JSON.parse(result.stdout) as LintResult[];
const warningsByRule = new Map<string, number>();
let failed = result.status !== 0;
for (const file of findings) {
  const path = file.filePath.slice(process.cwd().length + 1).replaceAll('\\', '/');
  const warnings = new Map<string, number>();
  for (const diagnostic of file.messages) {
    if (diagnostic.severity === 2) {
      console.error(
        `${path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message} (${diagnostic.ruleId})`,
      );
      failed = true;
    } else if (diagnostic.ruleId) {
      warnings.set(diagnostic.ruleId, (warnings.get(diagnostic.ruleId) ?? 0) + 1);
      warningsByRule.set(diagnostic.ruleId, (warningsByRule.get(diagnostic.ruleId) ?? 0) + 1);
    }
  }
  for (const [rule, count] of warnings) {
    const limit = baseline[path]?.[rule] ?? 0;
    if (count > limit) {
      console.error(`${path}: ${rule} warnings grew ${limit} -> ${count}; fix the added warnings`);
      failed = true;
    }
  }
}
console.log(`ESLint legacy warning counts: ${JSON.stringify(Object.fromEntries(warningsByRule))}`);
console.log('Full diagnostics: .context/lint-results.json');
if (failed) process.exit(1);
