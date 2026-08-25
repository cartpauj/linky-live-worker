import assert from 'node:assert/strict';
import test from 'node:test';

import { ADMIN_HTML } from '../src/admin-ui.js';

/*
 * The reconcile helpers are pulled out of the page and run directly, rather than
 * copied here. A copy would be a second source of truth for the one piece of
 * browser logic with real consequences — showing somebody a row that is not
 * there, or hiding one that is.
 */
const between = ADMIN_HTML.split('/* --8<-- reconcile')[1].split('/* --8<-- end reconcile')[0];
const source = between.slice(between.indexOf('*/') + 2);

const { rowMatches, reconcileWith } = new Function(
	`${source}\nreturn { rowMatches, reconcileWith };`,
)();

const NOW = 1_700_000_000_000;
const TTL = 120000;
const id = (row) => row.hash;

/** The page passes its own TTL in; the tests pass a fixed one. */
const settle = (store, rows, now = NOW) => reconcileWith(store, rows, id, now, TTL);

const rows = (...names) => names.map((name) => ({ hash: name, name, active: true }));

test('a row the server has not caught up with is shown anyway', () => {
	// The exact bug: a key is issued, the write succeeds, and KV's listing does
	// not include it for several seconds.
	const store = { newkey: { op: 'add', at: NOW, row: { hash: 'newkey', name: 'Dara', active: true } } };
	const out = settle(store, rows('alice'), NOW);

	assert.deepEqual(out.map(id), ['alice', 'newkey']);
	assert.ok(store.newkey, 'the note stays until the server lists it');
});

test('once the server lists it, the note is dropped', () => {
	const store = { newkey: { op: 'add', at: NOW, row: { hash: 'newkey', name: 'Dara' } } };
	const out = settle(store, rows('alice', 'newkey'), NOW);

	assert.deepEqual(out.map(id), ['alice', 'newkey'], 'and not listed twice');
	assert.equal(store.newkey, undefined, 'the server is authoritative again');
});

test('a removed row stays hidden while the server still reports it', () => {
	const store = { alice: { op: 'drop', at: NOW } };

	assert.deepEqual(settle(store, rows('alice', 'bob'), NOW).map(id), ['bob']);
	assert.ok(store.alice);

	// And the note goes as soon as the server agrees it is gone.
	const settled = { alice: { op: 'drop', at: NOW } };
	assert.deepEqual(settle(settled, rows('bob'), NOW).map(id), ['bob']);
	assert.equal(settled.alice, undefined);
});

test('a changed field is overwritten until the server reports the new value', () => {
	const store = { alice: { op: 'patch', at: NOW, patch: { active: false } } };
	const out = settle(store, rows('alice'), NOW);

	assert.equal(out[0].active, false);
	assert.equal(out[0].name, 'alice', 'other fields are left alone');
	assert.ok(store.alice);

	const settled = { alice: { op: 'patch', at: NOW, patch: { active: false } } };
	settle(settled, [{ hash: 'alice', name: 'alice', active: false }], NOW);
	assert.equal(settled.alice, undefined);
});

test('a note that never settles is abandoned rather than lying forever', () => {
	// If a write somehow did not take, the page must go back to the truth instead
	// of asserting a change nobody made.
	const store = { ghost: { op: 'add', at: NOW - TTL - 1, row: { hash: 'ghost', name: 'Ghost' } } };
	const out = settle(store, rows('alice'), NOW);

	assert.deepEqual(out.map(id), ['alice']);
	assert.equal(store.ghost, undefined);
});

test('a roll shows the new key immediately and stops showing the old', () => {
	const store = {
		oldhash: { op: 'drop', at: NOW },
		newhash: { op: 'add', at: NOW, row: { hash: 'newhash', name: 'Alice', active: true } },
	};

	assert.deepEqual(settle(store, rows('oldhash'), NOW).map(id), ['newhash']);
});

test('an empty store leaves the server rows exactly as they came', () => {
	const server = rows('alice', 'bob');

	assert.deepEqual(reconcileWith({}, server, id, NOW), server);
});

test('rowMatches compares only the fields the note names', () => {
	assert.equal(rowMatches({ a: 1, b: 2 }, { a: 1 }), true);
	assert.equal(rowMatches({ a: 1, b: 2 }, { a: 2 }), false);
	assert.equal(rowMatches({ a: 1 }, {}), true);
});
