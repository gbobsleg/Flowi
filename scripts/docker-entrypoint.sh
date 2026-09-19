#!/bin/sh
set -e
node scripts/seed.js
exec node dist/server.js
