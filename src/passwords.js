/**
 * Password hashing, for deployments that are not using Cloudflare Access.
 *
 * PBKDF2-HMAC-SHA256, because it is what WebCrypto gives a Worker. Argon2 or
 * scrypt would be better against a GPU, but neither exists here and pulling in a
 * WASM build to get one is a large dependency in a project that has none — so
 * the iteration count is set high and the choice is written down rather than
 * left to be discovered.
 *
 * The parameters are stored beside each hash instead of being constants read at
 * verify time. That way raising the count later keeps every existing password
 * working: old hashes verify at the count they were made with, and each one is
 * quietly upgraded the next time its owner signs in.
 */

const ITERATIONS = 210000;
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
 */
export async function verifyPassword(password, record) {
	if (!record || !record.hash || !record.salt || !record.iterations) {
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

/** Was this hash made with weaker parameters than we now use? */
export const needsUpgrade = (record) => Boolean(record) && record.iterations < ITERATIONS;

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
