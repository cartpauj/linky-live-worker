#!/usr/bin/env node

/**
 * Manage who may use the Linky Live add-on.
 *
 * Keys are stored in KV as a SHA-256 of the key plus a display name, so a key can
 * be verified but never read back — not by this script, not by the Worker, not by
 * anyone with dashboard access. A lost key is reissued rather than recovered.
 *
 *   node scripts/keys.mjs issue "Alice"
 *   node scripts/keys.mjs list
 *   node scripts/keys.mjs revoke "Alice"
 *   node scripts/keys.mjs restore "Alice"
 *   node scripts/keys.mjs remove "Alice"
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const BINDING = 'LINKY';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/* ------------------------------------------------------------------ */

function fail(message) {
	console.error(`\n${message}\n`);
	process.exit(1);
}

/** Fail early with something actionable rather than a wrangler stack trace. */
function checkConfig() {
	let config;

	try {
		config = readFileSync('wrangler.toml', 'utf8');
	} catch {
		fail('No wrangler.toml here. Run this from the project root, after:\n  cp wrangler.example.toml wrangler.toml');
	}

	if (/YOUR_KV_NAMESPACE_ID/.test(config)) {
		fail('wrangler.toml still has the placeholder KV id. Run:\n  npx wrangler kv namespace create LINKY\nthen paste the printed id into the [[kv_namespaces]] block.');
	}

	// The route pattern is the hostname the add-on talks to, so a new key can be
	// handed over complete rather than in two pieces from two places.
	const route = config.match(/^\s*pattern\s*=\s*"([^"]+)"/m);

	return { serviceHost: route ? route[1].replace(/\/\*$/, '') : null };
}

function wrangler(args, { quiet = false } = {}) {
	try {
		return execFileSync('npx', ['wrangler', ...args], {
			encoding: 'utf8',
			stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
		});
	} catch (err) {
		if (quiet) {
			return null;
		}

		fail(`wrangler failed:\n${err.stderr || err.stdout || err.message}`);
	}

	return null;
}

const kvPut = (key, value) =>
	wrangler(['kv', 'key', 'put', key, value, `--binding=${BINDING}`, '--remote']);

const kvGet = (key) => {
	const out = wrangler(['kv', 'key', 'get', key, `--binding=${BINDING}`, '--remote'], { quiet: true });

	try {
		return out ? JSON.parse(out) : null;
	} catch {
		return null;
	}
};

const kvDelete = (key) =>
	wrangler(['kv', 'key', 'delete', key, `--binding=${BINDING}`, '--remote', '--force']);

function everyone() {
	const raw = wrangler(['kv', 'key', 'list', `--binding=${BINDING}`, '--prefix=teamkey:', '--remote']);
	const keys = JSON.parse(raw || '[]');

	return keys
		.map(({ name }) => ({ hash: name.replace('teamkey:', ''), ...(kvGet(name) || {}) }))
		.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Print people as a numbered table.
 *
 * The number is the person's position in the full sorted list, not in whatever
 * subset is being shown. That way a number means the same thing whether it came
 * from `list` or from `search` — numbering a filtered view separately would make
 * `remove 2` mean different people depending on how you found them.
 */
function show(people, all) {
	console.log('');

	for (const person of people) {
		const number = all.findIndex((p) => p.hash === person.hash) + 1;
		const status = person.active === false ? 'revoked' : 'active';
		const when = person.issuedAt ? person.issuedAt.slice(0, 10) : '';

		console.log(
			`  ${String(number).padStart(3)}  ${String(person.name || '?').padEnd(24)} `
			+ `${status.padEnd(8)} ${when}  ${person.hint ? `…${person.hint}` : '—'}`,
		);
	}
}

/**
 * Turn what the user typed into exactly one person.
 *
 * Accepts, in order of how safe each is against a shifting list:
 *
 *   remove …Qw8zT1     the key fragment alone — cannot shift, so no prompt
 *   remove 3 Qw8zT1    a number, checked against the fragment at that position
 *   remove 3           a number alone, confirmed by name
 *   remove "Alice"     a name, confirmed by name
 *
 * Numbers are positions in a shared list. If another admin issues or removes a
 * key in between, every later number moves by one — so a number paired with the
 * fragment printed beside it is verified rather than trusted.
 *
 * @returns {{ person: object, verified: boolean }}
 */
function resolve(tokens) {
	const all = everyone();

	if (!all.length) {
		fail('Nobody has a key yet.');
	}

	// Fragments are printed with a leading ellipsis; accept it either way.
	const clean = (t) => String(t || '').trim().replace(/^…/, '').replace(/^\.\.\./, '');
	const parts = tokens.map(clean).filter(Boolean);

	if (!parts.length) {
		fail('Who? Pass a number or key fragment from `list`, or a name.');
	}

	const byHint = (value) => all.filter((p) => p.hint && p.hint === value);

	// A number plus the fragment printed beside it.
	if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
		const person = all[Number(parts[0]) - 1];

		if (!person) {
			fail(`There is no #${parts[0]}. The list has ${all.length} entries.`);
		}

		if (person.hint !== parts[1]) {
			const actual = byHint(parts[1])[0];

			fail(
				`#${parts[0]} is ${person.name} (…${person.hint}), not …${parts[1]}.\n\n`
				+ 'The list has changed since you looked — someone else added or removed a key.\n'
				+ (actual
					? `…${parts[1]} is now ${actual.name}. Re-run with just the fragment:\n  npm run keys ${command} …${parts[1]}`
					: `Nothing ends in …${parts[1]} any more. Run \`list\` again.`),
			);
		}

		return { person, verified: true };
	}

	const single = parts[0];

	// A fragment on its own, which cannot be shifted by someone else's edit.
	const hinted = byHint(single);

	if (hinted.length === 1) {
		return { person: hinted[0], verified: true };
	}

	if (hinted.length > 1) {
		console.log(`\nMore than one key ends in …${single}. Use a number and fragment:`);
		show(hinted, all);
		console.log('');
		process.exit(1);
	}

	// A bare number.
	if (/^\d+$/.test(single)) {
		const person = all[Number(single) - 1];

		if (!person) {
			fail(`There is no #${single}. The list has ${all.length} entries.`);
		}

		return { person, verified: false };
	}

	// A name.
	const wanted = single.toLowerCase();
	const named = all.find((p) => String(p.name || '').toLowerCase() === wanted);

	if (named) {
		return { person: named, verified: false };
	}

	const near = all.filter((p) => String(p.name || '').toLowerCase().includes(wanted));

	if (near.length) {
		console.log(`\nNo exact match for "${single}". Did you mean one of these?`);
		show(near, all);
		console.log('');
		process.exit(1);
	}

	fail(`Nothing matches "${single}". Run \`list\` to see who has a key.`);

	return null;
}

/**
 * Confirm a destructive action, naming exactly who it resolved to.
 *
 * Numbers come from a listing taken moments earlier, and the list is shared: if
 * someone else issues or removes a key in between, every number after theirs
 * shifts by one. Echoing the name and hash means a shifted number is caught by
 * the person, not discovered afterwards.
 *
 * `--yes` skips the prompt for scripted use.
 */
async function confirm(action, person) {
	if (process.argv.includes('--yes') || process.argv.includes('-y')) {
		return true;
	}

	if (!process.stdin.isTTY) {
		fail(`Refusing to ${action} without confirmation. Re-run with --yes, or from a terminal.`);
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const answer = await new Promise((resolve) => {
		rl.question(
			`\n${action} ${person.name} (${person.hash.slice(0, 12)}…)? [y/N] `,
			(reply) => {
				rl.close();
				resolve(reply.trim().toLowerCase());
			},
		);
	});

	if (answer !== 'y' && answer !== 'yes') {
		console.log('\nNothing changed.\n');

		return false;
	}

	return true;
}

/* ------------------------------------------------------------------ */

const [command, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => a !== '--yes' && a !== '-y');
const arg = positional.join(' ').trim();

const USAGE = `
Manage who may use the Linky Live add-on.

  node scripts/keys.mjs issue "Alice"       Generate a key and print it once
  node scripts/keys.mjs list                Show everyone, with a fragment each
  node scripts/keys.mjs search alice        Same, filtered
  node scripts/keys.mjs revoke …Qw8zT1      Block them, keeping the record
  node scripts/keys.mjs restore …Qw8zT1     Undo a revoke
  node scripts/keys.mjs remove …Qw8zT1      Delete the record entirely

revoke, restore and remove confirm first, naming who they matched. Add --yes to
skip that.

The fragment shown in `list` is what identifies a key — it never changes. A name
works too, and a row number is accepted for quick use:

  …Qw8zT1        the fragment; preferred
  "Alice"        a name
  3 Qw8zT1       a row number, checked against that fragment
  3              a row number alone, confirmed by name

Row numbers move when anyone adds or removes a key, so they are checked or
confirmed rather than trusted. --yes skips prompts.
`;

if (!command || command === 'help' || command === '--help') {
	console.log(USAGE);
	process.exit(command ? 0 : 1);
}

const { serviceHost } = checkConfig();

async function main() {
		switch (command) {
		case 'issue': {
			if (!arg) {
				fail('Who is it for?\n  node scripts/keys.mjs issue "Alice"');
			}

			/*
			 * Names are unique, so a name stays a reliable way to refer to someone.
			 * Without that, `remove "Alice"` becomes ambiguous the moment a second
			 * Alice exists — and the safe response to an ambiguous destructive
			 * command is to refuse, which is worse than refusing here, where the fix
			 * is obvious.
			 */
			const taken = everyone().find((p) => String(p.name).toLowerCase() === arg.toLowerCase());

			if (taken) {
				const revoked = taken.active === false;

				fail(
					`"${taken.name}" already has a key${revoked ? ' (currently revoked)' : ''}.\n\n`
					+ (revoked
						? `Bring it back:\n  npm run keys restore "${taken.name}"\n\nOr roll it:\n`
						: 'Use a different name, or roll theirs:\n')
					+ `  npm run keys remove "${taken.name}"\n`
					+ `  npm run keys issue "${taken.name}"`,
				);
			}

			// 32 random bytes, url-safe so it survives chat, email and password managers.
			const key = `linky_${randomBytes(32).toString('base64url')}`;

			/*
			 * `hint` is the last six characters of the key.
			 *
			 * The key itself is never stored — only its hash — so there is no way to
			 * show anyone their key again; a lost key is rolled, not recovered. But
			 * without some fragment, `list` cannot answer "which of these is mine?",
			 * which matters when one person holds keys on several machines. Six
			 * characters identify a key among a handful without narrowing a
			 * brute-force search of 32 random bytes to any useful degree.
			 */
			kvPut(`teamkey:${sha256(key)}`, JSON.stringify({
				name: arg,
				active: true,
				hint: key.slice(-6),
				issuedAt: new Date().toISOString(),
			}));

			// Both halves together: the add-on needs each on first run, and hunting
			// for the hostname separately is how people end up guessing it.
			console.log(`\nKey for ${arg} — send both lines:\n`);
			console.log(`  Service:  ${serviceHost || '(not set in wrangler.toml)'}`);
			console.log(`  Key:      ${key}\n`);
			console.log('They enter these in Local, in the Linky Live tab of any site.\n');
			console.log('Only a hash is stored, so this key cannot be shown again. If it is');
			console.log(`lost, roll it:\n  npm run keys remove "${arg}" && npm run keys issue "${arg}"\n`);
			break;
		}

		case 'list':
		case 'search': {
			const all = everyone();

			if (!all.length) {
				console.log('\nNobody has a key yet.\n\n  node scripts/keys.mjs issue "Alice"\n');
				break;
			}

			const shown = command === 'search' && arg
				? all.filter((p) => String(p.name || '').toLowerCase().includes(arg.toLowerCase()))
				: all;

			if (!shown.length) {
				console.log(`\nNothing matches "${arg}". ${all.length} key(s) in total.\n`);
				break;
			}

			show(shown, all);

			console.log(
				`\n  ${shown.length}${shown.length === all.length ? '' : ` of ${all.length}`} key(s). `
				+ 'Include the fragment to be sure of the target:\n'
				+ `    npm run keys remove …${shown[0].hint || ''}\n`
				+ `    npm run keys remove ${all.findIndex((p) => p.hash === shown[0].hash) + 1} ${shown[0].hint || ''}\n`,
			);
			break;
		}

		case 'revoke':
		case 'restore': {
			if (!arg) {
				fail(`Who?\n  node scripts/keys.mjs ${command} "Alice"`);
			}

			const { person, verified } = resolve(positional);
			const active = command === 'restore';

			// A verified fragment already identifies the person, so a prompt adds nothing.
			if (!verified && !(await confirm(active ? 'Restore' : 'Revoke', person))) {
				break;
			}

			if ((person.active !== false) === active) {
				console.log(`\n${person.name} is already ${active ? 'active' : 'revoked'}. Nothing to do.\n`);
				break;
			}

			kvPut(`teamkey:${person.hash}`, JSON.stringify({
				...person,
				hash: undefined,
				active,
				[active ? 'restoredAt' : 'revokedAt']: new Date().toISOString(),
			}));

			console.log(`\n${active ? 'Restored' : 'Revoked'} ${person.name}.`);

			if (!active) {
				console.log('They cannot provision anything from now on. Links already running keep');
				console.log('running until stopped, so release any hostnames you want reclaimed.');
			}

			console.log('');
			break;
		}

		case 'remove': {
			if (!arg) {
				fail('Who?\n  node scripts/keys.mjs remove "Alice"');
			}

			const { person, verified } = resolve(positional);

			if (!verified && !(await confirm('Permanently remove', person))) {
				break;
			}

			kvDelete(`teamkey:${person.hash}`);

			console.log(`\nRemoved ${person.name}.`);
			console.log('Their site records remain in KV. Use `revoke` instead if you might');
			console.log('want to restore access later.\n');
			break;
		}

		default:
				fail(`Unknown command "${command}".${USAGE}`);
		}
	}

await main();
