// Provocation for the hypothesized freePort() race: keep opening listeners on ephemeral ports (port 0 → the OS's
// next free port) and hold each briefly, so a port freePort() just closed is likely to be taken before Python binds it.
import { createServer } from 'node:net';
const HOLD_MS = Number(process.argv[2] ?? 300), PARALLEL = Number(process.argv[3] ?? 64);
let taken = 0;
function one() { const s = createServer().listen(0, '127.0.0.1', () => { taken++; setTimeout(() => s.close(one), HOLD_MS); }); s.on('error', () => setTimeout(one, 5)); }
for (let i = 0; i < PARALLEL; i++) one();
setInterval(() => process.stderr.write(`churn listeners opened ${taken}\n`), 10000);
