import assert from 'node:assert/strict';
import test from 'node:test';

import { createHash } from 'node:crypto';

import worker from '../src/index.js';
import { sha256Hex } from '../src/util.js';

/** Minimal stand-in for a KV namespace. */
function fakeKV(seed = {}) {
	const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));

	return {
		store,
		async get(key, type) {
			const raw = store.get(key);

			if (raw === undefined) {
				return null;
			}

			return type === 'json' ? JSON.parse(raw) : raw;
		},
		async put(key, value) {
			store.set(key, value);
		},
		async delete(key) {
			store.delete(key);
		},
		async list({ prefix }) {
			return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
		},
	};
}

const HOST = 'linky-k4d8vn.example.com';

/** Node's crypto, so seeding an env does not have to be awaited. */
const sha256Sync = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Keys live in KV, so an env needs a teamkey record rather than a variable.
 */
function makeEnv(seed, key = 'linky_mykey') {
	return {
		LINKY: fakeKV({ [`teamkey:${sha256Sync(key)}`]: { name: 'Paul', active: true }, ...seed }),
		ZONE_NAME: 'example.com',
		HOSTNAME_PREFIX: 'linky',
		WORKER_SCRIPT_NAME: 'linky-live-links',
		CF_ACCOUNT_ID: 'acct',
		CF_ZONE_ID: 'zone',
		CF_API_TOKEN: 'token',
	};
}

const hostRecord = {
	siteId: 'site-1',
	keyHash: 'hash',
	authUser: 'cedar',
	authPass: 'heron-42',
	bypassPaths: ['/mepr'],
};

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

/** Capture what the gateway forwards to the origin instead of really fetching. */
function stubFetch() {
	const calls = [];

	globalThis.fetch = async (req) => {
		calls.push(req);

		return new Response('origin ok', { status: 200, headers: { 'X-From': 'origin' } });
	};

	return calls;
}

test('gateway demands auth for a normal request', async () => {
	stubFetch();

	const res = await worker.fetch(new Request(`https://${HOST}/`), makeEnv({ [`host:${HOST}`]: hostRecord }));

	assert.equal(res.status, 401);
	assert.match(res.headers.get('WWW-Authenticate'), /^Basic realm=/);
});

test('gateway rejects wrong credentials', async () => {
	stubFetch();
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	for (const header of [basic('cedar', 'wrong'), basic('wrong', 'heron-42'), 'Basic !!!notbase64', 'Bearer xyz']) {
		const res = await worker.fetch(
			new Request(`https://${HOST}/`, { headers: { Authorization: header } }),
			env,
		);

		assert.equal(res.status, 401, `should reject: ${header}`);
	}
});

test('gateway passes through with correct credentials', async () => {
	const calls = stubFetch();

	const res = await worker.fetch(
		new Request(`https://${HOST}/wp-admin`, { headers: { Authorization: basic('cedar', 'heron-42') } }),
		makeEnv({ [`host:${HOST}`]: hostRecord }),
	);

	assert.equal(res.status, 200);
	assert.equal(calls.length, 1);

	// The origin must learn the public hostname but never see our credentials.
	assert.equal(calls[0].headers.get('X-Original-Host'), HOST);
	assert.equal(calls[0].headers.get('X-Linky-Live'), 'auth');
	assert.equal(calls[0].headers.get('Authorization'), null);

	// Dev sites must never be indexed or cached.
	assert.match(res.headers.get('X-Robots-Tag'), /noindex/);
	assert.match(res.headers.get('Cache-Control'), /no-store/);
});

test('bypass paths reach the origin with no credentials at all', async () => {
	const calls = stubFetch();
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	// This is the whole point: a webhook POST with no auth header must get through.
	for (const path of ['/mepr', '/mepr/notify/paypal']) {
		const res = await worker.fetch(
			new Request(`https://${HOST}${path}`, { method: 'POST', body: 'payload' }),
			env,
		);

		assert.equal(res.status, 200, `${path} should bypass auth`);
	}

	assert.equal(calls.length, 2);
	assert.equal(calls[0].headers.get('X-Linky-Live'), 'bypass');
});

test('a bypass entry is a prefix, and everything else stays protected', async () => {
	stubFetch();
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	// Bypasses are prefix matches by design: a gateway listener may append
	// anything to its base path, and a silently unmatched bypass loses webhooks.
	for (const path of ['/mepr', '/mepr/', '/mepr/notify', '/meprsdkfjl']) {
		const res = await worker.fetch(new Request(`https://${HOST}${path}`), env);

		assert.equal(res.status, 200, `${path} should bypass auth`);
	}

	// Anything not starting with a listed prefix must still require the password.
	for (const path of ['/', '/wp-admin', '/wp-login.php', '/wp-admin/mepr', '/xmepr']) {
		const res = await worker.fetch(new Request(`https://${HOST}${path}`), env);

		assert.equal(res.status, 401, `${path} must still require auth`);
	}
});

test('unknown hostnames are refused without touching the origin', async () => {
	const calls = stubFetch();

	// A hostname with no stored record is not site traffic, so it falls through to
	// the API and is rejected for lacking a key. Either way the origin is never
	// contacted, which is the part that matters.
	const res = await worker.fetch(new Request('https://linky-nope.example.com/'), makeEnv({}));

	assert.equal(res.status, 401);
	assert.equal(calls.length, 0, 'must not proxy to any origin');
});

test('the API answers on any hostname, including the free workers.dev URL', async () => {
	stubFetch();

	const env = makeEnv({});

	// No CONTROL_HOSTNAME is configured; the worker infers its role instead, so it
	// needs no subdomain or DNS record of its own.
	for (const host of [
		'linky-live-links.example.workers.dev',
		'linky-live.example.com',
		'anything-else.example.com',
	]) {
		const res = await worker.fetch(
			new Request(`https://${host}/v1/status`, { headers: { Authorization: 'Bearer linky_mykey' } }),
			env,
		);

		assert.equal(res.status, 200, `API must answer on ${host}`);
	}
});

test('a provisioned hostname is always treated as site traffic, never as the API', async () => {
	stubFetch();

	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	// Even with a valid API key, a site hostname must go through the auth gateway
	// rather than exposing the control plane on a public site URL.
	const res = await worker.fetch(
		new Request(`https://${HOST}/v1/status`, { headers: { Authorization: 'Bearer linky_mykey' } }),
		env,
	);

	assert.equal(res.status, 401);
	assert.match(res.headers.get('WWW-Authenticate') || '', /^Basic/, 'must be the site auth challenge');
});

test('control plane rejects missing and bad API keys', async () => {
	stubFetch();
	const env = makeEnv({});

	const noKey = await worker.fetch(
		new Request('https://linky-live.example.com/v1/provision', { method: 'POST', body: '{}' }),
		env,
	);
	assert.equal(noKey.status, 401);

	const badKey = await worker.fetch(
		new Request('https://linky-live.example.com/v1/provision', {
			method: 'POST',
			body: '{}',
			headers: { Authorization: 'Bearer nonsense' },
		}),
		env,
	);
	assert.equal(badKey.status, 401);
});

test('a deactivated key stops working', async () => {
	stubFetch();

	// A revoked key keeps its record but stops working.
	const env = makeEnv({ [`teamkey:${sha256Sync('retired-key')}`]: { name: 'ex', active: false } });

	const res = await worker.fetch(
		new Request('https://linky-live.example.com/v1/status', { headers: { Authorization: 'Bearer retired-key' } }),
		env,
	);

	assert.equal(res.status, 401);
});

test('control plane isolates one teammate from another', async () => {
	stubFetch();

	const theirs = await sha256Hex('their-key');

	const env = makeEnv({
		[`site:${theirs}:secret-site`]: { siteId: 'secret-site', hostname: 'linky-theirs.example.com', bypassPaths: [] },
	}, 'my-key');

	const res = await worker.fetch(
		new Request('https://linky-live.example.com/v1/status', { headers: { Authorization: 'Bearer my-key' } }),
		env,
	);

	const body = await res.json();

	assert.equal(res.status, 200);
	assert.deepEqual(body.sites, [], "must not see another teammate's sites");
});

test('config endpoint validates before storing', async () => {
	stubFetch();

	const hash = await sha256Hex('my-key');
	const env = makeEnv({
		[`site:${hash}:site-1`]: { ...hostRecord, hostname: HOST, port: 10063 },
	}, 'my-key');

	const post = (body) =>
		worker.fetch(
			new Request('https://linky-live.example.com/v1/config', {
				method: 'POST',
				body: JSON.stringify(body),
				headers: { Authorization: 'Bearer my-key' },
			}),
			env,
		);

	// A wildcard bypass must be refused even by an authenticated caller.
	const bad = await post({ siteId: 'site-1', bypassPaths: ['/*'] });
	assert.equal(bad.status, 400);

	const stillOne = await env.LINKY.get(`host:${HOST}`, 'json');
	assert.equal(stillOne, null, 'a rejected config must not have been written');

	const good = await post({ siteId: 'site-1', authUser: 'newuser', bypassPaths: ['/paypal'] });
	assert.equal(good.status, 200);

	// The gateway reads the hostname-keyed mirror, so it must be updated too.
	const mirrored = await env.LINKY.get(`host:${HOST}`, 'json');
	assert.equal(mirrored.authUser, 'newuser');
	assert.deepEqual(mirrored.bypassPaths, ['/paypal']);
});

/** Stub the origin with a specific status and content type. */
function stubOrigin(status, contentType, body = 'x') {
	const calls = [];

	globalThis.fetch = async (req) => {
		calls.push(req);

		return new Response(body, { status, headers: { 'Content-Type': contentType } });
	};

	return calls;
}

test('a successful response on a bypassed path is untouched', async () => {
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	// The whole point of the bypass: a real listener must work unauthenticated.
	for (const status of [200, 201, 302, 500]) {
		stubOrigin(status, 'text/html');

		const res = await worker.fetch(new Request(`https://${HOST}/mepr`), env);

		assert.equal(res.status, status, `status ${status} must pass through`);
	}
});

test('the 404 template is never served unauthenticated, whatever the method', async () => {
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	// The regression this guards: an earlier version only stripped the body for
	// GET, so sending POST returned the entire 404 template — WordPress version,
	// plugin names and all.
	for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH']) {
		stubOrigin(404, 'text/html; charset=UTF-8', '<html>WordPress 7.1 my-plugin</html>');

		const res = await worker.fetch(new Request(`https://${HOST}/mepr/nope`, { method }), env);
		const body = method === 'HEAD' ? '' : await res.text();

		assert.equal(res.status, 404, `${method} must still be a 404`);
		assert.doesNotMatch(body, /WordPress 7\.1|my-plugin/, `${method} must not leak the template`);
	}
});

test('a missing asset is a plain 404 and never prompts', async () => {
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	// WordPress answers a missing image with the 404 template too, so this leaks
	// by the same route. And a password prompt over a missing favicon would be
	// infuriating.
	for (const path of ['/favicon.ico', '/missing.png', '/wp-content/themes/x/gone.css']) {
		stubOrigin(404, 'text/html; charset=UTF-8', '<html>WordPress 7.1</html>');

		const res = await worker.fetch(new Request(`https://${HOST}${path}`), env);

		assert.equal(res.status, 404, `${path} must stay a 404`);
		assert.equal(res.headers.get('WWW-Authenticate'), null, `${path} must not prompt`);
		assert.doesNotMatch(await res.text(), /WordPress/, `${path} must not leak the template`);
	}
});

test('a non-HTML 404 reaches the caller intact', async () => {
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	// A REST endpoint answering 404 as JSON is reporting a real result, not leaking
	// a page, so the body must survive.
	for (const type of ['application/json', 'text/plain']) {
		stubOrigin(404, type, '{"code":"no_route"}');

		const res = await worker.fetch(
			new Request(`https://${HOST}/mepr/api`, { method: 'POST' }),
			env,
		);

		assert.equal(res.status, 404);
		assert.match(await res.text(), /no_route/, `${type} body must pass through`);
	}
});

test('an authenticated visitor still sees the real 404 page', async () => {
	stubOrigin(404, 'text/html; charset=UTF-8', '<html>WordPress 7.1</html>');
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	const res = await worker.fetch(
		new Request(`https://${HOST}/mepr/nope`, {
			headers: { Authorization: basic('cedar', 'heron-42') },
		}),
		env,
	);

	// They hold the password; there is nothing to hide from them.
	assert.equal(res.status, 404);
	assert.match(await res.text(), /WordPress/);
});

test('successful responses on a bypassed path are untouched', async () => {
	const env = makeEnv({ [`host:${HOST}`]: hostRecord });

	// The whole point of a bypass: a real listener must work unauthenticated.
	for (const status of [200, 201, 302, 400, 500]) {
		stubOrigin(status, 'text/html', 'real listener output');

		const res = await worker.fetch(new Request(`https://${HOST}/mepr`, { method: 'POST' }), env);

		assert.equal(res.status, status, `status ${status} must pass through`);
		assert.match(await res.text(), /real listener output/, `status ${status} body must survive`);
	}
});
