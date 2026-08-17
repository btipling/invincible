#!/usr/bin/env node
/**
 * Update a GitHub issue comment body via `gh api` PATCH.
 *
 * The `gh api -f body=...` flag auto-encodes the value (avoids manual JSON
 * escaping that breaks on multi-line bodies, quotes, or backslashes).
 *
 * Usage:
 *   node scripts/update-issue-comment.mjs --repo btipling/invincible --comment-id <ID> --body-file <path>
 *   echo "body text" | node scripts/update-issue-comment.mjs --repo btipling/invincible --comment-id <ID>
 *
 * Options:
 *   --repo        owner/repo (required)
 *   --comment-id  issue comment id to PATCH (required)
 *   --body-file   path to file containing the new body
 *   --dry-run     print the command without executing
 *
 * If --body-file is omitted the script reads the body from stdin.
 * Exit 0 on success, non-zero on failure.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const HELP = `Usage: node scripts/update-issue-comment.mjs --repo <owner/repo> --comment-id <ID> [--body-file <path>] [--dry-run]

Update a GitHub issue comment body in place via gh api PATCH.
Body is read from --body-file (preferred) or stdin.`;

function fail(msg) {
  process.stderr.write(`update-issue-comment: ${msg}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    repo:         { type: "string" },
    "comment-id": { type: "string" },
    "body-file":  { type: "string" },
    "dry-run":    { type: "boolean", default: false },
    help:         { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

if (!values.repo || !values["comment-id"]) {
  fail("--repo and --comment-id are required\n\n" + HELP);
}

let body;
if (values["body-file"]) {
  try {
    body = readFileSync(values["body-file"], "utf-8");
  } catch (err) {
    fail(`cannot read --body-file ${values["body-file"]}: ${err.message}`);
  }
} else {
  // Read from stdin in one shot.
  const chunks = [];
  const { stdin } = process;
  // If stdin is already ended (non-TTY pipe that finished before we attached),
  // read what we can; otherwise wait for end.
  stdin.setEncoding("utf-8");
  stdin.on("data", (c) => chunks.push(c));
  // We must drain synchronously — spawn cannot start until we have the body.
  // Use a simple read-if-available approach: if stdin is a TTY and empty, fail.
  if (stdin.isTTY) {
    fail("no --body-file and stdin is a TTY; pipe a body or use --body-file\n\n" + HELP);
  }
  // Node streams: we must read all data before spawning. Use a syncish approach
  // with on('readable') + read(), but simplest is to collect and then check.
  // For reliability, collect in the next tick.
  await new Promise((resolve, reject) => {
    if (stdin.readableEnded) {
      body = chunks.join("");
      resolve();
      return;
    }
    stdin.on("end", () => {
      body = chunks.join("");
      resolve();
    });
    stdin.on("error", reject);
    stdin.resume();
  });
}

if (!body || body.trim().length === 0) {
  fail("body is empty — refusing to blank a comment");
}

const endpoint = `repos/${values.repo}/issues/comments/${values["comment-id"]}`;
const args = ["api", "-X", "PATCH", endpoint, "-f", `body=${body}`];

if (values["dry-run"]) {
  process.stdout.write(`[dry-run] gh ${args.join(" ")}\n`);
  process.exit(0);
}

const child = spawn("gh", args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => fail(`gh spawn failed: ${err.message}`));
