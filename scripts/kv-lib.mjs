/**
 * The one place that shells out to wrangler.
 *
 * `keys.mjs` and `admins.mjs` both read and write KV, and both grew their own
 * copy of these four functions. The copies then disagreed: one passed `--force`
 * to `kv key delete`, which wrangler v4 does not accept, so deleting anything
 * failed with "Unknown argument: force" — in the middle of a command that had
 * already written its half of the change.
 *
 * There is no way to type-check a flag against a CLI, so the defence is to have
 * exactly one call site per operation. A test keeps it that way by refusing to
 * let either script build a `wrangler kv` command of its own.
 */

import { execFileSync } from 'node:child_process';

const BINDING = 'LINKY';

export function fail(message) {
	console.error(`\n${message}\n`);
	process.exit(1);
}

export function wrangler(args, { quiet = false } = {}) {
	try {
		return execFileSync('npx', ['wrangler', ...args], {
			encoding: 'utf8',
			stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
		});
	} catch (err) {
		if (quiet) {
			return null;
		}

		fail(`wrangler failed:\n${err.stderr || err.stdout || err.message}`);
	}

	return null;
}

const scope = [`--binding=${BINDING}`, '--remote'];

export const kvPut = (key, value) => wrangler(['kv', 'key', 'put', key, value, ...scope]);

export const kvGet = (key) => {
	const out = wrangler(['kv', 'key', 'get', key, ...scope], { quiet: true });

	try {
		return out ? JSON.parse(out) : null;
	} catch {
		return null;
	}
};

/*
 * No `--force`: wrangler v4 has no such flag here and rejects the whole command
 * if it is passed. Deleting a key it cannot find is not an error either way, so
 * there was never anything to force.
 */
export const kvDelete = (key) => wrangler(['kv', 'key', 'delete', key, ...scope]);

/** Every key under a prefix, as a plain array of names. */
export const kvList = (prefix) => {
	const raw = wrangler(['kv', 'key', 'list', ...scope, `--prefix=${prefix}`]);

	return JSON.parse(raw || '[]').map(({ name }) => name);
};
