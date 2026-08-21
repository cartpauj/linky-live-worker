import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { parseTeamKeys } from '../src/index.js';
import { sha256Hex } from '../src/util.js';

function fakeKV(seed = {}) {
	const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));

	return {
		store,
		async get(key, type) {
			const raw = store.get(key);
			if (raw === undefined) return null;
			return type === 'json' ? JSON.parse(raw) : raw;
		},
		async put(key, value) { store.set(key, value); },
		async delete(key) { store.delete(key); },
		async list({ prefix }) {
			return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
		},
	};
}

const baseEnv = (over = {}) => ({
	LINKY: fakeKV(over.seed || {}),
	ZONE_NAME: 'example.com',
	CONTROL_HOSTNAME: 'linky-live.example.com',
	WORKER_SCRIPT_NAME: 'linky-live-links',
	CF_ACCOUNT_ID: 'acct',
	CF_ZONE_ID: 'zone',
	CF_API_TOKEN: 'token',
	TEAM_KEYS: over.TEAM_KEYS,
});

const status = (env, key) =>
	worker.fetch(
		new Request('https://linky-live.example.com/v1/status', { headers: { Authorization: `Bearer ${key}` } }),
		env,
	);

test('parses the dashboard key list in every reasonable shape', () => {
	const parsed = parseTeamKeys(`
		# Company live link keys
		Paul = linky_paulkey

		Dave: linky_davekey
		Ana Maria = linky_anakey
		linky_barekey
	`);

	assert.deepEqual(parsed, [
		{ name: 'Paul', key: 'linky_paulkey' },
		{ name: 'Dave', key: 'linky_davekey' },
		{ name: 'Ana Maria', key: 'linky_anakey' },
		{ name: 'unnamed', key: 'linky_barekey' },
	]);

	// Comma-separated on one line, for a quick single-field edit.
	assert.deepEqual(parseTeamKeys('Paul=linky_a,Dave=linky_b'), [
		{ name: 'Paul', key: 'linky_a' },
		{ name: 'Dave', key: 'linky_b' },
	]);
});

test('a malformed or empty list denies everyone rather than admitting anyone', () => {
	// The dangerous failure mode for a hand-edited field is fail-open: an unusable
	// value must grant nobody access, never everybody.
	for (const raw of [undefined, '', '   ', '\n\n', '# only a comment', 'Paul=', ',,,', null, 42]) {
		assert.deepEqual(parseTeamKeys(raw), [], `must yield no keys for ${JSON.stringify(raw)}`);
	}
});

test('a key with a missing name still works, but is reported as unnamed', () => {
	// Someone fat-fingering the label should not lock that person out — the key
	// was still deliberately listed. It is only the name that is missing.
	assert.deepEqual(parseTeamKeys('=linky_x'), [{ name: 'unnamed', key: 'linky_x' }]);
	assert.deepEqual(parseTeamKeys('linky_x'), [{ name: 'unnamed', key: 'linky_x' }]);
});

test('a key listed in the dashboard variable is accepted', async () => {
	const env = baseEnv({ TEAM_KEYS: 'Paul = linky_paulkey\nDave: linky_davekey' });

	for (const key of ['linky_paulkey', 'linky_davekey']) {
		const res = await status(env, key);
		assert.equal(res.status, 200, `${key} should be accepted`);
	}
});

test('removing a line from the variable revokes that person immediately', async () => {
	const before = baseEnv({ TEAM_KEYS: 'Paul = linky_paulkey\nDave: linky_davekey' });
	assert.equal((await status(before, 'linky_davekey')).status, 200);

	// Dave leaves: the admin deletes his line in the dashboard.
	const after = baseEnv({ TEAM_KEYS: 'Paul = linky_paulkey' });

	assert.equal((await status(after, 'linky_davekey')).status, 401, 'Dave must be locked out');
	assert.equal((await status(after, 'linky_paulkey')).status, 200, 'Paul must be unaffected');
});

test('keys not in the list are rejected, including near misses', async () => {
	const env = baseEnv({ TEAM_KEYS: 'Paul = linky_paulkey' });

	for (const key of ['linky_paulke', 'linky_paulkeyy', 'LINKY_PAULKEY', 'Paul', 'linky_', '']) {
		assert.equal((await status(env, key)).status, 401, `${key} must be rejected`);
	}
});

test('the name field is never mistaken for a key', async () => {
	const env = baseEnv({ TEAM_KEYS: 'Paul = linky_paulkey' });

	// Authenticating as the label rather than the secret must fail.
	assert.equal((await status(env, 'Paul')).status, 401);
	assert.equal((await status(env, 'Paul = linky_paulkey')).status, 401);
});

test('the name is a label only and never affects access', async () => {
	const key = 'linky_samekey';

	// Same key, wildly different labels — all must authenticate identically.
	for (const raw of [
		`Paul = ${key}`,
		`Paul Smith = ${key}`,
		`paul@example.com: ${key}`,
		`  Paul (laptop)  =  ${key}  `,
		key,
	]) {
		assert.equal((await status(baseEnv({ TEAM_KEYS: raw }), key)).status, 200, `failed for: ${raw}`);
	}
});

test('renaming a person does not lose their sites', async () => {
	const key = 'linky_renamekey';
	const hash = await sha256Hex(key);

	// A site provisioned while the label said "Paul".
	const seed = { [`site:${hash}:site-1`]: { siteId: 'site-1', hostname: 'linky-abc123.example.com', bypassPaths: [] } };

	// Admin later corrects the label. Sites are keyed on the key's hash, not the
	// name, so the subdomain must still be attached to the same site.
	for (const label of ['Paul', 'Paul Smith', 'paul@example.com']) {
		const body = await (await status(baseEnv({ TEAM_KEYS: `${label} = ${key}`, seed }), key)).json();

		assert.equal(body.sites.length, 1, `renaming to "${label}" must not orphan sites`);
		assert.equal(body.sites[0].hostname, 'linky-abc123.example.com');
	}
});

test('two people cannot be merged by giving them the same name', async () => {
	const env = baseEnv({ TEAM_KEYS: 'Dev = linky_firstkey\nDev = linky_secondkey' });

	// Duplicate labels are fine; each key is still a separate identity.
	assert.equal((await status(env, 'linky_firstkey')).status, 200);
	assert.equal((await status(env, 'linky_secondkey')).status, 200);

	const first = await (await status(env, 'linky_firstkey')).json();
	const second = await (await status(env, 'linky_secondkey')).json();

	assert.deepEqual(first.sites, []);
	assert.deepEqual(second.sites, []);
});


test('the status endpoint reports the deployed version', async () => {
	const env = baseEnv({ TEAM_KEYS: 'Paul = linky_paulkey' });

	const body = await (await status(env, 'linky_paulkey')).json();

	// Operators need to know which build is live: a deploy affects everyone at
	// once, and the Worker shares a wire contract with the add-on.
	assert.match(body.version, /^\d+\.\d+\.\d+$/, `expected a semver, got ${body.version}`);

	// It must come from package.json rather than a hand-maintained constant, or the
	// two drift and the reported version becomes a lie.
	const pkg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync('package.json', 'utf8')));

	assert.equal(body.version, pkg.version, 'reported version must match package.json');
});

test('the version is not announced to anonymous callers', async () => {
	const env = baseEnv({ TEAM_KEYS: 'Paul = linky_paulkey' });

	const res = await status(env, 'wrong-key');
	const body = await res.json();

	// Telling a stranger which build is deployed only helps them fingerprint it.
	assert.equal(res.status, 401);
	assert.equal(body.version, undefined);
});
