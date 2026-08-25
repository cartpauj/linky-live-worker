/**
 * Admin accounts — the Google logins allowed to reach /admin.
 *
 * An account is an email address, a role, and — in password mode — a hash. Which
 * of those matter depends on how the deployment authenticates:
 *
 *   password mode   the hash here is the credential, and this file owns it
 *   Access mode     Cloudflare proves who somebody is; the hash is unused, and
 *                   the record says only what that person may do
 *
 * Either way the role lives here and is read on every request rather than
 * trusted from a session, so removing or suspending somebody takes effect on
 * their next click.
 *
 * Records are keyed by email, so an address is the identity. Changing somebody's
 * address means adding the new one and removing the old, which is the honest
 * outcome: it is a different login.
 */

import { hashPassword, validatePassword } from './passwords.js';
import { canActOnAdmin, canGrant, isValidRole, roleOf, wouldStrandService, aOrAn } from './roles.js';
import { adminKey, randomToken } from './util.js';

/** Every admin account, ordered by email so the list is stable between loads. */
export async function listAccounts(env) {
	const list = await env.LINKY.list({ prefix: 'admin:' });
	const accounts = [];

	for (const entry of list.keys) {
		const record = await env.LINKY.get(entry.name, 'json');

		if (record && roleOf(record)) {
			accounts.push({
				email: entry.name.slice('admin:'.length),
				role: roleOf(record),
				active: record.active !== false,
				addedAt: record.addedAt || null,
				addedBy: record.addedBy || null,

				// So the UI can show "has not signed in yet" without ever handling
				// the hash itself.
				pending: record.mustChangePassword === true,
			});
		}
	}

	return accounts.sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * The account for a verified email, or null.
 *
 * A valid Google login on the right domain is not by itself permission to be
 * here — that is what this lookup decides. Somebody at the company who has never
 * been added gets a plain "ask an owner", which is a better answer than silently
 * creating an account for whoever shows up first.
 */
export async function accountFor(env, email) {
	const record = await env.LINKY.get(adminKey(email), 'json');

	if (!record || roleOf(record) === null || record.active === false) {
		return null;
	}

	return {
		email: String(email).toLowerCase(),
		role: roleOf(record),
		mustChangePassword: record.mustChangePassword === true,
	};
}

/** The stored record, for the paths that genuinely need the hash. */
export const rawAccount = (env, email) => env.LINKY.get(adminKey(email), 'json');

/* ------------------------------------------------------------------ *
 * Changes
 *
 * Each returns { error } or { ok, ... }, so the router can stay a router and
 * the same functions can be driven from a script without a Response in the way.
 * ------------------------------------------------------------------ */

/**
 * Normalise and sanity-check an email before it becomes a KV key.
 *
 * Deliberately loose: the address has already been proved by Google for anyone
 * signing in, and an owner adding a colleague is typing an address that does not
 * exist here yet, so there is nothing to check it against. This only rejects
 * shapes that are not addresses at all.
 */
export function normaliseEmail(raw, domain) {
	const email = String(raw || '').trim().toLowerCase();

	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return { error: 'That does not look like an email address.' };
	}

	if (domain && !email.endsWith(`@${domain}`)) {
		return { error: `Only @${domain} addresses can be given access.` };
	}

	return { email };
}

/**
 * A first password nobody chose.
 *
 * Long and random, shown once, and useless after the first sign-in because the
 * account is flagged to require a change. An owner adding a colleague has no way
 * to send them a password securely — so the shape of this is "here is a one-time
 * code, go and pick your own", not "here is your password".
 */
const temporaryPassword = () => randomToken(12);

/**
 * Add an admin account.
 *
 * In password mode this mints a temporary password and hands it back exactly
 * once, for the owner to pass on however they normally would. In Access mode
 * there is no password at all: the record is the whole account, and Cloudflare
 * decides whether that email can log in.
 */
export async function addAccount(env, actor, { email: rawEmail, role, domain, mode = 'password' }) {
	if (!canGrant(actor, role)) {
		return { error: isValidRole(role) ? 'Only owners can add admin accounts.' : 'Pick a role.', status: 403 };
	}

	const parsed = normaliseEmail(rawEmail, domain);

	if (parsed.error) {
		return { error: parsed.error, status: 400 };
	}

	const existing = await env.LINKY.get(adminKey(parsed.email), 'json');

	if (existing && roleOf(existing)) {
		return {
			error: `${parsed.email} already has access, as ${aOrAn(roleOf(existing))}.`,
			status: 409,
		};
	}

	const record = {
		role,
		active: true,
		addedAt: new Date().toISOString(),
		addedBy: actor.email,
	};

	let password = null;

	if (mode === 'password') {
		password = temporaryPassword();
		record.password = await hashPassword(password);
		record.mustChangePassword = true;
	}

	await env.LINKY.put(adminKey(parsed.email), JSON.stringify(record));

	return { ok: true, email: parsed.email, role, password };
}

/**
 * Set somebody's own password.
 *
 * Only ever called for the signed-in account — an owner cannot set a colleague's
 * password, only reset it to a fresh temporary one. Knowing another person's
 * working password is not something the system should make possible, and
 * "reset and hand over a one-time code" covers every real reason to want it.
 */
export async function setOwnPassword(env, actor, { password }) {
	const checked = validatePassword(password, actor.email);

	if (checked.error) {
		return { error: checked.error, status: 400 };
	}

	const record = await env.LINKY.get(adminKey(actor.email), 'json');

	if (!record || !roleOf(record)) {
		return { error: 'Your account is gone. Sign in again.', status: 401 };
	}

	await env.LINKY.put(adminKey(actor.email), JSON.stringify({
		...record,
		password: await hashPassword(checked.value),
		mustChangePassword: false,
		passwordChangedAt: new Date().toISOString(),
	}));

	return { ok: true };
}

/** Reset a colleague to a fresh one-time password, shown once. */
export async function resetPassword(env, actor, { email: rawEmail }) {
	const found = await loadTarget(env, actor, rawEmail);

	if (found.error) {
		return found;
	}

	const { email, record } = found;
	const password = temporaryPassword();

	await env.LINKY.put(adminKey(email), JSON.stringify({
		...record,
		password: await hashPassword(password),
		mustChangePassword: true,
		passwordResetAt: new Date().toISOString(),
	}));

	return { ok: true, email, password };
}

async function loadTarget(env, actor, rawEmail) {
	if (!canActOnAdmin(actor, null)) {
		return { error: 'Only owners can change admin accounts.', status: 403 };
	}

	const email = String(rawEmail || '').trim().toLowerCase();
	const record = await env.LINKY.get(adminKey(email), 'json');

	if (!record || !roleOf(record)) {
		return { error: `${email || 'That account'} does not have access. Reload the page.`, status: 404 };
	}

	return { email, record };
}

/**
 * Why a change was refused for leaving the service without an owner.
 *
 * Phrased from the asker's point of view, because "you are the last owner" and
 * "they are the last owner" call for different next steps even though the check
 * behind them is identical.
 */
const strandedMessage = (email, isSelf, verb) =>
	isSelf
		? `${verb} your own access would leave the service with no owner. `
			+ 'Make somebody else an owner first, then step down.'
		: `${verb} ${email} would leave the service with no owner. Make somebody else an owner first.`;

export async function setRole(env, actor, { email: rawEmail, role }) {
	const found = await loadTarget(env, actor, rawEmail);

	if (found.error) {
		return found;
	}

	if (!canGrant(actor, role)) {
		return { error: isValidRole(role) ? 'Only owners can change roles.' : 'Pick a role.', status: 403 };
	}

	const { email, record } = found;

	if (roleOf(record) === role) {
		return { error: `${email} is already ${aOrAn(role)}.`, status: 400 };
	}

	if (wouldStrandService(await listAccounts(env), email, { role })) {
		return { error: strandedMessage(email, email === actor.email, 'Demoting'), status: 409 };
	}

	await env.LINKY.put(adminKey(email), JSON.stringify({ ...record, role }));

	return { ok: true, email, role };
}

export async function setActive(env, actor, { email: rawEmail, active }) {
	const found = await loadTarget(env, actor, rawEmail);

	if (found.error) {
		return found;
	}

	const { email, record } = found;

	if ((record.active !== false) === active) {
		return { error: `${email} is already ${active ? 'active' : 'suspended'}.`, status: 400 };
	}

	if (!active && wouldStrandService(await listAccounts(env), email, { active: false })) {
		return { error: strandedMessage(email, email === actor.email, 'Suspending'), status: 409 };
	}

	await env.LINKY.put(adminKey(email), JSON.stringify({
		...record,
		active,
		[active ? 'restoredAt' : 'suspendedAt']: new Date().toISOString(),
	}));

	return { ok: true, email, active };
}

export async function removeAccount(env, actor, { email: rawEmail }) {
	const found = await loadTarget(env, actor, rawEmail);

	if (found.error) {
		return found;
	}

	const { email } = found;

	if (wouldStrandService(await listAccounts(env), email, { removed: true })) {
		return { error: strandedMessage(email, email === actor.email, 'Removing'), status: 409 };
	}

	/*
	 * Only the admin record goes. Any team keys this person issued stay exactly
	 * where they are, still working: a key belongs to the user it was issued to,
	 * not to whoever happened to press the button.
	 */
	await env.LINKY.delete(adminKey(email));

	return { ok: true, email };
}
