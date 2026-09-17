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

La persistance est **PostgreSQL uniquement**, via `DATABASE_URL`. Avec Docker Compose, l’hôte est le service `postgres` :

```
DATABASE_URL=postgres://flowi:flowi@postgres:5432/flowi
```

Cette valeur est aussi imposée par [`docker-compose.yml`](docker-compose.yml) (`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` = `flowi`). Autres variables : `PORT`, `SUPERVISOR_PIN`, quotas et options OTA (`GITHUB_OWNER`, `GITHUB_REPO`, etc. — voir [.env.example](.env.example)).

## Lancement

```bash
docker compose up -d --build
```

Le service `flowi` attend que PostgreSQL soit `healthy`, applique les migrations, exécute le seed idempotent, puis démarre le serveur.

Accès : [http://127.0.0.1:3001](http://127.0.0.1:3001)

- Agent : `/agent/`
- Superviseur : `/supervisor/` (PIN par défaut après seed : `1234`)

Arrêt : `docker compose down`. Les données restent dans le volume nommé `flowi_pgdata`.

## Amorçage des données

Le seed s’exécute automatiquement au démarrage du conteneur (`scripts/docker-entrypoint.sh`). Il initialise `app_settings` (PIN superviseur `1234`, clés GitHub OTA, durées), les offres par défaut, les règles de quota et l’annuaire d’agents de démonstration.

Le script est **idempotent**. Relance manuelle :

```bash
docker compose exec flowi node scripts/seed.js
```
