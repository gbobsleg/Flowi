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

La persistance est **MariaDB (10.5 minimum)**, via `DATABASE_URL`. La base n’est pas dans le compose : elle tourne sur l’hôte, joint depuis le conteneur par `host.containers.internal` (Podman) ou `host.docker.internal` (Docker) :

```
DATABASE_URL=mysql://flowi_user:motdepasse@host.containers.internal:3306/flowi
```

La base `flowi` doit exister en `utf8mb4`. Les migrations créent les tables au démarrage. Autres variables : `PORT`, `SUPERVISOR_PIN`, quotas et options OTA (`GITHUB_OWNER`, `GITHUB_REPO`, etc. — voir [.env.example](.env.example)).

## Lancement

```bash
docker compose up -d --build
```

Le service `flowi` applique les migrations, exécute le seed idempotent, puis démarre le serveur.

Accès : [http://127.0.0.1:3001](http://127.0.0.1:3001)

- Agent : `/agent/`
- Superviseur : `/supervisor/` (PIN par défaut après seed : `1234`)

Arrêt : `docker compose down`. Les données restent dans la base MariaDB de l’hôte.

Tests : `docker compose -f docker-compose.test.yml up -d --wait`, puis `NODE_ENV=test DATABASE_URL=mysql://flowi:flowi@127.0.0.1:3307/flowi_test npm test`.

## Amorçage des données

Le seed s’exécute automatiquement au démarrage du conteneur (`scripts/docker-entrypoint.sh`). Il initialise `app_settings` (PIN superviseur `1234`, clés GitHub OTA, durées), les offres par défaut, les règles de quota et l’annuaire d’agents de démonstration.

Le script est **idempotent**. Relance manuelle :

```bash
docker compose exec flowi node scripts/seed.js
```
