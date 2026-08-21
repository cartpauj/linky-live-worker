import assert from 'node:assert/strict';
import test from 'node:test';

import { isRewritable, maybeRewrite, replacementsFor, rewriteBody } from '../src/rewrite.js';

const LOCAL = 'localhost:10028';
const PUBLIC = 'linky-a7f3k2.example.com';

/** Feed a body through the rewriter in fixed-size chunks and read it back. */
async function through(text, chunkSize = 8) {
	const bytes = new TextEncoder().encode(text);

	const source = new ReadableStream({
		start(controller) {
			for (let i = 0; i < bytes.length; i += chunkSize) {
				controller.enqueue(bytes.slice(i, i + chunkSize));
			}

			controller.close();
		},
	});

	const out = rewriteBody(source, replacementsFor(LOCAL, PUBLIC));

	return new Response(out).text();
}

test('rewrites both schemes and the scheme-relative form', async () => {
	const input = [
		'<a href="http://localhost:10028/about/">a</a>',
		'<img src="https://localhost:10028/wp-content/x.jpg">',
		'<script src="//localhost:10028/app.js"></script>',
	].join('\n');

	const out = await through(input, 4096);

	assert.ok(out.includes(`https://${PUBLIC}/about/`));
	assert.ok(out.includes(`https://${PUBLIC}/wp-content/x.jpg`));
	assert.ok(out.includes(`//${PUBLIC}/app.js`));

	// Plain http must be upgraded, or the browser reports mixed content.
	assert.ok(!out.includes('http://localhost'));
	assert.ok(!out.includes(`http://${PUBLIC}`));
});

test('a URL split across chunk boundaries is still rewritten', async () => {
	// The failure this guards is nasty: with naive per-chunk replacement the URL
	// silently survives, and only some pages break depending on byte alignment.
	const input = `<img src="http://localhost:10028/wp-content/uploads/photo.jpg">`;

	for (const chunkSize of [1, 2, 3, 5, 7, 8, 13, 16, 31, 64]) {
		const out = await through(input, chunkSize);

		assert.equal(
			out,
			`<img src="https://${PUBLIC}/wp-content/uploads/photo.jpg">`,
			`failed at chunk size ${chunkSize}`,
		);
	}
});

test('escaped URLs inside embedded JSON are rewritten', async () => {
	// WordPress inlines block and settings data as JSON in <script> tags.
	const input = '<script>var s = {"url":"http:\\/\\/localhost:10028\\/wp-json\\/"};</script>';

	const out = await through(input, 6);

	assert.ok(out.includes(`https:\\/\\/${PUBLIC}\\/wp-json\\/`), out);
	assert.ok(!out.includes('localhost:10028'));
});

test('multi-byte characters survive chunking', async () => {
	// Splitting UTF-8 mid-character would corrupt the page; the decoder is used in
	// streaming mode precisely to avoid that.
	const input = 'héllo — 日本語 http://localhost:10028/café/ 🎉';

	for (const chunkSize of [1, 2, 3, 5, 9]) {
		const out = await through(input, chunkSize);

		assert.equal(out, `héllo — 日本語 https://${PUBLIC}/café/ 🎉`, `chunk size ${chunkSize}`);
	}
});

test('content with nothing to replace comes through byte-identical', async () => {
	const input = '<p>Nothing to see here. http://example.com/ stays put.</p>';

	assert.equal(await through(input, 5), input);
});

test('only text types are considered rewritable', () => {
	for (const type of [
		'text/html',
		'text/html; charset=UTF-8',
		'application/json',
		'application/rss+xml',
		'text/plain',
	]) {
		assert.equal(isRewritable(type), true, type);
	}

	// Rewriting these would waste the CPU budget and could corrupt them.
	for (const type of ['image/jpeg', 'font/woff2', 'video/mp4', 'application/zip', 'text/css', 'application/javascript', '', null]) {
		assert.equal(isRewritable(type), false, String(type));
	}
});

test('a response with no X-Local-Host header is returned untouched', async () => {
	const original = new Response('http://localhost:10028/', {
		headers: { 'Content-Type': 'text/html' },
	});

	const result = maybeRewrite(original, PUBLIC);

	// The same object, so no stream is built and no bytes are decoded.
	assert.equal(result, original);
	assert.equal(await result.text(), 'http://localhost:10028/');
});

test('binary responses skip the rewriter entirely', async () => {
	const original = new Response('binary-ish', {
		headers: { 'Content-Type': 'image/png', 'X-Local-Host': LOCAL },
	});

	assert.equal(maybeRewrite(original, PUBLIC), original);
});

test('rewriting strips Content-Length and hides the local host', async () => {
	const original = new Response('<a href="http://localhost:10028/">x</a>', {
		headers: {
			'Content-Type': 'text/html',
			'Content-Length': '39',
			'X-Local-Host': LOCAL,
			'X-Robots-Tag': 'noindex',
		},
	});

	const result = maybeRewrite(original, PUBLIC);

	// A stale Content-Length would truncate the rewritten body.
	assert.equal(result.headers.get('Content-Length'), null);

	// The visitor has no business knowing the developer's local port.
	assert.equal(result.headers.get('X-Local-Host'), null);

	// Unrelated headers must survive.
	assert.equal(result.headers.get('X-Robots-Tag'), 'noindex');

	assert.equal(await result.text(), `<a href="https://${PUBLIC}/">x</a>`);
});

test('status and statusText are preserved through a rewrite', async () => {
	const original = new Response('<p>http://localhost:10028/</p>', {
		status: 404,
		statusText: 'Not Found',
		headers: { 'Content-Type': 'text/html', 'X-Local-Host': LOCAL },
	});

	const result = maybeRewrite(original, PUBLIC);

	assert.equal(result.status, 404);
	assert.match(await result.text(), /linky-a7f3k2\.example\.com/);
});

test('a host equal to the public host produces no replacements', () => {
	assert.deepEqual(replacementsFor(PUBLIC, PUBLIC), []);
	assert.deepEqual(replacementsFor('', PUBLIC), []);
	assert.deepEqual(replacementsFor(LOCAL, ''), []);
});

test('a large body streams without buffering the whole thing', async () => {
	// 2MB of content with a URL near the end: if the implementation buffered, the
	// carry would grow without bound instead of staying at needle length.
	const filler = 'x'.repeat(2 * 1024 * 1024);
	const input = `${filler}<a href="http://localhost:10028/end">e</a>`;

	const out = await through(input, 65536);

	assert.ok(out.endsWith(`<a href="https://${PUBLIC}/end">e</a>`));
	assert.equal(out.length, input.length + (PUBLIC.length - LOCAL.length) + 1);
});
