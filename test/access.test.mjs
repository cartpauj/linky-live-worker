import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { adminEnv, adminRequest } from './helpers.mjs';

/*
 * A stand-in Zero Trust team.
 *
 * Access tokens are RS256, so the test signs real ones with a key it made and
 * serves the matching JWKS from a stubbed fetch. Anything less would be testing
 * that the code reads a header, when the point is that it verifies a signature.
 */
const TEAM = 'testteam.cloudflareaccess.com';
const AUD = 'aud-tag-for-this-app';

const { subtle } = globalThis.crypto;

async function makeKeys() {
	const pair = await subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	);

	const jwk = await subtle.exportKey('jwk', pair.publicKey);

	return { pair, jwk: { ...jwk, kid: 'test-kid', alg: 'RS256', use: 'sig' } };
}

const b64url = (bytes) =>
	Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Sign a JWT the way Access does, with whatever claims a test wants to bend. */
async function mint(privateKey, claims, { kid = 'test-kid', alg = 'RS256' } = {}) {
	const header = b64url(new TextEncoder().encode(JSON.stringify({ alg, kid, typ: 'JWT' })));
	const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
	const data = new TextEncoder().encode(`${header}.${payload}`);
	const signature = await subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data);

	return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

const now = () => Math.floor(Date.now() / 1000);

const goodClaims = (over = {}) => ({
	aud: [AUD],
	iss: `https://${TEAM}`,
	email: 'owner@example.com',
	exp: now() + 600,
	iat: now(),
	...over,
});

const accessEnv = (seed = {}) =>
	adminEnv(seed, {
		AUTH_MODE: 'access',
		ACCESS_TEAM_DOMAIN: TEAM,
		ACCESS_AUD: AUD,
		ADMIN_EMAIL_DOMAIN: 'example.com',
	});

/** Serve the JWKS, and nothing else. */
function stubCerts(jwk) {
	const real = globalThis.fetch;

	globalThis.fetch = async (input) => {
		const url = typeof input === 'string' ? input : input.url;

		if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
			return new Response(JSON.stringify({ keys: [jwk] }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		throw new Error(`unexpected fetch: ${url}`);
	};

	return () => { globalThis.fetch = real; };
}

const withToken = (env, token, path = '/admin/api/state') =>
	worker.fetch(adminRequest(path, { headers: { 'Cf-Access-Jwt-Assertion': token } }), env);

/* ------------------------------------------------------------------ */

test('a properly signed token for a known account gets in', async () => {
	const { pair, jwk } = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: true } });
		const res = await withToken(env, await mint(pair.privateKey, goodClaims()));
		const body = await res.json();

		assert.equal(res.status, 200);
		assert.equal(body.you.email, 'owner@example.com');
		assert.equal(body.mode, 'access');
	} finally {
		restore();
	}
});

test('a token signed by somebody else is refused', async () => {
	const { jwk } = await makeKeys();
	const other = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: true } });

		// Signed with a key the team does not publish, but claiming its kid.
		const forged = await mint(other.pair.privateKey, goodClaims());

		assert.equal((await withToken(env, forged)).status, 403);
	} finally {
		restore();
	}
});

test('an unsigned token is refused', async () => {
	const { jwk } = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: true } });

		const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'none', kid: 'test-kid' })));
		const payload = b64url(new TextEncoder().encode(JSON.stringify(goodClaims())));

		assert.equal((await withToken(env, `${header}.${payload}.`)).status, 401);
	} finally {
		restore();
	}
});

test('a token for a different Access application is refused', async () => {
	const { pair, jwk } = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: true } });
		const token = await mint(pair.privateKey, goodClaims({ aud: ['some-other-app'] }));

		// Every app in one Zero Trust account shares an issuer and signing keys, so
		// the audience is the only thing telling them apart.
		assert.equal((await withToken(env, token)).status, 403);
	} finally {
		restore();
	}
});

test('a token from a different team is refused', async () => {
	const { pair, jwk } = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: true } });
		const token = await mint(pair.privateKey, goodClaims({ iss: 'https://elsewhere.cloudflareaccess.com' }));

		assert.equal((await withToken(env, token)).status, 403);
	} finally {
		restore();
	}
});

test('an expired token is refused', async () => {
	const { pair, jwk } = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: true } });
		const token = await mint(pair.privateKey, goodClaims({ exp: now() - 3600 }));

		assert.equal((await withToken(env, token)).status, 401);
	} finally {
		restore();
	}
});

test('a valid login on the wrong email domain is refused', async () => {
	const { pair, jwk } = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		// Seeded as an owner, so only the domain check can stop them. This is the
		// case where the Access policy was widened by mistake.
		const env = accessEnv({ 'admin:stranger@gmail.com': { role: 'owner', active: true } });
		const token = await mint(pair.privateKey, goodClaims({ email: 'stranger@gmail.com' }));
		const res = await withToken(env, token);

		assert.equal(res.status, 403);
		assert.match((await res.json()).error, /@example\.com/);
	} finally {
		restore();
	}
});

test('a real company login with no account here is told so plainly', async () => {
	const { pair, jwk } = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		const env = accessEnv({});
		const token = await mint(pair.privateKey, goodClaims({ email: 'newbie@example.com' }));
		const res = await withToken(env, token);

		assert.equal(res.status, 403);
		assert.match((await res.json()).error, /Ask an owner/);
	} finally {
		restore();
	}
});

test('a suspended account is refused even with a good login', async () => {
	const { pair, jwk } = await makeKeys();
	const restore = stubCerts(jwk);

	try {
		const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: false } });

		assert.equal((await withToken(env, await mint(pair.privateKey, goodClaims()))).status, 403);
	} finally {
		restore();
	}
});

test('no token at all is refused', async () => {
	const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: true } });

	assert.equal((await worker.fetch(adminRequest('/admin/api/state'), env)).status, 401);
});

test('a password session is worthless in Access mode', async () => {
	// The two modes must not be alternatives to each other: switching to Access
	// has to close the password door, not leave it ajar.
	const env = accessEnv({ 'admin:owner@example.com': { role: 'owner', active: true } });

	const login = await worker.fetch(
		adminRequest('/admin/api/login', {
			method: 'POST',
			body: { email: 'owner@example.com', password: 'anything' },
		}),
		env,
	);

	assert.equal(login.status, 400);
	assert.equal(login.headers.get('Set-Cookie'), null, 'no session may be minted');
});

test('Access mode with no configuration serves nothing', async () => {
	// Failing closed matters: there is no second way in, so a half-finished setup
	// must say so rather than fall back to something weaker.
	const env = adminEnv({}, { AUTH_MODE: 'access' });
	const res = await worker.fetch(adminRequest('/admin/api/state'), env);

	assert.equal(res.status, 503);
	assert.match((await res.json()).error, /ACCESS_TEAM_DOMAIN/);
});
