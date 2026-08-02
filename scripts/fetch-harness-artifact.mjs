#!/usr/bin/env node
/**
 * Phase 3.4 option B: pull latest Actions artifact `harness-wasm` into public/harness/
 * so Vercel can serve Wasm without committing binaries.
 *
 * Env (first match wins for token):
 *   HARNESS_ARTIFACT_TOKEN  — preferred (fine-grained PAT, Actions: Read)
 *   GH_TOKEN / GITHUB_TOKEN
 *
 * Optional:
 *   HARNESS_ARTIFACT_ID     — pin a specific artifact id
 *   HARNESS_OWNER / HARNESS_REPO — default btipling / invincible
 *   HARNESS_SKIP_FETCH=1    — skip network (use existing files or local dist)
 *   HARNESS_REQUIRE=0       — do not fail if fetch impossible (local only)
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEST = join(ROOT, 'public', 'harness');
const LOCAL_DIST = join(ROOT, 'native', 'dist', 'harness');

const OWNER = process.env.HARNESS_OWNER || 'btipling';
const REPO = process.env.HARNESS_REPO || 'invincible';
const ARTIFACT_NAME = 'harness-wasm';
const ON_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const SKIP = process.env.HARNESS_SKIP_FETCH === '1';
const REQUIRE =
  process.env.HARNESS_REQUIRE === '0'
    ? false
    : ON_VERCEL || process.env.HARNESS_REQUIRE === '1';

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
    // data descriptor (bit 3): sizes are zero in local header — use central directory not implemented
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

async function fetchLatestArtifact(tok) {
  let artifact;
  if (process.env.HARNESS_ARTIFACT_ID) {
    const id = process.env.HARNESS_ARTIFACT_ID;
    artifact = await ghJson(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${id}`,
      tok,
    );
  } else {
    const list = await ghJson(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts?name=${encodeURIComponent(ARTIFACT_NAME)}&per_page=20`,
      tok,
    );
    artifact = (list.artifacts || []).find((a) => !a.expired);
    if (!artifact) {
      throw new Error(
        `no non-expired artifact named "${ARTIFACT_NAME}" — run build-harness on invincible-do-1 first`,
      );
    }
  }

  log(
    `artifact id=${artifact.id} size=${artifact.size_in_bytes}B created=${artifact.created_at} run=${artifact.workflow_run?.id ?? '?'}`,
  );

  const zip = await ghBinary(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${artifact.id}/zip`,
    tok,
  );
  log(`downloaded zip ${zip.length} bytes`);

  // extract to temp then promote required files
  const tmp = join(tmpdir(), `harness-extract-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  try {
    extractZipBuffer(zip, tmp);
    if (!hasHarnessFiles(tmp)) {
      throw new Error(`artifact zip missing harness.wasm/web.js; got: ${execFileSync('ls', ['-la', tmp]).toString()}`);
    }
    mkdirSync(DEST, { recursive: true });
    // clean previous binaries only
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
    });
    log(`installed → ${DEST}`);
    const wasm = readFileSync(join(DEST, 'harness.wasm'));
    if (wasm.subarray(0, 4).toString('binary') !== '\0asm') {
      // check magic bytes
      if (!(wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d)) {
        throw new Error('harness.wasm missing Wasm magic');
      }
    }
    log(`harness.wasm ${wasm.length} bytes OK`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
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

  // Prefer fresh artifact when token present; fall back to local dist / existing.
  const tok = token();
  if (tok) {
    try {
      await fetchLatestArtifact(tok);
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

  // No token
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
