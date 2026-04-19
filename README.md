# Flowi

## Description

Application web de gestion des temps de pause pour centre d’appels : rattachement par offre, quotas dynamiques, supervision et temps réel (Socket.io).

## Prérequis

- [Node.js](https://nodejs.org/) **20.x ou 22.x** (LTS recommandée)
- Outils de build natifs pour `better-sqlite3` si `npm install` échoue (Python / Visual Studio Build Tools sous Windows)

## Installation

```bash
npm install
```

## Configuration

Copier le fichier d’exemple et adapter les variables :

```bash
copy .env.example .env
```

Sur Linux ou macOS : `cp .env.example .env`.

Principales variables : `PORT`, `DB_PATH`, `SUPERVISOR_PIN`, quotas et options OTA (`GITHUB_OWNER`, `GITHUB_REPO`, etc. — voir [.env.example](.env.example)).

## Amorçage des données

**`npm run seed` est obligatoire** après la première création de la base : il initialise les paramètres persistés dans SQLite (`app_settings`), dont le **PIN superviseur par défaut (`1234`)**, les clés GitHub OTA vides, les offres par défaut, les règles de quota et l’annuaire d’agents de démonstration.

Sans ce passage, les clés attendues en base (PIN, maintenance, durées, etc.) peuvent être absentes et le comportement métier sera incomplet.

```bash
npm run seed
```

Le script est **idempotent** : vous pouvez le relancer sans erreur après une mise à jour.

## Lancement

```bash
npm start
```

Équivalent : `node src/server.js`. En développement avec rechargement : `npm run dev`.
