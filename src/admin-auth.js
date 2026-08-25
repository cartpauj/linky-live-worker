/**
 * Working out who is asking, under whichever sign-in the deployment uses.
 *
 * Two modes, chosen by AUTH_MODE in wrangler.toml:
 *
 *   password   the default. Email and password, hashed here, session in KV.
 *              Nothing to configure beyond deploying, which is the point — a
 *              new deployment should be usable without also standing up an
 *              identity provider.
 *
 *   access     Cloudflare Zero Trust in front of /admin, with Google or any
 *              other IdP behind it. No password is stored, no session is ours,
 *              and the Worker verifies the signed token on every request.
 *
 * Both end at the same place: an email that has been proved, looked up against
 * an admin record for a role. The proof differs; the authorisation does not.
 *
 * The lookup is what makes either mode revocable. Neither a session nor an
 * Access token carries a role — it is read from KV per request — so suspending
 * somebody or changing what they may do lands on their next click rather than
 * whenever their credential happens to expire.
 */

import { accessConfig, identify } from './access.js';
import { accountFor } from './admin-accounts.js';
import { readSession, readSessionToken } from './sessions.js';

export const authMode = (env) =>
	(String(env.AUTH_MODE || 'password').trim().toLowerCase() === 'access' ? 'access' : 'password');

/**
 * The email domain accounts are restricted to, or null for no restriction.
 *
 * Required in Access mode, where it is the difference between "our company" and
 * "anybody with a Google account". Optional with passwords, since an account has
 * to be created deliberately before it can be used at all.
 */
export const emailDomain = (env) =>
	String(env.ADMIN_EMAIL_DOMAIN || '').trim().toLowerCase().replace(/^@/, '') || null;

/**
 * Who is making this request.
 *
 * @returns {Promise<{ actor: object } | { error: string, status: number }>}
 */
export async function currentActor(request, env) {
	if (authMode(env) === 'access') {
		const config = accessConfig(env);

		if (config.missing.length) {
			return {
				status: 503,
				error: `AUTH_MODE is "access" but it is not configured. Missing: ${config.missing.join(', ')}. `
					+ 'See SETUP.md.',
			};
		}

		const who = await identify(request, env);

		if (who.error) {
			return who;
		}

		const account = await accountFor(env, who.email);

		if (!account) {
			/*
			 * A real login at the company, with no account here. Said plainly,
			 * because the alternative — a blank 403 — sends people to check their
			 * Google session when the answer is that nobody has added them yet.
			 */
			return {
				status: 403,
				error: `${who.email} signed in, but has not been given access to this service. Ask an owner to add you.`,
			};
		}

		return { actor: account };
	}

	const token = readSessionToken(request);
	const session = await readSession(env, token);

	if (!session) {
		return { status: 401, error: 'Sign in to manage this service.' };
	}

	const account = await accountFor(env, session.email);

	if (!account) {
		return { status: 401, error: 'Your access has been removed. Sign in again.' };
	}

	return { actor: { ...account, token } };
}
