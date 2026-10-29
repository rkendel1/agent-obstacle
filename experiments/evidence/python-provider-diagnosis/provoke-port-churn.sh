#!/bin/bash
# The three Python-provider test files only, alternating trees, with port churn running throughout.
S=$1; N=$2
node "$S/port-churn.mjs" 300 64 2> "$S/churn.log" &
CHURN=$!
for i in $(seq 1 "$N"); do
  for tree in base d6; do
    export PYDIAG_LOG="$S/provoke-$tree-$i.pydiag.jsonl"
    (cd "$S/$tree" && timeout 300 npx vitest run spec/test/behavioral-replacement-e2e.test.ts spec/test/integration-e2e.test.ts spec/test/agent-planning-e2e.test.ts > "$S/provoke-$tree-$i.log" 2>&1)
    code=$?
    summary=$(grep -hE '^ +Tests ' "$S/provoke-$tree-$i.log" | tail -1 | tr -s ' ')
    fails=$(grep -hE '^ FAIL ' "$S/provoke-$tree-$i.log" | cut -c1-120 | sort -u | tr '\n' ';')
    dead=$(grep -c '"childAlive":false' "$PYDIAG_LOG" 2>/dev/null); dns=$(grep -c '"did-not-start"' "$PYDIAG_LOG" 2>/dev/null); inuse=$(grep -c 'Address already in use' "$PYDIAG_LOG" 2>/dev/null)
    echo "$tree $i: exit $code |$summary | readyButChildDead ${dead:-0} didNotStart ${dns:-0} addrInUse ${inuse:-0} | $fails"
  done
done
kill $CHURN
