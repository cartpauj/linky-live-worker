import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { hashPassword } from '../src/passwords.js';
import { adminEnv, adminRequest, cookieFrom } from './helpers.mjs';

const PASSWORD = 'correct-horse-battery';

/** An env with the accounts named, each holding the same known password. */
async function envWith(accounts, seed = {}, over = {}) {
	const password = await hashPassword(PASSWORD);
	const records = {};

	for (const [email, extra] of Object.entries(accounts)) {
		records[`admin:${email}`] = { active: true, password, ...extra };
	}

	return adminEnv({ ...records, ...seed }, over);
}

const post = (env, path, body, cookie) =>
	worker.fetch(adminRequest(path, { method: 'POST', body, cookie }), env);

const state = (env, cookie) => worker.fetch(adminRequest('/admin/api/state', { cookie }), env);

async function signIn(env, email) {
	const res = await post(env, '/admin/api/login', { email, password: PASSWORD });

	assert.equal(res.status, 200, `${email} should be able to sign in`);

	return cookieFrom(res);
}

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

test('the page itself is served without a session, and carries no data', async () => {
	const env = await envWith(
		{ 'secret-owner@x.com': { role: 'owner' } },
		{ 'teamkey:abc': { name: 'Confidential Alice', active: true, hint: 'zz9xy1' } },
	);

	const res = await worker.fetch(adminRequest('/admin'), env);

	assert.equal(res.status, 200);
	assert.match(res.headers.get('Content-Type'), /text\/html/);
	assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);

	/*
	 * The page is public, so it must be a shell and nothing else — every fact
	 * comes from /admin/api/state, which is behind the session check.
	 */
	const body = await res.text();

	for (const secret of ['secret-owner@x.com', 'Confidential Alice', 'zz9xy1']) {
		assert.ok(!body.includes(secret), `the page must not embed "${secret}"`);
	}
});

test('a wrong password, an unknown email and a suspended account read alike', async () => {
	const env = await envWith({
		'owner@x.com': { role: 'owner' },
		'gone@x.com': { role: 'owner', active: false },
	});

	const attempts = [
		{ email: 'owner@x.com', password: 'wrong' },
		{ email: 'nobody@x.com', password: PASSWORD },
		{ email: 'gone@x.com', password: PASSWORD },
	];

	const seen = new Set();

	for (const attempt of attempts) {
		const res = await post(env, '/admin/api/login', attempt);
		const body = await res.json();

		assert.equal(res.status, 401);
		seen.add(body.error);
	}

	assert.equal(seen.size, 1, 'one message, so the form cannot be used to find who has access');
});

test('an account with no password never matches an empty one', async () => {
	// This is what an Access-mode record looks like; it must not be reachable.
	const env = adminEnv({ 'admin:owner@x.com': { role: 'owner', active: true } });

	for (const password of ['', ' ', 'undefined']) {
		assert.equal((await post(env, '/admin/api/login', { email: 'owner@x.com', password })).status, 401);
	}
});

test('signing out ends the session', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner' } });
	const cookie = await signIn(env, 'owner@x.com');

	assert.equal((await state(env, cookie)).status, 200);

	await post(env, '/admin/api/logout', {}, cookie);

	assert.equal((await state(env, cookie)).status, 401, 'the token must be dead, not just cleared client-side');
});

test('a request with no session is refused', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner' } });

	assert.equal((await state(env, null)).status, 401);
	assert.equal((await post(env, '/admin/api/keys/issue', { name: 'Alice' })).status, 401);
});

test('a mutating request without the CSRF header is refused', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner' } });
	const cookie = await signIn(env, 'owner@x.com');

	const res = await worker.fetch(
		new Request('https://linky-live.example.com/admin/api/keys/issue', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: `linky_admin=${cookie}` },
			body: JSON.stringify({ name: 'Alice' }),
		}),
		env,
	);

	assert.equal(res.status, 403);
});

/* ------------------------------------------------------------------ *
 * The first sign-in
 * ------------------------------------------------------------------ */

test('a one-time password gets in, but can do nothing until it is replaced', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner', mustChangePassword: true } });
	const cookie = await signIn(env, 'owner@x.com');

	const shown = await (await state(env, cookie)).json();
	assert.equal(shown.mustChangePassword, true);
	assert.equal(shown.users, undefined, 'nothing is loaded until they have chosen a password');

	const blocked = await post(env, '/admin/api/keys/issue', { name: 'Alice' }, cookie);
	assert.equal(blocked.status, 403);

	const changed = await post(env, '/admin/api/password', { password: 'a-much-better-password' }, cookie);
	assert.equal(changed.status, 200);

	// The response re-issues the cookie, and the new one is unencumbered.
	const fresh = cookieFrom(changed);
	const after = await (await state(env, fresh)).json();
	assert.equal(after.mustChangePassword, undefined);
	assert.equal((await post(env, '/admin/api/keys/issue', { name: 'Alice' }, fresh)).status, 200);
});

test('a short password is refused', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner' } });
	const cookie = await signIn(env, 'owner@x.com');

	const res = await post(env, '/admin/api/password', { password: 'short' }, cookie);

	assert.equal(res.status, 400);
	assert.match((await res.json()).error, /12 characters/);
});

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

test('a manager cannot see or touch admin accounts', async () => {
	const env = await envWith({
		'owner@x.com': { role: 'owner' },
		'manager@x.com': { role: 'manager' },
	});

	const cookie = await signIn(env, 'manager@x.com');
	const shown = await (await state(env, cookie)).json();

	assert.equal(shown.canManageAdmins, false);
	assert.deepEqual(shown.accounts, [], 'a manager is not shown who the owners are');
	assert.deepEqual(shown.canGrant, []);

	for (const [path, body] of [
		['/admin/api/accounts/add', { email: 'new@x.com', role: 'owner' }],
		['/admin/api/accounts/role', { email: 'owner@x.com', role: 'manager' }],
		['/admin/api/accounts/remove', { email: 'owner@x.com' }],
		['/admin/api/accounts/suspend', { email: 'owner@x.com' }],
	]) {
		const res = await post(env, path, body, cookie);

		assert.equal(res.status, 403, `${path} must be refused`);
	}
});

test('a manager can still manage users and keys', async () => {
	const env = await envWith({ 'manager@x.com': { role: 'manager' } });
	const cookie = await signIn(env, 'manager@x.com');

	const res = await post(env, '/admin/api/keys/issue', { name: 'Alice' }, cookie);
	const body = await res.json();

	assert.equal(res.status, 200);
	assert.match(body.key, /^linky_/);
});

test('an owner can add, demote and remove another owner', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner' } });
	const cookie = await signIn(env, 'owner@x.com');

	const added = await (await post(env, '/admin/api/accounts/add',
		{ email: 'second@x.com', role: 'owner' }, cookie)).json();

	assert.equal(added.ok, true);
	assert.ok(added.password, 'a one-time password comes back exactly once');

	assert.equal((await post(env, '/admin/api/accounts/role',
		{ email: 'second@x.com', role: 'manager' }, cookie)).status, 200);

	assert.equal((await post(env, '/admin/api/accounts/remove',
		{ email: 'second@x.com' }, cookie)).status, 200);
});

test('an owner may step down while another owner remains', async () => {
	const env = await envWith({
		'owner@x.com': { role: 'owner' },
		'second@x.com': { role: 'owner' },
	});

	const cookie = await signIn(env, 'owner@x.com');

	assert.equal((await post(env, '/admin/api/accounts/role',
		{ email: 'owner@x.com', role: 'manager' }, cookie)).status, 200);
});

test('the last owner cannot remove, demote or suspend themselves', async () => {
	for (const [path, body] of [
		['/admin/api/accounts/remove', { email: 'owner@x.com' }],
		['/admin/api/accounts/role', { email: 'owner@x.com', role: 'manager' }],
		['/admin/api/accounts/suspend', { email: 'owner@x.com' }],
	]) {
		const env = await envWith({
			'owner@x.com': { role: 'owner' },
			'manager@x.com': { role: 'manager' },
		});

		const cookie = await signIn(env, 'owner@x.com');
		const res = await post(env, path, body, cookie);

		assert.equal(res.status, 409, `${path} must be refused`);
		assert.match((await res.json()).error, /no owner/);
	}
});

test('removing an account ends its sessions but leaves keys alone', async () => {
	const env = await envWith(
		{ 'owner@x.com': { role: 'owner' }, 'manager@x.com': { role: 'manager' } },
		{ 'teamkey:abc': { name: 'Alice', active: true } },
	);

	const ownerCookie = await signIn(env, 'owner@x.com');
	const managerCookie = await signIn(env, 'manager@x.com');

	assert.equal((await state(env, managerCookie)).status, 200);

	await post(env, '/admin/api/accounts/remove', { email: 'manager@x.com' }, ownerCookie);

	assert.equal((await state(env, managerCookie)).status, 401, 'their session must die at once');
	assert.ok(await env.LINKY.get('teamkey:abc'), "a user's key is not an admin account and must survive");
});

/* ------------------------------------------------------------------ *
 * Users and keys
 * ------------------------------------------------------------------ */

test('a key is shown once and stored only as a hash', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner' } });
	const cookie = await signIn(env, 'owner@x.com');

	const issued = await (await post(env, '/admin/api/keys/issue', { name: 'Alice' }, cookie)).json();

	const stored = [...env.LINKY.store.entries()].filter(([k]) => k.startsWith('teamkey:'));
	assert.equal(stored.length, 1);
	assert.ok(!stored[0][1].includes(issued.key), 'the key itself must never be written down');

	const shown = await (await state(env, cookie)).json();
	assert.equal(shown.users[0].name, 'Alice');
	assert.equal(shown.users[0].hint, issued.key.slice(-6));
});

test('two people cannot share a name', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner' } });
	const cookie = await signIn(env, 'owner@x.com');

	await post(env, '/admin/api/keys/issue', { name: 'Alice' }, cookie);

	const again = await post(env, '/admin/api/keys/issue', { name: 'alice' }, cookie);

	assert.equal(again.status, 409);
});

test('revoking stops a running address without deleting it', async () => {
	const env = await envWith({ 'owner@x.com': { role: 'owner' } }, {
		[`teamkey:${'a'.repeat(64)}`]: { name: 'Alice', active: true, hint: 'abc123' },
		[`site:${'a'.repeat(64)}:site-1`]: { siteId: 'site-1', hostname: 'linky-x.example.com', siteName: 'Shop' },
		'host:linky-x.example.com': { siteId: 'site-1', ownerActive: true },
	});

	const cookie = await signIn(env, 'owner@x.com');

	await post(env, '/admin/api/keys/revoke', { hash: 'a'.repeat(64) }, cookie);

	const host = await env.LINKY.get('host:linky-x.example.com', 'json');

	assert.equal(host.ownerActive, false, 'the gateway reads this on every request');
	assert.ok(await env.LINKY.get(`site:${'a'.repeat(64)}:site-1`), 'the address stays reserved');
});

test('rolling a key carries the addresses to the new hash', async () => {
	const old = 'b'.repeat(64);
	const env = await envWith({ 'owner@x.com': { role: 'owner' } }, {
		[`teamkey:${old}`]: { name: 'Alice', active: true },
		[`site:${old}:site-1`]: { siteId: 'site-1', hostname: 'linky-y.example.com', keyHash: old },
		'host:linky-y.example.com': { siteId: 'site-1', keyHash: old },
	});

	const cookie = await signIn(env, 'owner@x.com');
	const rolled = await (await post(env, '/admin/api/keys/roll', { hash: old }, cookie)).json();

	assert.equal(rolled.addresses, 1);
	assert.equal(await env.LINKY.get(`teamkey:${old}`), null, 'the old key stops working at once');
	assert.ok(await env.LINKY.get(`site:${rolled.hash}:site-1`), 'the address moved with them');
	assert.equal(await env.LINKY.get(`site:${old}:site-1`), null, 'and did not stay behind');

	const host = await env.LINKY.get('host:linky-y.example.com', 'json');
	assert.equal(host.keyHash, rolled.hash);
});

test('removing a user deletes the route, DNS record and tunnel', async () => {
	const hash = 'c'.repeat(64);
	const env = await envWith({ 'owner@x.com': { role: 'owner' } }, {
		[`teamkey:${hash}`]: { name: 'Alice', active: true },
		[`site:${hash}:site-1`]: {
			siteId: 'site-1',
			hostname: 'linky-z.example.com',
			tunnelId: 'tun-1',
			routeId: 'route-1',
		},
		'host:linky-z.example.com': { siteId: 'site-1' },
	});

	const calls = [];
	const realFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const url = typeof input === 'string' ? input : input.url;
		calls.push(`${init.method || 'GET'} ${url.replace('https://api.cloudflare.com/client/v4', '')}`);

		// A DNS lookup by name answers with the record to delete; everything else
		// just has to look successful.
		const result = url.includes('/dns_records?') ? [{ id: 'dns-1' }] : {};

		return new Response(JSON.stringify({ success: true, result, errors: [] }), {
			headers: { 'Content-Type': 'application/json' },
		});
	};

	try {
		const cookie = await signIn(env, 'owner@x.com');
		const res = await post(env, '/admin/api/keys/remove', { hash, expectAddresses: 1 }, cookie);
		const body = await res.json();

		assert.equal(res.status, 200);
		assert.deepEqual(body.warnings, [], 'nothing should have failed');
	} finally {
		globalThis.fetch = realFetch;
	}

	assert.ok(calls.some((c) => c.startsWith('DELETE') && c.includes('/workers/routes/route-1')), 'route deleted');
	assert.ok(calls.some((c) => c.startsWith('DELETE') && c.includes('/dns_records/dns-1')), 'DNS record deleted');
	assert.ok(calls.some((c) => c.startsWith('DELETE') && c.includes('/cfd_tunnel/tun-1')), 'tunnel deleted');

	assert.equal(await env.LINKY.get(`teamkey:${hash}`), null);
	assert.equal(await env.LINKY.get(`site:${hash}:site-1`), null);
	assert.equal(await env.LINKY.get('host:linky-z.example.com'), null);
});

test('removing refuses when an address appeared since the page was drawn', async () => {
	const hash = 'd'.repeat(64);
	const env = await envWith({ 'owner@x.com': { role: 'owner' } }, {
		[`teamkey:${hash}`]: { name: 'Alice', active: true },
		[`site:${hash}:site-1`]: { siteId: 'site-1', hostname: 'linky-w.example.com' },
	});

	const cookie = await signIn(env, 'owner@x.com');

	// The browser last saw zero addresses; there is one now.
	const res = await post(env, '/admin/api/keys/remove', { hash, expectAddresses: 0 }, cookie);

	assert.equal(res.status, 409);
	assert.ok(await env.LINKY.get(`teamkey:${hash}`), 'nothing may be deleted on a stale count');
});

/* ------------------------------------------------------------------ *
 * Where the admin area is, and is not
 * ------------------------------------------------------------------ */

test("a teammate's own site keeps serving its own /admin", async () => {
	/*
	 * Order matters in the dispatcher: the gateway check comes first, so a
	 * provisioned hostname is site traffic all the way down. WordPress puts its
	 * dashboard at /wp-admin and plugins put things at /admin — none of that may
	 * be shadowed by this console, and none of it may skip the password.
	 */
	const env = adminEnv({
		'host:linky-x.example.com': {
			siteId: 'site-1',
			keyHash: 'abc',
			authUser: 'cedar',
			authPass: 'heron-42',
			bypassPaths: [],
			ownerActive: true,
		},
	});

	const res = await worker.fetch(new Request('https://linky-x.example.com/admin'), env);

	assert.equal(res.status, 401, 'that is the site, and the site wants its password');
	assert.match(res.headers.get('WWW-Authenticate') || '', /Basic/);
});

test('the control plane still answers on its own hostname', async () => {
	// /admin is carved out of the API host, so the add-on's endpoints must be
	// untouched by it.
	const env = adminEnv({});
	const res = await worker.fetch(
		new Request('https://linky-live.example.com/v1/status', { headers: { Authorization: 'Bearer nope' } }),
		env,
	);

	assert.equal(res.status, 401);
	assert.match((await res.json()).error, /API key/);
});

test('the session token never comes back in a response body', async () => {
	/*
	 * The cookie is HttpOnly so that nothing on the page can read the token.
	 * Returning it in JSON hands it to anything that can read a response, and to
	 * wherever that response is logged — which would undo the flag entirely.
	 */
	const env = await envWith({ 'owner@x.com': { role: 'owner', mustChangePassword: true } });
	const cookie = await signIn(env, 'owner@x.com');

	// Both shapes of the state response: before the forced change, and after.
	const first = await (await state(env, cookie)).text();
	assert.ok(!first.includes(cookie), 'the token must not appear before the password change');

	const changed = await post(env, '/admin/api/password', { password: 'a-much-better-password' }, cookie);
	const fresh = cookieFrom(changed);

	const second = await (await state(env, fresh)).text();
	assert.ok(!second.includes(fresh), 'nor after it');
	assert.ok(!second.includes('token'), 'and no field named token either');
});
