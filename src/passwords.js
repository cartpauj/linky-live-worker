/**
 * Password hashing, for deployments that are not using Cloudflare Access.
 *
 * PBKDF2-HMAC-SHA256, because it is what WebCrypto gives a Worker. Argon2 or
 * scrypt would be better against a GPU, but neither exists here and pulling in a
 * WASM build to get one is a large dependency in a project that has none.
 *
 * The count is pinned to the platform ceiling. Workers refuse anything above
 * 100,000 outright — `NotSupportedError: iteration counts above 100000 are not
 * supported` — so this is the most work that can be demanded of an attacker
 * here, not a number chosen for its own sake. It is below what OWASP asks of
 * PBKDF2-SHA256, which is worth knowing: the defence that matters more is that
 * passwords are minted at random by `admins add` rather than picked by people,
 * and Cloudflare Access mode stores no password at all.
 *
 * Node has no such cap, so a count that works in the test suite can still throw
 * in production — hence MAX_ITERATIONS below, and the test that pins it.
 *
 * The parameters are stored beside each hash instead of being constants read at
 * verify time. That way changing the count later keeps every existing password
 * working: old hashes verify at the count they were made with, and each one is
 * quietly re-hashed the next time its owner signs in.
 */

/** What Cloudflare Workers will accept. Raising this past the cap breaks login. */
export const MAX_ITERATIONS = 100000;

const ITERATIONS = MAX_ITERATIONS;
const KEY_BITS = 256;
const SALT_BYTES = 16;

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex) => {
	const out = new Uint8Array(hex.length / 2);

	for (let i = 0; i < out.length; i += 1) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}

	return out;
};

async function derive(password, salt, iterations) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	);

	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
		key,
		KEY_BITS,
	);

	return new Uint8Array(bits);
}

/** @returns {Promise<{ hash: string, salt: string, iterations: number }>} */
export async function hashPassword(password) {
	const salt = new Uint8Array(SALT_BYTES);
	crypto.getRandomValues(salt);

	return {
		hash: toHex(await derive(password, salt, ITERATIONS)),
		salt: toHex(salt),
		iterations: ITERATIONS,
	};
}

/**
 * Check a password, in constant time with respect to the hash.
 *
 * A record with no password set never matches — that is what an account created
 * for Access mode looks like, and it must not be reachable by guessing an empty
 * password.
 *
 * A record the platform refuses to process — one written with an iteration count
 * above the cap — is a failed login rather than a thrown request. Whoever holds
 * that account is stuck either way, but a 401 sends them to ask for a reset,
 * which fixes it, where a 500 tells them nothing and takes the sign-in form down
 * for everybody else too.
 */
export async function verifyPassword(password, record) {
	if (!record || !record.hash || !record.salt || !record.iterations) {
		return false;
	}

	if (record.iterations > MAX_ITERATIONS) {
		return false;
	}

	const expected = fromHex(record.hash);
	const actual = await derive(password, fromHex(record.salt), record.iterations);

	let diff = expected.length ^ actual.length;

	for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
		diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0);
	}

	return diff === 0;
}

/** Was this hash made with different parameters from the ones we use now? */
export const needsUpgrade = (record) => Boolean(record) && record.iterations !== ITERATIONS;

/**
 * The one rule worth enforcing: length.
 *
 * Composition rules — a capital, a digit, a symbol — reliably produce
 * "Password1!" and little else, so there are none. Twelve characters is the
 * floor, and the UI says so before anybody types rather than after.
 */
export function validatePassword(password, email) {
	const value = String(password || '');

	if (value.length < 12) {
		return { error: 'Use at least 12 characters.' };
	}

	if (value.length > 200) {
		return { error: 'That is longer than 200 characters.' };
	}

	if (email && value.trim().toLowerCase() === String(email).trim().toLowerCase()) {
		return { error: 'Your password cannot be your email address.' };
	}

	return { ok: true, value };
}
