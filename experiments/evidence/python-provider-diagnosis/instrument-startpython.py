# Diagnostic-only instrumentation of startPython in a scratch copy (not a fix): logs port, child liveness and stderr.
import sys
p=sys.argv[1]+'/spec/test/support/work-order-fixtures.ts'
s=open(p).read()
old='''  const child = spawn("python3", [`${pythonDir}server.py`, "--port", String(port), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${origin}/.well-known/appport`)).ok) return { origin, process: child };
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error("python provider did not start");'''
assert old in s, 'startPython changed'
new='''  const child = spawn("python3", [`${pythonDir}server.py`, "--port", String(port), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  const origin = `http://127.0.0.1:${port}`;
  let stderr = ""; child.stderr?.on("data", (d) => { stderr += String(d); });
  const t0 = Date.now();
  const diag = (event: string, more: Record<string, unknown> = {}) => { try { (require("node:fs") as typeof import("node:fs")).appendFileSync(process.env.PYDIAG_LOG ?? "/tmp/pydiag.log", JSON.stringify({ event, port, pid: child.pid, extra, ms: Date.now() - t0, exitCode: child.exitCode, signal: child.signalCode, worker: process.env.VITEST_WORKER_ID, file: (globalThis as any).__vitest_worker__?.filepath, stderr: stderr.slice(-300), ...more }) + "\\n"); } catch {} };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${origin}/.well-known/appport`)).ok) { diag("ready", { attempt, childAlive: child.exitCode === null && child.signalCode === null }); return { origin, process: child }; }
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  diag("did-not-start");
  child.kill();
  throw new Error("python provider did not start");'''
s=s.replace(old,new)
if 'createRequire' not in s:
  s='import { createRequire as __cr } from "node:module";\nconst require = __cr(import.meta.url);\n'+s
open(p,'w').write(s)
