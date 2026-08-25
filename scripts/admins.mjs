#!/usr/bin/env node

/**
 * Manage who may sign in to the admin area.
 *
 * These are admin accounts — the logins that reach https://<service>/admin — and
 * they have nothing to do with team keys. A key holder runs the Local add-on and
 * never signs in anywhere; an account holder manages the service and may not
 * hold a key at all. Use `npm run keys` for those.
 *
 *   node scripts/admins.mjs init
 *   node scripts/admins.mjs list
 *   node scripts/admins.mjs add alice@example.com manager
 *   node scripts/admins.mjs role alice@example.com owner
 *   node scripts/admins.mjs passwd alice@example.com
 *   node scripts/admins.mjs suspend alice@example.com
 *   node scripts/admins.mjs restore alice@example.com
 *   node scripts/admins.mjs remove alice@example.com
 *
 * This runs as whoever is logged into wrangler, which is above every role — it
 * is the way in when there is no way in, so it applies none of the limits the
 * web UI does. The one rule it keeps is the last-owner check, because a
 * deployment with no owner is a support problem rather than a policy decision.
 */

import { createInterface } from 'node:readline';

import { hashPassword, validatePassword } from '../src/passwords.js';
import { ROLES, isValidRole, roleOf, wouldStrandService } from '../src/roles.js';
import { randomToken } from '../src/util.js';
import { fail, kvDelete, kvGet, kvList, kvPut } from './kv-lib.mjs';
import { readConfig } from './config.mjs';

const recordKey = (email) => `admin:${email}`;

/** Every admin account, in the shape roles.js expects. */
function everyone() {
	return kvList('admin:')
		.map((name) => {
			const record = kvGet(name) || {};

			return {
				email: name.slice('admin:'.length),
				role: roleOf(record),
				active: record.active !== false,
				pending: record.mustChangePassword === true,
				addedAt: record.addedAt || null,
				record,
			};
		})
		.filter((a) => a.role)
		.sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Read the deployment's settings.
 *
 * The email domain and the sign-in mode both live in wrangler.toml, so an
 * account created here lands under the same rules the Worker will apply to it.
 * Creating one the Worker would then refuse to admit is the failure worth
 * ruling out.
 */
function settings() {
	const config = readConfig();

	if (config.missing) {
		fail('No wrangler.toml here. Run this from the project root, after:\n  cp wrangler.example.toml wrangler.toml');
	}

	const mode = (config.value('AUTH_MODE') || 'password').toLowerCase() === 'access' ? 'access' : 'password';
	const domain = (config.value('ADMIN_EMAIL_DOMAIN') || '').toLowerCase().replace(/^@/, '');

	return {
		mode,
		domain: config.unset(domain) ? null : domain,
		bootstrap: (config.value('BOOTSTRAP_OWNER_EMAIL') || '').toLowerCase(),
		serviceHost: config.apiHost,
	};
}

function checkEmail(raw, domain) {
	const email = String(raw || '').trim().toLowerCase();

	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		fail(`"${raw}" does not look like an email address.`);
	}

	if (domain && !email.endsWith(`@${domain}`)) {
		fail(
			`ADMIN_EMAIL_DOMAIN is "${domain}", so ${email} could never sign in.\n\n`
			+ 'Use an address on that domain, or widen ADMIN_EMAIL_DOMAIN in wrangler.toml.',
		);
	}

	return email;
}

function checkRole(raw) {
	const role = String(raw || '').trim().toLowerCase();

	if (!isValidRole(role)) {
		fail(`"${raw}" is not a role. Pick one of: ${ROLES.join(', ')}.`);
	}

	return role;
}

/** Refuse anything that would leave the service with no way in. */
function guardLastOwner(email, after, verb) {
	if (wouldStrandService(everyone(), email, after)) {
		fail(
			`${verb} ${email} would leave the service with no active owner, and nobody\n`
			+ 'able to let anyone back in from the web UI.\n\n'
			+ 'Make somebody else an owner first:\n'
			+ '  npm run admins add someone@example.com owner',
		);
	}
}

async function confirm(question) {
	if (process.argv.includes('--yes') || process.argv.includes('-y')) {
		return true;
	}

	if (!process.stdin.isTTY) {
		fail('Refusing to do that without confirmation. Re-run with --yes, or from a terminal.');
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const answer = await new Promise((resolve) => {
		rl.question(`\n${question} [y/N] `, (reply) => {
			rl.close();
			resolve(reply.trim().toLowerCase());
		});
	});

	if (answer !== 'y' && answer !== 'yes') {
		console.log('\nNothing changed.\n');

		return false;
	}

	return true;
}

/**
 * Write an account, minting a one-time password when the deployment uses one.
 *
 * In Access mode no password is stored at all: Cloudflare proves who somebody
 * is, and the record only says what they may do. Printing a password there would
 * be printing something nothing will ever check.
 */
async function writeAccount(email, role, mode, extra = {}) {
	const record = {
		role,
		active: true,
		addedAt: new Date().toISOString(),
		addedBy: 'cli',
		...extra,
	};

	let password = null;

	if (mode === 'password') {
		password = randomToken(12);
		record.password = await hashPassword(password);
		record.mustChangePassword = true;
	}

	kvPut(recordKey(email), JSON.stringify(record));

	return password;
}

function announce(email, role, password, serviceHost, mode) {
	const where = `https://${serviceHost || '<service>'}/admin`;

	console.log(`\n${email} is now ${role === 'owner' ? 'an owner' : 'a manager'}.\n`);

	if (mode === 'access') {
		console.log('Signing in goes through Cloudflare Access, so there is no password.');
		console.log(`They visit ${where} and log in with their identity provider.\n`);

		return;
	}

	console.log('Send these. The password works once, then they choose their own:\n');
	console.log(`  Sign in:   ${where}`);
	console.log(`  Email:     ${email}`);
	console.log(`  Password:  ${password}\n`);
	console.log('Only a hash is stored, so this cannot be shown again. If it is lost:');
	console.log(`  npm run admins passwd ${email}\n`);
}

/* ------------------------------------------------------------------ */

const [command, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith('-'));

const USAGE = `
Manage who may sign in to the admin area.

  node scripts/admins.mjs init                     Create the first owner
  node scripts/admins.mjs list                     Show every account
  node scripts/admins.mjs add <email> [role]       Add somebody (default: manager)
  node scripts/admins.mjs role <email> <role>      Change what they may do
  node scripts/admins.mjs passwd <email>           Reset to a one-time password
  node scripts/admins.mjs suspend <email>          Block them, keeping the record
  node scripts/admins.mjs restore <email>          Undo a suspend
  node scripts/admins.mjs remove <email>           Delete the account

Roles:

  owner     manages admin accounts, and everything a manager can do
  manager   manages users and their keys

These accounts are not team keys. A key holder runs the Local add-on and never
signs in here; an account holder manages the service and need not hold a key.
Use \`npm run keys\` for users and their keys.

'init' reads BOOTSTRAP_OWNER_EMAIL from wrangler.toml and makes that address the
first owner. Everything after that can be done from the web UI, so this script is
the way in when there is no way in — it applies none of the web UI's limits,
except refusing to leave the service with no owner.

suspend, remove and passwd confirm first. Add --yes to skip that.
`;

async function main() {
	if (!command || command === 'help' || command === '--help') {
		console.log(USAGE);
		process.exit(command ? 0 : 1);
	}

	const config = settings();

	switch (command) {
		case 'init': {
			if (!config.bootstrap) {
				fail(
					'BOOTSTRAP_OWNER_EMAIL is not set in wrangler.toml.\n\n'
					+ 'Put your email there and run this again, or name one directly:\n'
					+ '  npm run admins add you@example.com owner',
				);
			}

			const existing = everyone();

			/*
			 * Only ever the first one. After that, adding owners is a decision for an
			 * owner to make — from the web UI or from `add` — and re-running `init`
			 * should not quietly hand out a fresh password for an account somebody is
			 * already using.
			 */
			if (existing.length) {
				fail(
					`There ${existing.length === 1 ? 'is already an account' : `are already ${existing.length} accounts`}, `
					+ 'so there is nothing to bootstrap.\n\n'
					+ 'To add somebody:            npm run admins add <email> <role>\n'
					+ 'To reset a lost password:   npm run admins passwd <email>',
				);
			}

			const email = checkEmail(config.bootstrap, config.domain);
			const password = await writeAccount(email, 'owner', config.mode);

			announce(email, 'owner', password, config.serviceHost, config.mode);
			break;
		}

		case 'list': {
			const all = everyone();

			if (!all.length) {
				console.log('\nNobody can sign in yet.\n\n  npm run admins init\n');
				break;
			}

			console.log('');

			for (const account of all) {
				const status = !account.active
					? 'suspended'
					: (account.pending ? 'not signed in' : 'active');

				console.log(
					`  ${account.email.padEnd(34)} ${account.role.padEnd(8)} ${status.padEnd(14)} `
					+ `${account.addedAt ? account.addedAt.slice(0, 10) : ''}`,
				);
			}

			console.log(`\n  ${all.length} account(s). Sign in at https://${config.serviceHost || '<service>'}/admin\n`);
			break;
		}

		case 'add': {
			const email = checkEmail(positional[0], config.domain);
			const role = positional[1] ? checkRole(positional[1]) : 'manager';

			if (everyone().some((a) => a.email === email)) {
				fail(
					`${email} already has an account.\n\n`
					+ `To change what they may do:  npm run admins role ${email} <role>\n`
					+ `To reset their password:     npm run admins passwd ${email}`,
				);
			}

			const password = await writeAccount(email, role, config.mode);

			announce(email, role, password, config.serviceHost, config.mode);
			break;
		}

		case 'role': {
			const email = checkEmail(positional[0], config.domain);
			const role = checkRole(positional[1]);
			const account = everyone().find((a) => a.email === email);

			if (!account) {
				fail(`${email} does not have an account.\n\n  npm run admins add ${email} ${role}`);
			}

			if (account.role === role) {
				console.log(`\n${email} is already ${role === 'owner' ? 'an owner' : 'a manager'}. Nothing to do.\n`);
				break;
			}

			guardLastOwner(email, { role }, 'Demoting');

			kvPut(recordKey(email), JSON.stringify({ ...account.record, role }));

			console.log(`\n${email} is now ${role === 'owner' ? 'an owner' : 'a manager'}.\n`);
			break;
		}

		case 'passwd': {
			if (config.mode === 'access') {
				fail(
					'AUTH_MODE is "access", so sign-in goes through Cloudflare and there are\n'
					+ 'no passwords here to reset.',
				);
			}

			const email = checkEmail(positional[0], config.domain);
			const account = everyone().find((a) => a.email === email);

			if (!account) {
				fail(`${email} does not have an account.`);
			}

			if (!(await confirm(`Reset the password for ${email}? Any session they have open ends.`))) {
				break;
			}

			/*
			 * A chosen password can be passed in, for the case where somebody is
			 * standing next to you. Left out, a random one is minted — which is the
			 * better default, since it cannot be reused from another service.
			 */
			let password = positional[1];

			if (password) {
				const checked = validatePassword(password, email);

				if (checked.error) {
					fail(checked.error);
				}
			} else {
				password = randomToken(12);
			}

			kvPut(recordKey(email), JSON.stringify({
				...account.record,
				password: await hashPassword(password),
				mustChangePassword: true,
				passwordResetAt: new Date().toISOString(),
			}));

			dropSessions(email);

			console.log(`\nOne-time password for ${email}:\n`);
			console.log(`  Sign in:   https://${config.serviceHost || '<service>'}/admin`);
			console.log(`  Password:  ${password}\n`);
			console.log('They must choose their own on first sign-in.\n');
			break;
		}

		case 'suspend':
		case 'restore': {
			const email = checkEmail(positional[0], config.domain);
			const active = command === 'restore';
			const account = everyone().find((a) => a.email === email);

			if (!account) {
				fail(`${email} does not have an account.`);
			}

			if (account.active === active) {
				console.log(`\n${email} is already ${active ? 'active' : 'suspended'}. Nothing to do.\n`);
				break;
			}

			if (!active) {
				guardLastOwner(email, { active: false }, 'Suspending');

				if (!(await confirm(`Suspend ${email}? They lose access immediately.`))) {
					break;
				}
			}

			kvPut(recordKey(email), JSON.stringify({
				...account.record,
				active,
				[active ? 'restoredAt' : 'suspendedAt']: new Date().toISOString(),
			}));

			if (!active) {
				dropSessions(email);
			}

			console.log(`\n${active ? 'Restored' : 'Suspended'} ${email}.\n`);
			break;
		}

		case 'remove': {
			const email = checkEmail(positional[0], config.domain);

			if (!everyone().some((a) => a.email === email)) {
				fail(`${email} does not have an account.`);
			}

			guardLastOwner(email, { removed: true }, 'Removing');

			if (!(await confirm(`Remove ${email}? They lose access to the admin area.`))) {
				break;
			}

			kvDelete(recordKey(email));
			dropSessions(email);

			/*
			 * Only the account goes. Any team keys this person issued keep working:
			 * a key belongs to the user it was issued to, not to whoever pressed the
			 * button.
			 */
			console.log(`\nRemoved ${email}. Nobody's key or addresses were touched.\n`);
			break;
		}

		default:
			fail(`Unknown command "${command}".${USAGE}`);
	}
}

/** End any open browser session for an account whose access just changed. */
function dropSessions(email) {
	for (const name of kvList('session:')) {
		const session = kvGet(name);

		if (session && String(session.email).toLowerCase() === email) {
			kvDelete(name);
		}
	}
}

await main();
