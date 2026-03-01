#!/usr/bin/env node

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT_ENV_KEYS = [
  "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_COMMIT_SHA",
  "GITHUB_SHA",
  "GIT_COMMIT_SHA",
  "GIT_SHA",
  "COMMIT_SHA",
  "SOURCE_VERSION",
];

function pickEnvCommit() {
  for (const key of COMMIT_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return { sha: value.trim(), source: key };
    }
  }
  return { sha: null, source: null };
}

function resolveGitSha() {
  const envCommit = pickEnvCommit();
  if (envCommit.sha) {
    return envCommit;
  }

  try {
    const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    if (sha) {
      return { sha, source: "git" };
    }
  } catch {
    // ignore
  }

  return { sha: "unknown", source: "unknown" };
}

function writeBuildInfo() {
  const commit = resolveGitSha();
  const buildTime = new Date().toISOString();

  mkdirSync("dist", { recursive: true });
  writeFileSync(
    join("dist", "build-info.json"),
    JSON.stringify(
      {
        commitSha: commit.sha,
        commitSource: commit.source ?? "unknown",
        buildTime,
        buildTimeSource: "script",
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`[build-info] commit=${commit.sha} source=${commit.source} build_time=${buildTime}`);
}

writeBuildInfo();
