import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import { MAX_ITERATIONS, hashPassword, needsUpgrade, validatePassword, verifyPassword } from '../src/passwords.js';

/*
 * The reason this file exists.
 *
 * Node's WebCrypto will run PBKDF2 at any iteration count; Cloudflare Workers
 * refuse anything above 100,000 with a NotSupportedError, which surfaces as a
 * 1101 and takes sign-in down completely. A count that passes every test here
 * can still be broken in production, so the constant itself is pinned — the one
 * thing a Node test can actually check.
 */
test('the iteration count stays within what Workers accept', () => {
	assert.equal(MAX_ITERATIONS, 100000, 'this is a platform limit, not a preference');

	const source = readFileSync('src/passwords.js', 'utf8');
	const literals = [...source.matchAll(/iterations?\s*[:=]\s*(\d+)/gi)].map((m) => Number(m[1]));

	for (const value of literals) {
		assert.ok(value <= MAX_ITERATIONS, `${value} is above the cap Workers enforce`);
	}
});

test('a hash we just made is at the count we use, and verifies', async () => {
	const record = await hashPassword('a-good-long-password');

	assert.ok(record.iterations <= MAX_ITERATIONS);
	assert.equal(needsUpgrade(record), false, 'a fresh hash never needs re-hashing');
	assert.equal(await verifyPassword('a-good-long-password', record), true);
	assert.equal(await verifyPassword('a-good-long-passwore', record), false);
});

test('two hashes of one password differ, so the salt is doing its job', async () => {
	const a = await hashPassword('a-good-long-password');
	const b = await hashPassword('a-good-long-password');

	assert.notEqual(a.hash, b.hash);
	assert.notEqual(a.salt, b.salt);
});

test('a record the platform would refuse fails the login rather than the request', async () => {
	// Written by an older build, or by Node, at a count Workers will not run. It
	// must come back false — never throw, which would 500 the sign-in form.
	const record = { hash: 'aa'.repeat(32), salt: 'bb'.repeat(16), iterations: 210000 };

	assert.equal(await verifyPassword('anything', record), false);
});

test('an incomplete or absent record never matches', async () => {
	for (const record of [null, undefined, {}, { hash: 'aa' }, { hash: 'aa', salt: 'bb' }]) {
		assert.equal(await verifyPassword('', record), false);
		assert.equal(await verifyPassword('anything', record), false);
	}
});

test('a hash at a different count is re-hashed on the next sign-in', () => {
	assert.equal(needsUpgrade({ iterations: 1000 }), true);
	assert.equal(needsUpgrade({ iterations: MAX_ITERATIONS }), false);
});

test('passwords must be long, but need not be ugly', () => {
	assert.match(validatePassword('short').error, /12 characters/);
	assert.equal(validatePassword('correct horse battery staple').ok, true);
	assert.match(validatePassword('a'.repeat(201)).error, /200/);
	assert.match(validatePassword('alice@example.com', 'alice@example.com').error, /email/);
});
