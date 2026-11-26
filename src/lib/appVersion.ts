'use strict';

const fs = require('fs');
const path = require('path');

type PackageJson = { name?: string; version?: string; dependencies?: Record<string, string> };

/** package.json à la racine du projet (dist/lib → ../../package.json). */
function readPackageJson(): PackageJson {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  } catch {
    return { name: 'app-pauses', version: '0.0.0', dependencies: {} };
  }
}

/** Version publiée de Flowi, ex. "1.1.0". Mise à jour par `npm version`. */
function localVersion(): string {
  return readPackageJson().version || '0.0.0';
}

module.exports = { readPackageJson, localVersion };
