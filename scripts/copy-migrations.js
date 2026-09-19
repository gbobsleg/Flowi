'use strict';

const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
const destDir = path.join(__dirname, '..', 'dist', 'db', 'migrations');

fs.mkdirSync(destDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith('.sql')) continue;
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}
