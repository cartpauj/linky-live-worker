import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteDnsRecordsByName } from '../src/cf.js';

const env = {
	CF_ZONE_ID: 'zone123',
	CF_API_TOKEN: 'token',
	ZONE_NAME: 'example.com',
	HOSTNAME_PREFIX: 'linky',
};

/** Records the calls made, and serves a list response for the lookup. */
function stub(existing) {
	const calls = [];

	globalThis.fetch = async (url, init = {}) => {
		const method = (init.method || 'GET').toUpperCase();
		calls.push({ url, method });

		const result = method === 'GET' ? existing : { id: 'deleted' };

		return new Response(JSON.stringify({ success: true, result, errors: [] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	return calls;
}

test('removes every record for the hostname, not just the one we created', async () => {
	// The bug this guards: setting a tunnel's ingress makes Cloudflare publish its
	// own record, so deleting only our stored id left the hostname resolving.
	const calls = stub([{ id: 'ours' }, { id: 'cloudflares' }]);

	const removed = await deleteDnsRecordsByName(env, 'linky-q91xzm.example.com');

	assert.equal(removed, 2);

	const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);

	assert.equal(deletes.length, 2);
	assert.ok(deletes.some((u) => u.endsWith('/ours')));
	assert.ok(deletes.some((u) => u.endsWith('/cloudflares')));
});

test('looks the hostname up by exact name', async () => {
	const calls = stub([]);

	await deleteDnsRecordsByName(env, 'linky-abc123.example.com');

	const lookup = calls.find((c) => c.method === 'GET');

	assert.match(lookup.url, /\/zones\/zone123\/dns_records\?name=linky-abc123\.example\.com$/);
});

test('a hostname with no records is not an error', async () => {
	stub([]);

	assert.equal(await deleteDnsRecordsByName(env, 'linky-gone.example.com'), 0);
});

test('refuses to touch anything that is not one of our hostnames', async () => {
	const calls = stub([{ id: 'production' }]);

	// The whole point of the guard: this call is the only one that could damage an
	// unrelated record on a zone that runs real services.
	for (const hostname of [
		'www.example.com',
		'example.com',
		'api.example.com',
		'linky-x.evil.com',
		'evil.com',
		'linky-x.sub.example.com',
		'notlinky-x.example.com',
	]) {
		await assert.rejects(
			() => deleteDnsRecordsByName(env, hostname),
			/Refusing to delete DNS/,
			`must refuse ${hostname}`,
		);
	}

	assert.deepEqual(calls, [], 'must not issue any request at all');
});
