/**
 * Read the bits of wrangler.toml that the scripts need.
 *
 * Deliberately a regex rather than a TOML parser, to keep the project free of
 * dependencies. It only reads flat `key = "value"` lines, which is all these
 * fields are.
 */

import { readFileSync } from 'node:fs';

export function readConfig() {
	let text;

	try {
		text = readFileSync('wrangler.toml', 'utf8');
	} catch {
		return { missing: true };
	}

	const value = (key) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? null;
	const unset = (v) => v === null || v === '' || /^YOUR_/.test(v);

	const zone = value('ZONE_NAME');
	const subdomain = value('API_SUBDOMAIN');

	return {
		missing: false,
		text,
		value,
		unset,
		accountId: value('account_id'),
		name: value('name'),
		scriptName: value('WORKER_SCRIPT_NAME'),
		zone,
		subdomain,

		/*
		 * The hostname the add-on talks to, composed rather than written out.
		 * TOML cannot reference ZONE_NAME, so spelling the zone again in a route
		 * pattern was a second place to keep in sync.
		 */
		apiHost: unset(zone) || unset(subdomain) ? null : `${subdomain}.${zone}`,
	};
}
