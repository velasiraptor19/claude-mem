#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fixturePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'tests/fixtures/maintained-retrieval-acceptance-v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const port = process.env.CLAUDE_MEM_WORKER_PORT || '37700';
const endpoint = `http://127.0.0.1:${port}/api/search`;

async function runCase(testCase) {
  const url = new URL(endpoint);
  url.searchParams.set('query', testCase.query);
  url.searchParams.set('project', fixture.project);
  url.searchParams.set('type', 'observations');
  url.searchParams.set('dateEnd', fixture.dateEnd);
  url.searchParams.set('limit', String(fixture.topK));
  url.searchParams.set('orderBy', 'relevance');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${testCase.id}: HTTP ${response.status}`);
  const body = await response.json();
  const text = body?.content?.map(item => item.text || '').join('\n') || '';
  const ids = [...text.matchAll(/\| #(\d+) \|/g)].map(match => Number(match[1]));
  const rankIndex = ids.indexOf(testCase.expectedObservationId);
  return { ...testCase, returnedIds: ids, rank: rankIndex === -1 ? null : rankIndex + 1, passed: rankIndex !== -1 };
}

async function main() {
  const results = [];
  for (const testCase of fixture.cases) results.push(await runCase(testCase));
  const passed = results.filter(result => result.passed).length;
  const reciprocalRank = results.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0) / results.length;
  const report = {
    schemaVersion: fixture.schemaVersion,
    generatedAt: new Date().toISOString(),
    project: fixture.project,
    workerPort: Number(port),
    topK: fixture.topK,
    total: results.length,
    passed,
    failed: results.length - passed,
    hitRate: passed / results.length,
    meanReciprocalRank: reciprocalRank,
    results
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
