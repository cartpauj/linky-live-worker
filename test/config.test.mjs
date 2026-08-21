import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createWorkerRoute } from '../src/cf.js';

/**
 * `name` and `account_id` are wrangler's build-time settings and are invisible to
 * the running Worker, so WORKER_SCRIPT_NAME and CF_ACCOUNT_ID repeat them. A
 * mismatch deploys cleanly and only fails later, when provisioning a site, so the
 * errors have to name the cause.
 */

const env = {
	CF_ZONE_ID: 'zone123',
	CF_API_TOKEN: 'token',
	WORKER_SCRIPT_NAME: 'linky-live',
};

test('a missing WORKER_SCRIPT_NAME says exactly what to add', async () => {
	await assert.rejects(
		() => createWorkerRoute({ ...env, WORKER_SCRIPT_NAME: undefined }, 'linky-abc123.example.com'),
		/WORKER_SCRIPT_NAME is not set.*\[vars\].*wrangler\.toml/s,
	);
});

test('an unknown script name is explained, not passed through raw', async () => {
	// What Cloudflare actually returns is a generic lookup failure that gives no
	// hint that two config values have drifted apart.
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({ success: false, errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }] }),
			{ status: 404, headers: { 'Content-Type': 'application/json' } },
		);

	await assert.rejects(
		() => createWorkerRoute(env, 'linky-abc123.example.com'),
		(err) => {
			assert.match(err.message, /No Worker named "linky-live" exists/);
			assert.match(err.message, /must match the `name`/);

			return true;
		},
	);
});

test('unrelated Cloudflare failures are not misattributed', async () => {
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }),
			{ status: 403, headers: { 'Content-Type': 'application/json' } },
		);

	await assert.rejects(
		() => createWorkerRoute(env, 'linky-abc123.example.com'),
		(err) => {
			assert.match(err.message, /Invalid access token/);
			assert.doesNotMatch(err.message, /must match the `name`/, 'a token problem is not a naming problem');

			return true;
		},
	);
});

test('the template pairs the duplicated values consistently', () => {
	const template = readFileSync('wrangler.example.toml', 'utf8');

	const name = template.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
	const script = template.match(/^WORKER_SCRIPT_NAME\s*=\s*"([^"]+)"/m)?.[1];

	assert.ok(name, 'template must define name');
	assert.ok(script, 'template must define WORKER_SCRIPT_NAME');

	// Someone copying the template should not start out with a mismatch.
	assert.equal(script, name, 'WORKER_SCRIPT_NAME must match name in the template');

	// And the duplication must be explained where it is written.
	assert.match(template, /not visible to the running Worker/, 'template must explain why it repeats');
});
