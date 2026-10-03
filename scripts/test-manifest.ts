import { readFileSync, writeFileSync } from 'node:fs';
import { testInventory } from './test-inventory';

const expected = testInventory().join('\n') + '\n';
if (process.argv.includes('--write')) {
  writeFileSync('tests/manifest.txt', expected);
  console.log(`Generated tests/manifest.txt (${testInventory().length} tests)`);
} else {
  if (readFileSync('tests/manifest.txt', 'utf8') !== expected) {
    throw new Error(
      'Test inventory changed. Review every change, then run npm run test:manifest:update.',
    );
  }
  console.log(`Test manifest matches ${testInventory().length} tests`);
}
