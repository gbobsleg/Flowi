#!/bin/sh
set -e
node scripts/seed.js
exec node src/server.js
