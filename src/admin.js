/**
 * The admin area: routing, and the checks every route shares.
 *
 * Two unrelated things are managed here, and keeping them apart is most of the
 * design:
 *
 *   admin accounts   email logins that reach this page. Owners and managers.
 *   users and keys   people who run the Local add-on. No login, no role.
 *
 * A user is not an account. Removing a user does not touch anybody's login;
 * removing an account does not touch anybody's key. Nothing joins the two
 * tables, and no code below looks one up from the other.
 *
 * Signing in is either a password or Cloudflare Access, decided by AUTH_MODE and
 * resolved in admin-auth.js. Everything past that point is identical, because
 * authorisation reads a role out of KV rather than out of whatever proved the
 * identity.
 */

import { authMode, currentActor, emailDomain } from './admin-auth.js';

import {
	addAccount,
	listAccounts,
	rawAccount,
	removeAccount,
	resetPassword,
	setActive,
	setOwnPassword,
	setRole,
} from './admin-accounts.js';

import {
	issueKey,
	listUsers,
	removeKey,
	rollKey,
	setKeyActive,
	sitesOf,
	siteView,
} from './admin-keys.js';

import { needsUpgrade, hashPassword, verifyPassword } from './passwords.js';
import { canManageAdmins, canManageKeys, grantableBy, wouldStrandService } from './roles.js';

import {
	clearSessionCookie,
	endSession,
	endSessionsFor,
	readSessionToken,
	setSessionCookie,
	startSession,
} from './sessions.js';

import { ADMIN_HTML } from './admin-ui.js';
import { adminKey } from './util.js';

const json = (data, status = 200, headers = {}) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
	});

const fail = (message, status = 400) => json({ ok: false, error: message }, status);

/** Turn what the account and key modules return into a response. */
const respond = (result) =>
	(result.error ? fail(result.error, result.status || 400) : json(result));

/* ------------------------------------------------------------------ *
 * Signing in with a password
 * ------------------------------------------------------------------ */

async function handleLogin(request, env) {
	if (authMode(env) === 'access') {
		return fail('This service signs in through Cloudflare Access. Reload the page.', 400);
	}

	let body;

	try {
		body = await request.json();
	} catch {
		return fail('Request body must be JSON.');
	}

	const email = String(body.email || '').trim().toLowerCase();
	const password = String(body.password || '');
	const record = email ? await rawAccount(env, email) : null;

	const matches = await verifyPassword(password, record && record.password);

	/*
	 * One message for every kind of failure — no such account, wrong password,
	 * suspended. Distinguishing them turns this form into a way to find out who
	 * has access, which is worth more to somebody guessing than it is to somebody
	 * who simply mistyped.
	 */
	if (!record || !matches || record.active === false) {
		return fail('That email and password do not match an account.', 401);
	}

	// Raising the iteration count only helps if existing hashes move up to it,
	// and a sign-in is the one moment the plaintext is in hand to do that.
	if (needsUpgrade(record.password)) {
		await env.LINKY.put(adminKey(email), JSON.stringify({ ...record, password: await hashPassword(password) }));
	}

	const token = await startSession(env, email, { mustChangePassword: record.mustChangePassword === true });

	return json({ ok: true }, 200, { 'Set-Cookie': setSessionCookie(token) });
}

async function handleLogout(request, env) {
	await endSession(env, readSessionToken(request));

	return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * Everything the page draws, in one call.
 *
 * `manageable` style flags are computed here rather than in the browser, so the
 * page greys out exactly what the API would refuse and the two can never drift.
 * Disabling a control is a courtesy to whoever is clicking; the check that
 * matters is the one beside the write.
 */
async function handleState(env, actor) {
	const mode = authMode(env);

	if (actor.mustChangePassword) {
		// Nothing else is loaded until they have picked a password. A page that
		// showed the console behind the change-password form would be showing
		// somebody a service they have not finished signing in to.
		return json({ ok: true, mode, you: actor, mustChangePassword: true });
	}

	const all = canManageAdmins(actor) ? await listAccounts(env) : [];

	/*
	 * `lastOwner` marks the account that cannot be removed, demoted or suspended
	 * without leaving nobody able to administer the service. Worked out here for
	 * the same reason every other permission is: the page then greys out exactly
	 * what the API would refuse, instead of offering a button that always fails.
	 */
	const accounts = all.map((a) => ({
		...a,
		you: a.email === actor.email,
		lastOwner: wouldStrandService(all, a.email, { removed: true }),
	}));

	const users = [];

	for (const user of await listUsers(env)) {
		users.push({ ...user, sites: (await sitesOf(env, user.hash)).map(siteView) });
	}

	return json({
		ok: true,
		mode,
		you: { email: actor.email, role: actor.role },
		canManageAdmins: canManageAdmins(actor),
		canGrant: grantableBy(actor),
		domain: emailDomain(env),
		accounts,
		users,
	});
}

/** Owner-only, and the reason is always the same one. */
const ownerOnly = (actor) =>
	(canManageAdmins(actor) ? null : fail('Only owners can manage admin accounts.', 403));

async function handleAccountRoute(action, env, actor, body) {
	const refusal = ownerOnly(actor);

	if (refusal) {
		return refusal;
	}

	const mode = authMode(env);

	switch (action) {
		case 'add':
			return respond(await addAccount(env, actor, {
				email: body.email,
				role: body.role,
				domain: emailDomain(env),
				mode,
			}));

		case 'role':
			return respond(await setRole(env, actor, { email: body.email, role: body.role }));

		case 'suspend': {
			const result = await setActive(env, actor, { email: body.email, active: false });

			// A suspended account must stop working now, not when its session runs out.
			if (result.ok) {
				await endSessionsFor(env, result.email);
			}

			return respond(result);
		}

		case 'restore':
			return respond(await setActive(env, actor, { email: body.email, active: true }));

		case 'remove': {
			const result = await removeAccount(env, actor, { email: body.email });

			if (result.ok) {
				await endSessionsFor(env, result.email);
			}

			return respond(result);
		}

		case 'reset': {
			if (mode === 'access') {
				return fail('This service signs in through Cloudflare Access, so there are no passwords to reset.');
			}

			const result = await resetPassword(env, actor, { email: body.email });

			// Their old password is gone, so any session resting on it goes too.
			if (result.ok) {
				await endSessionsFor(env, result.email);
			}

			return respond(result);
		}

		default:
			return fail('Unknown endpoint.', 404);
	}
}

async function handleKeyRoute(action, env, actor, body) {
	if (!canManageKeys(actor)) {
		return fail('You do not have access to this service.', 403);
	}

	switch (action) {
		case 'issue':
			return respond(await issueKey(env, { name: body.name }));

		case 'revoke':
			return respond(await setKeyActive(env, { hash: body.hash, active: false }));

		case 'restore':
			return respond(await setKeyActive(env, { hash: body.hash, active: true }));

		case 'roll':
			return respond(await rollKey(env, { hash: body.hash }));

		case 'remove':
			return respond(await removeKey(env, { hash: body.hash, expectAddresses: body.expectAddresses }));

		default:
			return fail('Unknown endpoint.', 404);
	}
}

async function handlePassword(env, actor, body) {
	if (authMode(env) === 'access') {
		return fail('This service signs in through Cloudflare Access, so there is no password to change.');
	}

	const result = await setOwnPassword(env, actor, { password: body.password });

	if (result.error) {
		return fail(result.error, result.status || 400);
	}

	/*
	 * Every other session for this account ends, but not this one.
	 *
	 * Changing a password is how somebody responds to a session they think
	 * another person has, so leaving the rest alive would defeat the point —
	 * while signing them out of the tab they just used would be baffling.
	 */
	await endSessionsFor(env, actor.email, { except: actor.token });

	// The session was flagged at sign-in; a fresh one clears the flag.
	const token = await startSession(env, actor.email, { mustChangePassword: false });
	await endSession(env, actor.token);

	return json({ ok: true }, 200, { 'Set-Cookie': setSessionCookie(token) });
}

/* ------------------------------------------------------------------ */

export async function handleAdmin(request, env, url) {
	const path = url.pathname.replace(/\/+$/, '') || '/admin';

	// The page is served to anybody; it is a sign-in form until the API says
	// otherwise, and shipping it unauthenticated keeps signing in to one round
	// trip. It contains no data — everything comes from /admin/api/state.
	if (path === '/admin' && request.method === 'GET') {
		return new Response(ADMIN_HTML, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'X-Robots-Tag': 'noindex, nofollow',
				/*
				 * Everything the page needs is inline, so nothing is fetched from
				 * anywhere. Saying so explicitly means a future edit that reaches for a
				 * CDN fails loudly here, rather than quietly adding a third party to a
				 * page that hands out credentials.
				 */
				'Content-Security-Policy':
					"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
					+ "connect-src 'self'; img-src data:; form-action 'none'; frame-ancestors 'none'",
				'Referrer-Policy': 'no-referrer',
			},
		});
	}

	if (path === '/admin/api/login' && request.method === 'POST') {
		return handleLogin(request, env);
	}

	if (path === '/admin/api/logout' && request.method === 'POST') {
		return handleLogout(request, env);
	}

	const who = await currentActor(request, env);

	if (who.error) {
		return fail(who.error, who.status || 401);
	}

	const actor = who.actor;

	if (path === '/admin/api/state' && request.method === 'GET') {
		return handleState(env, actor);
	}

	if (request.method !== 'POST') {
		return fail('Method not allowed.', 405);
	}

	/*
	 * A header no cross-site form can set.
	 *
	 * With a password the session cookie is already SameSite=Strict; with Access
	 * the cookie is Cloudflare's and its attributes are not ours to choose. This
	 * covers both: an HTML form can be pointed at any URL, but it cannot add a
	 * header, so a request arriving without this one did not come from the admin
	 * page.
	 */
	if (request.headers.get('X-Linky-Admin') !== '1') {
		return fail('Bad request.', 403);
	}

	let body;

	try {
		body = await request.json();
	} catch {
		return fail('Request body must be JSON.');
	}

	if (path === '/admin/api/password') {
		return handlePassword(env, actor, body);
	}

	/*
	 * A first sign-in stops here.
	 *
	 * The account is real and the role is real, but the password is one somebody
	 * else generated and may well have sent over chat. Until it is replaced, the
	 * only thing this session can do is replace it.
	 */
	if (actor.mustChangePassword) {
		return fail('Choose a password before making changes.', 403);
	}

	const account = path.match(/^\/admin\/api\/accounts\/([a-z]+)$/);

	if (account) {
		return handleAccountRoute(account[1], env, actor, body);
	}

	const key = path.match(/^\/admin\/api\/keys\/([a-z]+)$/);

	if (key) {
		return handleKeyRoute(key[1], env, actor, body);
	}

	return fail('Unknown endpoint.', 404);
}
