/**
 * Users and their keys — the thing the console manages.
 *
 * A user here is somebody who runs the Local add-on. They hold a key, they own
 * addresses, and they never sign in to this admin area; an admin account is a
 * separate record with no connection to any of this. The two are managed in one
 * page because that is convenient, not because they are related.
 *
 * Everything below works on the same KV records `npm run keys` writes, so the
 * web UI and the CLI are interchangeable: issue a key at a terminal and it shows
 * up in the browser, revoke it in the browser and the CLI agrees. Neither is the
 * source of truth; KV is.
 */

import { deleteDnsRecordsByName, deleteTunnel, deleteWorkerRoute } from './cf.js';
import { hostKey, randomToken, sha256Hex, siteKey, teamKeyKey } from './util.js';

/**
 * Everyone who holds a key, ordered by name.
 *
 * Order is a human convenience only. The UI addresses people by key hash, unlike
 * the CLI where a row number can be typed and therefore has to be checked
 * against the fragment printed beside it.
 */
export async function listUsers(env) {
	const list = await env.LINKY.list({ prefix: 'teamkey:' });
	const users = [];

	for (const entry of list.keys) {
		const record = await env.LINKY.get(entry.name, 'json');

		if (record) {
			users.push({
				hash: entry.name.slice('teamkey:'.length),
				name: record.name,
				active: record.active !== false,
				hint: record.hint || null,
				issuedAt: record.issuedAt || null,
				rolledAt: record.rolledAt || null,
			});
		}
	}

	return users.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Every address one key owns.
 *
 * Site records are prefixed with the owner's key hash, so this reads one
 * person's without touching anybody else's.
 */
export async function sitesOf(env, hash) {
	const list = await env.LINKY.list({ prefix: `site:${hash}:` });
	const sites = [];

	for (const entry of list.keys) {
		const record = await env.LINKY.get(entry.name, 'json');

		if (record) {
			sites.push({ kvKey: entry.name, ...record });
		}
	}

	return sites.sort((a, b) => String(a.siteName).localeCompare(String(b.siteName)));
}

/*
 * What the browser is allowed to see about an address.
 *
 * The tunnel token is left out on purpose: it is the credential that lets a
 * machine serve that hostname, and it is the add-on's business rather than an
 * administrator's. The basic-auth username and password are left out for the
 * same reason — deciding who holds a key does not require reading the passwords
 * on their sites, and the CLI has never printed either.
 */
export const siteView = (s) => ({
	siteId: s.siteId,
	siteName: s.siteName || '',
	hostname: s.hostname,
	url: `https://${s.hostname}`,
	bypassPaths: s.bypassPaths || [],
	publicAssets: s.publicAssets !== false,
	createdAt: s.createdAt || null,
});

/**
 * Generate a key, store its hash, and return the key itself exactly once.
 *
 * The same shape the CLI mints: only the SHA-256 and a six-character tail are
 * kept, so a key is verifiable but never readable again. The browser gets its
 * one and only look at it in the response to this call, which is also why
 * issuing and rolling both hand it straight back.
 */
async function mintKey(env, name, extra = {}) {
	const key = `linky_${randomToken()}`;
	const hash = await sha256Hex(key);

	await env.LINKY.put(teamKeyKey(hash), JSON.stringify({
		name,
		active: true,
		hint: key.slice(-6),
		issuedAt: new Date().toISOString(),
		...extra,
	}));

	return { key, hash };
}

/** Mirror a change onto the hostname records the gateway reads on every request. */
async function patchHostRecords(env, sites, patch) {
	for (const site of sites) {
		const host = await env.LINKY.get(hostKey(site.hostname), 'json');

		if (host) {
			await env.LINKY.put(hostKey(site.hostname), JSON.stringify({ ...host, ...patch }));
		}
	}
}

/**
 * Delete one address completely: Cloudflare resources first, then KV.
 *
 * All three resources the Worker created when it provisioned — the route, the
 * DNS record and the tunnel — torn down in the reverse order they appear to a
 * request. Deleting the KV entries without these would leave the tunnel running
 * and the hostname resolving, with nothing left that knows they exist.
 *
 * DNS goes by name rather than by stored record id, so a record recreated by
 * hand in the dashboard is still found. A resource already gone is not an error:
 * the goal is to leave nothing behind, not to insist everything was still there.
 * What did fail is collected and reported, so a half-deleted address is visible
 * rather than silent.
 */
async function tearDownSite(env, site) {
	const problems = [];

	for (const [label, fn] of [
		['Worker route', () => deleteWorkerRoute(env, site.routeId)],
		['DNS record', () => deleteDnsRecordsByName(env, site.hostname)],
		['tunnel', () => deleteTunnel(env, site.tunnelId)],
	]) {
		try {
			await fn();
		} catch (err) {
			problems.push(`${site.hostname} ${label}: ${err.message}`);
		}
	}

	await env.LINKY.delete(hostKey(site.hostname));
	await env.LINKY.delete(site.kvKey);

	return problems;
}

/**
 * Resolve the hash the browser sent to a real key holder.
 *
 * A hash from a page loaded ten minutes ago can name somebody another admin has
 * since removed, so this is looked up rather than assumed.
 */
async function target(env, rawHash) {
	const hash = String(rawHash || '').trim();

	if (!/^[0-9a-f]{64}$/.test(hash)) {
		return { error: 'Pick somebody from the list.', status: 400 };
	}

	const record = await env.LINKY.get(teamKeyKey(hash), 'json');

	if (!record) {
		return { error: 'That key is gone — somebody else removed it. Reload the page.', status: 404 };
	}

	return { hash, record };
}

/* ------------------------------------------------------------------ *
 * Changes
 * ------------------------------------------------------------------ */

export async function issueKey(env, { name: rawName }) {
	const name = String(rawName || '').trim().slice(0, 120);

	if (!name) {
		return { error: 'Who is the key for?', status: 400 };
	}

	/*
	 * Names are unique, the same rule the CLI enforces. Without it `remove
	 * "Alice"` at a terminal is ambiguous the moment a second Alice exists, and
	 * the two front ends would disagree about what is allowed.
	 */
	const taken = (await listUsers(env)).find((u) => String(u.name).toLowerCase() === name.toLowerCase());

	if (taken) {
		return {
			error: taken.active
				? `"${taken.name}" already has a key. Use a different name, or roll theirs.`
				: `"${taken.name}" already has a key, currently revoked. Restore it, or remove it first.`,
			status: 409,
		};
	}

	const { key, hash } = await mintKey(env, name);

	return { ok: true, name, hash, key };
}

export async function setKeyActive(env, { hash: rawHash, active }) {
	const found = await target(env, rawHash);

	if (found.error) {
		return found;
	}

	const { hash, record } = found;

	if ((record.active !== false) === active) {
		return { error: `${record.name} is already ${active ? 'active' : 'revoked'}.`, status: 400 };
	}

	await env.LINKY.put(teamKeyKey(hash), JSON.stringify({
		...record,
		active,
		[active ? 'restoredAt' : 'revokedAt']: new Date().toISOString(),
	}));

	/*
	 * The gateway reads `ownerActive` from the hostname record, so flipping it
	 * here is what makes a revoke reach traffic that is already flowing rather
	 * than only the next provision.
	 */
	const sites = await sitesOf(env, hash);
	await patchHostRecords(env, sites, { ownerActive: active });

	return { ok: true, name: record.name, addresses: sites.length };
}

/**
 * Replace somebody's key, carrying their addresses across.
 *
 * Site records are keyed by the hash of the owner's key, so a new key has to
 * take the old one's records with it. Otherwise those addresses sit in KV under
 * a hash nobody holds: still serving, still costing a tunnel, and invisible to
 * their owner.
 */
export async function rollKey(env, { hash: rawHash }) {
	const found = await target(env, rawHash);

	if (found.error) {
		return found;
	}

	const { hash, record } = found;
	const sites = await sitesOf(env, hash);

	const minted = await mintKey(env, record.name, {
		active: record.active !== false,
		rolledAt: new Date().toISOString(),
	});

	for (const site of sites) {
		await env.LINKY.put(
			siteKey(minted.hash, site.siteId),
			JSON.stringify({ ...site, kvKey: undefined, keyHash: minted.hash }),
		);
		await env.LINKY.delete(site.kvKey);
	}

	await patchHostRecords(env, sites, { keyHash: minted.hash });
	await env.LINKY.delete(teamKeyKey(hash));

	return { ok: true, name: record.name, hash: minted.hash, key: minted.key, addresses: sites.length };
}

/**
 * Delete a key and everything it owns.
 *
 * Their addresses go too, because nothing can manage a site whose owner's key is
 * gone — leaving them would strand a tunnel, a DNS record and a Worker route on
 * the zone for every site that person ever had. Revoking is the option that
 * keeps the addresses reserved.
 */
export async function removeKey(env, { hash: rawHash, expectAddresses }) {
	const found = await target(env, rawHash);

	if (found.error) {
		return found;
	}

	const { hash, record } = found;
	const sites = await sitesOf(env, hash);

	/*
	 * Deleting addresses is neither reversible nor cheap to redo — a webhook URL
	 * registered with a payment provider stops working the moment its hostname
	 * goes. So the count the browser confirmed against has to still be the count
	 * we found, or the admin is agreeing to something they were not shown.
	 */
	if (Number(expectAddresses) !== sites.length) {
		return {
			error: `${record.name} now holds ${sites.length} address(es), not ${Number(expectAddresses) || 0}. `
				+ 'Reload the page and try again.',
			status: 409,
		};
	}

	const problems = [];

	for (const site of sites) {
		problems.push(...(await tearDownSite(env, site)));
	}

	await env.LINKY.delete(teamKeyKey(hash));

	return { ok: true, name: record.name, addresses: sites.length, warnings: problems };
}
