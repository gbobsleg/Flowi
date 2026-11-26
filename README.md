# Flowi

## Description

Application web de gestion des temps de pause pour centre d’appels : rattachement par offre, quotas dynamiques, supervision et temps réel (Socket.io).

## Prérequis

- [Docker](https://docs.docker.com/get-docker/) et Docker Compose (Docker Desktop sous Windows)

## Configuration

Copier le fichier d’exemple et adapter si besoin :

```bash
copy .env.example .env
```

Sur Linux ou macOS : `cp .env.example .env`.

La persistance est **MariaDB 10.5.29** (même version que la VM de production). Avec Docker, le compose démarre MariaDB dans le conteneur `flowi-mariadb` (volume `flowi_mariadb`) et fournit `DATABASE_URL` à l’application : rien à renseigner dans `.env`.

Hors compose (Node lancé à la main, Podman avec un MariaDB existant), renseigner `DATABASE_URL` vers une base `flowi` en `utf8mb4` :

```
DATABASE_URL=mysql://flowi:flowi@127.0.0.1:3306/flowi
```

Les migrations créent les tables au démarrage. Autres variables : `PORT`, `SUPERVISOR_PIN`, quotas et options OTA (`GITHUB_OWNER`, `GITHUB_REPO`, etc. — voir [.env.example](.env.example)).

## Lancement

```bash
docker compose up -d --build
```

Le service `flowi` applique les migrations, exécute le seed idempotent, puis démarre le serveur.

Accès : [http://127.0.0.1:3001](http://127.0.0.1:3001)

- Agent : `/agent/`
- Superviseur : `/supervisor/` (PIN par défaut après seed : `1234`)

Arrêt : `docker compose down`. Les données restent dans le volume `flowi_mariadb` (`docker compose down -v` les efface).

Reprise d’une ancienne base PostgreSQL (une seule fois par machine, Flowi arrêté, conteneur `flowi-postgres` démarré) :

```bash
docker compose up -d --wait mariadb
docker compose build flowi
docker compose run --rm --no-deps --entrypoint sh \
  -e PG_URL=postgres://flowi:flowi@flowi-postgres:5432/flowi \
  flowi -c "npm i --no-save pg@8 && node scripts/migrate-pg-to-mariadb.js"
docker compose up -d
```

Tests : `docker compose -f docker-compose.test.yml up -d --wait`, puis `NODE_ENV=test DATABASE_URL=mysql://flowi:flowi@127.0.0.1:3317/flowi_test npm test`.

## Amorçage des données

Le seed s’exécute automatiquement au démarrage du conteneur (`scripts/docker-entrypoint.sh`). Il initialise `app_settings` (PIN superviseur `1234`, clés GitHub OTA, durées), les offres par défaut, les règles de quota et l’annuaire d’agents de démonstration.

Le script est **idempotent**. Relance manuelle :

```bash
docker compose exec flowi node scripts/seed.js
```

## Signalement de bugs (Fixi)

Les pages agent et superviseur chargent le widget [Fixi](https://fixi.duckdns.org) via `GET /fixi-loader.js`. Il est activé par deux variables du `.env` :

```bash
FIXI_WIDGET_URL=https://fixi.duckdns.org/widget.js
FIXI_API_KEY=<clé de l'application flowi dans l'admin Fixi>
```

Si l'une des deux est vide (cas par défaut en local), le widget n'est pas chargé et rien n'est envoyé à Fixi. Après modification en production : `docker compose up -d --build` (`docker compose restart` ne relit pas `.env`).

L'origine de la page (ex. `https://flowi.duckdns.org`) doit être déclarée dans l'application `flowi` de Fixi, sinon les signalements sont refusés (403).

Données personnelles : les noms d'agents portent `data-fixi-mask` (masqués sur la capture), et le loader déclare `data-redact-keys` (`query`, `agent_matricule`, `matricule`, `nom`, `prenom` caviardés dans la chronologie réseau). Les matricules présents dans le chemin d'URL (`/api/supervisor/agents/:matricule/...`) ne sont pas caviardés.

## Publier une version

La version affichée (page « À propos », comparaison OTA, `data-version` du widget Fixi) est celle de `package.json`. Après fusion sur `main` :

```bash
git switch main && git pull
npm version minor          # ou patch : met à jour package.json, commite et crée le tag vX.Y.Z
git push --follow-tags     # le tag déclenche la création de la release GitHub
```

Lancer ensuite le workflow « Déployer sur le VPS ».
