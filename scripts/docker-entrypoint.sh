#!/bin/sh
set -e
mkdir -p /app/data
node scripts/seed.js
exec node src/server.js
