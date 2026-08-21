#!/usr/bin/env node

/**
 * Deploy, passing the account id through from `account_id`.
 *
 * wrangler needs `account_id` in wrangler.toml to know where to deploy, but does
 * not expose it to the running Worker — which makes its own Cloudflare API calls
 * and needs the same id. TOML has no variable references, so the alternatives were
 * writing the id twice or discovering it at runtime. Reading it here and passing
 * it as `--var` keeps one source of truth and costs nothing at runtime.
 *
 *   npm run deploy            -- any extra flags are passed straight through
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let config;

try {
	config = readFileSync('wrangler.toml', 'utf8');
} catch {
	console.error('\nNo wrangler.toml here. Run this from the project root, after:\n  cp wrangler.example.toml wrangler.toml\n');
	process.exit(1);
}

const accountId = config.match(/^\s*account_id\s*=\s*"([^"]*)"/m)?.[1];

if (!accountId || /^YOUR_|^$/.test(accountId)) {
	console.error('\naccount_id is not set in wrangler.toml. Run:\n  npx wrangler whoami\n\nthen put the id in as `── 1 ──` says. `npm run check` lists anything else missing.\n');
	process.exit(1);
}

// Anything already set in [vars] wins, so an operator can still override.
const args = [
	'wrangler',
	'deploy',
	'--var',
	`CF_ACCOUNT_ID:${accountId}`,
	...process.argv.slice(2),
];

console.log(`\nDeploying to account ${accountId.slice(0, 8)}…\n`);

try {
	execFileSync('npx', args, { stdio: 'inherit' });
} catch {
	// wrangler has already printed why.
	process.exit(1);
}
