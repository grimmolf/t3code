#!/usr/bin/env bash
# Four-step REPL scenario on one provider. Usage: repl-scenario.sh <providerInstanceId> <model> <label>
set -euo pipefail
cd <t3code checkout>
export VP_HOME=<vp home>
export PATH="$VP_HOME/fallback-bin:$VP_HOME/bin:$PATH"
FIXTURE=/Users/Shared/acme-app
t3() { node apps/server/src/bin.ts "$@" --base-dir .t3; }
reply() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const t=j.reply??j.text??j.message??(Array.isArray(j.messages)?j.messages.at(-1)?.text:undefined)??JSON.stringify(j).slice(0,600);console.log(String(t).slice(0,700))}catch{console.log(s.slice(-700))}})'; }

STEP1='Use the t3_code_run tool once with title `Index src files`: read every file under src/ with fs, store an array of {path, text} on globalThis.files, and return only the count. Report the count.'
STEP2='Use the t3_code_run tool once with title `Reuse saved files`: without reading the disk again, use globalThis.files from your previous script to return the paths whose text contains "maxAttempts: 3". Report what it returned and whether globalThis.files was still there.'
STEP3='Use the t3_code_run tool once with title `Chain T3 tools`: call await t3.tools(), then await t3.t3_thread_list({}) and return only {toolCount, threadTitles: the first 3 thread titles}. Report the result.'
STEP4='Use the t3_code_run tool once with title `Slow job`: `await new Promise(r => setTimeout(r, 30000)); return "slow job done";`. It will return a handle while it runs; then call t3_code_poll with that handle until it reports done. Report the final result and how many polls it took.'

echo "== $3: step 1 (new thread)"
OUT=$(t3 thread start --provider "$1" --model "$2" --title "REPL demo: $3" --json --wait "$FIXTURE" "$STEP1" 2>&1 || true)
THREAD=$(printf '%s' "$OUT" | grep -oE 'mcp:[0-9a-f-]{36}' | head -1)
echo "thread $THREAD"; printf '%s' "$OUT" | reply
for n in 2 3 4; do
  eval "MSG=\$STEP$n"
  echo "== $3: step $n"
  t3 thread send --json --wait "$THREAD" "$MSG" 2>&1 | reply || true
done
echo "THREAD_ID=$THREAD"
