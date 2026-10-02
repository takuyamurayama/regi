import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

let compiled = false;
export async function apiFixture() {
  if (!compiled) {
    execFileSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json'],
      { stdio: 'pipe' },
    );
    compiled = true;
  }
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = spawn(
    process.execPath,
    [
      '-e',
      "require('./apps/api/dist/apps/api/src/main.js').createApp({writeOpenapi:false}).then(app=>app.listen(Number(process.env.PORT),'127.0.0.1')).catch(error=>{console.error(error);process.exit(1)})",
    ],
    {
      env: { ...process.env, NODE_ENV: 'test', REGI_DEV_AUTH: 'true', PORT: String(address.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  server.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  server.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const base = 'http://127.0.0.1:' + String(address.port);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150 && server.exitCode === null; attempt++) {
      try {
        if ((await fetch(base + '/health')).ok) {
          ready = true;
          break;
        }
      } catch {
        /* socket not ready */
      }
      await delay(100);
    }
    assert.ok(ready, output);
    return {
      base,
      close: async () => {
        if (server.exitCode !== null) return;
        server.kill('SIGTERM');
        await new Promise<void>((resolve) => server.once('exit', () => resolve()));
      },
    };
  } catch (error) {
    server.kill('SIGTERM');
    throw error;
  }
}
