import assert from 'node:assert/strict';
import test from 'node:test';

import {
	canActOnAdmin,
	canGrant,
	canManageAdmins,
	canManageKeys,
	grantableBy,
	roleOf,
	wouldStrandService,
} from '../src/roles.js';

const owner = { role: 'owner' };
const manager = { role: 'manager' };

test('an owner manages admin accounts and a manager does not', () => {
	assert.equal(canManageAdmins(owner), true);
	assert.equal(canManageAdmins(manager), false);
	assert.equal(canActOnAdmin(manager, owner), false, 'a manager must not reach an owner');
	assert.equal(canActOnAdmin(manager, manager), false, 'nor another manager');
});

test('owners manage other owners, including themselves', () => {
	assert.equal(canActOnAdmin(owner, owner), true);
});

test('only owners hand out roles, and they can hand out either', () => {
	assert.deepEqual(grantableBy(owner), ['manager', 'owner']);
	assert.deepEqual(grantableBy(manager), []);
	assert.equal(canGrant(manager, 'manager'), false);
	assert.equal(canGrant(owner, 'owner'), true);
});

test('both roles manage users and keys', () => {
	assert.equal(canManageKeys(owner), true);
	assert.equal(canManageKeys(manager), true);
	assert.equal(canManageKeys({}), false, 'somebody with no role manages nothing');
});

test('an unrecognised role reads as no role at all', () => {
	// Failing closed matters here: a malformed record must not become an owner.
	for (const record of [null, {}, { role: 'admin' }, { role: 'OWNER' }, { role: 1 }]) {
		assert.equal(roleOf(record), null);
		assert.equal(canManageKeys(record), false);
	}
});

/* ------------------------------------------------------------------ */

const accounts = [
	{ email: 'a@x.com', role: 'owner', active: true },
	{ email: 'b@x.com', role: 'owner', active: true },
	{ email: 'c@x.com', role: 'manager', active: true },
];

test('the last active owner cannot be removed, demoted or suspended', () => {
	const alone = [accounts[0], accounts[2]];

	assert.equal(wouldStrandService(alone, 'a@x.com', { removed: true }), true);
	assert.equal(wouldStrandService(alone, 'a@x.com', { role: 'manager' }), true);
	assert.equal(wouldStrandService(alone, 'a@x.com', { active: false }), true);
});

test('with a second owner, either may step down', () => {
	assert.equal(wouldStrandService(accounts, 'a@x.com', { removed: true }), false);
	assert.equal(wouldStrandService(accounts, 'b@x.com', { role: 'manager' }), false);
});

test('a suspended owner does not count as a way back in', () => {
	// Otherwise the last usable account could be removed on the strength of one
	// that is already switched off.
	const suspended = [
		{ email: 'a@x.com', role: 'owner', active: true },
		{ email: 'b@x.com', role: 'owner', active: false },
	];

	assert.equal(wouldStrandService(suspended, 'a@x.com', { removed: true }), true);
});

test('removing a manager never strands the service', () => {
	assert.equal(wouldStrandService(accounts, 'c@x.com', { removed: true }), false);
});
