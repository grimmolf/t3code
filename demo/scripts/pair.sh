#!/usr/bin/env bash
cd <t3code checkout>
export VP_HOME=<vp home>
export PATH="$VP_HOME/fallback-bin:$VP_HOME/bin:$PATH"
node apps/server/src/bin.ts pair --base-dir .t3 --ttl 30m --label demo 2>/dev/null | grep -oE 'https?://[^ ]*pair#token=[A-Z0-9]+' | head -1 | sed -E 's#https?://[^/]+#http://localhost:5986#'
