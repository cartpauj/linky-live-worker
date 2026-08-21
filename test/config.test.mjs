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

		// An optional setting may appear commented out, since the point is that it
		// normally stays unset.
		const inTemplate = new RegExp(`^\\s*#?\\s*${name}\\s*=`, 'm').test(template);

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

	assert.equal(placeholders.length, 4, `expected 4 placeholders, found ${placeholders.length}`);

	for (const { key, comment } of placeholders) {
		assert.match(comment, /──\s*\d\s*──/, `${key} must carry a numbered marker`);
		assert.ok(comment.replace(/[#─\d\s]/g, '').length > 12, `${key} must say what to put there`);
	}

	// Numbered in the order they are filled, so following them top to bottom works.
	const numbers = placeholders.map((p) => Number(p.comment.match(/──\s*(\d)\s*──/)[1]));

	assert.deepEqual(numbers, [1, 2, 3, 4], 'markers must run 1-4 in file order');
});

test('the setup doc points at the numbering rather than restating it', () => {
	const setup = readFileSync('SETUP.md', 'utf8');

	// Listing every field in both places is how the two drifted apart before.
	assert.match(setup, /four placeholders/i, 'the doc must say how many there are');
	assert.match(setup, /── 1 ──/, 'and refer to the markers in the file');

	// The one ordering constraint cannot be inferred from the file alone.
	assert.match(setup, /after step 1/, 'must say the KV step comes after the account id');
	assert.match(setup, /7003/, 'and name the error it causes');
});

test('the account id is discovered rather than configured twice', async () => {
	const { accountId } = await import('../src/cf.js');

	const store = new Map();
	const env = {
		CF_API_TOKEN: 'token',
		LINKY: {
			get: async (k) => store.get(k) ?? null,
			put: async (k, v) => store.set(k, v),
		},
	};

	let calls = 0;

	globalThis.fetch = async () => {
		calls += 1;

		return new Response(
			JSON.stringify({ success: true, result: [{ id: 'acc123', name: 'Mine' }], errors: [] }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	};

	// Asking for account_id a second time under [vars] was pure duplication: the
	// token already knows which account it belongs to.
	assert.equal(await accountId(env), 'acc123');

	// Cached, because this runs on every provision.
	assert.equal(await accountId(env), 'acc123');
	assert.equal(calls, 1, 'the lookup must happen once, not per call');
});

test('an explicit account id always wins', async () => {
	const { accountId } = await import('../src/cf.js');

	globalThis.fetch = async () => {
		throw new Error('should not be called');
	};

	// Set deliberately, so it must not be second-guessed.
	assert.equal(await accountId({ CF_ACCOUNT_ID: 'explicit' }), 'explicit');
});

test('an ambiguous token says what to set rather than guessing', async () => {
	const { accountId } = await import('../src/cf.js');

	const env = {
		CF_API_TOKEN: 'token',
		LINKY: { get: async () => null, put: async () => {} },
	};

	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({ success: true, result: [{ id: 'a' }, { id: 'b' }], errors: [] }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);

	// Picking one of several would silently provision into the wrong account.
	await assert.rejects(() => accountId(env), /2 accounts.*Set CF_ACCOUNT_ID/s);
});

test('a token that can see no accounts is explained', async () => {
	const { accountId } = await import('../src/cf.js');

	const env = {
		CF_API_TOKEN: 'token',
		LINKY: { get: async () => null, put: async () => {} },
	};

	globalThis.fetch = async () =>
		new Response(JSON.stringify({ success: true, result: [], errors: [] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});

	await assert.rejects(() => accountId(env), /Set CF_ACCOUNT_ID/);
});

test('a token that cannot list accounts still explains the one-line fix', async () => {
	const { accountId } = await import('../src/cf.js');

	const env = {
		CF_API_TOKEN: 'token',
		LINKY: { get: async () => null, put: async () => {} },
	};

	// Discovery depends on a permission we do not explicitly request, so a refusal
	// has to be a signpost rather than a dead end.
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				success: false,
				errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
			}),
			{ status: 403, headers: { 'Content-Type': 'application/json' } },
		);

	await assert.rejects(
		() => accountId(env),
		(err) => {
			assert.match(err.message, /Set CF_ACCOUNT_ID under \[vars\]/, 'must name the fix');
			assert.match(err.message, /Unauthorized/, 'and keep the underlying cause');

			return true;
		},
	);
});

test('the deploy wrapper passes the account id through from account_id', () => {
	const wrapper = readFileSync('scripts/deploy.mjs', 'utf8');

	// TOML has no variable references and wrangler does not expose account_id to
	// the running Worker, so this is what keeps it entered once.
	assert.match(wrapper, /account_id/, 'must read account_id from wrangler.toml');
	assert.match(wrapper, /--var/, 'and pass it as a wrangler var');
	assert.match(wrapper, /CF_ACCOUNT_ID:/, 'under the name the Worker reads');

	// Extra flags must reach wrangler, or the wrapper becomes a dead end.
	assert.match(wrapper, /process\.argv\.slice\(2\)/, 'must pass extra flags through');

	// A placeholder must be caught before deploying, not surfaced as a Cloudflare
	// 7003 later. The check itself lives in the shared config reader.
	assert.match(wrapper, /config\.unset\(config\.accountId\)/, 'must reject an unset account_id');

	const reader = readFileSync('scripts/config.mjs', 'utf8');

	assert.match(reader, /\^YOUR_/, 'the reader must recognise placeholders');
});

test('the template does not ask for the account id a second time', () => {
	const template = readFileSync('wrangler.example.toml', 'utf8');

	// It may appear as a commented-out override, but never as something to fill in.
	const active = template
		.split('\n')
		.filter((l) => !l.trim().startsWith('#'))
		.join('\n');

	assert.doesNotMatch(active, /CF_ACCOUNT_ID/, 'CF_ACCOUNT_ID must not be an active field');

	// And account_id itself is still asked for, exactly once.
	const asks = [...template.matchAll(/^\s*account_id\s*=/gm)];

	assert.equal(asks.length, 1, 'account_id must appear exactly once');
});

test('the API hostname is composed, not written out twice', async () => {
	const { readConfig } = await import('../scripts/config.mjs');
	const template = readFileSync('wrangler.example.toml', 'utf8');

	// A route pattern would have spelled the zone a second time, with nothing to
	// keep the two in step.
	assert.doesNotMatch(template, /\[\[routes\]\]/, 'there should be no route block to keep in sync');
	assert.match(template, /^API_SUBDOMAIN\s*=/m, 'the subdomain is configured on its own');

	// And the zone appears exactly once as something to fill in.
	const zoneAsks = [...template.matchAll(/^\s*ZONE_NAME\s*=/gm)];

	assert.equal(zoneAsks.length, 1, 'ZONE_NAME must appear exactly once');

	assert.equal(typeof readConfig, 'function', 'the composition lives in one shared place');
});

test('the deploy wrapper attaches the composed domain', () => {
	const wrapper = readFileSync('scripts/deploy.mjs', 'utf8');

	assert.match(wrapper, /--domains/, 'must attach the API hostname as a custom domain');
	assert.match(wrapper, /config\.apiHost/, 'built from the config rather than hardcoded');

	// Printed, so a wrong hostname is visible at deploy rather than discovered later.
	assert.match(wrapper, /Attaching custom domain/, 'must say what it is attaching');
});

test('every command the scripts tell you to run is documented', () => {
	const readme = readFileSync('README.md', 'utf8');
	const setup = readFileSync('SETUP.md', 'utf8');

	// `npm run kv` ends by pointing at `npm run check`, which the README did not
	// mention anywhere — a dead end for anyone following the quick start rather
	// than SETUP.md. Anything the tooling names has to exist in both docs.
	const named = new Set();

	for (const file of ['kv.mjs', 'deploy.mjs', 'check-config.mjs', 'keys.mjs']) {
		for (const [, name] of readFileSync(`scripts/${file}`, 'utf8').matchAll(/npm run ([a-z]+)/g)) {
			named.add(name);
		}
	}

	assert.ok(named.size >= 3, 'expected the scripts to cross-reference each other');

	for (const name of named) {
		assert.match(readme, new RegExp(`npm run ${name}\\b`), `README must document npm run ${name}`);
		assert.match(setup, new RegExp(`npm run ${name}\\b`), `SETUP must document npm run ${name}`);
	}

	// And each one has to be a script that exists, or the docs send people at a
	// command npm cannot run.
	const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

	for (const name of named) {
		assert.ok(pkg.scripts[name], `npm run ${name} is referenced but not defined`);
	}
});
