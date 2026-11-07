# README 365 — profil GitHub auto-actualisé

Ce dépôt **est** le dépôt de profil `ledodd-s/ledodd-s`. Le fichier `README.md`
affiché sur <https://github.com/ledodd-s> est régénéré chaque jour par GitHub
Actions : une case verte par jour, sans intervention.

## Comment ça marche

| Fichier | Rôle |
|---|---|
| `README.template.md` | **la source à éditer** — contient les jetons `<#...>` |
| `scripts/generate.mjs` | remplit les jetons, interroge l'API GitHub, écrit `README.md` |
| `scripts/backfill.mjs` | crée un commit antidaté par jour manquant (`--from` / `--to`) |
| `data/streak.json` | registre de série (`current`, `best`, `since`, `runs`) |
| `data/backfill.log` | journal des jours rattrapés (preuve lisible dans `git log`) |
| `.github/workflows/readme-365.yml` | cron `17 3 * * *` UTC + `workflow_dispatch` |

Le workflow utilise `GITHUB_TOKEN` avec `permissions: contents: write` —
**aucun PAT à créer**, donc rien qui expire en silence.

## Ne jamais éditer `README.md` à la main

`README.md` est un artefact : il est écrasé au prochain run. Toute
personnalisation va dans `README.template.md`. Un jeton `<#inconnu>` fait
échouer le script **exprès** — c'est une protection, pas un bug.

## E-mail de commit (le seul point qui décide de la case verte)

Un commit ne colore le graphe que si son adresse d'auteur est **rattachée et
vérifiée** sur le compte. Le workflow résout cet e-mail dans cet ordre :

1. secret `README_COMMIT_EMAIL`, s'il existe ;
2. sinon, repli automatique sur l'adresse noreply officielle
   `216334851+ledodd-s@users.noreply.github.com` (dérivée via `GET /users/ledodd-s`).

Le repli existe parce que le token d'installation de cet agent n'a pas la
permission *Secrets*. Le comportement par défaut est donc déjà correct ; créer
le secret reste possible si tu préfères un e-mail réel.

## Commandes utiles

```bash
npm run build                                  # régénère README.md
npm run check                                  # 0 = à jour, 1 = à régénérer
node scripts/backfill.mjs --from 2025-01-01 --dry-run   # liste les jours manquants
node scripts/backfill.mjs --from 2025-01-01 --yes       # crée les commits
```

En local, si `fetch failed` / `unable to verify the first certificate` :
le bac à sable intercepte le TLS, exporter le certificat racine résout le problème.

```bash
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/e2b-ca.crt \
  GITHUB_TOKEN="$GH_TOKEN" GH_LOGIN=ledodd-s README_TZ=Europe/Paris \
  node scripts/generate.mjs
```

## Couverture historique

Les 676 jours du **2025-01-01** au **2026-11-07** sont couverts, sans trou.

À savoir : le graphe de contributions n'affiche qu'une fenêtre glissante de
52 semaines. Les commits de **nov. 2025 → aujourd'hui** y sont visibles ; ceux
de **janv. → nov. 2025** sont bien dans `git log` et apparaissent dans l'archive
annuelle 2025, mais pas dans la fenêtre courante. C'est mécanique, pas une panne.

## Honnêteté

Le cron quotidien est honnête : le README change réellement chaque jour.

Le rattrapage, lui, a fabriqué 675 commits rétroactifs en quelques secondes. Le
graphe ne fait pas la différence, mais `git log` montre 675 commits identiques
créés le même jour de push, avec des dates d'auteur antérieures. C'est un choix
assumé. Pour une version entièrement honnête : `FROM=skip` dans `setup.sh` et un
journal de dev quotidien.
