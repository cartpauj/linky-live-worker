/**
 * Cloudflare Access — verifying who is at the door.
 *
 * The admin area is fronted by an Access application in Cloudflare Zero Trust,
 * with Google as the identity provider and a policy that admits one email
 * domain. Access does the login; this file decides whether to believe it.
 *
 * That second half is not belt-and-braces, it is load-bearing. An Access
 * application is attached to a hostname on the zone, and the Worker also answers
 * on its workers.dev URL — which no Access policy covers. A Worker that trusted
 * the presence of a header would therefore be wide open at its other address, so
 * the token is verified cryptographically on every request:
 *
 *   1. The JWT arrives as Cf-Access-Jwt-Assertion, put there by Access, or as
 *      the CF_Authorization cookie on a plain browser navigation.
 *   2. Its signature is checked against the team's public keys, fetched from
 *      <team>.cloudflareaccess.com and cached in memory.
 *   3. `aud` must be this application's tag, so a token minted for some other
 *      Access app in the same account is not accepted here.
 *   4. `iss` must be the configured team, and `exp`/`nbf` must be current.
 *   5. The email is re-checked against the allowed domain, so the Worker does
 *      not depend on the Access policy having been written correctly.
 *
 * Passing all five proves a Google login on the right domain. It says nothing
 * about what that person may do here — that is an admin record, in admins.js.
 */

const CERTS_TTL_MS = 60 * 60 * 1000;

/*
 * Cached across requests on the same isolate.
 *
 * Signing keys rotate rarely and every admin request would otherwise mean a
 * round trip to fetch them. A verification that fails on an unknown key id
 * refetches immediately, so a rotation costs one slow request rather than an
 * hour of failures.
 */
let certsCache = { at: 0, keys: null, team: null };

const decodeSegment = (segment) => {
	const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));

	return bytes;
};

const decodeJson = (segment) => JSON.parse(new TextDecoder().decode(decodeSegment(segment)));

async function fetchCerts(teamDomain, { force = false } = {}) {
	const fresh = certsCache.keys
		&& certsCache.team === teamDomain
		&& Date.now() - certsCache.at < CERTS_TTL_MS;

	if (fresh && !force) {
		return certsCache.keys;
	}

	const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);

	if (!res.ok) {
		throw new Error(`Could not fetch Access signing keys (HTTP ${res.status}).`);
	}

	const body = await res.json();
	const keys = Array.isArray(body.keys) ? body.keys : [];

	certsCache = { at: Date.now(), keys, team: teamDomain };

	return keys;
}

async function verifySignature(teamDomain, token, kid) {
	const [header, payload, signature] = token.split('.');
	const data = new TextEncoder().encode(`${header}.${payload}`);
	const sig = decodeSegment(signature);

	// One retry with fresh keys, so a rotation heals itself rather than locking
	// everybody out until the cache expires.
	for (const force of [false, true]) {
		const keys = await fetchCerts(teamDomain, { force });
		const jwk = keys.find((k) => k.kid === kid);

		if (!jwk) {
			if (force) {
				return false;
			}

			continue;
		}

		const key = await crypto.subtle.importKey(
			'jwk',
			jwk,
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['verify'],
		);

		if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data)) {
			return true;
		}

		if (force) {
			return false;
		}
	}

	return false;
}

/** The token Access attached, from either place it can appear. */
function readToken(request) {
	const header = request.headers.get('Cf-Access-Jwt-Assertion');

	if (header) {
		return header.trim();
	}

	const cookies = request.headers.get('Cookie') || '';

	for (const part of cookies.split(';')) {
		const eq = part.indexOf('=');

		if (eq !== -1 && part.slice(0, eq).trim() === 'CF_Authorization') {
			return part.slice(eq + 1).trim();
		}
	}

	return null;
}

/**
 * Is Access wired up at all?
 *
 * Returned separately so a missing configuration is reported as "this is not set
 * up yet" rather than "you are not allowed in". Without it the first symptom of
 * a half-finished setup is a login loop with no explanation.
 */
export function accessConfig(env) {
	const teamDomain = String(env.ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
	const aud = String(env.ACCESS_AUD || '').trim();
	const domain = String(env.ADMIN_EMAIL_DOMAIN || '').trim().toLowerCase().replace(/^@/, '');

	const missing = [
		!teamDomain && 'ACCESS_TEAM_DOMAIN',
		!aud && 'ACCESS_AUD',
		!domain && 'ADMIN_EMAIL_DOMAIN',
	].filter(Boolean);

	return { teamDomain, aud, domain, missing };
}

/**
 * Who Cloudflare Access says this is, or a reason to refuse.
 *
 * @returns {Promise<{ email: string } | { error: string, status: number }>}
 */
export async function identify(request, env) {
	const config = accessConfig(env);

	if (config.missing.length) {
		/*
		 * Fail closed, loudly. There is no second way in by design — no local
		 * password, no bearer token — so an unconfigured Worker must refuse rather
		 * than fall back to something weaker.
		 */
		return {
			status: 503,
			error: `The admin area is not configured yet. Missing: ${config.missing.join(', ')}. See SETUP.md.`,
		};
	}

	const token = readToken(request);

	if (!token) {
		return { status: 401, error: 'No Cloudflare Access login on this request.' };
	}

	const parts = token.split('.');

	if (parts.length !== 3) {
		return { status: 401, error: 'That Access token is malformed.' };
	}

	let header;
	let claims;

	try {
		header = decodeJson(parts[0]);
		claims = decodeJson(parts[1]);
	} catch {
		return { status: 401, error: 'That Access token is unreadable.' };
	}

	if (header.alg !== 'RS256') {
		return { status: 401, error: 'That Access token is signed with an unexpected algorithm.' };
	}

	/*
	 * The audience is what stops a token from another Access application in the
	 * same Zero Trust account being replayed here. Every account has more than one
	 * app sooner or later, and they all share an issuer and a set of signing keys —
	 * the AUD tag is the only claim that distinguishes them.
	 */
	const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

	if (!audience.includes(config.aud)) {
		return { status: 403, error: 'That Access token was issued for a different application.' };
	}

	if (claims.iss !== `https://${config.teamDomain}`) {
		return { status: 403, error: 'That Access token was issued by a different team.' };
	}

	const now = Math.floor(Date.now() / 1000);

	// A little slack, since the token is minted on one machine and read on another.
	if (typeof claims.exp !== 'number' || claims.exp + 60 < now) {
		return { status: 401, error: 'That Access login has expired. Reload the page to sign in again.' };
	}

	if (typeof claims.nbf === 'number' && claims.nbf - 60 > now) {
		return { status: 401, error: 'That Access login is not valid yet.' };
	}

	if (!(await verifySignature(config.teamDomain, token, header.kid))) {
		return { status: 403, error: 'That Access token failed signature verification.' };
	}

	const email = String(claims.email || '').trim().toLowerCase();

	if (!email) {
		return { status: 403, error: 'That Access login carries no email address.' };
	}

	/*
	 * The domain is checked here as well as in the Access policy.
	 *
	 * The policy is edited in a dashboard by a person, and one wrong click widens
	 * it to everyone with a Google account. Repeating the rule in code means the
	 * dashboard can only ever be more restrictive than this file, never less.
	 */
	if (!email.endsWith(`@${config.domain}`)) {
		return { status: 403, error: `Only @${config.domain} accounts can manage this service.` };
	}

	return { email };
}
