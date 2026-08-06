#!/usr/bin/env node
/**
 * Phase 3.4 option B: pull Actions artifact `harness-wasm` into public/harness/
 * so Vercel can serve Wasm without committing binaries.
 *
 * Race fix (Phase 3.10+): when Vercel builds the same git push that triggers
 * `build-harness.yml`, Git deploy often finishes *before* the artifact exists.
 * On Vercel we wait for a successful build-harness run for VERCEL_GIT_COMMIT_SHA
 * (if one is queued/running), then download *that* run's artifact. If no run
 * appears after grace: if the commit touches harness build paths → **fail closed**
 * (do not ship stale Wasm); otherwise fall back to latest.
 *
 * Env (first match wins for token):
 *   HARNESS_ARTIFACT_TOKEN  — preferred (fine-grained PAT, Actions: Read)
 *   GH_TOKEN / GITHUB_TOKEN
 *
 * Optional:
 *   HARNESS_ARTIFACT_ID     — pin a specific artifact id (skip wait)
 *   HARNESS_OWNER / HARNESS_REPO — optional override (else Vercel/GitHub git env)
 *   VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG — auto on Vercel Git deploys
 *   GITHUB_REPOSITORY       — auto on GitHub Actions ("owner/repo")
 *   HARNESS_SKIP_FETCH=1    — skip network (use existing files or local dist)
 *   HARNESS_REQUIRE=0       — do not fail if fetch impossible (local only)
 *   HARNESS_WAIT_MS         — max wait for harness CI (default 720000 = 12m on Vercel)
 *   HARNESS_WAIT_GRACE_MS   — how long to wait for a run to *appear* (default 90000)
 *   HARNESS_POLL_MS         — poll interval while waiting (default 12000)
 *   HARNESS_COMMIT_SHA      — override commit (else VERCEL_GIT_COMMIT_SHA / GITHUB_SHA)
 *
 * Owner/repo resolution (see scripts/harnessRepo.mjs):
 *   HARNESS_* → VERCEL_GIT_REPO_* → GITHUB_REPOSITORY → local fallback (off REQUIRE)
 * On Vercel (or HARNESS_REQUIRE=1), unresolved owner/repo is a hard failure.
 *
 * On Vercel (VERCEL=1), missing token / missing artifact is a hard build failure
 * unless HARNESS_SKIP_FETCH=1 (not recommended for prod).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  commitTouchesHarnessBuild,
  isHarnessRequire,
  resolveHarnessRepo,
} from './harnessRepo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEST = join(ROOT, 'public', 'harness');
const LOCAL_DIST = join(ROOT, 'native', 'dist', 'harness');

let OWNER;
let REPO;
let REPO_SOURCE;
try {
  const resolved = resolveHarnessRepo(process.env);
  OWNER = resolved.owner;
  REPO = resolved.repo;
  REPO_SOURCE = resolved.source;
} catch (e) {
  console.error('[fetch-harness] error:', e instanceof Error ? e.message : e);
  process.exit(1);
}

const ARTIFACT_NAME = 'harness-wasm';
const WORKFLOW_FILE = 'build-harness.yml';
const ON_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const SKIP = process.env.HARNESS_SKIP_FETCH === '1';
const REQUIRE = isHarnessRequire(process.env);

const WAIT_MAX_MS = Number(
  process.env.HARNESS_WAIT_MS || (ON_VERCEL ? 720_000 : 0),
);
const WAIT_GRACE_MS = Number(process.env.HARNESS_WAIT_GRACE_MS || 90_000);
const POLL_MS = Number(process.env.HARNESS_POLL_MS || 12_000);

function log(...args) {
  console.log('[fetch-harness]', ...args);
}

function fail(msg, code = 1) {
  console.error('[fetch-harness] error:', msg);
  process.exit(code);
}

function token() {
  return (
    process.env.HARNESS_ARTIFACT_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    ''
  ).trim();
}

function commitSha() {
  return (
    process.env.HARNESS_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    ''
  ).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasHarnessFiles(dir) {
  return existsSync(join(dir, 'harness.wasm')) && existsSync(join(dir, 'web.js'));
}

function copyFrom(src) {
  mkdirSync(DEST, { recursive: true });
  cpSync(join(src, 'harness.wasm'), join(DEST, 'harness.wasm'));
  cpSync(join(src, 'web.js'), join(DEST, 'web.js'));
  if (existsSync(join(src, 'index.html'))) {
    cpSync(join(src, 'index.html'), join(DEST, 'index.html'));
  }
  for (const f of ['build-id.txt', 'build-id-full.txt']) {
    if (existsSync(join(src, f))) cpSync(join(src, f), join(DEST, f));
  }
  log(`copied from ${src}`);
  writeMeta({ source: 'local-copy', path: src });
}

function writeMeta(meta) {
  mkdirSync(DEST, { recursive: true });
  writeFileSync(
    join(DEST, '.artifact-meta.json'),
    JSON.stringify({ ...meta, fetchedAt: new Date().toISOString() }, null, 2) + '\n',
  );
}

/** Extract Actions artifact zip (prefer system unzip / python; pure inflate fallback). */
function extractZipBuffer(buf, destDir) {
  mkdirSync(destDir, { recursive: true });
  const zipPath = join(tmpdir(), `harness-${randomBytes(4).toString('hex')}.zip`);
  writeFileSync(zipPath, buf);
  try {
    try {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
      return;
    } catch {
      /* try python */
    }
    try {
      execFileSync(
        'python3',
        ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, destDir],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return;
    } catch {
      /* pure JS */
    }
    extractZipPure(buf, destDir);
  } finally {
    try {
      rmSync(zipPath);
    } catch {
      /* ignore */
    }
  }
}

function extractZipPure(buf, destDir) {
  let offset = 0;
  let files = 0;
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    let compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    let dataStart = nameStart + nameLen + extraLen;
    if ((flags & 0x8) !== 0 && compSize === 0) {
      throw new Error('zip data descriptors require unzip/python (install unzip)');
    }
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw new Error(`zip truncated at ${name}`);
    const compressed = buf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    if (!name.endsWith('/')) {
      const outPath = join(destDir, name);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, data);
      files += 1;
    }
    offset = dataEnd;
  }
  if (files === 0) throw new Error('zip contained no files');
}

async function ghJson(url, tok) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'invincible-fetch-harness',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function ghBinary(url, tok) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'invincible-fetch-harness',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub download ${res.status}: ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function listRunsForSha(tok, sha) {
  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/runs` +
    `?head_sha=${encodeURIComponent(sha)}&per_page=5`;
  const data = await ghJson(url, tok);
  return data.workflow_runs || [];
}

/** @returns {Promise<string[]>} */
async function listCommitPaths(tok, sha) {
  const data = await ghJson(
    `https://api.github.com/repos/${OWNER}/${REPO}/commits/${encodeURIComponent(sha)}`,
    tok,
  );
  const files = data.files || [];
  return files.map((f) => f.filename).filter(Boolean);
}

/**
 * After grace with no build-harness run: fail closed if this commit needed a
 * harness rebuild; else latest (docs-only / host-only changes).
 */
async function resolveNoRunFallback(tok, sha) {
  let paths = [];
  try {
    paths = await listCommitPaths(tok, sha);
  } catch (e) {
    log('list commit files failed:', e instanceof Error ? e.message : e);
    // Unknown whether this commit needs Wasm — fail closed on Vercel require path.
    throw new Error(
      `no ${WORKFLOW_FILE} run for ${sha.slice(0, 7)} and could not read commit files — refusing to guess stale Wasm`,
    );
  }
  if (commitTouchesHarnessBuild(paths)) {
    const hit = paths.filter((p) => p.includes('harness') || p.includes('ZIG_VERSION') || p.includes('build-harness'));
    throw new Error(
      `no ${WORKFLOW_FILE} run for ${sha.slice(0, 7)} but commit touches harness build paths ` +
        `(${hit.slice(0, 5).join(', ') || 'native/harness/**'}) — refusing stale Wasm. ` +
        `Run workflow_dispatch build-harness on main, or wait for path-filtered push CI.`,
    );
  }
  log(
    `no ${WORKFLOW_FILE} run for ${sha.slice(0, 7)} after grace — commit does not touch harness paths; using latest artifact`,
  );
  return latestArtifact(tok);
}

async function artifactForRun(tok, runId) {
  const data = await ghJson(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${runId}/artifacts?per_page=20`,
    tok,
  );
  return (data.artifacts || []).find((a) => a.name === ARTIFACT_NAME && !a.expired) || null;
}

async function latestArtifact(tok) {
  const list = await ghJson(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts?name=${encodeURIComponent(ARTIFACT_NAME)}&per_page=20`,
    tok,
  );
  const artifact = (list.artifacts || []).find((a) => !a.expired);
  if (!artifact) {
    throw new Error(
      `no non-expired artifact named "${ARTIFACT_NAME}" — run build-harness on invincible-do-1 first`,
    );
  }
  return artifact;
}

/**
 * Wait for build-harness on this commit (if any), then return the right artifact.
 * Avoids Vercel Git deploy racing the self-hosted Zig job.
 */
async function resolveArtifact(tok) {
  if (process.env.HARNESS_ARTIFACT_ID) {
    const id = process.env.HARNESS_ARTIFACT_ID;
    return ghJson(`https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${id}`, tok);
  }

  const sha = commitSha();
  const shouldWait = WAIT_MAX_MS > 0 && Boolean(sha);

  if (!shouldWait) {
    log(sha ? `sha=${sha.slice(0, 7)} wait disabled — using latest artifact` : 'no commit sha — using latest artifact');
    return latestArtifact(tok);
  }

  log(
    `waiting for ${WORKFLOW_FILE} on ${sha.slice(0, 7)} (grace ${WAIT_GRACE_MS}ms, max ${WAIT_MAX_MS}ms)`,
  );

  const started = Date.now();
  let sawRun = false;

  while (Date.now() - started < WAIT_MAX_MS) {
    let runs = [];
    try {
      runs = await listRunsForSha(tok, sha);
    } catch (e) {
      log('list runs failed:', e instanceof Error ? e.message : e);
    }

    const run = runs[0];
    if (!run) {
      if (Date.now() - started >= WAIT_GRACE_MS) {
        return resolveNoRunFallback(tok, sha);
      }
      log(`no run yet for ${sha.slice(0, 7)}…`);
      await sleep(POLL_MS);
      continue;
    }

    sawRun = true;
    log(`run id=${run.id} status=${run.status} conclusion=${run.conclusion ?? '-'}`);

    if (run.status !== 'completed') {
      await sleep(POLL_MS);
      continue;
    }

    if (run.conclusion !== 'success') {
      throw new Error(
        `${WORKFLOW_FILE} run ${run.id} for ${sha.slice(0, 7)} concluded ${run.conclusion} — not shipping stale Wasm`,
      );
    }

    // Artifact upload can lag a few seconds after run success.
    for (let i = 0; i < 8; i++) {
      const art = await artifactForRun(tok, run.id);
      if (art) {
        log(`using artifact from run ${run.id} (commit-matched)`);
        return art;
      }
      log(`run ${run.id} success but artifact not listed yet (try ${i + 1}/8)`);
      await sleep(3000);
    }

    throw new Error(
      `${WORKFLOW_FILE} run ${run.id} succeeded but artifact "${ARTIFACT_NAME}" not found`,
    );
  }

  if (sawRun) {
    throw new Error(
      `timed out waiting for ${WORKFLOW_FILE} on ${sha.slice(0, 7)} after ${WAIT_MAX_MS}ms`,
    );
  }

  return resolveNoRunFallback(tok, sha);
}

async function installArtifact(tok, artifact) {
  log(
    `artifact id=${artifact.id} size=${artifact.size_in_bytes}B created=${artifact.created_at} run=${artifact.workflow_run?.id ?? '?'}`,
  );

  const zip = await ghBinary(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${artifact.id}/zip`,
    tok,
  );
  log(`downloaded zip ${zip.length} bytes`);

  const tmp = join(tmpdir(), `harness-extract-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  try {
    extractZipBuffer(zip, tmp);
    if (!hasHarnessFiles(tmp)) {
      throw new Error(
        `artifact zip missing harness.wasm/web.js; got: ${execFileSync('ls', ['-la', tmp]).toString()}`,
      );
    }
    mkdirSync(DEST, { recursive: true });
    for (const f of ['harness.wasm', 'web.js', 'index.html', 'web.wasm']) {
      const p = join(DEST, f);
      if (existsSync(p)) rmSync(p);
    }
    cpSync(join(tmp, 'harness.wasm'), join(DEST, 'harness.wasm'));
    cpSync(join(tmp, 'web.js'), join(DEST, 'web.js'));
    if (existsSync(join(tmp, 'index.html'))) {
      cpSync(join(tmp, 'index.html'), join(DEST, 'index.html'));
    }
    writeMeta({
      source: 'github-actions-artifact',
      artifactId: artifact.id,
      artifactName: artifact.name,
      createdAt: artifact.created_at,
      workflowRunId: artifact.workflow_run?.id ?? null,
      sizeInBytes: artifact.size_in_bytes,
      commitSha: commitSha() || null,
      matchedCommit: Boolean(commitSha() && artifact.workflow_run),
    });
    log(`installed → ${DEST}`);
    const wasm = readFileSync(join(DEST, 'harness.wasm'));
    if (!(wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d)) {
      throw new Error('harness.wasm missing Wasm magic');
    }
    log(`harness.wasm ${wasm.length} bytes OK`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchHarness(tok) {
  const artifact = await resolveArtifact(tok);
  await installArtifact(tok, artifact);
}

async function main() {
  log(`repo=${OWNER}/${REPO} source=${REPO_SOURCE}`);
  if (REPO_SOURCE === 'fallback') {
    log(
      `WARN: using fallback repo=${OWNER}/${REPO} — missing fields filled from maintainer defaults (btipling/invincible). Set HARNESS_OWNER/HARNESS_REPO or git env for BYO`,
    );
  }
  if (SKIP) {
    if (hasHarnessFiles(DEST)) {
      log('HARNESS_SKIP_FETCH=1 and public/harness already present — OK');
      return;
    }
    if (hasHarnessFiles(LOCAL_DIST)) {
      copyFrom(LOCAL_DIST);
      return;
    }
    if (REQUIRE) fail('HARNESS_SKIP_FETCH=1 but no harness files available');
    log('skip: no files (non-fatal)');
    return;
  }

  const tok = token();
  if (tok) {
    try {
      await fetchHarness(tok);
      return;
    } catch (e) {
      console.error('[fetch-harness]', e instanceof Error ? e.message : e);
      if (hasHarnessFiles(LOCAL_DIST)) {
        log('falling back to native/dist/harness');
        copyFrom(LOCAL_DIST);
        return;
      }
      if (hasHarnessFiles(DEST) && !REQUIRE) {
        log('keeping existing public/harness (non-fatal)');
        return;
      }
      if (REQUIRE) fail(e instanceof Error ? e.message : String(e));
      return;
    }
  }

  if (hasHarnessFiles(LOCAL_DIST)) {
    log('no token — using native/dist/harness');
    copyFrom(LOCAL_DIST);
    return;
  }
  if (hasHarnessFiles(DEST)) {
    log('no token — using existing public/harness');
    return;
  }

  const hint = `Set HARNESS_ARTIFACT_TOKEN (GitHub fine-grained PAT: Actions Read on ${OWNER}/${REPO}) in Vercel env, or run ./native/harness/build.sh locally.`;
  if (REQUIRE) fail(hint);
  log(`warning: ${hint}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
