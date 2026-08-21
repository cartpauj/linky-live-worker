import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The CLI shells out to wrangler, so these check its contract rather than
 * executing it: the properties that make destructive commands safe to run
 * against a namespace several admins share.
 */

const source = readFileSync('scripts/keys.mjs', 'utf8');

test('names are unique, so a name is a safe way to refer to someone', () => {
	// Without uniqueness, `remove "Alice"` becomes ambiguous the moment a second
	// Alice exists, and the safe response to an ambiguous destructive command is to
	// refuse — worse than refusing at issue time, where the fix is obvious.
	assert.match(source, /already has a key/, 'issue must refuse a taken name');
	assert.match(source, /npm run keys remove/, 'and say how to rotate it');
});

test('the key itself is never stored', () => {
	// Only a hash goes to KV, so a key can be verified but never read back.
	assert.match(source, /sha256\(key\)/, 'the stored id must be a hash of the key');
	assert.doesNotMatch(
		source,
		/JSON\.stringify\(\{[^}]*\bkey\b\s*[,}]/,
		'the key must not be written into the stored record',
	);
});

test('destructive commands confirm and name who they matched', () => {
	// Numbers are positions in a shared list. If another admin adds or removes a
	// key between someone's `list` and their `remove`, every later number shifts —
	// so the confirmation has to identify the person, not the number.
	assert.match(source, /async function confirm/, 'must have a confirmation step');
	assert.match(source, /person\.name/, 'confirmation must name the person');
	assert.match(source, /person\.hash\.slice/, 'and show the hash it resolved to');

	for (const cmd of ['Permanently remove', 'Revoke']) {
		assert.ok(source.includes(cmd), `${cmd} must be confirmed`);
	}
});

test('confirmation can be skipped explicitly, but never implicitly', () => {
	assert.match(source, /--yes/, 'scripted use needs an opt-out');

	// A pipeline with no terminal must not be treated as consent.
	assert.match(source, /process\.stdin\.isTTY/, 'must detect a missing terminal');
	assert.match(source, /Refusing to \$\{action\} without confirmation/, 'and refuse rather than proceed');
});

test('a flag is never mistaken for a name', () => {
	// `remove 3 --yes` must not resolve "3 --yes" as the target.
	assert.match(source, /filter\(\(a\) => a !== '--yes' && a !== '-y'\)/);
});

test('numbers refer to positions in the full list, not a filtered view', () => {
	// Otherwise `search` would number its own results and `remove 2` would mean
	// different people depending on how you found them.
	assert.match(source, /all\.findIndex/, 'numbering must index the full list');
});

test('missing or unconfigured wrangler.toml is explained, not stack-traced', () => {
	assert.match(source, /No wrangler\.toml here/);
	assert.match(source, /YOUR_KV_NAMESPACE_ID/, 'must catch an unconfigured KV id');
});

test('the key is never recoverable, but a fragment identifies it', () => {
	// One person may hold keys on several machines, so `list` has to answer "which
	// of these is mine?" without making the key itself retrievable.
	assert.match(source, /hint: key\.slice\(-6\)/, 'must store a short tail as a hint');
	assert.match(source, /person\.hint/, 'and show it in listings');
	assert.doesNotMatch(source, /console\.log\([^)]*person\.key/, 'the key is not stored, so it cannot be shown');
});

test('issuing hands over both halves at once', () => {
	// The add-on needs the service hostname and the key on first run. Printing only
	// the key is how people end up guessing the hostname.
	assert.match(source, /Service:/, 'must print the service host');
	assert.match(source, /serviceHost/, 'read from wrangler.toml rather than retyped');
	assert.match(source, /send both lines/i, 'and say to send both');
});

test('a lost key is rolled, not recovered', () => {
	assert.match(source, /roll it/, 'must tell the operator what to do instead');
	assert.match(source, /remove "\$\{arg\}" && npm run keys issue/, 'with the exact commands');
});
