#!/usr/bin/env node
/**
 * Pre-flight check for local configuration.
 *
 * Reports which variables are set and which are missing, and never prints a secret's value — only
 * whether it is present. Exits non-zero when something required for the requested scope is absent.
 *
 * Usage:
 *   node scripts/check-env.mjs            # check everything
 *   node scripts/check-env.mjs contracts  # or: web
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scope = process.argv[2];

const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";
const DIM = "[2m";
const RESET = "[0m";

/** Variables whose values must never be echoed. */
const SECRET = /PRIVATE_KEY|MNEMONIC|SECRET|API_KEY|AUTHTOKEN|PASSWORD/i;

const GROUPS = [
  {
    name: "contracts",
    file: join(root, "contracts/.env"),
    example: join(root, "contracts/.env.example"),
    required: ["DEPLOYER_PRIVATE_KEY"],
    optional: [
      "POLYGON_RPC_URL",
      "SEPOLIA_RPC_URL",
      "OWNER_ADDRESS",
      "REFUND_GRACE_PERIOD_SECONDS",
      "SETTLEMENT_TOKEN_ADDRESS",
    ],
  },
  {
    name: "web",
    file: join(root, "web/.env.local"),
    example: join(root, "web/.env.example"),
    required: [
      "NEXT_PUBLIC_EVM_CHAIN_ID",
      "NEXT_PUBLIC_ESCROW_ADDRESS",
      "NEXT_PUBLIC_SETTLEMENT_TOKEN_ADDRESS",
    ],
    optional: [
      "NEXT_PUBLIC_RPC_URL",
      "NEXT_PUBLIC_EXPLORER_URL",
      "NEXT_PUBLIC_ENABLE_PUBLIC_MODE",
      "ATTESTOR_PRIVATE_KEY",
      "ATTESTOR_ESCROW_ADDRESS",
    ],
  },
];

/** Minimal dotenv parse. Only key presence is used; values are never printed for secrets. */
function parseEnvFile(path) {
  if (!existsSync(path)) return undefined;
  const values = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    values.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
  }
  return values;
}

function describe(key, values) {
  const raw = values.get(key) ?? process.env[key];
  if (!raw || raw.length === 0) return undefined;
  if (SECRET.test(key)) return "set (hidden)";
  return raw.length > 46 ? `${raw.slice(0, 43)}...` : raw;
}

let failures = 0;
const groups = scope ? GROUPS.filter((g) => g.name === scope) : GROUPS;

if (groups.length === 0) {
  console.error(`Unknown scope "${scope}". Use one of: ${GROUPS.map((g) => g.name).join(", ")}`);
  process.exit(2);
}

for (const group of groups) {
  console.log(`\n${group.name}`);
  const values = parseEnvFile(group.file);

  if (!values) {
    console.log(
      `  ${YELLOW}no ${group.file.replace(root, ".")}${RESET} ${DIM}(copy ${group.example.replace(root, ".")})${RESET}`,
    );
    failures += group.required.length;
    for (const key of group.required) {
      console.log(`  ${RED}missing${RESET}  ${key}`);
    }
    continue;
  }

  for (const key of group.required) {
    const value = describe(key, values);
    if (value) {
      console.log(`  ${GREEN}ok${RESET}       ${key} ${DIM}= ${value}${RESET}`);
    } else {
      console.log(`  ${RED}missing${RESET}  ${key}`);
      failures++;
    }
  }

  for (const key of group.optional) {
    const value = describe(key, values);
    console.log(
      value
        ? `  ${GREEN}ok${RESET}       ${key} ${DIM}= ${value}${RESET}`
        : `  ${DIM}unset    ${key}${RESET}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} required variable(s) missing.`);
  process.exit(1);
}

console.log(`\n${GREEN}All required variables present.${RESET}`);
