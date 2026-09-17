const express      = require('express');
const router       = express.Router();
const https        = require('https');
const { spawn }    = require('child_process');
const path         = require('path');
const fs           = require('fs');
const config       = require('../config');
const db           = require('../db');
const { requireSupervisor } = require('../middlewares/supervisorAuth');
const { Errors }   = require('../middlewares/validate');

// Verrou : un seul update à la fois
let updateRunning = false;
let currentUpdateId = null;

// ---------- helpers ----------

function githubGet(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path:     urlPath,
      headers:  { 'User-Agent': 'app-pauses-ota/1.0', 'Accept': 'application/vnd.github+json' },
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { reject(new Error('Réponse GitHub non-JSON')); }
      });
    }).on('error', reject);
  });
}

function readPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  } catch {
    return { name: 'app-pauses', version: '0.0.0', dependencies: {} };
  }
}

function localVersion() {
  return readPackageJson().version || '0.0.0';
}

function installedVersion(pkgName) {
  try {
    return require(`${pkgName}/package.json`).version || null;
  } catch {
    return null;
  }
}

const DEP_ROLES = {
  express: 'Serveur web',
  pg: 'Base de données',
  'socket.io': 'Mises à jour en direct',
  'cookie-parser': 'Session de connexion',
  dotenv: 'Configuration',
  uuid: 'Identifiants',
};

function semverGt(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function readSetting(key) {
  const row = await db.queryOne('SELECT value FROM app_settings WHERE key = $1', [key]);
  if (!row || typeof row.value !== 'string') return '';
  return row.value.trim();
}

async function resolveOtaRepo() {
  const ownerFromDb = await readSetting('github_owner');
  const repoFromDb = await readSetting('github_repo');

  const owner = ownerFromDb || String(config.GITHUB_OWNER || '').trim();
  const repo = repoFromDb || String(config.GITHUB_REPO || '').trim();

  return { owner, repo };
}

// ---------- routes ----------

/**
 * GET /api/supervisor/system/about
 * Versions installées (package.json + Node + PostgreSQL) pour l’onglet À propos.
 */
router.get('/about', requireSupervisor, async (req, res) => {
  try {
    const pkg = readPackageJson();

    let database = null;
    try {
      const row = await db.queryOne("SELECT current_setting('server_version') AS version");
      database = row && row.version ? String(row.version) : null;
    } catch {
      database = null;
    }

    const dependencies = Object.keys(pkg.dependencies || {}).sort().map((name) => ({
      name,
      version: installedVersion(name),
      role: DEP_ROLES[name] || 'Composant serveur',
    }));

    const socketIoVersion = installedVersion('socket.io');

    res.json({
      app: {
        name: pkg.name || 'app-pauses',
        version: pkg.version || '0.0.0',
      },
      runtime: { node: process.version },
      database,
      dependencies,
      frontend: [
        { name: 'Alpine.js', version: '3 (CDN)', role: 'Interface' },
        { name: 'Tailwind CSS', version: 'CDN', role: 'Apparence' },
        {
          name: 'Socket.io (navigateur)',
          version: socketIoVersion || 'servi par l’application',
          role: 'Mises à jour en direct',
        },
      ],
    });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * GET /api/supervisor/system/update/check
 * Compare la version locale (package.json) avec la dernière release GitHub.
 */
router.get('/update/check', requireSupervisor, async (req, res) => {
  try {
    const { owner, repo } = await resolveOtaRepo();

    if (!owner || !repo) {
      return res.status(503).json({
        error: {
          code: 'OTA_NOT_CONFIGURED',
          message: 'github_owner et github_repo doivent être définis (app_settings prioritaire, .env en fallback)',
        },
      });
    }

    const { status, body } = await githubGet(`/repos/${owner}/${repo}/releases/latest`);

    if (status === 404) return Errors.notFound(res, 'Aucune release GitHub disponible');
    if (status !== 200) return res.status(502).json({ error: { code: 'GITHUB_ERROR', message: `GitHub a répondu avec le code ${status}` } });

    const remoteVersion = (body.tag_name || '').replace(/^v/, '');
    const localVer      = localVersion();
    const updateAvailable = semverGt(remoteVersion, localVer);

    res.json({
      localVersion:    localVer,
      remoteVersion,
      updateAvailable,
      releaseUrl:      body.html_url  || null,
      releaseName:     body.name      || null,
      publishedAt:     body.published_at || null,
      updateRunning,
    });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/supervisor/system/update
 * Déclenche le script de mise à jour via child_process.spawn.
 * Streame stdout/stderr vers les clients via Socket.io (system:update-log).
 */
router.post('/update', requireSupervisor, (req, res) => {
  try {
    if (updateRunning) {
      return res.status(409).json({ error: { code: 'UPDATE_ALREADY_RUNNING', message: 'Une mise à jour est déjà en cours' } });
    }

    const scriptPath = path.resolve(config.UPDATE_SCRIPT_PATH);
    if (!fs.existsSync(scriptPath)) {
      return res.status(503).json({ error: { code: 'SCRIPT_NOT_FOUND', message: `Script introuvable : ${scriptPath}` } });
    }

    const { randomUUID } = require('crypto');
    const updateId = randomUUID();

    updateRunning    = true;
    currentUpdateId  = updateId;

    const io = req.app.get('io');

    function emit(stream, line) {
      if (io) io.emit('system:update-log', { updateId, stream, line, ts: new Date().toISOString() });
    }

    function emitStatus(status, extra = {}) {
      if (io) io.emit('system:update-status', { updateId, status, ts: new Date().toISOString(), ...extra });
    }

    emit('system', `[OTA] Démarrage de la mise à jour (id: ${updateId})`);
    emit('system', `[OTA] Script : ${scriptPath}`);
    emitStatus('started');

    // Répondre immédiatement avant le spawn
    res.status(202).json({ started: true, updateId });

    const child = spawn('bash', [scriptPath], {
      cwd: path.resolve(__dirname, '../../'),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    emitStatus('running');

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      chunk.split('\n').filter(l => l).forEach(line => emit('stdout', line));
    });

    child.stderr.on('data', chunk => {
      chunk.split('\n').filter(l => l).forEach(line => emit('stderr', line));
    });

    child.on('close', (code, signal) => {
      updateRunning   = false;
      currentUpdateId = null;

      if (code === 0) {
        emit('system', `[OTA] Mise à jour terminée avec succès (code: ${code})`);
        emitStatus('completed', { code });
      } else {
        emit('system', `[OTA] Échec de la mise à jour (code: ${code}, signal: ${signal})`);
        emitStatus('failed', { code, signal });
      }
    });

    child.on('error', err => {
      updateRunning   = false;
      currentUpdateId = null;
      emit('system', `[OTA] Erreur spawn: ${err.message}`);
      emitStatus('failed', { message: err.message });
    });

  } catch (err) {
    updateRunning = false;
    Errors.internal(res, err);
  }
});

/**
 * GET /api/supervisor/system/update/status
 * Retourne l'état courant du processus OTA.
 */
router.get('/update/status', requireSupervisor, (req, res) => {
  res.json({ updateRunning, currentUpdateId });
});

module.exports = router;
