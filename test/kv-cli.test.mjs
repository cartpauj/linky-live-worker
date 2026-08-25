import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

/**
 * `npm run kv` is the one setup step whose value cannot be known in advance — the
 * namespace does not exist until the command runs — so it is the placeholder most
 * likely to be fumbled in the copy across. These run the script for real against
 * a stub `npx`, because the properties that matter are all about what ends up in
 * wrangler.toml.
 */

const script = resolve('scripts/kv.mjs');
const template = readFileSync('wrangler.example.toml', 'utf8');

/*
 * A 32-hex namespace id, built rather than written out: the no-secrets guard
 * rejects any literal 32-character hex string in a committed file, and it is
 * right to — that is exactly the shape of a real account, zone, or KV id.
 */
const ID = 'da7a'.repeat(8);

/**
 * A working config, from the real template, with everything but the KV id filled
 * in. Starting from the template means a change to it that breaks the script is
 * caught here rather than by whoever is setting up.
 */
function filledTemplate() {
	return template
		.replace('YOUR_ACCOUNT_ID', 'acc0123456789')
		.replace('YOUR_ZONE_ID', 'zone0123456789')
		.replace('YOUR_ZONE', 'example.com');
}

/**
 * Run the script in a throwaway directory with a stub `npx` ahead of the real one
 * on PATH, and hand back what it printed plus the resulting wrangler.toml.
 *
 * `stub` is the body of a shell script standing in for `npx wrangler …`.
 */
function run(config, stub, { expectFailure = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'linky-kv-'));
	const bin = join(dir, 'bin');

	mkdirSync(bin);
	writeFileSync(join(dir, 'wrangler.toml'), config);
	writeFileSync(join(bin, 'npx'), `#!/bin/sh\n${stub}\n`);
	chmodSync(join(bin, 'npx'), 0o755);

	let output;
	let failed = false;

	try {
		output = execFileSync(process.execPath, [script], {
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (err) {
		failed = true;
		output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
	}

	assert.equal(failed, expectFailure, `unexpected exit status. Output:\n${output}`);

	return { output, toml: readFileSync(join(dir, 'wrangler.toml'), 'utf8') };
}

/** A stub that answers `list` with the given namespaces and `create` with an id. */
const stubWrangler = (namespaces, createdId) => `
case "$*" in
  *"namespace list"*) echo '${JSON.stringify(namespaces)}' ;;
  *"namespace create"*)
    echo '🌀 Creating namespace with title "linky-live-LINKY"'
    echo '✨ Success!'
    echo 'Add the following to your configuration file:'
    echo '[[kv_namespaces]]'
    echo 'binding = "LINKY"'
    echo 'id = "${createdId}"'
    ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac`;

/** A stub that fails loudly, for the paths that must not call wrangler at all. */
const stubForbidden = 'echo "wrangler must not be called: $*" >&2; exit 1';

/*
 * The stub is a /bin/sh script, so the tests that need one are skipped on
 * Windows. CI is Linux, and the text-level checks below still run everywhere.
 */
const needsShell = process.platform === 'win32' ? 'the wrangler stub needs /bin/sh' : false;

test('the script parses', () => {
	execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' });
});

test('the created id is written into wrangler.toml', { skip: needsShell }, () => {
	const { output, toml } = run(filledTemplate(), stubWrangler([], ID));

	assert.match(toml, new RegExp(`^\\s*id\\s*=\\s*"${ID}"`, 'm'), 'the id must land in the file');
	assert.match(output, new RegExp(ID), 'and be printed, so it is visible in a scrollback');

	// The whole point is that nothing has to be copied across by hand.
	assert.doesNotMatch(toml, /YOUR_KV_NAMESPACE_ID/, 'the placeholder must be gone');
});

test('the existing block is filled in rather than a second one appended', { skip: needsShell }, () => {
	const { toml } = run(filledTemplate(), stubWrangler([], ID));

	// wrangler's own --update-config appends, which leaves two entries for one
	// binding — a config that deploys and then reads from the wrong namespace.
	assert.equal([...toml.matchAll(/\[\[kv_namespaces\]\]/g)].length, 1, 'exactly one kv block');
	assert.equal([...toml.matchAll(/binding\s*=/g)].length, 1, 'exactly one binding');

	// And the comments explaining every other field have to survive, since they
	// are what someone reads while filling the rest in.
	assert.match(toml, /── 1 ──/, 'the numbered markers must survive');
	assert.match(toml, /CF_API_TOKEN is a secret/, 'trailing comments must survive');
	assert.match(toml, /^name = "linky-live"$/m, 'unrelated fields must be untouched');
});

test('an existing namespace is reused instead of creating a second', { skip: needsShell }, () => {
	// Re-running after a half-finished setup would otherwise leave a trail of
	// unused namespaces, each looking as plausible as the last.
	const existing = [
		{ id: 'f'.repeat(32), title: 'something-else' },
		{ id: ID, title: 'linky-live-LINKY' },
	];

	const stub = `
case "$*" in
  *"namespace list"*) echo '${JSON.stringify(existing)}' ;;
  *"namespace create"*) echo "must not create a second namespace" >&2; exit 1 ;;
esac`;

	const { output, toml } = run(filledTemplate(), stub);

	assert.match(toml, new RegExp(`id\\s*=\\s*"${ID}"`));
	assert.match(output, /Reusing/, 'and say so, so it is not mistaken for a fresh one');
});

test('an id already in the file is left alone', { skip: needsShell }, () => {
	const config = filledTemplate().replace('YOUR_KV_NAMESPACE_ID', 'existing0000000000000000000000ff');

	// Overwriting it would silently point a working deployment at an empty
	// namespace, losing every key and site record.
	const { output, toml } = run(config, stubForbidden);

	assert.match(toml, /id = "existing0000000000000000000000ff"/, 'must not be replaced');
	assert.match(output, /already has/, 'must say why it did nothing');
});

test('an unset account_id is refused before wrangler is called', { skip: needsShell }, () => {
	// wrangler needs it to know whose namespace to create, and without it fails
	// with a 7003 routing error that does not name the missing field.
	const config = template.replace('YOUR_ZONE_ID', 'zone0123456789').replace('YOUR_ZONE', 'example.com');

	const { output, toml } = run(config, stubForbidden, { expectFailure: true });

	assert.match(output, /account_id/, 'must name the field');
	assert.match(output, /whoami/, 'and the command that produces it');
	assert.match(toml, /YOUR_KV_NAMESPACE_ID/, 'nothing may be written on the way out');
});

test('a missing wrangler.toml is explained rather than crashed on', () => {
	const dir = mkdtempSync(join(tmpdir(), 'linky-kv-'));

	assert.throws(
		() => execFileSync(process.execPath, [script], { cwd: dir, stdio: 'pipe' }),
		(err) => {
			assert.match(`${err.stderr}`, /cp wrangler\.example\.toml wrangler\.toml/, 'must say how to create it');

			return true;
		},
	);
});

test('the step is reachable as an npm script', () => {
	const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

	// The docs tell people `npm run kv`, so the name is part of the contract.
	assert.equal(pkg.scripts.kv, 'node scripts/kv.mjs');
});

test('deploy stops early when the namespace is missing', () => {
	const wrapper = readFileSync('scripts/deploy.mjs', 'utf8');

	// Otherwise wrangler rejects the placeholder id with no hint that one command
	// would have filled it in.
	assert.match(wrapper, /config\.unset\(config\.kvId\)/, 'must check the kv id');
	assert.match(wrapper, /npm run kv/, 'and name the command that sets it');
});

test('the template and the checker both point at the command', () => {
	// Placeholder 5 is the one nobody should be typing, so both places someone
	// looks while stuck have to say so.
	assert.match(template, /── 5 ──[\s\S]{0,200}npm run kv/, 'the template must point at it');

	const checker = readFileSync('scripts/check-config.mjs', 'utf8');

	assert.match(checker, /npm run kv/, 'the checker must point at it');
});

test('the setup doc says the step is automatic and safe to repeat', () => {
	const setup = readFileSync('SETUP.md', 'utf8');

	assert.match(setup, /npm run kv/, 'must name the command');
	assert.match(setup, /again is safe|Running it again/, 'must say re-running is safe');

	// The old instruction was to copy the id across by hand; it must not linger
	// anywhere as a second, contradictory route.
	assert.doesNotMatch(setup, /paste the printed id/i, 'no leftover copy-by-hand instruction');
});
