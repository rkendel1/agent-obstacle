// Start/stop the published feltdb-server 0.3.0 binary for the prototype.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE = join(ROOT, 'state');
export const BINARY = process.env.FELTDB_SERVER_BIN || '/opt/feltdb/bin/feltdb-server';
export const PORT = Number(process.env.FELTDB_PORT || 7791);
export const NAMESPACE = 'aoc';
export const DATA = join(STATE, 'feltdb.log');   // siblings: feltdb.grants.json, feltdb.workers.json, feltdb.platform.json ...
export const KEYS = join(STATE, 'api-keys.json');
export const ENV = {
  ...process.env,
  FELTDB_MASTER_KEY: 'aoc-local-master-key-change-me-0001',          // encrypts key store / data; required
  FELTDB_SESSION_SECRET: 'aoc-local-session-secret-at-least-32-bytes',  // console sessions; harmless here
  FELTDB_GRANT_SIGNING_KEY: 'aoc-local-grant-signing-key-keep-stable', // ED25519 grant key seed; MUST be stable across restarts
};
export const ARGS = ['--host', '127.0.0.1', '--port', String(PORT), '--namespace', NAMESPACE,
  '--data', DATA, '--keys', KEYS, '--auth'];
// No --worker: the autonomous in-process worker stays off; a single node with no
// --peer is implicitly the Durable Work authority (--work-authority is only for clusters).

export const cli = (...args) => execFileSync(BINARY, args, { encoding: 'utf8', env: ENV });

export async function startServer(log = join(STATE, 'server.out')) {
  mkdirSync(STATE, { recursive: true });
  const child = spawn(BINARY, ARGS, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const collect = chunk => {
      output += chunk; appendFileSync(log, chunk);
      const m = output.match(/ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) resolve(m[1]);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', code => reject(new Error(`server exited ${code}: ${output}`)));
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  return {
    url, pid: child.pid,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      await exited;
    },
  };
}
