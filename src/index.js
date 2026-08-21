/**
 * localinky-live-links control plane + auth gateway.
 *
 * This one script wears two hats, chosen by whether the request hostname is a
 * site we have provisioned:
 *
 *   1. Auth gateway (an allocated linky-*.<zone> hostname) — sits in front of the
 *      tunnel, enforces basic auth, and lets whitelisted paths through so
 *      webhook listeners can reach the site unauthenticated.
 *
 *   2. Control plane (anything else, including the free workers.dev URL) — an
 *      authenticated JSON API the Local add-on calls to allocate, reconfigure,
 *      and tear down tunnels.
 *
 * Dispatching on the stored record rather than a configured hostname means the
 * API needs no DNS record and no config of its own, and it costs nothing: the
 * gateway had to read that record anyway.
 *
 * Traffic to a site never passes through the control plane. It goes
 * Cloudflare edge -> this Worker -> <tunnel-id>.cfargotunnel.com -> the
 * teammate's cloudflared -> local nginx.
 */

import {
	createDnsRecord,
	createTunnel,
	createWorkerRoute,
	deleteDnsRecordsByName,
	deleteTunnel,
	deleteWorkerRoute,
	putIngress,
} from './cf.js';

import { maybeRewrite } from './rewrite.js';

import {
	isBypassed,
	isPublicAsset,
	randomPassword,
	randomSlug,
	randomUsername,
	safeEqual,
	sha256Hex,
	validateBypassPaths,
	validateCredential,
} from './util.js';

const json = (data, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});

const fail = (message, status = 400) => json({ ok: false, error: message }, status);

/* ------------------------------------------------------------------ *
 * KV keys
 *
 *   site:<keyHash>:<siteId> -> full site record        addon-facing lookup
 *   host:<hostname>         -> auth + bypass subset    gateway hot path
 * ------------------------------------------------------------------ */

const siteKey = (hash, siteId) => `site:${hash}:${siteId}`;
const hostKey = (hostname) => `host:${hostname}`;

/**
 * Mirror the auth-relevant fields to a hostname-keyed entry.
 *
 * The gateway runs on every single request, so it must not have to know which
 * teammate owns the host — one KV read by hostname and it has what it needs.
 */
async function syncHostRecord(env, record) {
	await env.LINKY.put(
		hostKey(record.hostname),
		JSON.stringify({
			siteId: record.siteId,
			keyHash: record.keyHash,
			authUser: record.authUser,
			authPass: record.authPass,
			bypassPaths: record.bypassPaths,
			publicAssets: record.publicAssets !== false,
		}),
	);
}

/**
 * Parse the dashboard-managed key list.
 *
 * Kept deliberately forgiving so it can be edited by hand in the Cloudflare
 * dashboard without a syntax error locking the whole team out. Accepts one
 * entry per line or comma-separated, named or bare:
 *
 *   Paul = linky_abc123
 *   Dave: linky_xyz789
 *   linky_anonymous
 *
 * Blank lines and lines starting with # are ignored.
 */
export function parseTeamKeys(raw) {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return [];
	}

	return raw
		.split(/[\n,]/)
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => {
			const split = line.search(/[=:]/);

			if (split === -1) {
				return { name: 'unnamed', key: line };
			}

			return {
				name: line.slice(0, split).trim() || 'unnamed',
				key: line.slice(split + 1).trim(),
			};
		})
		.filter((entry) => entry.key !== '');
}

/**
 * Resolve the caller's bearer token to a teammate, or null.
 *
 * Keys live in the TEAM_KEYS variable, edited in the Cloudflare dashboard, so
 * adding or removing someone is a text edit with no deploy and no tooling.
 *
 * A caller is identified by the SHA-256 of their key, never by the name beside
 * it, so a person can be renamed freely without orphaning their sites.
 */
async function authenticateAddon(request, env) {
	const header = request.headers.get('Authorization') || '';
	const match = header.match(/^Bearer\s+(.+)$/i);

	if (!match) {
		return null;
	}

	const presented = match[1].trim();

	// Compare against every entry rather than stopping at the first match, so the
	// time taken does not reveal a key's position in the list.
	let found = null;

	for (const entry of parseTeamKeys(env.TEAM_KEYS)) {
		if (safeEqual(entry.key, presented)) {
			found = entry;
		}
	}

	if (!found) {
		return null;
	}

	return { hash: await sha256Hex(presented), team: { name: found.name } };
}

/** What the addon is allowed to see. Never leaks other teammates' records. */
const publicView = (r) => ({
	siteId: r.siteId,
	siteName: r.siteName,
	hostname: r.hostname,
	url: `https://${r.hostname}`,
	tunnelToken: r.tunnelToken,
	port: r.port,
	authUser: r.authUser,
	authPass: r.authPass,
	bypassPaths: r.bypassPaths,
	publicAssets: r.publicAssets !== false,
	createdAt: r.createdAt,
});

/* ------------------------------------------------------------------ *
 * Control plane
 * ------------------------------------------------------------------ */

/**
 * Allocate a hostname for a site, or hand back the one it already has.
 *
 * Idempotent by (teammate, siteId) — that is what makes URLs sticky. Disabling
 * a link only stops the local process; the tunnel, DNS record, and route all
 * survive so re-enabling returns the identical URL. Only an explicit release
 * call tears that down, which means a webhook endpoint registered with Stripe
 * stays valid indefinitely.
 */
async function handleProvision(env, keyHash, body) {
	const siteId = String(body.siteId || '').trim();
	const port = Number(body.port);
	const siteName = String(body.siteName || '').trim().slice(0, 120);

	if (!siteId) {
		return fail('siteId is required.');
	}

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return fail('A valid port is required.');
	}

	const key = siteKey(keyHash, siteId);
	const existing = await env.LINKY.get(key, 'json');

	if (existing) {
		// Local can reassign a site's port between restarts; keep ingress honest.
		if (existing.port !== port) {
			await putIngress(env, existing.tunnelId, existing.hostname, port);
			existing.port = port;
		}

		existing.siteName = siteName || existing.siteName;
		await env.LINKY.put(key, JSON.stringify(existing));
		await syncHostRecord(env, existing);

		return json({ ok: true, reused: true, site: publicView(existing) });
	}

	const hostname = `${randomSlug(env.HOSTNAME_PREFIX || 'linky')}.${env.ZONE_NAME}`;

	// Track what we've created so a partial failure doesn't strand resources.
	const created = {};

	try {
		const tunnel = await createTunnel(env, hostname);
		created.tunnelId = tunnel.id;

		await putIngress(env, tunnel.id, hostname, port);

		const dns = await createDnsRecord(env, hostname, tunnel.id);
		created.dnsRecordId = dns.id;

		const route = await createWorkerRoute(env, hostname);
		created.routeId = route.id;

		const record = {
			siteId,
			siteName,
			keyHash,
			hostname,
			port,
			tunnelId: tunnel.id,
			tunnelToken: tunnel.token,
			dnsRecordId: dns.id,
			routeId: route.id,
			authUser: randomUsername(),
			authPass: randomPassword(),
			bypassPaths: [],
			createdAt: new Date().toISOString(),
		};

		await env.LINKY.put(key, JSON.stringify(record));
		await syncHostRecord(env, record);

		return json({ ok: true, reused: false, site: publicView(record) });
	} catch (err) {
		// Roll back in reverse order; ignore cleanup failures so the caller sees
		// the original cause rather than a confusing secondary error.
		if (created.routeId) {
			await deleteWorkerRoute(env, created.routeId).catch(() => {});
		}

		if (created.dnsRecordId || created.hostname) {
			await deleteDnsRecordsByName(env, hostname).catch(() => {});
		}

		if (created.tunnelId) {
			await deleteTunnel(env, created.tunnelId).catch(() => {});
		}

		return fail(`Could not allocate a live link: ${err.message}`, 502);
	}
}

/** Update the credentials and/or bypass paths the site owner controls. */
async function handleConfig(env, keyHash, body) {
	const siteId = String(body.siteId || '').trim();
	const record = await env.LINKY.get(siteKey(keyHash, siteId), 'json');

	if (!record) {
		return fail('No live link exists for that site.', 404);
	}

	if (body.authUser !== undefined) {
		const result = validateCredential(body.authUser, 'Username');

		if (!result.ok) {
			return fail(result.error);
		}

		record.authUser = result.value;
	}

	if (body.authPass !== undefined) {
		const result = validateCredential(body.authPass, 'Password');

		if (!result.ok) {
			return fail(result.error);
		}

		record.authPass = result.value;
	}

	if (body.bypassPaths !== undefined) {
		const result = validateBypassPaths(body.bypassPaths);

		if (!result.ok) {
			return fail(result.error);
		}

		record.bypassPaths = result.value;
	}

	if (body.publicAssets !== undefined) {
		record.publicAssets = Boolean(body.publicAssets);
	}

	if (body.regenerate === true) {
		record.authUser = randomUsername();
		record.authPass = randomPassword();
	}

	await env.LINKY.put(siteKey(keyHash, siteId), JSON.stringify(record));
	await syncHostRecord(env, record);

	return json({ ok: true, site: publicView(record) });
}

/**
 * Permanently release a site's hostname.
 *
 * This is the destructive counterpart to simply toggling a link off, and it is
 * what invalidates any webhook URL already registered with a payment provider.
 */
async function handleRelease(env, keyHash, body) {
	const siteId = String(body.siteId || '').trim();
	const key = siteKey(keyHash, siteId);
	const record = await env.LINKY.get(key, 'json');

	if (!record) {
		return json({ ok: true, released: false });
	}

	const problems = [];

	for (const [label, fn] of [
		['worker route', () => deleteWorkerRoute(env, record.routeId)],
		['DNS records', () => deleteDnsRecordsByName(env, record.hostname)],
		['tunnel', () => deleteTunnel(env, record.tunnelId)],
	]) {
		try {
			await fn();
		} catch (err) {
			// A resource deleted out-of-band shouldn't block the rest of teardown.
			problems.push(`${label}: ${err.message}`);
		}
	}

	await env.LINKY.delete(hostKey(record.hostname));
	await env.LINKY.delete(key);

	return json({ ok: true, released: true, warnings: problems });
}

async function handleStatus(env, keyHash, url) {
	const siteId = String(url.searchParams.get('siteId') || '').trim();

	if (siteId) {
		const record = await env.LINKY.get(siteKey(keyHash, siteId), 'json');

		return record
			? json({ ok: true, site: publicView(record) })
			: json({ ok: true, site: null });
	}

	const list = await env.LINKY.list({ prefix: `site:${keyHash}:` });
	const sites = [];

	for (const entry of list.keys) {
		const record = await env.LINKY.get(entry.name, 'json');

		if (record) {
			sites.push(publicView(record));
		}
	}

	return json({ ok: true, sites });
}

async function handleControlPlane(request, env, url) {
	const caller = await authenticateAddon(request, env);

	if (!caller) {
		return fail('Invalid or missing API key.', 401);
	}

	if (url.pathname === '/v1/status' && request.method === 'GET') {
		return handleStatus(env, caller.hash, url);
	}

	if (request.method !== 'POST') {
		return fail('Method not allowed.', 405);
	}

	let body;

	try {
		body = await request.json();
	} catch {
		return fail('Request body must be JSON.');
	}

	switch (url.pathname) {
		case '/v1/provision':
			return handleProvision(env, caller.hash, body);
		case '/v1/config':
			return handleConfig(env, caller.hash, body);
		case '/v1/release':
			return handleRelease(env, caller.hash, body);
		default:
			return fail('Unknown endpoint.', 404);
	}
}

/* ------------------------------------------------------------------ *
 * Auth gateway
 * ------------------------------------------------------------------ */

function checkBasicAuth(request, user, pass) {
	const header = request.headers.get('Authorization') || '';
	const match = header.match(/^Basic\s+(.+)$/i);

	if (!match) {
		return false;
	}

	let decoded;

	try {
		decoded = atob(match[1].trim());
	} catch {
		return false;
	}

	const separator = decoded.indexOf(':');

	if (separator === -1) {
		return false;
	}

	// Compare both halves unconditionally so failures cost the same either way.
	const userOk = safeEqual(decoded.slice(0, separator), user);
	const passOk = safeEqual(decoded.slice(separator + 1), pass);

	return userOk && passOk;
}

async function handleGateway(request, env, url, record) {
	/*
	 * Static assets are served without a password when the site allows it.
	 *
	 * Without this, a bypassed webhook path still renders as a broken page in a
	 * browser: the HTML comes through but every stylesheet and image behind it
	 * returns 401, which makes the browser pop an auth prompt anyway.
	 *
	 * Restricted to an extension allowlist rather than a directory, so plugin
	 * source, database dumps, logs and PHP stay behind the password.
	 */
	const assetsPublic = record.publicAssets !== false;
	const pathBypassed = isBypassed(url.pathname, url.search, record.bypassPaths);
	const assetBypassed = assetsPublic && isPublicAsset(url.pathname);
	const bypassed = pathBypassed || assetBypassed;

	if (!bypassed && !checkBasicAuth(request, record.authUser, record.authPass)) {
		return new Response('Authentication required.\n', {
			status: 401,
			headers: {
				'WWW-Authenticate': 'Basic realm="Linky Live", charset="UTF-8"',
				'Cache-Control': 'no-store',
			},
		});
	}

	const headers = new Headers(request.headers);

	// The origin has no use for our gateway credentials.
	headers.delete('Authorization');

	// Lets the site's mu-plugin rewrite URLs to the public hostname, and tells it
	// the request genuinely arrived through the tunnel.
	headers.set('X-Original-Host', url.hostname);
	headers.set('X-Linky-Live', bypassed ? 'bypass' : 'auth');

	/*
	 * Ask the origin for uncompressed bytes.
	 *
	 * The response body gets rewritten below, and gunzipping in JS would dominate
	 * the CPU budget. Cloudflare re-compresses on the way to the visitor, so this
	 * costs nothing over the wire.
	 */
	headers.set('Accept-Encoding', 'identity');

	// Clone from the original request rather than rebuilding from the URL, so the
	// method and streaming body carry over untouched. Rebuilding would require a
	// `duplex` option and risks mangling webhook payloads.
	const upstream = await fetch(new Request(request, { headers, redirect: 'manual' }));

	/*
	 * Never hand the site's 404 page to an unauthenticated visitor.
	 *
	 * A bypass prefix lets a webhook listener through, but it also means any
	 * non-existent path beneath it returns WordPress's 404 template — which names
	 * the WordPress version and every installed plugin and theme. The same is true
	 * of a missing image, since WordPress answers that with the template too.
	 *
	 * The body is replaced with a bare 404, on every method. A method-specific rule
	 * would be defeated simply by sending POST instead of GET.
	 *
	 * Deliberately a 404 and not an auth challenge: a password prompt on a path the
	 * user just whitelisted looks broken, and prompting on a missing favicon would
	 * be worse. A listener that answers 404 to a real webhook is misconfigured
	 * anyway, so nothing legitimate is lost.
	 *
	 * Only HTML is replaced, so a JSON or plain-text 404 from a real API endpoint
	 * still reaches the caller intact.
	 */
	if (
		bypassed &&
		upstream.status === 404 &&
		(upstream.headers.get('Content-Type') || '').toLowerCase().includes('text/html') &&
		!checkBasicAuth(request, record.authUser, record.authPass)
	) {
		return new Response('Not found\n', {
			status: 404,
			headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
		});
	}

	// Swap the site's local host for the public one in text responses. Anything
	// else is passed through without touching the body at all.
	const response = maybeRewrite(upstream, url.hostname);

	// These are one developer's in-progress sites; keep them out of caches and
	// out of search results even if something upstream would allow indexing.
	const out = new Response(response.body, response);
	out.headers.set('Cache-Control', 'private, no-store');
	out.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');

	return out;
}

/* ------------------------------------------------------------------ */

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// A hostname we have provisioned is site traffic and must be gated. Anything
		// else is the addon calling the API.
		const record = await env.LINKY.get(hostKey(url.hostname), 'json');

		if (record) {
			return handleGateway(request, env, url, record);
		}

		return handleControlPlane(request, env, url);
	},
};
