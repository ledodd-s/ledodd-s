#!/usr/bin/env node
/**
 * backfill.mjs — remplit tous les jours manquants entre --from et --to
 * en créant un commit par jour, avec une date d'auteur antidatée
 * (GIT_AUTHOR_DATE / GIT_COMMITTER_DATE).
 *
 * Cas d'usage : couvrir l'année précédente + l'année en cours sur le graphe,
 * ou réparer une série cassée (cron désactivé, token expiré, oubli).
 *
 * Le script met aussi à jour data/streak.json pour que le README affiche
 * la bonne série dès le premier run du workflow.
 *
 * Usage :
 *   node scripts/backfill.mjs --from 2025-01-01 --dry-run     # liste, ne commit rien
 *   node scripts/backfill.mjs --from 2025-01-01 --yes         # crée les commits
 *   puis : git push
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'data', 'backfill.log');
const LEDGER = path.join(ROOT, 'data', 'streak.json');

const args = process.argv.slice(2);
const val = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DRY = args.includes('--dry-run') || !args.includes('--yes');
const FROM = val('--from');
const TO = val('--to', new Date().toISOString().slice(0, 10));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  git('rev-parse', '--is-inside-work-tree');
} catch {
  console.error("❌ Ce dossier n'est pas un repo git. Clone ton repo de profil, copie le kit dedans, puis relance.");
  process.exit(1);
}

if (!FROM || !ISO.test(FROM) || !ISO.test(TO)) {
  console.error('Usage : node scripts/backfill.mjs --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run|--yes]');
  process.exit(1);
}
if (FROM > TO) {
  console.error(`❌ --from (${FROM}) est après --to (${TO}).`);
  process.exit(1);
}
if (TO > new Date().toISOString().slice(0, 10)) {
  console.error('❌ --to est dans le futur : GitHub ignore les commits datés après aujourd’hui.');
  process.exit(1);
}

// Jours déjà couverts par un commit existant (date d'auteur) sur la branche courante.
try {
  if (!git('config', 'user.email').trim()) throw new Error('vide');
} catch {
  console.error("❌ Identité git absente. Lance : git config user.name \"ton-pseudo\" && git config user.email \"ton@email\"");
  process.exit(1);
}

let covered = new Set();
try {
  covered = new Set(git('log', '--pretty=format:%ad', '--date=short').split('\n').filter(Boolean));
} catch {
  // repo encore vide (aucun commit) : tout est à créer
}

const dates = [];
for (let d = new Date(`${FROM}T12:00:00Z`); d <= new Date(`${TO}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  if (!covered.has(iso)) dates.push(iso);
}

const all = new Set([...covered, ...dates]);
const today = new Date().toISOString().slice(0, 10);

/** Série consécutive qui se termine aujourd'hui (ou hier, tolérance cron en retard). */
function currentStreak(set) {
  let cursor = new Date(`${today}T12:00:00Z`);
  if (!set.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let n = 0;
  let since = null;
  while (set.has(cursor.toISOString().slice(0, 10))) {
    n += 1;
    since = cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return { n, since };
}

if (!dates.length) {
  console.log(`Rien à rattraper : les ${ISO.test(FROM) ? FROM + ' → ' + TO : ''} sont déjà couverts. Total de jours actifs : ${all.size}.`);
  process.exit(0);
}

const streak = currentStreak(all);
console.log(`${dates.length} jour(s) à rattraper : ${dates[0]} → ${dates.at(-1)}`);
console.log(`Après rattrapage : ${all.size} jours actifs, série courante de ${streak.n} jour(s) (depuis ${streak.since}).`);

if (DRY) {
  console.log('\nDRY-RUN : aucun commit créé. Relance avec --yes pour de vrai.');
  console.log(dates.join('\n'));
  process.exit(0);
}

// Journal lu une seule fois, puis maintenu en mémoire : on n'écrase jamais un
// contenu déjà commité (git checkout restaure ce fichier, un rm le recréerait vide).
if (!existsSync(LOG)) writeFileSync(LOG, '# rattrapage du streak\n');
const logLines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim());
const logged = new Set(logLines.map((l) => l.split(' ')[0]));
if (!logLines[0].startsWith('# ')) logLines.unshift('# rattrapage du streak');

let i = 0;
for (const iso of dates) {
  i += 1;
  // Idempotent : on n'ajoute une ligne que si le jour n'y figure pas déjà.
  if (!logged.has(iso)) {
    logLines.push(`${iso} — rattrapage`);
    logged.add(iso);
    writeFileSync(LOG, `${logLines.join('\n').replace(/\n+$/, '')}\n`);
  }
  execFileSync('git', ['add', 'data/backfill.log'], { cwd: ROOT });
  execFileSync('git', ['commit', '-q', '-m', `chore(readme): rattrapage ${iso}`], {
    cwd: ROOT,
    env: { ...process.env, GIT_AUTHOR_DATE: `${iso}T12:00:00+0000`, GIT_COMMITTER_DATE: `${iso}T12:00:00+0000` },
  });
  if (i % 50 === 0) console.log(`  ${i}/${dates.length} commits…`);
}

// Le registre de série reflète la réalité du repo (sinon le README afficherait 1 jour).
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
const next = {
  current: streak.n,
  best: Math.max(ledger.best || 0, streak.n),
  since: streak.since,
  // fin réelle de la série : aujourd'hui si on vient de le créer, sinon hier
  lastRun: all.has(today) ? today : new Date(Date.now() - 86400000).toISOString().slice(0, 10),
  runs: Math.max(ledger.runs || 0, all.size),
};
writeFileSync(LEDGER, `${JSON.stringify(next, null, 2)}\n`);
console.log(`\n✅ ${dates.length} commits créés · data/streak.json mis à jour (série ${next.current} j, record ${next.best}).`);
console.log('   Vérifie : git log --oneline | head -3');
console.log('   Puis    : git push');
