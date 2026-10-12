#!/usr/bin/env bash
# Disposable CI containers only. Never point this script at an existing deployment.
set -euo pipefail
cd "$(dirname "$0")/.."

task_env=$(mktemp)
task_project="pullback-ci-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
export PULLBACK_ENV_FILE="$task_env"
export PULLBACK_ORIGIN="https://pullback-ci.example.test"
export PULLBACK_DB="/app/data/pullback.sqlite"
compose() { docker compose --env-file /dev/null --project-name "$task_project" -f deploy/compose.yml "$@"; }
cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$task_env"
}
trap cleanup EXIT
python3 - "$task_env" <<'PY'
import secrets, sys
with open(sys.argv[1], 'w') as stream:
    stream.write('PULLBACK_PASSWORD=' + secrets.token_hex(32) + '\nPULLBACK_DEMO=0\nPULLBACK_MARKET_WORKER=0\n')
PY
docker compose version
compose config --quiet
compose build app
docker run --rm -e PULLBACK_ORIGIN -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --validate >/dev/null
compose up -d --wait --wait-timeout 120 app

check_app() {
  compose exec -T -e SMOKE_PHASE="$1" app node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const base = 'http://127.0.0.1:3000/api';
const marker = { 'x-requested-with': 'PullbackLab', 'content-type': 'application/json' };
const health = await fetch(base + '/health');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), {ok: true, dataReady: false});
assert.equal((await fetch(base + '/operations/status')).status, 401);
if (process.env.SMOKE_PHASE === 'restored') {
  const db = new Database(process.env.PULLBACK_DB, {readonly: true, fileMustExist: true});
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM command_results').get().n, 0);
  } finally { db.close(); }
}
const login = await fetch(base + '/login', {method: 'POST', headers: marker, body: JSON.stringify({password: process.env.PULLBACK_PASSWORD})});
assert.equal(login.status, 200);
const setCookie = login.headers.get('set-cookie');
assert.match(setCookie, /; Secure/i);
assert.match(setCookie, /; HttpOnly/i);
assert.match(setCookie, /; SameSite=Strict/i);
const headers = {...marker, cookie: setCookie.split(';')[0]};
const diagnostics = await fetch(base + '/operations/status', {headers});
assert.equal(diagnostics.status, 200);
const report = await diagnostics.json();
assert.equal(report.runtime.journalMode, 'wal');
assert.equal(report.runtime.synchronous, 'FULL');
assert.equal(report.security.secureCookiesConfigured, true);
assert.equal(report.security.originConfigured, true);
assert.equal(report.security.publicTls, 'UNKNOWN');
assert.deepEqual(report.markets, {US: 'UNKNOWN', CN: 'UNKNOWN'});
assert.equal(report.worker.state, 'DISABLED');
assert.ok(report.disk.availableBytes > 0);
assert.equal(JSON.stringify(report).includes(process.env.PULLBACK_PASSWORD), false);
const session = await (await fetch(base + '/session', {headers})).json();
assert.equal(session.demo, false);
if (process.env.SMOKE_PHASE === 'write') {
  const add = await fetch(base + '/universe', {method:'POST', headers: {...headers, 'idempotency-key':'smoke-import'}, body:JSON.stringify({symbol:'CI.US',market:'US',name:'Synthetic deployment test'})});
  assert.equal(add.status, 200);
}
const universe = await (await fetch(base + '/universe', {headers})).json();
assert.equal(universe.rows.length, 1);
assert.equal(universe.rows[0].instrument.symbol, 'CI.US');
console.log('DEPLOYMENT_SMOKE_' + process.env.SMOKE_PHASE.toUpperCase() + '_PASS');
JS
}
check_app write
compose restart app
compose up -d --wait --wait-timeout 120 app
check_app read
compose exec -T app npm run backup -- /app/data/backups/ci.sqlite
compose stop app
compose run --rm --no-deps app npm run restore -- /app/data/backups/ci.sqlite /app/data/restored.sqlite
export PULLBACK_DB="/app/data/restored.sqlite"
compose up -d --force-recreate --wait --wait-timeout 120 app
check_app restored
