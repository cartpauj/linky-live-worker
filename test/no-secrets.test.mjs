import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * This repository is public. Nothing committed to it may contain a real
 * deployment's identifiers or credentials.
 *
 * wrangler.toml is gitignored and holds the operator's own values, so it is
 * excluded here — wrangler.example.toml is the committed template.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist']);
const SKIP_FILES = new Set(['wrangler.toml']);

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) {
			continue;
		}

		const full = join(dir, entry);

		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (/\.(js|mjs|json|toml|md|php|sh|yml|yaml)$/.test(entry)) {
			out.push(full);
		}
	}

	return out;
}

const FORBIDDEN = [
	// A 32-character hex string is a Cloudflare account, zone, or namespace id.
	{ pattern: /\b[0-9a-f]{32}\b/, why: 'looks like a real Cloudflare account, zone or KV id' },
	// A Cloudflare API token.
	{ pattern: /\b[A-Za-z0-9_-]{40}\b(?![A-Za-z0-9_-])/, why: 'looks like a real API token' },
	// A generated Linky Live key is 43 url-safe base64 characters after the prefix.
	{ pattern: /linky_[A-Za-z0-9_-]{20,}/, why: 'looks like a real Linky Live API key' },
];

test('no committed file contains real credentials or account identifiers', () => {
	const problems = [];

	for (const file of walk('.')) {
		const text = readFileSync(file, 'utf8');

		for (const line of text.split('\n')) {
			// Placeholders and examples are the point of the template.
			if (/YOUR_|replace_me|example\.com|EXAMPLE/i.test(line)) {
				continue;
			}

			for (const { pattern, why } of FORBIDDEN) {
				const hit = line.match(pattern);

				if (hit) {
					problems.push(`${file}: ${why} — ${hit[0].slice(0, 12)}…`);
				}
			}
		}
	}

	assert.deepEqual(problems, [], `secrets must not be committed:\n${problems.join('\n')}`);
});

test('the committed template has no real values filled in', () => {
	const template = readFileSync('wrangler.example.toml', 'utf8');

	// Every operator-specific field must still be a placeholder.
	for (const key of ['account_id', 'ZONE_NAME', 'CF_ACCOUNT_ID', 'CF_ZONE_ID']) {
		const line = template.split('\n').find((l) => l.trim().startsWith(key));

		assert.ok(line, `${key} must be present in the template`);
		assert.match(line, /YOUR_|"YOUR/, `${key} must be a placeholder, not a real value`);
	}

	// And it must not name a real host.
	assert.doesNotMatch(template, /\.co\b(?!m)/, 'the template must not reference a real zone');
});
