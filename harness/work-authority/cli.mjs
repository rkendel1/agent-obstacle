#!/usr/bin/env node
// npm run harness:authority:setup|start|stop|status   (prints no secrets)
import { setupAuthority, startAuthority, stopAuthority, authorityStatus } from './authority.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const log = (m) => console.log(`[authority] ${m}`);
try {
  switch (cmd) {
    case 'setup': { const s = await setupAuthority({ force: rest.includes('--force'), log }); log(`ready at ${s.url} (tenant ${s.tenantId}, app ${s.appId})`); break; }
    case 'start': { const r = await startAuthority(); log(`${r.already ? 'already running' : 'started'} at ${r.url} (pid ${r.pid})`); break; }
    case 'stop': { const r = await stopAuthority(); log(r.stopped ? `stopped pid ${r.pid}` : r.reason); break; }
    case 'status': { const s = await authorityStatus(); console.log(JSON.stringify(s, null, 2)); process.exitCode = s.healthy && s.setUp ? 0 : 1; break; }
    default: console.error('usage: cli.mjs setup [--force] | start | stop | status'); process.exitCode = 2;
  }
} catch (e) { console.error(`[authority] ${e.message}`); process.exitCode = 1; }
