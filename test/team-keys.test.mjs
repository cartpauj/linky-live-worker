import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
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


test('a key stored in KV is accepted', async () => {
	const hash = await sha256Hex('linky_alicekey');
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Alice', active: true } } });

	assert.equal((await status(env, 'linky_alicekey')).status, 200);
});

test('an unknown key is rejected', async () => {
	const hash = await sha256Hex('linky_alicekey');
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Alice', active: true } } });

	// Including near misses: a truncated or extended key must not pass.
	for (const key of ['linky_wrong', 'Alice', '', 'linky_alicake', 'linky_alicekeyy']) {
		assert.equal((await status(env, key)).status, 401, `"${key}" must be rejected`);
	}
});

test('surrounding whitespace on a pasted key is forgiven', async () => {
	const hash = await sha256Hex('linky_alicekey');
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Alice', active: true } } });

	// Keys travel through chat and password managers, so a stray space is common
	// and is trimmed on purpose. Anything else about the key must still match.
	assert.equal((await status(env, 'linky_alicekey ')).status, 200);
	assert.equal((await status(env, '  linky_alicekey')).status, 200);
});

test('a revoked key stops working without being deleted', async () => {
	const hash = await sha256Hex('linky_bobkey');

	// revoke keeps the record so the name stays visible in `list`.
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Bob', active: false } } });

	assert.equal((await status(env, 'linky_bobkey')).status, 401);
});

test('access is decided by the key, never by the name beside it', async () => {
	const hash = await sha256Hex('linky_samekey');

	// Renaming someone must not orphan their sites, so identity is the key hash.
	for (const name of ['Alice', 'Alice Smith', 'alice@example.com']) {
		const env = baseEnv({
			seed: {
				[`teamkey:${hash}`]: { name, active: true },
				[`site:${hash}:site-1`]: { siteId: 'site-1', hostname: 'linky-abc123.example.com', bypassPaths: [] },
			},
		});

		const body = await (await status(env, 'linky_samekey')).json();

		assert.equal(body.sites.length, 1, `renaming to "${name}" must not lose sites`);
	}
});

test('the deployed version is reported to authenticated callers only', async () => {
	const hash = await sha256Hex('linky_alicekey');
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Alice', active: true } } });

	const ok = await (await status(env, 'linky_alicekey')).json();
	assert.match(ok.version, /^\d+\.\d+\.\d+$/);

	// Telling a stranger which build is deployed only helps them fingerprint it.
	const denied = await (await status(env, 'nope')).json();
	assert.equal(denied.version, undefined);
});

test('provisioning marks the hostname record as owned by an active key', async () => {
	const hash = await sha256Hex('linky_alicekey');
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Alice', active: true } } });

	// Provisioning talks to Cloudflare four times; the ids are all this test needs
	// back, so one canned success answers every call.
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ success: true, errors: [], result: { id: 'res-1', token: 'tok' } }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});

	const res = await worker.fetch(
		new Request('https://linky-live.example.com/v1/provision', {
			method: 'POST',
			headers: { Authorization: 'Bearer linky_alicekey', 'Content-Type': 'application/json' },
			body: JSON.stringify({ siteId: 'site-1', siteName: 'my-site', port: 10063 }),
		}),
		env,
	);

	const body = await res.json();

	assert.equal(body.ok, true, JSON.stringify(body));

	// The gateway reads this rather than looking the owner up on every request, so
	// it has to be written whenever a hostname record is. Only an active key can
	// get this far, which is why writing true here is always writing the truth.
	const host = await env.LINKY.get(`host:${body.site.hostname}`, 'json');

	assert.equal(host.ownerActive, true);
});

/* ------------------------------------------------------------------ *
 * Telling apart a wrong key and a thing that is not a key
 * ------------------------------------------------------------------ */

test('a pasted block is named as such, not called an invalid key', async () => {
	/*
	 * The admin UI shows a service line and a key line together. Pasting both into
	 * a single-line field flattens them into one string that still ends in the
	 * key's last six characters — so the fragment the add-on displays matches the
	 * fragment on the server, and "invalid or missing API key" sends somebody
	 * checking the one thing that is fine.
	 */
	const key = 'linky_alicekey';
	const hash = await sha256Hex(key);
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Alice', active: true } } });

	const pasted = `Service:  linky-live.example.com Key:      ${key}`;
	const res = await status(env, pasted);
	const body = await res.json();

	assert.equal(res.status, 401);
	assert.match(body.error, /does not look like a Linky Live key/);
	assert.match(body.error, /Key line on its own/, 'and says what to do instead');
});

test('a key-shaped value we do not know says so plainly', async () => {
	const hash = await sha256Hex('linky_alicekey');
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Alice', active: true } } });

	// Right shape, wrong key — including a key truncated by one character, which
	// is the other common paste mistake and is indistinguishable from any other
	// unknown key.
	for (const key of ['linky_nobodyskey', 'linky_alicake', 'linky_alicekeyy']) {
		const body = await (await status(env, key)).json();

		assert.match(body.error, /not recognised/, `"${key}" should read as unknown, not malformed`);
	}
});

test('a revoked key is told it was revoked', async () => {
	const key = 'linky_alicekey';
	const hash = await sha256Hex(key);
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Alice', active: false } } });

	const res = await status(env, key);

	assert.equal(res.status, 401);
	assert.match((await res.json()).error, /revoked/);
});

test('no header at all says the key is missing', async () => {
	const env = baseEnv({ seed: {} });
	const res = await worker.fetch(new Request('https://linky-live.example.com/v1/status'), env);

	assert.equal(res.status, 401);
	assert.match((await res.json()).error, /Missing API key/);
});

test('an oddly shaped key still works if it is genuinely ours', async () => {
	/*
	 * The shape check exists to word an error, not to authenticate. If it gated
	 * sign-in, the prefix would quietly become part of the credential format and
	 * any key predating that rule would stop working.
	 */
	const key = 'a-key-with-no-prefix-at-all';
	const hash = await sha256Hex(key);
	const env = baseEnv({ seed: { [`teamkey:${hash}`]: { name: 'Legacy', active: true } } });

	assert.equal((await status(env, key)).status, 200);
});
