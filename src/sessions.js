/**
 * Browser sessions, for password sign-in.
 *
 * Cloudflare Access brings its own session, so none of this runs in Access mode.
 * With passwords there has to be something, and it is a random token in KV
 * rather than a signed cookie: signing out, suspending somebody, or removing
 * their account then ends the session at once instead of leaving a valid token
 * in the wild until it expires. Sessions are cheap to look up here because the
 * admin area is low traffic — this is not the gateway hot path.
 */

import { randomToken, sessionKey, sha256Hex } from './util.js';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const COOKIE = 'linky_admin';

/*
 * `Secure` is unconditional even though it makes the cookie useless over plain
 * HTTP. The Worker is only reached through Cloudflare, which is HTTPS, and a
 * flag that quietly turns itself off in some environments is a flag you cannot
 * reason about. `wrangler dev --local` is the one place this bites; use the CLI
 * there.
 */
const cookie = (value, maxAge) =>
	`${COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export const setSessionCookie = (token) => cookie(token, SESSION_TTL_SECONDS);
export const clearSessionCookie = () => cookie('', 0);

export function readSessionToken(request) {
	const header = request.headers.get('Cookie') || '';

	for (const part of header.split(';')) {
		const eq = part.indexOf('=');

		if (eq !== -1 && part.slice(0, eq).trim() === COOKIE) {
			return part.slice(eq + 1).trim();
		}
	}

	return null;
}

export async function startSession(env, email, { mustChangePassword = false } = {}) {
	const token = randomToken();

	await env.LINKY.put(
		sessionKey(await sha256Hex(token)),
		JSON.stringify({ email: String(email).toLowerCase(), mustChangePassword, startedAt: new Date().toISOString() }),
		{ expirationTtl: SESSION_TTL_SECONDS },
	);

	return token;
}

export async function readSession(env, token) {
	if (!token) {
		return null;
	}

	return env.LINKY.get(sessionKey(await sha256Hex(token)), 'json');
}

export async function endSession(env, token) {
	if (token) {
		await env.LINKY.delete(sessionKey(await sha256Hex(token)));
	}
}

/**
 * End every session belonging to one account.
 *
 * Called after suspending or removing somebody, and after they change their own
 * password — a password change is how you respond to a session you think
 * somebody else has, so leaving the others alive would defeat the point.
 */
export async function endSessionsFor(env, email, { except = null } = {}) {
	const target = String(email).toLowerCase();
	const list = await env.LINKY.list({ prefix: 'session:' });

	for (const entry of list.keys) {
		if (except && entry.name === sessionKey(await sha256Hex(except))) {
			continue;
		}

		const session = await env.LINKY.get(entry.name, 'json');

		if (session && String(session.email).toLowerCase() === target) {
			await env.LINKY.delete(entry.name);
		}
	}
}
