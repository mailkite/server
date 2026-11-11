// Readiness for orchestrators (Railway template, Fly, compose).
//
// The template health-checks `/api/health`, not `/`: serving the SPA files proves the image built,
// not that the volume mounted and SQLite opened. This is the failure mode a SQLite-backed service
// must not hide behind a 200.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 23000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = new URL('..', import.meta.url).pathname;

let proc, dataDir, stdout = '';

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mk-health-'));
  proc = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...process.env, DATA_DIR: dataDir, HMAC_SECRET: 'health-test-secret', PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(() => {
  proc?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/health answers from the store and names the data dir', async () => {
  const res = await fetch(BASE + '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // The count comes from a real query — an empty install is 0, not an error.
  assert.equal(body.messages, 0);
  // Which directory the state lives in: the first thing to check when a volume is missing.
  assert.equal(body.dataDir, dataDir, `expected ${dataDir} in ${JSON.stringify(body)}`);
});
