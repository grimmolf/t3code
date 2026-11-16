#!/bin/sh
cd "$(dirname "$0")"
node harness.mjs --model claude-haiku-5-5 --tasks A,B,C --n 5 --tag main > logs/haiku.log 2>&1
node harness.mjs --model claude-sonnet-5-5 --tasks A,B --n 5 --tag main > logs/sonnet-ab.log 2>&1
node harness.mjs --model claude-sonnet-5-5 --tasks C --n 3 --tag main > logs/sonnet-c.log 2>&1
echo ALL_RUNS_DONE > logs/done.marker
