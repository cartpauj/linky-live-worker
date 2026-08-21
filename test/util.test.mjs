import assert from 'node:assert/strict';
import test from 'node:test';

import {
	isBypassed,
	parseBypassEntry,
	randomPassword,
	randomSlug,
	safeEqual,
	validateBypassPath,
	validateBypassPaths,
	validateCredential,
} from '../src/util.js';

test('bypass paths must be real paths, never the whole site', () => {
	// The core safety rule: nothing may open the entire site.
	assert.equal(validateBypassPath('/').ok, false);
	assert.equal(validateBypassPath('/*').ok, false);
	assert.equal(validateBypassPath('*').ok, false);
	assert.equal(validateBypassPath('/mepr/*').ok, false);

	// Must be rooted.
	assert.equal(validateBypassPath('mepr').ok, false);

	// Obvious junk.
	assert.equal(validateBypassPath('/a b').ok, false);
	assert.equal(validateBypassPath('/../etc').ok, false);
	assert.equal(validateBypassPath('').ok, false);
	assert.equal(validateBypassPath(null).ok, false);
});

test('valid bypass paths are accepted and normalised', () => {
	assert.deepEqual(validateBypassPath('/mepr'), { ok: true, value: '/mepr' });
	assert.deepEqual(validateBypassPath('  /mepr  '), { ok: true, value: '/mepr' });

	// A trailing slash is dropped so /mepr and /mepr/ can't both be stored.
	assert.deepEqual(validateBypassPath('/mepr/'), { ok: true, value: '/mepr' });
	assert.deepEqual(validateBypassPath('/wp-json/wc/v3'), { ok: true, value: '/wp-json/wc/v3' });
});

test('bypass path lists dedupe and are capped', () => {
	assert.deepEqual(validateBypassPaths(['/mepr', '/mepr/', '/paypal']).value, ['/mepr', '/paypal']);
	assert.equal(validateBypassPaths(Array(26).fill('/x')).ok, true, 'duplicates collapse before the cap');
	assert.equal(validateBypassPaths(Array.from({ length: 26 }, (_, i) => `/p${i}`)).ok, false);
	assert.equal(validateBypassPaths('nope').ok, false);

	// One bad entry rejects the whole batch rather than silently dropping it.
	assert.equal(validateBypassPaths(['/ok', '/']).ok, false);
});

test('bypass matching is a plain prefix match', () => {
	const paths = ['/mepr'];

	assert.equal(isBypassed('/mepr', '', paths), true);
	assert.equal(isBypassed('/mepr/', '', paths), true);
	assert.equal(isBypassed('/mepr/notify/paypal', '', paths), true);

	// Deliberately broad: a listener may append anything to its base path, and a
	// bypass that quietly fails to match loses webhooks invisibly.
	assert.equal(isBypassed('/meprsdkfjl', '', paths), true);
	assert.equal(isBypassed('/mepr-anything', '', paths), true);

	// Still anchored at the start, so unrelated paths stay protected.
	assert.equal(isBypassed('/wp-admin', '', paths), false);
	assert.equal(isBypassed('/wp-admin/mepr', '', paths), false);
	assert.equal(isBypassed('/', '', paths), false);
	assert.equal(isBypassed('/anything', '', []), false);

	// A path-only entry ignores the query entirely.
	assert.equal(isBypassed('/mepr', '?anything=1', paths), true);
});

test('an entry can pin query parameters', () => {
	const entry = ['/?action=mepr'];

	// The point of this: a listener that lives at a query string, and the only safe
	// way to open '/' at all.
	assert.equal(isBypassed('/', '?action=mepr', entry), true);

	// Extra parameters are ignored — senders routinely add their own.
	assert.equal(isBypassed('/', '?action=mepr&foo=bar', entry), true);
	assert.equal(isBypassed('/', '?foo=bar&action=mepr', entry), true, 'order must not matter');

	// The pinned parameter must actually be there, with that value.
	assert.equal(isBypassed('/', '', entry), false, 'bare / must stay protected');
	assert.equal(isBypassed('/', '?action=other', entry), false);
	assert.equal(isBypassed('/', '?foo=bar', entry), false);
	assert.equal(isBypassed('/', '?action=', entry), false);
});

test('multiple pinned parameters must all match', () => {
	const entry = ['/?action=mepr&mode=live'];

	assert.equal(isBypassed('/', '?action=mepr&mode=live', entry), true);
	assert.equal(isBypassed('/', '?mode=live&action=mepr&x=1', entry), true);

	// Half a match is not a match.
	assert.equal(isBypassed('/', '?action=mepr', entry), false);
	assert.equal(isBypassed('/', '?mode=live', entry), false);
	assert.equal(isBypassed('/', '?action=mepr&mode=test', entry), false);
});

test('a parameter with no value only requires presence', () => {
	const entry = ['/?mepr-listener'];

	assert.equal(isBypassed('/', '?mepr-listener=whatever', entry), true);
	assert.equal(isBypassed('/', '?mepr-listener=', entry), true);
	assert.equal(isBypassed('/', '?other=1', entry), false);
});

test('a query-pinned entry matches its path exactly, never as a prefix', () => {
	const entry = ['/wp-json/mp/v1?key=abc'];

	assert.equal(isBypassed('/wp-json/mp/v1', '?key=abc', entry), true);
	assert.equal(isBypassed('/wp-json/mp/v1', '?key=abc&x=1', entry), true);

	// A deeper path is NOT covered: prefix-matching a query entry would be unsafe.
	assert.equal(isBypassed('/wp-json/mp/v1/notify', '?key=abc', entry), false);

	// Right query, wrong path.
	assert.equal(isBypassed('/wp-admin', '?key=abc', entry), false);

	// Right path, wrong query.
	assert.equal(isBypassed('/wp-json/mp/v1', '?key=nope', entry), false);
});

test('a query pinned on the root cannot unlock every other path', () => {
	const entry = ['/?action=mepr'];

	// The hole this closes: '/' is a prefix of literally every path, so a prefix
	// match would have let anyone append ?action=mepr to any URL and skip the
	// password entirely.
	assert.equal(isBypassed('/', '?action=mepr', entry), true);

	for (const path of [
		'/wp-admin/',
		'/wp-admin/admin-ajax.php',
		'/wp-login.php',
		'/wp-json/wp/v2/users',
		'/anything',
	]) {
		assert.equal(
			isBypassed(path, '?action=mepr', entry),
			false,
			`${path} must stay protected even with the pinned parameter`,
		);
	}
});

test('entries are parsed into a path and parameter requirements', () => {
	assert.deepEqual(parseBypassEntry('/mepr'), { path: '/mepr', params: [] });

	assert.deepEqual(parseBypassEntry('/?action=mepr'), {
		path: '/',
		params: [{ key: 'action', value: 'mepr' }],
	});

	assert.deepEqual(parseBypassEntry('/?a=1&b'), {
		path: '/',
		params: [{ key: 'a', value: '1' }, { key: 'b', value: null }],
	});

	// Encoded values must survive the round trip.
	assert.deepEqual(parseBypassEntry('/?a=x%20y'), {
		path: '/',
		params: [{ key: 'a', value: 'x y' }],
	});
});

test('a query-pinned root is allowed but a bare root is not', () => {
	assert.equal(validateBypassPath('/').ok, false);
	assert.equal(validateBypassPath('/?').ok, false, 'a "?" with nothing after it opens everything');

	const ok = validateBypassPath('/?action=mepr');

	assert.equal(ok.ok, true);
	assert.equal(ok.value, '/?action=mepr');

	// Must still be rooted.
	assert.equal(validateBypassPath('?action=mepr').ok, false);

	// A trailing slash must not be trimmed off a query entry.
	assert.equal(validateBypassPath('/mepr/?x=1').value, '/mepr/?x=1');
});

test('a bypass entry cannot be crafted to open the whole site', () => {
	// Prefix matching makes the validation the only thing standing between a typo
	// and a fully public site, so the refusals matter more than before.
	assert.equal(validateBypassPath('/').ok, false);
	assert.equal(validateBypassPath('/*').ok, false);
	assert.equal(validateBypassPath('').ok, false);

	// And an accepted entry always has at least one real character after the slash.
	const result = validateBypassPath('/m');

	assert.equal(result.ok, true);
	assert.equal(isBypassed('/wp-admin', '', [result.value]), false);
});

test('safeEqual compares correctly regardless of length', () => {
	assert.equal(safeEqual('hunter2', 'hunter2'), true);
	assert.equal(safeEqual('hunter2', 'hunter3'), false);
	assert.equal(safeEqual('short', 'muchlongervalue'), false);
	assert.equal(safeEqual('', ''), true);
	assert.equal(safeEqual('a', ''), false);
});

test('credential validation rejects unusable values', () => {
	assert.equal(validateCredential('ab', 'Username').ok, false, 'too short');
	assert.equal(validateCredential('a'.repeat(65), 'Password').ok, false, 'too long');
	assert.equal(validateCredential('has space', 'Password').ok, false);
	assert.equal(validateCredential('user:name', 'Username').ok, false, 'colon breaks user:pass');
	assert.equal(validateCredential('cedar-heron-42', 'Password').ok, true);
	assert.deepEqual(validateCredential('  cedar  ', 'Username'), { ok: true, value: 'cedar' });
});

test('generated hostnames are valid single DNS labels', () => {
	for (let i = 0; i < 200; i += 1) {
		const slug = randomSlug('linky');

		// Must be a legal label, and one level only so Universal SSL covers it.
		assert.match(slug, /^linky-[a-z0-9]{6}$/);
		assert.ok(slug.length <= 63);
		assert.ok(!slug.includes('.'), 'a dot would create an uncovered second level');
	}
});

test('generated passwords avoid characters that break basic auth', () => {
	for (let i = 0; i < 200; i += 1) {
		const pass = randomPassword();

		assert.doesNotMatch(pass, /[\s:]/);
		assert.ok(pass.length >= 8);
	}
});

test('a malformed query never throws, it just does not match', () => {
	// isBypassed runs on every request; throwing would fail the whole site rather
	// than one bypass entry.
	for (const search of [undefined, null, 0, {}, [], '???', '%']) {
		assert.doesNotThrow(() => isBypassed('/mepr', search, ['/mepr']));
	}

	// A path-only entry still matches regardless of the junk query.
	assert.equal(isBypassed('/mepr', null, ['/mepr']), true);

	// A query-pinned entry cannot match when the query is unreadable.
	assert.equal(isBypassed('/', {}, ['/?action=mepr']), false);
});
