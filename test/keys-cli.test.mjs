import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The CLI shells out to wrangler, so these check its contract rather than
 * executing it: the properties that make destructive commands safe to run
 * against a namespace several admins share.
 */

const source = readFileSync('scripts/keys.mjs', 'utf8');

/**
 * Every other test here reads the script as text, which cannot catch a syntax
 * error — and the usage text is a template literal, so a stray backtick in it
 * terminates the string and breaks the whole file. Parse and run it for real.
 */
test('the script parses', () => {
	execFileSync(process.execPath, ['--check', 'scripts/keys.mjs'], { stdio: 'pipe' });
});

test('the script runs and prints usage', () => {
	// Usage is the one path that needs no config and no network, so it is the
	// cheapest end-to-end check that the file actually executes.
	const out = execFileSync(process.execPath, ['scripts/keys.mjs', 'help'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	for (const command of ['issue', 'list', 'search', 'revoke', 'restore', 'remove']) {
		assert.ok(out.includes(command), `usage must mention ${command}`);
	}

	// The fragment is the identifier we want people reaching for first.
	assert.ok(out.indexOf('…') < out.indexOf('row number'), 'usage should lead with the fragment');
});

test('an unknown command exits non-zero', () => {
	assert.throws(
		() => execFileSync(process.execPath, ['scripts/keys.mjs', 'frobnicate'], { stdio: 'pipe' }),
		/Command failed/,
	);
});

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

	for (const cmd of ['Permanently remove', 'Revoke']) {
		assert.ok(source.includes(cmd), `${cmd} must be confirmed`);
	}
});

test('a number paired with a fragment is verified, not trusted', () => {
	// This is the fix for a shifting list: the fragment printed beside a number
	// acts as a check on it, so acting on a stale number is caught rather than
	// silently hitting whoever moved into that position.
	assert.match(source, /person\.hint !== parts\[1\]/, 'must compare the fragment to the row');
	assert.match(source, /The list has changed since you looked/, 'and explain why it mismatched');
	assert.match(source, /is now \$\{actual\.name\}/, 'naming who actually holds that fragment');
});

test('a fragment on its own needs no confirmation', () => {
	// A fragment cannot shift, so it already identifies one person exactly; a
	// prompt would add friction without adding safety.
	assert.match(source, /verified: true/, 'must mark fragment matches as verified');
	assert.match(source, /!verified && !\(await confirm/, 'and skip the prompt when verified');
});

test('an ambiguous fragment refuses rather than guessing', () => {
	assert.match(source, /More than one key ends in/, 'must refuse a fragment shared by two keys');
});

test('a leading ellipsis is accepted, since that is how it is printed', () => {
	// `list` shows …Qw8zT1, so pasting that back verbatim has to work.
	assert.match(source, /replace\(\/\^…\//, 'must strip the printed ellipsis');
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
