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

import { readConfig } from './config.mjs';

const config = readConfig();

if (config.missing) {
	console.error('\nNo wrangler.toml here. Run this from the project root, after:\n  cp wrangler.example.toml wrangler.toml\n');
	process.exit(1);
}

if (config.unset(config.accountId)) {
	console.error('\naccount_id is not set in wrangler.toml. Run:\n  npx wrangler whoami\n\nthen put the id in as `── 1 ──` says. `npm run check` lists anything else missing.\n');
	process.exit(1);
}

if (config.unset(config.kvId)) {
	console.error('\nNo KV namespace id in wrangler.toml. Run:\n  npm run kv\n\nwhich creates the namespace and writes its id in for you.\n');
	process.exit(1);
}

if (!config.apiHost) {
	console.error('\nZONE_NAME is not set in wrangler.toml, so the API hostname cannot be built.\nRun `npm run check`.\n');
	process.exit(1);
}

/*
 * Both values are passed rather than written in wrangler.toml.
 *
 * TOML has no variable references, so `account_id` could not be reused for the
 * var the Worker reads, and ZONE_NAME could not be reused in a route pattern.
 * Composing them here keeps each entered exactly once.
 */
const args = [
	'wrangler',
	'deploy',
	'--var',
	`CF_ACCOUNT_ID:${config.accountId}`,
	'--domains',
	config.apiHost,
	...process.argv.slice(2),
];

console.log(`\nDeploying to account ${config.accountId.slice(0, 8)}…`);
console.log(`Attaching custom domain ${config.apiHost}\n`);

try {
	execFileSync('npx', args, { stdio: 'inherit' });
} catch {
	// wrangler has already printed why.
	process.exit(1);
}
