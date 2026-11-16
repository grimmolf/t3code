#!/bin/sh
cd "$(dirname "$0")"
node harness.mjs --model claude-haiku-5-5 --tasks B2 --n 5 --tag main > logs/haiku-b2.log 2>&1
node harness.mjs --model claude-sonnet-5-5 --tasks B2,A --n 5 --tag main > logs/sonnet-b2.log 2>&1
node harness.mjs --model claude-sonnet-5-5 --tasks A --n 10 --tag main > logs/sonnet-a10.log 2>&1
