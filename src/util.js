/**
 * Credential generation, comparison, and bypass-path validation.
 */

/**
 * Short, typable words. Credentials get read aloud and typed by hand, so these
 * beat random base64 for the default values. Users can override both anyway.
 */
const WORDS = [
	'amber', 'anchor', 'apron', 'basin', 'beacon', 'birch', 'bison', 'bramble',
	'cactus', 'canyon', 'cedar', 'cinder', 'clover', 'cobalt', 'copper', 'cove',
	'dahlia', 'dapple', 'delta', 'ember', 'fathom', 'fennel', 'fjord', 'flint',
	'gable', 'garnet', 'ginger', 'gravel', 'harbor', 'hazel', 'heron', 'indigo',
	'ivory', 'jasper', 'juniper', 'kelp', 'lantern', 'larch', 'lichen', 'lupine',
	'maple', 'marble', 'meadow', 'mesa', 'nectar', 'nimbus', 'nutmeg', 'onyx',
	'opal', 'orchid', 'pebble', 'pewter', 'pine', 'quarry', 'quartz', 'raven',
	'ridge', 'rustic', 'saffron', 'sage', 'sandy', 'shale', 'sierra', 'silo',
	'slate', 'sorrel', 'spruce', 'summit', 'talon', 'thicket', 'thistle', 'timber',
	'tundra', 'umber', 'valley', 'velvet', 'walnut', 'willow', 'yarrow', 'zephyr',
];

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomInts(count, ceiling) {
	const buf = new Uint32Array(count);
	crypto.getRandomValues(buf);
	return Array.from(buf, (n) => n % ceiling);
}

function randomWord() {
	return WORDS[randomInts(1, WORDS.length)[0]];
}

/** e.g. "linky-k4d8vn" — the DNS label for an allocated hostname. */
export function randomSlug(prefix = 'linky') {
	const chars = randomInts(6, SLUG_ALPHABET.length).map((n) => SLUG_ALPHABET[n]).join('');
	return `${prefix}-${chars}`;
}

/** Two words plus digits, e.g. "cedar-heron-48". Typable but not guessable. */
export function randomPassword() {
	const [n] = randomInts(1, 90);
	return `${randomWord()}-${randomWord()}-${n + 10}`;
}

export function randomUsername() {
	return randomWord();
}

/**
 * Length-independent comparison so a wrong password can't be narrowed down by
 * timing the response.
 */
export function safeEqual(a, b) {
	const enc = new TextEncoder();
	const ba = enc.encode(String(a));
	const bb = enc.encode(String(b));

	// Fold length into the result rather than returning early on a mismatch.
	let diff = ba.length ^ bb.length;

	for (let i = 0; i < Math.max(ba.length, bb.length); i += 1) {
		diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
	}

	return diff === 0;
}

export async function sha256Hex(input) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a single auth-bypass path.
 *
 * The hard rule: a bypass may never open the whole site. `/` and any use of `*`
 * are rejected, so every entry has to name a real path prefix such as `/mepr`.
 */
export function validateBypassPath(raw) {
	if (typeof raw !== 'string') {
		return { ok: false, error: 'Path must be text.' };
	}

	const path = raw.trim();

	if (!path.startsWith('/')) {
		return { ok: false, error: `"${path}" must start with a slash, e.g. /mepr` };
	}

	// A bare '/' opens everything; '/?action=x' opens only that one request shape.
	if (path === '/' || path === '') {
		return { ok: false, error: 'A bare "/" would expose the entire site without auth.' };
	}

	const questionMark = path.indexOf('?');

	if (questionMark !== -1) {
		const query = path.slice(questionMark + 1);

		if (query === '') {
			return { ok: false, error: `"${path}" needs at least one query parameter after the "?".` };
		}

		if (questionMark === 0) {
			return { ok: false, error: `"${path}" must start with a slash, e.g. /?action=mepr` };
		}
	}

	if (path.includes('*')) {
		return { ok: false, error: `Wildcards are not allowed — "${path}" must be a real path.` };
	}

	if (path.length < 2 || path.length > 128) {
		return { ok: false, error: `"${path}" must be between 2 and 128 characters.` };
	}

	if (/\s/.test(path)) {
		return { ok: false, error: `"${path}" cannot contain spaces.` };
	}

	if (path.includes('..')) {
		return { ok: false, error: `"${path}" cannot contain "..".` };
	}

	// Strip a trailing slash so /mepr and /mepr/ are stored identically, but never
	// touch an entry carrying a query string.
	if (path.includes('?')) {
		return { ok: true, value: path };
	}

	return { ok: true, value: path.length > 1 ? path.replace(/\/+$/, '') : path };
}

export function validateBypassPaths(list) {
	if (!Array.isArray(list)) {
		return { ok: false, error: 'bypassPaths must be an array.' };
	}

	const out = [];

	for (const entry of list) {
		const result = validateBypassPath(entry);

		if (!result.ok) {
			return result;
		}

		if (!out.includes(result.value)) {
			out.push(result.value);
		}
	}

	// Cap the deduplicated set rather than the raw input, so the limit reflects
	// what actually gets stored and re-sending an existing list never trips it.
	if (out.length > 25) {
		return { ok: false, error: 'A maximum of 25 bypass paths is allowed.' };
	}

	return { ok: true, value: out };
}

/**
 * Split a bypass entry into its path prefix and any required query parameters.
 *
 * An entry may pin specific query parameters, which is the only way to whitelist
 * a listener that lives at a query string rather than a path — and the only way
 * to open `/` narrowly, since a bare `/` would expose the whole site.
 *
 *   /mepr                    path prefix only
 *   /?action=mepr            root, but only with action=mepr
 *   /?action=mepr&mode=live   both parameters required
 *   /?action                  parameter must be present, any value
 */
export function parseBypassEntry(entry) {
	const raw = String(entry || '');
	const q = raw.indexOf('?');

	if (q === -1) {
		return { path: raw, params: [] };
	}

	const params = raw
		.slice(q + 1)
		.split('&')
		.filter((pair) => pair !== '')
		.map((pair) => {
			const eq = pair.indexOf('=');

			// No '=' means "this parameter must exist", whatever its value.
			return eq === -1
				? { key: decodeURIComponent(pair), value: null }
				: {
					key: decodeURIComponent(pair.slice(0, eq)),
					value: decodeURIComponent(pair.slice(eq + 1)),
				};
		});

	return { path: raw.slice(0, q), params };
}

/**
 * True when a request falls under a bypass entry.
 *
 * The path is a plain prefix match: `/mepr` covers `/mepr`, `/mepr/notify` and
 * `/meprsdkfjl`. That is deliberately broad — listeners append all sorts of
 * things to their base path, and a bypass that silently fails to match loses
 * webhooks invisibly, which stays invisible until a payment goes astray.
 *
 * Query parameters, when present in the entry, must all match. Extra parameters
 * on the request are ignored, so `/?action=mepr` still matches
 * `/?action=mepr&foo=bar` — senders routinely add their own.
 *
 * @param {string} pathname     Request path.
 * @param {URLSearchParams|string} search Request query.
 * @param {string[]} bypassPaths
 */
export function isBypassed(pathname, search, bypassPaths = []) {
	/*
	 * Never let a malformed query take the gateway down: this runs on every single
	 * request, and throwing here would fail the whole site rather than one bypass.
	 */
	let query;

	try {
		query = new URLSearchParams(typeof search === 'string' ? search : search || '');
	} catch {
		query = new URLSearchParams();
	}

	return (bypassPaths || []).some((entry) => {
		const { path, params } = parseBypassEntry(entry);

		/*
		 * A path-only entry is a prefix; an entry that pins query parameters must
		 * match its path exactly.
		 *
		 * Prefix-matching a query entry is dangerous: `/?action=mepr` has a path of
		 * `/`, and every path starts with `/`, so it would mean "any URL carrying
		 * action=mepr" — including /wp-admin/?action=mepr. Anyone who learned the
		 * parameter could append it to any request and walk past the password.
		 *
		 * If a prefix plus a parameter is genuinely wanted, add the prefix as its own
		 * path-only entry.
		 */
		const pathMatches = params.length
			? pathname === path || (path.endsWith('/') && pathname === path.slice(0, -1))
			: pathname.startsWith(path);

		if (!pathMatches) {
			return false;
		}

		return params.every(({ key, value }) => {
			if (!query.has(key)) {
				return false;
			}

			return value === null || query.get(key) === value;
		});
	});
}

/**
 * File extensions treated as public static assets.
 *
 * Deliberately an allowlist of things a browser needs to render a page, rather
 * than a directory rule. Allowing `/wp-content` wholesale would also expose:
 *
 *   - plugin and theme source code, which for a plugin vendor is the product
 *   - database dumps and archives that backup plugins leave in wp-content
 *   - `wp-content/debug.log`, which leaks paths, queries and sometimes tokens
 *
 * and allowing `/wp-includes` would put unauthenticated requests in front of
 * executable PHP. None of those end in one of these extensions.
 *
 * Notably absent and therefore still protected: .php, .sql, .zip, .tar, .gz,
 * .log, .env, .json, .xml, .csv, .txt, .pdf, .map.
 */
const ASSET_EXTENSIONS = new Set([
	// Stylesheets and scripts
	'css', 'js', 'mjs',
	// Images
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
	// Fonts
	'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

/**
 * True when a path is a static asset that may be served without a password.
 *
 * Matches on the path only, so a query string cannot disguise something else:
 * `/wp-config.php?x=.css` has a path of `/wp-config.php`.
 */
export function isPublicAsset(pathname) {
	const lastSlash = pathname.lastIndexOf('/');
	const filename = lastSlash === -1 ? pathname : pathname.slice(lastSlash + 1);
	const dot = filename.lastIndexOf('.');

	// No extension at all — a page route, not an asset.
	if (dot <= 0) {
		return false;
	}

	return ASSET_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

export function validateCredential(value, field) {
	if (typeof value !== 'string') {
		return { ok: false, error: `${field} must be text.` };
	}

	const trimmed = value.trim();

	if (trimmed.length < 3 || trimmed.length > 64) {
		return { ok: false, error: `${field} must be between 3 and 64 characters.` };
	}

	if (/[\s]/.test(trimmed)) {
		return { ok: false, error: `${field} cannot contain spaces.` };
	}

	// A colon would be ambiguous once encoded as "user:pass".
	if (field === 'Username' && trimmed.includes(':')) {
		return { ok: false, error: 'Username cannot contain a colon.' };
	}

	return { ok: true, value: trimmed };
}
