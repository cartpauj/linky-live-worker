import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

const LIB = readFileSync('scripts/kv-lib.mjs', 'utf8');
const SCRIPTS = ['scripts/keys.mjs', 'scripts/admins.mjs'];

/*
 * These two scripts each had their own copy of the KV helpers, and the copies
 * disagreed: both passed `--force` to `kv key delete`, which wrangler v4 rejects
 * outright with "Unknown argument: force". Every delete failed — in the middle
 * of commands that had already written their half of the change.
 *
 * A flag cannot be type-checked against a CLI, so the defence is one call site
 * per operation. These tests keep it that way.
 */

test('only kv-lib shells out to wrangler', () => {
	for (const path of SCRIPTS) {
		const source = readFileSync(path, 'utf8');

		assert.ok(!source.includes('execFileSync'), `${path} must not spawn wrangler itself`);
		assert.ok(!/'kv',\s*'key'/.test(source), `${path} must not build its own kv command`);
	}
});

test('kv key delete is not passed a flag wrangler does not have', () => {
	// wrangler v4's `kv key delete` takes --binding, --namespace-id, --preview,
	// --local, --remote, --persist-to. Nothing else, and deleting a key that is
	// not there is not an error, so there was never anything to force.
	const call = LIB.match(/kvDelete\s*=\s*\(key\)\s*=>\s*wrangler\(\[([^\]]*)\]/);

	assert.ok(call, 'kvDelete must be a single wrangler call');
	assert.ok(!call[1].includes('force'), '--force is not a flag on kv key delete');
});

test('every kv command is scoped to the right namespace and to remote storage', () => {
	// Dropping --remote silently reads and writes a local file instead, which
	// looks like success and changes nothing that is deployed.
	assert.match(LIB, /const scope = \[`--binding=\$\{BINDING\}`, '--remote'\]/);

	for (const [, args] of LIB.matchAll(/wrangler\(\[([\s\S]*?)\]/g)) {
		assert.ok(args.includes('...scope'), `a kv call is missing the shared scope: ${args.trim()}`);
	}
});
