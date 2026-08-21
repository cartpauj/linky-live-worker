import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { sha256Hex } from '../src/util.js';

/**
 * Guards the privilege boundary around API keys.
 *
 * Keys may only be created, revoked, or listed by an admin holding Cloudflare
 * account access (via `npm run keys`). Nothing reachable over HTTP — and so
 * nothing the addon can reach with a leaked teammate key — may mint or alter
 * one. These tests exist to make a future regression loud.
 */

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

/** Stub the Cloudflare API so provisioning can run without network access. */
function stubCloudflareApi() {
	globalThis.fetch = async (input) => {
		const url = typeof input === 'string' ? input : input.url;

		const result = url.includes('/cfd_tunnel') && !url.includes('/configurations')
			? { id: 'tunnel-abc', token: 'tunnel-token' }
			: { id: 'resource-1' };

		return new Response(JSON.stringify({ success: true, result, errors: [] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};
}

const ADMIN_ISSUED_KEY = 'linky_issued-by-an-admin';

async function envWithKey() {
	const hash = await sha256Hex(ADMIN_ISSUED_KEY);

	return {
		env: {
			LINKY: fakeKV({}),
			TEAM_KEYS: `Paul = ${ADMIN_ISSUED_KEY}`,
			ZONE_NAME: 'example.com',
			HOSTNAME_PREFIX: 'linky',
			CONTROL_HOSTNAME: 'linky-live.example.com',
			WORKER_SCRIPT_NAME: 'linky-live-links',
			CF_ACCOUNT_ID: 'acct',
			CF_ZONE_ID: 'zone',
			CF_API_TOKEN: 'privileged-token',
		},
		hash,
	};
}

const call = (env, path, body, method = 'POST') =>
	worker.fetch(
		new Request(`https://linky-live.example.com${path}`, {
			method,
			...(body ? { body: JSON.stringify(body) } : {}),
			headers: { Authorization: `Bearer ${ADMIN_ISSUED_KEY}` },
		}),
		env,
	);

test('no HTTP endpoint mints, lists, or revokes API keys', async () => {
	stubCloudflareApi();
	const { env } = await envWithKey();

	// Every shape someone might add later, or probe for.
	for (const path of [
		'/v1/admin/keys',
		'/v1/keys',
		'/v1/keys/issue',
		'/v1/issue-key',
		'/v1/admin/keys/revoke',
		'/v1/teamkey',
	]) {
		const res = await call(env, path, { name: 'Attacker' });

		assert.equal(res.status, 404, `${path} must not exist`);

		const body = await res.json();
		assert.equal(body.ok, false);
	}
});

test('a valid teammate key cannot create or alter any key record', async () => {
	stubCloudflareApi();
	const { env, hash } = await envWithKey();

	const before = (await env.LINKY.list({ prefix: 'teamkey:' })).keys.map((k) => k.name);

	// Exercise the entire addon-facing surface with a legitimate key.
	await call(env, '/v1/provision', { siteId: 'site-1', siteName: 'my-site', port: 10063 });
	await call(env, '/v1/config', { siteId: 'site-1', authUser: 'cedar', bypassPaths: ['/mepr'] });
	await call(env, '/v1/status', null, 'GET');
	await call(env, '/v1/release', { siteId: 'site-1' });

	const after = (await env.LINKY.list({ prefix: 'teamkey:' })).keys.map((k) => k.name);

	// Keys live in a dashboard variable the worker can only read, so nothing it
	// writes can ever create or alter one.
	assert.deepEqual(after, before, 'no key record may appear in KV');
	assert.equal(after.length, 0);
	assert.equal(hash.length, 64, 'the caller is identified by a hash, not a stored record');
});

test('payload fields cannot smuggle a key record into KV', async () => {
	stubCloudflareApi();
	const { env } = await envWithKey();

	// Attempt to influence the KV key that provisioning writes.
	for (const siteId of ['../teamkey:deadbeef', 'x', 'site:evil', 'teamkey:deadbeef']) {
		await call(env, '/v1/provision', { siteId, siteName: 'x', port: 10063 });
	}

	const teamKeys = (await env.LINKY.list({ prefix: 'teamkey:' })).keys.map((k) => k.name);

	assert.equal(teamKeys.length, 0, 'no key record may appear in KV');

	// Anything written must live under the caller-scoped site: or host: namespace.
	for (const name of env.LINKY.store.keys()) {
		assert.ok(
			name.startsWith('site:') || name.startsWith('host:'),
			`unexpected KV namespace written: ${name}`,
		);
	}
});

test('the privileged Cloudflare token is never returned to a caller', async () => {
	stubCloudflareApi();
	const { env } = await envWithKey();

	const res = await call(env, '/v1/provision', { siteId: 'site-1', siteName: 'my-site', port: 10063 });
	const text = await res.text();

	assert.doesNotMatch(text, /privileged-token/, 'the CF API token must never leak to the addon');
	assert.match(text, /tunnel-token/, 'but the per-tunnel token is expected');
});

test('a caller cannot make the worker delete an arbitrary zone record', async () => {
	const deleted = [];

	// Record every destructive Cloudflare call the worker makes.
	globalThis.fetch = async (input, init = {}) => {
		const url = typeof input === 'string' ? input : input.url;
		const method = (init.method || (typeof input === 'object' ? input.method : 'GET') || 'GET').toUpperCase();

		if (method === 'DELETE') {
			deleted.push(url);
		}

		const result = url.includes('/cfd_tunnel') && !url.includes('/configurations')
			? { id: 'tunnel-abc', token: 'tunnel-token' }
			: { id: 'resource-1' };

		return new Response(JSON.stringify({ success: true, result, errors: [] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const { env } = await envWithKey();

	await call(env, '/v1/provision', { siteId: 'site-1', siteName: 'my-site', port: 10063 });

	deleted.length = 0;

	// Try to smuggle IDs belonging to unrelated production records on the zone.
	await call(env, '/v1/release', {
		siteId: 'site-1',
		dnsRecordId: 'PRODUCTION-www-record',
		routeId: 'PRODUCTION-route',
		tunnelId: 'PRODUCTION-tunnel',
	});

	assert.ok(deleted.length > 0, 'the release should still have deleted its own resources');

	for (const url of deleted) {
		assert.doesNotMatch(url, /PRODUCTION/, `client-supplied id must be ignored: ${url}`);
		assert.match(url, /resource-1|tunnel-abc/, 'only ids the worker stored may be deleted');
	}
});

test('releasing a site id you do not own deletes nothing', async () => {
	const deleted = [];

	globalThis.fetch = async (input, init = {}) => {
		const url = typeof input === 'string' ? input : input.url;
		const method = (init.method || 'GET').toUpperCase();

		if (method === 'DELETE') deleted.push(url);

		return new Response(JSON.stringify({ success: true, result: { id: 'x' }, errors: [] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const { env } = await envWithKey();

	// A site belonging to a different person.
	await env.LINKY.put('site:someone-elses-hash:their-site', JSON.stringify({
		siteId: 'their-site', hostname: 'linky-theirs.example.com',
		dnsRecordId: 'their-dns', routeId: 'their-route', tunnelId: 'their-tunnel',
	}));

	const res = await call(env, '/v1/release', { siteId: 'their-site' });

	assert.equal(res.status, 200);
	assert.deepEqual(deleted, [], 'must not touch another person\'s resources');
	assert.ok(await env.LINKY.get('site:someone-elses-hash:their-site', 'json'), 'their record must survive');
});
