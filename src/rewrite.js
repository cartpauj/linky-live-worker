/**
 * Streaming replacement of a site's local host with its public hostname.
 *
 * WordPress keeps believing it lives at localhost:PORT, which is what makes
 * one-click admin, loopback requests, and `.local` browsing all keep working.
 * Anything the site emits with its local address still has to reach the visitor
 * as the public one, so it is fixed here on the way out instead.
 *
 * The site tells us what to look for with an X-Local-Host response header. We
 * cannot infer it: the port is per-site and assigned by Local.
 *
 * Cost matters — the free plan allows 10ms CPU per request — so the work is kept
 * proportional to the bytes that can actually contain a URL:
 *
 *   - non-text responses are passed straight through, untouched
 *   - text is streamed, never buffered whole
 *   - one needle, one replacement, no regex
 */

/** Only these can contain a URL worth rewriting. */
const REWRITABLE = [
	'text/html',
	'application/json',
	'application/xml',
	'text/xml',
	'application/rss+xml',
	'application/atom+xml',
	'text/plain',
];

export function isRewritable(contentType) {
	if (!contentType) {
		return false;
	}

	const type = contentType.split(';')[0].trim().toLowerCase();

	return REWRITABLE.includes(type);
}

/**
 * Build the search/replace pairs for a host swap.
 *
 * Both schemes are handled because a site can emit either, and the bare host is
 * handled last for URLs written without a scheme (`//host/path`).
 */
export function replacementsFor(localHost, publicHost) {
	if (!localHost || !publicHost || localHost === publicHost) {
		return [];
	}

	return [
		[`http://${localHost}`, `https://${publicHost}`],
		[`https://${localHost}`, `https://${publicHost}`],
		// Escaped form, as it appears inside JSON embedded in HTML.
		[`http:\\/\\/${localHost}`, `https:\\/\\/${publicHost}`],
		[`https:\\/\\/${localHost}`, `https:\\/\\/${publicHost}`],
		[`//${localHost}`, `//${publicHost}`],
	];
}

function applyAll(text, replacements) {
	let out = text;

	for (const [from, to] of replacements) {
		// split/join beats a global regex here: no pattern compilation and no
		// escaping concerns for a host that contains dots and a colon.
		if (out.includes(from)) {
			out = out.split(from).join(to);
		}
	}

	return out;
}

/**
 * Rewrite a response body as it streams.
 *
 * A match can straddle a chunk boundary, so the last few bytes of each chunk are
 * held back and prepended to the next one. The carry is bounded by the longest
 * needle, so memory stays flat regardless of body size.
 */
export function rewriteBody(body, replacements) {
	const longest = replacements.reduce((max, [from]) => Math.max(max, from.length), 0);
	const carry = Math.max(0, longest - 1);

	const decoder = new TextDecoder('utf-8', { fatal: false });
	const encoder = new TextEncoder();

	let pending = '';

	return body.pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				pending += decoder.decode(chunk, { stream: true });

				if (pending.length <= carry) {
					// Too short to be sure a match does not continue into the next chunk.
					return;
				}

				/*
				 * Replace across the whole buffer before emitting anything.
				 *
				 * Replacing only the part about to be flushed would miss any match
				 * straddling the flush point, which fails silently and only on bodies
				 * whose byte alignment happens to split a URL.
				 */
				const replaced = applyAll(pending, replacements);
				const flushTo = replaced.length - carry;

				if (flushTo <= 0) {
					pending = replaced;

					return;
				}

				controller.enqueue(encoder.encode(replaced.slice(0, flushTo)));

				// Retain a needle's worth so a match can still span into the next chunk.
				pending = replaced.slice(flushTo);
			},

			flush(controller) {
				pending += decoder.decode();

				if (pending) {
					controller.enqueue(encoder.encode(applyAll(pending, replacements)));
				}
			},
		}),
	);
}

/**
 * Apply the rewrite to a response, or return it untouched.
 *
 * Returning the original response object when there is nothing to do is the main
 * cost saving: no stream is constructed and no bytes are decoded.
 */
export function maybeRewrite(response, publicHost) {
	const localHost = response.headers.get('X-Local-Host');

	if (!localHost) {
		return response;
	}

	const replacements = replacementsFor(localHost.trim(), publicHost);

	if (!replacements.length || !isRewritable(response.headers.get('Content-Type'))) {
		return response;
	}

	if (!response.body) {
		return response;
	}

	const headers = new Headers(response.headers);

	// The body length changes, and the site's local address is not the visitor's
	// business.
	headers.delete('Content-Length');
	headers.delete('X-Local-Host');

	return new Response(rewriteBody(response.body, replacements), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
