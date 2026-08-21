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

	// And the duplication must be explained where it is written, since that is
	// where someone notices it.
	assert.match(template, /cannot see/, 'template must explain why it repeats');
});

test('the checker requires exactly the values the Worker reads', () => {
	const checker = readFileSync('scripts/check-config.mjs', 'utf8');
	const template = readFileSync('wrangler.example.toml', 'utf8');

	// Anything the code reads from env must either be required by the checker or
	// ship with a working default, or someone deploys a Worker that fails at
	// runtime with no warning.
	const used = [...readFileSync('src/cf.js', 'utf8').matchAll(/env\.([A-Z_]+)/g)]
		.concat([...readFileSync('src/index.js', 'utf8').matchAll(/env\.([A-Z_]+)/g)])
		.map((m) => m[1]);

	for (const name of new Set(used)) {
		// LINKY is a binding, CF_API_TOKEN is a secret; neither is a [vars] entry.
		if (name === 'LINKY' || name === 'CF_API_TOKEN') {
			continue;
		}

		const inTemplate = new RegExp(`^\\s*${name}\\s*=`, 'm').test(template);

		assert.ok(inTemplate, `${name} is read by the Worker but absent from the template`);
	}

	// The secret cannot be checked from the file, so it must at least be mentioned.
	assert.match(checker, /CF_API_TOKEN/, 'the checker must mention the secret it cannot see');
});

test('every placeholder in the template is something the checker catches', () => {
	const template = readFileSync('wrangler.example.toml', 'utf8');
	const checker = readFileSync('scripts/check-config.mjs', 'utf8');

	// A placeholder nobody checks is a deploy that fails confusingly later.
	for (const line of template.split('\n')) {
		const match = line.match(/^\s*([A-Za-z_]+)\s*=\s*"[^"]*YOUR_[^"]*"/);

		if (match) {
			assert.match(
				checker,
				new RegExp(`'${match[1]}'`),
				`${match[1]} is a placeholder but the checker does not require it`,
			);
		}
	}
});

test('every placeholder is numbered and explained in the template', () => {
	const template = readFileSync('wrangler.example.toml', 'utf8');
	const lines = template.split('\n');

	// The template is where someone is looking while they edit, so each placeholder
	// has to carry its own instruction there. An unexplained one gets left in place
	// and surfaces later as an opaque Cloudflare error.
	const placeholders = [];

	lines.forEach((line, i) => {
		const match = line.match(/^\s*([A-Za-z_]+)\s*=\s*"[^"]*YOUR_[^"]*"/);

		if (!match) {
			return;
		}

		// The explanation is the comment block immediately above.
		const above = lines.slice(Math.max(0, i - 3), i).filter((l) => l.trim().startsWith('#'));

		placeholders.push({ key: match[1], comment: above.join(' ') });
	});

	assert.equal(placeholders.length, 6, `expected 6 placeholders, found ${placeholders.length}`);

	for (const { key, comment } of placeholders) {
		assert.match(comment, /──\s*\d\s*──/, `${key} must carry a numbered marker`);
		assert.ok(comment.replace(/[#─\d\s]/g, '').length > 12, `${key} must say what to put there`);
	}

	// Numbered in the order they are filled, so following them top to bottom works.
	const numbers = placeholders.map((p) => Number(p.comment.match(/──\s*(\d)\s*──/)[1]));

	assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6], 'markers must run 1-6 in file order');
});

test('the setup doc points at the numbering rather than restating it', () => {
	const setup = readFileSync('SETUP.md', 'utf8');

	// Listing every field in both places is how the two drifted apart before.
	assert.match(setup, /six placeholders/i, 'the doc must say how many there are');
	assert.match(setup, /── 1 ──/, 'and refer to the markers in the file');

	// The one ordering constraint cannot be inferred from the file alone.
	assert.match(setup, /after step 1/, 'must say the KV step comes after the account id');
	assert.match(setup, /7003/, 'and name the error it causes');
});
