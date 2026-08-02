// Unit tests for lib/backends.js — zero-dep (no Haraka install needed).
// Run: node --test 'test/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import backends from '../lib/backends.js';

const { parseBackendsConfig, BackendRouter } = backends;

const nullLog = { info() {}, warn() {}, error() {} };
const collectLog = () => {
  const lines = { info: [], warn: [], error: [] };
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m) };
};
const okFetch = (domainsByUrl) => async (url) => {
  const base = url.replace('/api/mx/accepted-domains', '');
  const domains = domainsByUrl[base];
  if (domains === undefined) throw new Error('connection refused');
  return { ok: true, status: 200, json: async () => ({ domains }) };
};

test('parseBackendsConfig: order kept, slashes stripped, ingestUrl derived', () => {
  const log = collectLog();
  const out = parseBackendsConfig({
    backends: [
      { name: 'cloud', url: 'https://api.example/', secretEnv: 'S_A' },
      { name: 'demo', url: 'https://demo.example', secretEnv: 'S_B' },
    ],
  }, { S_A: 'aaa', S_B: 'bbb' }, log);
  assert.deepEqual(out.map((b) => b.name), ['cloud', 'demo']);
  assert.equal(out[0].url, 'https://api.example');
  assert.equal(out[0].ingestUrl, 'https://api.example/api/ingest');
  assert.equal(out[1].secret, 'bbb');
  assert.equal(log.lines.error.length, 0);
});

test('parseBackendsConfig: missing secret env or fields → skipped loudly', () => {
  const log = collectLog();
  const out = parseBackendsConfig({
    backends: [
      { name: 'ok', url: 'https://a', secretEnv: 'HAS' },
      { name: 'no-secret', url: 'https://b', secretEnv: 'MISSING' },
      { url: 'https://c', secretEnv: 'HAS' }, // no name
    ],
  }, { HAS: 'x' }, log);
  assert.deepEqual(out.map((b) => b.name), ['ok']);
  assert.equal(log.lines.error.length, 2);
});

test('parseBackendsConfig: null/absent config → empty list (single-backend mode)', () => {
  assert.deepEqual(parseBackendsConfig(null, {}, nullLog), []);
  assert.deepEqual(parseBackendsConfig({}, {}, nullLog), []);
});

test('ownerOf: first-configured wins a conflict, warned exactly once per domain', async () => {
  const log = collectLog();
  const bs = parseBackendsConfig({
    backends: [
      { name: 'cloud', url: 'https://a', secretEnv: 'S' },
      { name: 'demo', url: 'https://b', secretEnv: 'S' },
    ],
  }, { S: 'x' }, log);
  const r = new BackendRouter(bs, {
    logger: log,
    fetch: okFetch({ 'https://a': ['both.example', 'cloud.example'], 'https://b': ['both.example', 'demo.example'] }),
  });
  await r.refreshAll();
  assert.equal(r.ownerOf('both.example').name, 'cloud');
  assert.equal(r.ownerOf('BOTH.example').name, 'cloud');
  assert.equal(r.ownerOf('demo.example').name, 'demo');
  assert.equal(log.lines.warn.filter((w) => w.includes('both.example')).length, 1, 'conflict warned once');
});

test('resilience: one backend down keeps the other; last-known survives a later failure', async () => {
  const bs = parseBackendsConfig({
    backends: [
      { name: 'up', url: 'https://up', secretEnv: 'S' },
      { name: 'down', url: 'https://down', secretEnv: 'S' },
    ],
  }, { S: 'x' }, nullLog);
  let downAnswers = false;
  const r = new BackendRouter(bs, {
    min_miss_interval_ms: 0,
    ttl_ms: 1, // everything goes stale immediately so refreshes really run
    logger: nullLog,
    fetch: async (url) => {
      if (url.startsWith('https://up')) return { ok: true, json: async () => ({ domains: ['up.example'] }) };
      if (!downAnswers) throw new Error('refused');
      return { ok: true, json: async () => ({ domains: ['down.example'] }) };
    },
  });
  await r.refreshAll();
  assert.equal(r.ownerOf('up.example').name, 'up');
  assert.equal(r.ownerOf('down.example'), null);
  assert.equal(r.hasFullCoverage(), false, 'down backend has no data yet');

  downAnswers = true;
  await r.refreshAll();
  assert.equal(r.ownerOf('down.example').name, 'down');
  assert.equal(r.hasFullCoverage(), true);

  downAnswers = false; // later blip: keep last-known, don't wipe
  await r.refreshAll();
  assert.equal(r.ownerOf('down.example').name, 'down', 'last-known set survives a failed refresh');
});

test('seed gives cold-start coverage before any fetch succeeds', () => {
  const bs = parseBackendsConfig({ backends: [{ name: 'only', url: 'https://x', secretEnv: 'S' }] }, { S: 's' }, nullLog);
  const r = new BackendRouter(bs, { logger: nullLog, fetch: async () => { throw new Error('down'); } });
  assert.equal(r.hasFullCoverage(), false);
  r.seed('only', ['Seeded.Example']);
  assert.equal(r.ownerOf('seeded.example').name, 'only');
  assert.equal(r.hasFullCoverage(), true);
});

test('refreshBackend coalesces concurrent callers into one fetch', async () => {
  let calls = 0;
  const bs = parseBackendsConfig({ backends: [{ name: 'b', url: 'https://b', secretEnv: 'S' }] }, { S: 's' }, nullLog);
  const r = new BackendRouter(bs, {
    logger: nullLog,
    fetch: async () => { calls++; await new Promise((res) => setTimeout(res, 20)); return { ok: true, json: async () => ({ domains: [] }) }; },
  });
  await Promise.all([r.refreshBackend(bs[0]), r.refreshBackend(bs[0]), r.refreshBackend(bs[0])]);
  assert.equal(calls, 1);
});

test('groupRcpts splits by owner and reports unmatched', async () => {
  const bs = parseBackendsConfig({
    backends: [
      { name: 'cloud', url: 'https://a', secretEnv: 'S' },
      { name: 'demo', url: 'https://b', secretEnv: 'S' },
    ],
  }, { S: 'x' }, nullLog);
  const r = new BackendRouter(bs, {
    logger: nullLog,
    fetch: okFetch({ 'https://a': ['c.example'], 'https://b': ['d.example'] }),
  });
  await r.refreshAll();
  const { groups, unmatched } = r.groupRcpts(['one@c.example', 'two@d.example', 'three@c.example', 'lost@nowhere.example']);
  const byName = new Map([...groups].map(([b, addrs]) => [b.name, addrs]));
  assert.deepEqual(byName.get('cloud'), ['one@c.example', 'three@c.example']);
  assert.deepEqual(byName.get('demo'), ['two@d.example']);
  assert.deepEqual(unmatched, ['lost@nowhere.example']);
});
