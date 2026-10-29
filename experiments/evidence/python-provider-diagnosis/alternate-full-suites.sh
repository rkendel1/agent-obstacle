#!/bin/bash
# Alternate full regression-suite runs (the evaluator's exact command) on the instrumented base and seq-6 trees.
# Per run: vitest summary, failing tests, load average, and every startPython diagnostic event.
S=$1; N=$2
for i in $(seq 1 "$N"); do
  for tree in base d6; do
    export PYDIAG_LOG="$S/$tree-$i.pydiag.jsonl"
    load=$(cut -d' ' -f1 /proc/loadavg)
    cargo=$(pgrep -c -x cargo || true)
    (cd "$S/$tree" && timeout 900 npx vitest run --exclude spec/test/audit.test.ts --exclude '**/node_modules/**' > "$S/$tree-$i.log" 2>&1)
    code=$?
    summary=$(grep -hE '^ +Tests ' "$S/$tree-$i.log" | tail -1 | tr -s ' ')
    fails=$(grep -hE '^ FAIL ' "$S/$tree-$i.log" | cut -c1-140 | sort -u | tr '\n' ';')
    starts=$(wc -l < "$PYDIAG_LOG" 2>/dev/null || echo 0)
    notalive=$(grep -c '"childAlive":false' "$PYDIAG_LOG" 2>/dev/null || echo 0)
    dns=$(grep -c '"did-not-start"' "$PYDIAG_LOG" 2>/dev/null || echo 0)
    echo "$tree run $i: exit $code | load $load cargo $cargo | $summary | pythonStarts $starts readyButChildDead $notalive didNotStart $dns | $fails"
  done
done
