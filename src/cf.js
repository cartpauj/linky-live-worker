/**
 * Thin wrappers around the Cloudflare API calls we need.
 *
 * Every call here uses the account-scoped API token held in worker secrets.
 * That token is powerful (tunnel + DNS + routes write), which is exactly why it
 * lives here and never reaches a teammate's machine.
 */

const API = 'https://api.cloudflare.com/client/v4';

async function cfFetch(env, path, init = {}) {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: {
			'Authorization': `Bearer ${env.CF_API_TOKEN}`,
			'Content-Type': 'application/json',
			...(init.headers || {}),
		},
	});

	const body = await res.json().catch(() => null);

	if (!res.ok || !body?.success) {
		const detail = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
		throw new Error(`Cloudflare API ${path} failed — ${detail}`);
	}

	return body.result;
}

/**
 * Create a remotely-managed tunnel. `config_src: 'cloudflare'` is what lets us
 * push ingress rules over the API instead of shipping a config file to the client.
 *
 * The returned `token` is all cloudflared needs to run this tunnel.
 */
export function createTunnel(env, name) {
	return cfFetch(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, {
		method: 'POST',
		body: JSON.stringify({ name, config_src: 'cloudflare' }),
	});
}

export function deleteTunnel(env, tunnelId) {
	return cfFetch(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, {
		method: 'DELETE',
	});
}

/**
 * Point the tunnel's hostname at the site's local nginx port.
 *
 * Local assigns each site its own port and its nginx has no `server_name`, so
 * any Host header reaches the right site. The trailing 404 is the required
 * catch-all for anything that doesn't match.
 */
export function putIngress(env, tunnelId, hostname, port) {
	return cfFetch(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
		method: 'PUT',
		body: JSON.stringify({
			config: {
				ingress: [
					{
						hostname,
						service: `http://127.0.0.1:${port}`,
						originRequest: { httpHostHeader: hostname, noTLSVerify: true },
					},
					{ service: 'http_status:404' },
				],
			},
		}),
	});
}

export function createDnsRecord(env, hostname, tunnelId) {
	return cfFetch(env, `/zones/${env.CF_ZONE_ID}/dns_records`, {
		method: 'POST',
		body: JSON.stringify({
			type: 'CNAME',
			name: hostname,
			content: `${tunnelId}.cfargotunnel.com`,
			proxied: true,
			comment: 'Managed by localinky-live-links',
		}),
	});
}

export function deleteDnsRecord(env, recordId) {
	return cfFetch(env, `/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`, {
		method: 'DELETE',
	});
}

/**
 * Delete every DNS record for a hostname, whoever created it.
 *
 * Deleting only the id we recorded at provision time turned out to leave the
 * hostname resolving: setting a remotely-managed tunnel's ingress makes
 * Cloudflare publish its own record for that hostname too, so releasing a site
 * left an orphan behind that still answered.
 *
 * Matching by name removes both, and keeps working if Cloudflare changes how many
 * records it maintains.
 *
 * @returns {Promise<number>} how many records were removed
 */
export async function deleteDnsRecordsByName(env, hostname) {
	// Refuse anything that is not one of our own generated hostnames. The name
	// comes from our own storage, but this is the one call that could damage an
	// unrelated production record, so the guard is explicit.
	const prefix = `${env.HOSTNAME_PREFIX || 'linky'}-`;
	const suffix = `.${env.ZONE_NAME}`;

	if (!hostname.endsWith(suffix) || !hostname.startsWith(prefix)) {
		throw new Error(`Refusing to delete DNS for unexpected hostname "${hostname}".`);
	}

	// Guard against a name like linky-x.evil.com.example.com resolving to a single label.
	if (hostname.slice(0, -suffix.length).includes('.')) {
		throw new Error(`Refusing to delete DNS for multi-label hostname "${hostname}".`);
	}

	const records = await cfFetch(
		env,
		`/zones/${env.CF_ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}`,
	);

	for (const record of records) {
		await cfFetch(env, `/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, { method: 'DELETE' });
	}

	return records.length;
}

/**
 * Bind this Worker to the exact allocated hostname so it can enforce auth.
 *
 * This has to be one route per hostname: route patterns forbid infix wildcards,
 * so `linky-*.example.com/*` is invalid, and the alternative (`*.example.com/*`) would
 * drag every other example.com subdomain through this Worker.
 */
export async function createWorkerRoute(env, hostname) {
	/*
	 * Checked here rather than left to Cloudflare.
	 *
	 * wrangler's `name` is build-time configuration and invisible at runtime, so
	 * WORKER_SCRIPT_NAME repeats it. When the two disagree — or the var is missing
	 * entirely — the deploy still succeeds and the failure only appears now, as a
	 * Cloudflare error about an unknown script. Saying what to fix is far more use.
	 */
	if (!env.WORKER_SCRIPT_NAME) {
		throw new Error(
			'WORKER_SCRIPT_NAME is not set. Add it under [vars] in wrangler.toml, '
			+ 'matching the `name` at the top of that file.',
		);
	}

	try {
		return await cfFetch(env, `/zones/${env.CF_ZONE_ID}/workers/routes`, {
			method: 'POST',
			body: JSON.stringify({ pattern: `${hostname}/*`, script: env.WORKER_SCRIPT_NAME }),
		});
	} catch (err) {
		// Cloudflare reports this as a generic lookup failure, which gives no clue
		// that two config values have drifted apart.
		// Cloudflare words this as `script_not_found`, so allow either separator.
		if (/script/i.test(err.message) && /not[ _]found|does not exist|invalid/i.test(err.message)) {
			throw new Error(
				`No Worker named "${env.WORKER_SCRIPT_NAME}" exists in this account. `
				+ 'WORKER_SCRIPT_NAME in wrangler.toml must match the `name` at the top '
				+ `of that file. (${err.message})`,
			);
		}

		throw err;
	}
}

export function deleteWorkerRoute(env, routeId) {
	return cfFetch(env, `/zones/${env.CF_ZONE_ID}/workers/routes/${routeId}`, {
		method: 'DELETE',
	});
}
