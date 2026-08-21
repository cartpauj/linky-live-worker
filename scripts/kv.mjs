#!/usr/bin/env node

/**
 * Create the KV namespace and write its id into wrangler.toml.
 *
 * `wrangler kv namespace create` prints the id and expects you to copy it into
 * the config by hand, which is the one placeholder nobody can fill in ahead of
 * time — it does not exist until the command runs. Copying it across was the
 * step most likely to be fumbled, and getting it wrong deploys cleanly and
 * fails later on the first provision.
 *
 * Re-running is safe: an id already in the file is left alone, and an existing
 * namespace is reused rather than a second one created.
 *
 *   npm run kv
 *
 * wrangler 4 has `--update-config`, which is deliberately not used: it appends a
 * fresh [[kv_namespaces]] block rather than filling in the one the template
 * already ships, leaving two entries for the same binding.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { readConfig } from './config.mjs';

const BINDING = 'LINKY';

const config = readConfig();

if (config.missing) {
	console.error('\nNo wrangler.toml here. Run this from the project root, after:\n  cp wrangler.example.toml wrangler.toml\n');
	process.exit(1);
}

/*
 * wrangler reads account_id from wrangler.toml to know whose namespaces to
 * create. With the placeholder still in place it fails with "Could not route to
 * /client/v4/accounts/YOUR_ACCOUNT_ID/... [code: 7003]", which does not point at
 * the cause — so it is caught here instead.
 */
if (config.unset(config.accountId)) {
	console.error('\naccount_id is not set in wrangler.toml, and wrangler needs it to know which\naccount to create the namespace in. Run:\n\n  npx wrangler whoami\n\nput the id in as `── 1 ──` says, then run `npm run kv` again.\n');
	process.exit(1);
}

if (!config.unset(config.kvId)) {
	console.log(`\nwrangler.toml already has a KV namespace id (${config.kvId}). Nothing to do.\n`);
	console.log('To point at a different namespace, clear that `id` and run this again.\n');
	process.exit(0);
}

/** Run wrangler and hand back what it printed, or null if it failed. */
function wrangler(args) {
	try {
		return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
	} catch {
		// wrangler has already printed why, on the inherited stderr.
		return null;
	}
}

/**
 * Find an existing namespace for this binding.
 *
 * wrangler titles a namespace after the Worker and the binding, so re-running
 * after a half-finished setup would otherwise leave a trail of unused
 * namespaces, each looking as plausible as the last.
 */
function findExisting() {
	const output = wrangler(['kv', 'namespace', 'list']);

	if (output === null) {
		return null;
	}

	let namespaces;

	try {
		// The JSON is preceded by wrangler's own banner lines on some versions.
		namespaces = JSON.parse(output.slice(output.indexOf('[')));
	} catch {
		return null;
	}

	const match = namespaces.find(
		(ns) => ns.title === BINDING || ns.title?.endsWith(`-${BINDING}`),
	);

	return match ? match.id : null;
}

const existing = findExisting();

let id = existing;

if (existing) {
	console.log(`\nReusing the existing "${BINDING}" namespace.`);
} else {
	console.log(`\nCreating the "${BINDING}" namespace…`);

	const output = wrangler(['kv', 'namespace', 'create', BINDING]);

	if (output === null) {
		console.error('\nwrangler could not create the namespace. Nothing was written to wrangler.toml.\n');
		process.exit(1);
	}

	/*
	 * wrangler prints the id inside a TOML snippet for you to copy. Its wording
	 * has changed between versions, so the id itself is what gets matched — a
	 * 32-character hex string — rather than the sentence around it.
	 */
	id = output.match(/\b([0-9a-f]{32})\b/)?.[1] ?? null;

	if (!id) {
		console.error('\nThe namespace was created, but its id could not be read from wrangler\'s output:\n');
		console.error(output);
		console.error(`Put the id under [[kv_namespaces]] in wrangler.toml by hand, then run \`npm run check\`.\n`);
		process.exit(1);
	}
}

/*
 * Written into the `id` the template already ships, so the comments explaining
 * every other field survive. Scoped to after the [[kv_namespaces]] header so a
 * future top-level `id` could not be overwritten by accident.
 */
const text = readFileSync('wrangler.toml', 'utf8');
const header = text.indexOf('[[kv_namespaces]]');

if (header === -1) {
	console.error(`\nwrangler.toml has no [[kv_namespaces]] block to write to. The namespace id is:\n\n  ${id}\n\nAdd it as wrangler.example.toml shows.\n`);
	process.exit(1);
}

const before = text.slice(0, header);
const after = text.slice(header).replace(/^(\s*id\s*=\s*)"[^"]*"/m, `$1"${id}"`);

if (!after.includes(id)) {
	console.error(`\nCould not find the \`id\` line under [[kv_namespaces]] in wrangler.toml. The\nnamespace id is:\n\n  ${id}\n\nAdd it by hand, then run \`npm run check\`.\n`);
	process.exit(1);
}

writeFileSync('wrangler.toml', before + after);

console.log(`Wrote id = "${id}" to wrangler.toml.\n`);
console.log('Next:\n  npm run check\n');
