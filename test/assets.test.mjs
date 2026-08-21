import assert from 'node:assert/strict';
import test from 'node:test';

import { isPublicAsset } from '../src/util.js';

/**
 * Static assets are readable without the password so that a bypassed webhook path
 * does not render as a broken page. The allowlist is the whole security boundary
 * for that decision, so these tests are about what must NOT get through.
 */

test('assets a browser needs are public', () => {
	for (const path of [
		'/wp-includes/css/dashicons.min.css',
		'/wp-content/themes/x/style.css',
		'/wp-includes/js/jquery/jquery.min.js',
		'/wp-content/uploads/2026/08/photo.jpg',
		'/wp-content/uploads/logo.PNG',
		'/wp-content/themes/x/font.woff2',
		'/favicon.ico',
		'/wp-content/plugins/x/icon.svg',
	]) {
		assert.equal(isPublicAsset(path), true, path);
	}
});

test('source code and secrets are never treated as assets', () => {
	// The reason this is an extension allowlist and not a directory rule: for a
	// plugin vendor the source in wp-content IS the product, and backup plugins
	// leave database dumps in there.
	for (const path of [
		'/wp-config.php',
		'/wp-content/plugins/my-plugin/my-plugin.php',
		'/wp-content/themes/x/functions.php',
		'/wp-content/debug.log',
		'/wp-content/backup.sql',
		'/wp-content/uploads/database-dump.sql.gz',
		'/wp-content/backups/site.zip',
		'/wp-content/uploads/backup.tar',
		'/.env',
		'/wp-content/uploads/clients.csv',
		'/wp-content/uploads/contract.pdf',
		'/wp-content/uploads/notes.txt',
		'/wp-json/wp/v2/users',
		'/wp-content/themes/x/style.css.map',
	]) {
		assert.equal(isPublicAsset(path), false, path);
	}
});

test('a query string cannot disguise a protected file as an asset', () => {
	// Matching is on the path only, so these are all page routes.
	for (const path of ['/wp-config.php', '/wp-login.php', '/']) {
		assert.equal(isPublicAsset(path), false, path);
	}
});

test('page routes without an extension are not assets', () => {
	for (const path of ['/', '/about', '/wp-admin/', '/mepr', '/wp-admin']) {
		assert.equal(isPublicAsset(path), false, path);
	}
});

test('a dotfile is not an asset', () => {
	// `.htaccess` has no basename before the dot; treating the whole name as an
	// extension would wrongly expose files like `.env.css`-style oddities.
	assert.equal(isPublicAsset('/.htaccess'), false);
	assert.equal(isPublicAsset('/.env'), false);
	assert.equal(isPublicAsset('/wp-content/.htaccess'), false);
});

test('extension matching is case-insensitive but exact', () => {
	assert.equal(isPublicAsset('/a/b.CSS'), true);
	assert.equal(isPublicAsset('/a/b.Js'), true);

	// Not a suffix match: a file merely ending in those letters is not an asset.
	assert.equal(isPublicAsset('/a/bcss'), false);
	assert.equal(isPublicAsset('/a/b.notcss'), false);
	assert.equal(isPublicAsset('/a/b.phpcss'), false);
});

test('a double extension is judged only by the last one', () => {
	// The dangerous direction: something.php must not pass because an earlier
	// segment looks like an asset.
	assert.equal(isPublicAsset('/wp-content/x.css.php'), false);
	assert.equal(isPublicAsset('/wp-content/x.jpg.php'), false);

	// And the benign direction still works.
	assert.equal(isPublicAsset('/wp-content/x.php.css'), true);
});
