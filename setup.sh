#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# setup.sh — installe le README 365 sur TON compte GitHub, en une commande.
#
#   GH_USER=mon-pseudo GH_EMAIL=moi@exemple.com bash setup.sh
#
# Variables :
#   GH_USER   (obligatoire) ton pseudo GitHub
#   GH_EMAIL  (obligatoire) un e-mail VÉRIFIÉ sur ton compte GitHub
#   TZ_NAME   (défaut Africa/Lagos) fuseau utilisé pour la date du README
#   FROM      (défaut 2025-01-01) début du rattrapage ; FROM=skip pour ne rien antidater
#   DRY_RUN   =1 → ne pousse rien (répétition générale)
#   LOCAL_REPO=chemin → travaille dans un clone existant au lieu d'en cloner un
#
# Prérequis : git, node >= 20, et `gh auth login` (ou LOCAL_REPO + accès git déjà en place).
# ---------------------------------------------------------------------------
set -euo pipefail

GH_USER="${GH_USER:-}"
GH_EMAIL="${GH_EMAIL:-}"
TZ_NAME="${TZ_NAME:-Africa/Lagos}"
FROM="${FROM:-2025-01-01}"
DRY_RUN="${DRY_RUN:-0}"
LOCAL_REPO="${LOCAL_REPO:-}"
REPO_SLUG="${GH_USER}/${GH_USER}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODAY="$(date -u +%F)"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. contrôles
say "Contrôles préalables"
[ -n "$GH_USER" ] || die "GH_USER manquant. Exemple : GH_USER=mon-pseudo GH_EMAIL=moi@x.com bash setup.sh"
[ -n "$GH_EMAIL" ] || die "GH_EMAIL manquant (doit être un e-mail vérifié sur github.com/settings/emails)."
case "$GH_USER" in *[!A-Za-z0-9-]*) die "GH_USER invalide : $GH_USER";; esac

command -v git >/dev/null || die "git introuvable."
command -v node >/dev/null || die "node introuvable (installe Node 20+)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR détecté, il faut Node 20+ (fetch natif)."
ok "git + node $NODE_MAJOR"

# ---------------------------------------------------------------- 1. le repo
WORK=""
if [ -n "$LOCAL_REPO" ]; then
  [ -d "$LOCAL_REPO/.git" ] || die "LOCAL_REPO=$LOCAL_REPO n'est pas un repo git."
  WORK="$(cd "$LOCAL_REPO" && pwd)"
  say "Clone existant : $WORK"
else
  command -v gh >/dev/null || die "gh (GitHub CLI) absent. Installe-le ou utilise LOCAL_REPO=chemin vers un clone existant."
  gh auth status >/dev/null 2>&1 || die "gh n'est pas authentifié : lance 'gh auth login'."

  WORK="$(mktemp -d)/$GH_USER"
  say "Récupération de $REPO_SLUG"
  if gh repo view "$REPO_SLUG" >/dev/null 2>&1; then
    gh repo clone "$REPO_SLUG" "$WORK" -- --quiet
  else
    warn "Le repo $REPO_SLUG n'existe pas — je le crée (public, avec un README)."
    gh repo create "$REPO_SLUG" --public --add-readme \
      --description "Profil GitHub — README régénéré chaque jour" >/dev/null
    gh repo clone "$REPO_SLUG" "$WORK" -- --quiet
  fi
fi
cd "$WORK"

PUBLIC="$(gh repo view "$REPO_SLUG" --json visibility -q .visibility 2>/dev/null || echo UNKNOWN)"
[ "$PUBLIC" = "PUBLIC" ] || warn "Repo $PUBLIC : les minutes Actions ne sont pas illimitées et le repo profil doit être public pour s'afficher."
git symbolic-ref -q HEAD >/dev/null || die "HEAD n'est rattaché à aucune branche (détaché ?)."
BRANCH="$(git symbolic-ref --short HEAD)"   # marche aussi sur un repo encore vide
git config user.name "$GH_USER"
git config user.email "$GH_EMAIL"
ok "repo prêt (branche $BRANCH, auteur $GH_EMAIL)"

# ---------------------------------------------------------------- 2. le kit
say "Copie du kit dans le repo"
mkdir -p .github/workflows scripts data
cp "$KIT_DIR/.github/workflows/readme-365.yml" .github/workflows/
cp "$KIT_DIR/scripts/generate.mjs" "$KIT_DIR/scripts/backfill.mjs" scripts/
cp "$KIT_DIR/package.json" .
if [ -f README.template.md ] || [ ! -f README.md ]; then
  [ -f README.template.md ] || cp "$KIT_DIR/README.template.md" .
else
  # Un README existant devient le template : on ne perd pas son contenu.
  warn "README.md existant → converti en README.template.md (original sauvegardé en README.existant.md)."
  cp README.md README.existant.md
  cp README.md README.template.md
fi
[ -f data/streak.json ] || echo '{"current":0,"best":0,"since":null,"lastRun":null,"runs":0}' > data/streak.json

# fuseau horaire dans le workflow
sed -i.bak "s|README_TZ: .*|README_TZ: $TZ_NAME|" .github/workflows/readme-365.yml && rm -f .github/workflows/readme-365.yml.bak
grep -q "README_TZ: $TZ_NAME" .github/workflows/readme-365.yml || die "Impossible d'écrire README_TZ dans le workflow."
ok "kit copié (fuseau $TZ_NAME)"

# ---------------------------------------------------------------- 3. rattrapage
if [ "$FROM" = "skip" ]; then
  say "Rattrapage désactivé (FROM=skip)"
else
  say "Rattrapage des jours manquants depuis $FROM"
  node scripts/backfill.mjs --from "$FROM" --to "$TODAY" --dry-run | tail -3
  node scripts/backfill.mjs --from "$FROM" --to "$TODAY" --yes | tail -4
fi

# ---------------------------------------------------------------- 4. README
say "Génération du README (stats live via l'API GitHub)"
GH_LOGIN="$GH_USER" README_TZ="$TZ_NAME" node scripts/generate.mjs || die "generate.mjs a échoué."

# ---------------------------------------------------------------- 5. commit
say "Commit + push"
git add -A
if git diff --staged --quiet; then
  ok "Rien de neuf à committer."
else
  git commit -q -m "chore(readme): installation du README 365 + historique $FROM → $TODAY"
fi

if [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 : rien n'a été poussé. Pour de vrai : relance sans DRY_RUN, ou 'git push' toi-même."
else
  git push origin "$BRANCH" || die "Le push a échoué (droits ? branche protégée ?)."
  ok "poussé sur $REPO_SLUG ($BRANCH)"
fi

# ---------------------------------------------------------------- 6. secret
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh secret set README_COMMIT_EMAIL --body "$GH_EMAIL" --repo "$REPO_SLUG" >/dev/null 2>&1; then
    ok "secret README_COMMIT_EMAIL créé sur $REPO_SLUG"
  else
    warn "Secret non créé automatiquement → Settings → Secrets → Actions → README_COMMIT_EMAIL = $GH_EMAIL"
  fi
  if gh workflow list --repo "$REPO_SLUG" 2>/dev/null | grep -q "README 365"; then
    gh workflow run readme-365.yml --repo "$REPO_SLUG" >/dev/null 2>&1 && ok "workflow déclenché à l'instant (run d'essai)"
  fi
else
  warn "gh indisponible : crée le secret à la main → Settings → Secrets and variables → Actions → New secret → README_COMMIT_EMAIL = $GH_EMAIL"
fi

# ---------------------------------------------------------------- 7. récap
cat <<EOF

─────────────────────────────────────────────────────────────
 Récapitulatif
─────────────────────────────────────────────────────────────
 Repo        : https://github.com/$REPO_SLUG
 Jours actifs: $(node -p "try{const l=require('$WORK/data/streak.json');l.runs||l.current}catch(e){'?'}" 2>/dev/null || echo '?')
 Série       : $(node -p "try{require('$WORK/data/streak.json').current}catch(e){'?'}" 2>/dev/null || echo '?') jour(s)
 Fuseau      : $TZ_NAME   ·   cron 03:17 UTC
─────────────────────────────────────────────────────────────
 À vérifier demain : une case verte sur https://github.com/$GH_USER
 Si le commit apparaît mais PAS la case → l'e-mail "$GH_EMAIL" n'est pas
 rattaché/vérifié sur ton compte, ou le repo n'est pas public.
EOF
