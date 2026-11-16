#!/bin/sh
# r2 runs, in order: Sonnet bashchain on A (10), Opus on A (4 arms x 8, idx 0 was the pilot), Opus on C (3 arms x 3) if budget remains.
# --budget is cumulative over results/summary.jsonl: $5.37 before r2 plus the $15 r2 cap, less 3x the largest pilot sample for runs in flight.
cd "$(dirname "$0")"
node harness.mjs --model claude-sonnet-5-5 --tasks A --arms bashchain --n 10 --tag r2 --budget 19.2 > logs/r2-sonnet-a.log 2>&1
node harness.mjs --model claude-opus-5-5 --tasks A --arms off,instructions,tool,bashchain --n 8 --tag r2 --budget 19.2 > logs/r2-opus-a.log 2>&1
node harness.mjs --model claude-opus-5-5 --tasks C --arms off,tool,bashchain --n 3 --tag r2 --budget 19.2 > logs/r2-opus-c.log 2>&1
echo R2_DONE > logs/r2-done.marker
