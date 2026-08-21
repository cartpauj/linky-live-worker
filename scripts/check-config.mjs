#!/usr/bin/env node

/**
 * Report what still needs filling in before a deploy will work.
 *
 * wrangler validates syntax but not content, so a leftover placeholder surfaces
 * later as an opaque Cloudflare error — creating the KV namespace with
 * account_id unset fails with "Could not route to
 * /client/v4/accounts/YOUR_ACCOUNT_ID/... [code: 7003]", which does not point at
 * the cause.
 */

import { readFileSync } from 'node:fs';

// CF_ACCOUNT_ID is deliberately absent: the Worker asks the API token which
// account it belongs to, so it only needs setting when the token can see several.
const REQUIRED = [
	{ key: 'account_id', where: 'top level', what: 'Your Cloudflare account id — `wrangler whoami`' },
	{ key: 'ZONE_NAME', where: '[vars]', what: 'The domain links are created on, e.g. example.com' },
	{ key: 'CF_ZONE_ID', where: '[vars]', what: 'That zone\'s id, from its Cloudflare overview page' },
	{ key: 'id', where: '[[kv_namespaces]]', what: 'From `wrangler kv namespace create LINKY`' },
];

/** Fields with working defaults, checked only for internal consistency. */
const PAIRED = [['name', 'WORKER_SCRIPT_NAME']];

let config;

try {
	config = readFileSync('wrangler.toml', 'utf8');
} catch {
	console.error('\nNo wrangler.toml here. Run this from the project root, after:\n  cp wrangler.example.toml wrangler.toml\n');
	process.exit(1);
}

const value = (key) => {
	const match = config.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));

	return match ? match[1] : null;
};

const problems = [];

for (const { key, where, what } of REQUIRED) {
	const found = value(key);

	if (found === null) {
		problems.push({ key, where, why: 'missing entirely', what });
	} else if (/YOUR_|^$/.test(found)) {
		problems.push({ key, where, why: `still "${found}"`, what });
	}
}

// name and WORKER_SCRIPT_NAME must agree, or provisioning fails at route creation.
for (const [a, b] of PAIRED) {
	const left = value(a);
	const right = value(b);

	if (left && right && left !== right) {
		problems.push({
			key: b,
			where: '[vars]',
			why: `"${right}" does not match ${a} "${left}"`,
			what: `Set both to the same value — ${a} is invisible to the running Worker`,
		});
	}
}

const secretHint = '\nAlso required, but not in this file:\n'
	+ '  CF_API_TOKEN         npx wrangler secret put CF_API_TOKEN\n';

if (!problems.length) {
	console.log('\nwrangler.toml looks complete.\n');
	console.log(secretHint);
	process.exit(0);
}

console.error(`\n${problems.length} thing(s) still to set in wrangler.toml:\n`);

for (const { key, where, why, what } of problems) {
	console.error(`  ${key}  (${where})`);
	console.error(`    ${why}`);
	console.error(`    ${what}\n`);
}

console.error(secretHint);
process.exit(1);
