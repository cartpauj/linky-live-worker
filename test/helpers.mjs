/**
 * Shared stand-ins for the bindings a Worker gets at runtime.
 *
 * Kept in one place because the admin tests need a KV that behaves like the real
 * one in the ways they exercise — prefix listing, JSON round-tripping — and
 * three copies of it would drift.
 */

/** Minimal stand-in for a KV namespace. */
export function fakeKV(seed = {}) {
	const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));

	return {
		store,
		async get(key, type) {
			const raw = store.get(key);

			if (raw === undefined) {
				return null;
			}

			return type === 'json' ? JSON.parse(raw) : raw;
		},
		async put(key, value) {
			store.set(key, value);
		},
		async delete(key) {
			store.delete(key);
		},
		async list({ prefix }) {
			return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
		},
	};
}

export const adminEnv = (seed = {}, over = {}) => ({
	LINKY: fakeKV(seed),
	ZONE_NAME: 'example.com',
	HOSTNAME_PREFIX: 'linky',
	WORKER_SCRIPT_NAME: 'linky-live',
	CF_ACCOUNT_ID: 'acct',
	CF_ZONE_ID: 'zone',
	CF_API_TOKEN: 'token',
	AUTH_MODE: 'password',
	...over,
});

const ORIGIN = 'https://linky-live.example.com';

/** A GET or POST to the admin API, with the CSRF header the Worker requires. */
export function adminRequest(path, { method = 'GET', body, cookie, headers = {} } = {}) {
	return new Request(`${ORIGIN}${path}`, {
		method,
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Linky-Admin': '1' }),
			...(cookie ? { Cookie: `linky_admin=${cookie}` } : {}),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/** The session token from a Set-Cookie header, or null. */
export function cookieFrom(response) {
	const header = response.headers.get('Set-Cookie') || '';
	const match = header.match(/linky_admin=([^;]*)/);

	return match && match[1] ? match[1] : null;
}

export const readJson = (response) => response.json();
