#!/usr/bin/env node
/**
 * generate.mjs — génère ton README de profil, 1 fois par jour, sans dépendance.
 *
 * Ce que fait le script :
 *   1. lit README.template.md et remplace les jetons <#...>
 *   2. va chercher tes vraies stats publiques sur l'API GitHub (repos, stars, followers)
 *   3. tient à jour le compteur de streak dans data/streak.json
 *   4. écrit README.md (le fichier que GitHub affiche sur ton profil)
 *
 * Aucune dépendance npm. Node >= 20 (fetch natif).
 * Usage : node scripts/generate.mjs [--check]
 *   --check : sort en code 1 si le README changerait (utile pour un job de CI)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'README.template.md');
const OUTPUT = path.join(ROOT, 'README.md');
const LEDGER = path.join(ROOT, 'data', 'streak.json');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const LOGIN =
  process.env.GH_LOGIN ||
  (process.env.GITHUB_REPOSITORY || '').split('/')[0] ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  '';
const TZ = process.env.README_TZ || 'UTC';
const CHECK_ONLY = process.argv.includes('--check');

// ---------------------------------------------------------------- dates

/** Date "aujourd'hui" dans le fuseau demandé, au format YYYY-MM-DD. */
function isoDate(d = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Une date lisible du type "Fri, Nov 7 2026". */
function humanDate(d = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function daysUntilNewYear(today = isoDate()) {
  const year = Number(today.slice(0, 4)) + 1;
  return daysBetween(today, `${year}-01-01`);
}

/** Phrase de signature qui change chaque jour (le détail qui rend le commit "vivant"). */
const MOODS = ['curiosity', 'sunshine', 'coffee', 'clean code', 'patience', 'focus', 'love'];
function signature(today = isoDate()) {
  const idx = (Number(today.replaceAll('-', '')) + 3) % MOODS.length;
  return `🤖 Ce README est régénéré chaque jour avec ${MOODS[idx]}, par mon workflow ❤️`;
}

// ---------------------------------------------------------------- GitHub API

const api = async (url) => {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'readme-365',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} sur ${url}\n${body.slice(0, 300)}`);
  }
  return res.json();
};

/** Stats publiques du compte. Renvoie des valeurs de repli si l'API ne répond pas. */
async function fetchStats(login) {
  const fallback = { publicRepos: 0, stars: 0, followers: 0, sources: 0, latest: [], ok: false };
  if (!login) return fallback;
  try {
    const [user, ...pages] = await Promise.all([
      api(`https://api.github.com/users/${login}`),
      api(`https://api.github.com/users/${login}/repos?per_page=100&page=1&sort=pushed`),
      api(`https://api.github.com/users/${login}/repos?per_page=100&page=2&sort=pushed`).catch(() => []),
      api(`https://api.github.com/users/${login}/repos?per_page=100&page=3&sort=pushed`).catch(() => []),
    ]);
    const repos = pages.flat();
    const own = repos.filter((r) => !r.fork);
    const latest = own
      .filter((r) => r.name.toLowerCase() !== login.toLowerCase())
      .sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at))
      .slice(0, 5)
      .map((r) => ({ name: r.name, url: r.html_url, desc: r.description || '', lang: r.language || '', stars: r.stargazers_count, pushed: r["pushed_at"].slice(0, 10) }));

    return {
      publicRepos: user.public_repos ?? repos.length,
      stars: repos.reduce((n, r) => n + r.stargazers_count, 0),
      followers: user.followers ?? 0,
      sources: own.length,
      latest,
      ok: true,
    };
  } catch (err) {
    console.warn(`⚠️  stats indisponibles (${err.message.split('\n')[0]}) — je garde les valeurs du cache.`);
    // On réutilise ce qui a été calculé au dernier run pour ne pas casser le README.
    try {
      const cached = JSON.parse(await readFile(path.join(ROOT, 'data', 'stats.json'), 'utf8'));
      return { ...cached, ok: false };
    } catch {
      return fallback;
    }
  }
}

// ---------------------------------------------------------------- streak

/**
 * Le streak est un simple registre : on incrémente si le dernier run date d'hier,
 * on remet à zéro sinon. Un fichier versionné = pas besoin de base de données.
 */
function bumpStreak(ledger, today) {
  const next = { ...ledger };
  if (!next.lastRun) {
    next.current = 1;
    next.since = today;
  } else {
    const gap = daysBetween(next.lastRun, today);
    if (gap === 0) {
      // déjà compté aujourd'hui (relance manuelle) : on ne touche à rien
      return next;
    }
    // On tolère 1 jour de décalage (cron GitHub en retard) en comptant quand même la série.
    next.current = gap === 1 ? (next.current || 0) + 1 : 1;
    if (gap !== 1) next.since = today;
  }
  next.lastRun = today;
  next.best = Math.max(next.best || 0, next.current);
  next.runs = (next.runs || 0) + 1;
  return next;
}

// ---------------------------------------------------------------- rendu

function render(template, values) {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`<#${key}>`, String(value));
  }
  const leftover = [...out.matchAll(/<#([a-z0-9_]+)>/gi)].map((m) => m[1]);
  if (leftover.length) {
    throw new Error(`Jeton(s) inconnu(s) dans README.template.md : ${[...new Set(leftover)].join(', ')}`);
  }
  return out;
}

function projectsBlock(latest) {
  if (!latest.length) return '_Ajoute tes projets dans README.template.md._';
  return latest
    .map((r) => {
      const meta = [r.lang, r.stars ? `⭐ ${r.stars}` : null].filter(Boolean).join(' · ');
      return `- **[${r.name}](${r.url})**${meta ? ` — ${meta}` : ''}\n  ${r.desc || '_sans description_'}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  if (!existsSync(TEMPLATE)) throw new Error('README.template.md introuvable à la racine du repo.');
  if (!LOGIN) throw new Error('Login GitHub introuvable : définis GH_LOGIN ou lance le script depuis Actions.');

  const today = isoDate();
  const stats = await fetchStats(LOGIN);

  const ledgerPath = LEDGER;
  const ledger = existsSync(ledgerPath) ? JSON.parse(await readFile(ledgerPath, 'utf8')) : { current: 0, best: 0, runs: 0 };
  const streak = bumpStreak(ledger, today);

  const values = {
    login: LOGIN,
    today_date: humanDate(),
    today_iso: today,
    day_before_new_years: daysUntilNewYear(today),
    next_year: Number(today.slice(0, 4)) + 1,
    streak_current: streak.current,
    streak_best: streak.best,
    streak_label: plural(streak.current, 'jour', 'jours'),
    streak_best_label: plural(streak.best || 0, 'jour', 'jours'),
    streak_since: streak.since ?? today,
    total_runs: streak.runs,
    repos_public: stats.publicRepos,
    repos_sources: stats.sources,
    stars_total: stats.stars,
    followers: stats.followers,
    projects: projectsBlock(stats.latest),
    signature: signature(today),
    run_number: process.env.GITHUB_RUN_NUMBER || '1',
  };

  const template = await readFile(TEMPLATE, 'utf8');
  const output = render(template, values);

  const previous = existsSync(OUTPUT) ? await readFile(OUTPUT, 'utf8') : '';
  const changed = previous !== output;

  if (CHECK_ONLY) {
    console.log(changed ? 'README à jour nécessaire' : 'README déjà à jour');
    process.exit(changed ? 1 : 0);
  }

  if (changed) {
    await writeFile(OUTPUT, output);
    await mkdir(path.dirname(LEDGER), { recursive: true });
    await writeFile(ledgerPath, `${JSON.stringify(streak, null, 2)}\n`);
    await writeFile(path.join(ROOT, 'data', 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
    console.log(`✅ README.md régénéré — streak ${streak.current} j (record ${streak.best}), ${stats.publicRepos} repos, ${stats.stars} ⭐`);
  } else {
    await writeFile(ledgerPath, `${JSON.stringify(streak, null, 2)}\n`);
    console.log('ℹ️  README identique, rien à écrire dans README.md (aucun commit vide).');
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
