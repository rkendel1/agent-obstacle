// Test-output parsing for the formats the harness knows (vitest, cargo). Unknown output yields
// null counts: callers treat that as "not observed", never as a pass.

/** Parse test counts and failing files/tests from vitest or cargo output. */
export function parseTestOutput(text) {
  const out = { passed: null, failed: null, skipped: null, failing: [] };
  const v = text.match(/^\s*Tests\s+(.+)$/m);
  if (v) {
    const n = (k) => { const m = v[1].match(new RegExp(`(\\d+) ${k}`)); return m ? Number(m[1]) : 0; };
    out.passed = n('passed'); out.failed = n('failed'); out.skipped = n('skipped');
  }
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length) {
    out.passed = cargo.reduce((a, m) => a + Number(m[1]), 0); out.failed = cargo.reduce((a, m) => a + Number(m[2]), 0); out.skipped = cargo.reduce((a, m) => a + Number(m[3]), 0);
  }
  const files = new Set();
  for (const m of text.matchAll(/^\s*(?:FAIL|❯|×)\s+([\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?)/gm)) files.add(m[1]);
  for (const m of text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) files.add(m[1]);
  out.failing = [...files].sort();
  return out;
}
