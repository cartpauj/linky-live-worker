/**
 * The admin page: one HTML document, inlined into the Worker bundle.
 *
 * No build step, no framework, no external fetch — a page that hands out
 * credentials should contain nothing that did not come from this repo, and the
 * Content-Security-Policy in admin.js says exactly that.
 *
 * It draws whatever /admin/api/state reports and nothing more. Which sections
 * appear, and which controls are offered, come from flags the Worker computed —
 * `canManageAdmins`, `canGrant` — rather than from the browser re-deriving the
 * rules. So the page offers precisely what the API would allow, and the two
 * cannot drift apart. Hiding a control is a courtesy to whoever is clicking; the
 * check that matters is the one beside the write.
 */

export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Linky Live — admin</title>
<style>
	:root {
		color-scheme: light dark;
		--bg: #f6f7f9; --card: #fff; --line: #e2e5ea; --ink: #16181d;
		--dim: #6b7280; --accent: #2f6feb; --danger: #b3261e; --ok: #146c43; --chip: #eef1f6;
	}

	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #14161a; --card: #1c1f25; --line: #2c313a; --ink: #e8eaed;
			--dim: #9aa1ad; --accent: #6ea0ff; --danger: #ef8a82; --ok: #6cc48d; --chip: #262b33;
		}
	}

	* { box-sizing: border-box; }

	body {
		margin: 0; padding: 2rem 1.25rem 4rem;
		background: var(--bg); color: var(--ink);
		font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	}

	.wrap { max-width: 64rem; margin: 0 auto; }
	.narrow { max-width: 25rem; margin: 3rem auto 0; }
	h1 { font-size: 1.3rem; margin: 0; font-weight: 650; }
	h2 { font-size: 1rem; margin: 0 0 .35rem; font-weight: 650; }
	p { margin: .35rem 0; }

	.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem; }
	header.bar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: baseline; justify-content: space-between; margin-bottom: 1.25rem; }

	.muted { color: var(--dim); }
	.small { font-size: .85rem; }
	.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
	.hidden { display: none !important; }

	label { display: block; font-size: .85rem; color: var(--dim); margin-bottom: .3rem; }
	input, select, button { font: inherit; border-radius: 8px; border: 1px solid var(--line); padding: .5rem .65rem; background: var(--card); color: var(--ink); }
	input { width: 100%; }
	input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
	button { cursor: pointer; width: auto; }
	button:disabled { cursor: not-allowed; opacity: .45; }
	button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
	button.danger { color: var(--danger); }
	button.link { border: 0; background: none; padding: .25rem .35rem; color: var(--accent); }

	.row { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end; }
	.grow { flex: 1 1 14rem; }

	table { width: 100%; border-collapse: collapse; }
	th { text-align: left; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); font-weight: 600; padding: 0 .5rem .5rem; }
	td { padding: .6rem .5rem; border-top: 1px solid var(--line); vertical-align: top; }
	tr.dim td:not(.actions) { opacity: .55; }

	.chip { display: inline-block; padding: .1rem .5rem; border-radius: 999px; background: var(--chip); font-size: .75rem; font-weight: 600; white-space: nowrap; }
	.chip.owner { color: var(--accent); }
	.chip.bad { color: var(--danger); }

	td.actions { text-align: right; white-space: nowrap; }
	td.actions button, td.actions select { padding: .3rem .45rem; font-size: .85rem; }

	.sites { margin: .3rem 0 0; padding: 0; list-style: none; }
	.sites li { font-size: .85rem; }
	.sites a { color: var(--accent); }

	.note { padding: .7rem .85rem; border-radius: 8px; border: 1px solid var(--line); margin-bottom: 1rem; }
	.note.error { color: var(--danger); border-color: currentColor; }
	.note.ok { color: var(--ok); border-color: currentColor; }

	dialog { border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--ink); max-width: 34rem; padding: 1.25rem; }
	dialog::backdrop { background: rgb(0 0 0 / .5); }
	pre.secret { background: var(--chip); padding: .7rem .85rem; border-radius: 8px; white-space: pre-wrap; word-break: break-all; margin: .5rem 0; }
</style>
</head>
<body>
<div class="wrap">

	<!-- Password sign-in. Never shown in Access mode: Cloudflare has already
	     asked, and a second form would be a phishing lesson. -->
	<section id="signin" class="card narrow hidden">
		<h2>Linky Live</h2>
		<p class="muted small">Sign in to manage users and keys.</p>
		<div id="signin-note" class="note error hidden"></div>
		<form id="signin-form">
			<label for="signin-email">Email</label>
			<input id="signin-email" type="email" autocomplete="username" required>
			<label for="signin-password" style="margin-top:.75rem">Password</label>
			<input id="signin-password" type="password" autocomplete="current-password" required>
			<button class="primary" style="margin-top:1rem;width:100%" type="submit">Sign in</button>
		</form>
	</section>

	<!-- Shown to anyone signing in with a password somebody else generated. -->
	<section id="change" class="card narrow hidden">
		<h2>Choose a password</h2>
		<p class="muted small">
			You signed in with a one-time password. Pick your own before going on —
			at least 12 characters.
		</p>
		<div id="change-note" class="note error hidden"></div>
		<form id="change-form">
			<label for="change-password">New password</label>
			<input id="change-password" type="password" autocomplete="new-password" minlength="12" required>
			<label for="change-confirm" style="margin-top:.75rem">Again</label>
			<input id="change-confirm" type="password" autocomplete="new-password" minlength="12" required>
			<button class="primary" style="margin-top:1rem;width:100%" type="submit">Save and continue</button>
		</form>
	</section>

	<!-- Blocked before we know who anybody is: a valid company login with no
	     account here, or a Worker whose auth is half-configured. -->
	<section id="blocked" class="card narrow hidden">
		<h2>No access</h2>
		<p id="blocked-why" class="small"></p>
	</section>

	<main id="console" class="hidden">
		<header class="bar">
			<h1>Linky Live</h1>
			<div class="small muted">
				<span id="whoami"></span>
				<button class="link hidden" id="signout" type="button">Sign out</button>
			</div>
		</header>

		<div id="note" class="note hidden"></div>

		<!-- Admin accounts. Owners only; a manager never sees this section. -->
		<section id="accounts-card" class="card hidden">
			<h2>Admin accounts</h2>
			<p class="muted small" id="accounts-blurb"></p>

			<form id="account-form" class="row" style="margin:1rem 0">
				<div class="grow">
					<label for="account-email">Email</label>
					<input id="account-email" type="email" placeholder="alice@example.com" required>
				</div>
				<div>
					<label for="account-role">Role</label>
					<select id="account-role"></select>
				</div>
				<button class="primary" type="submit">Add</button>
			</form>

			<table>
				<thead><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
				<tbody id="accounts"></tbody>
			</table>
		</section>

		<!-- Users and their keys. Unrelated to the accounts above. -->
		<section class="card">
			<h2>Users and keys</h2>
			<p class="muted small">
				People running the Local add-on. They hold a key and own addresses; they
				do not sign in here.
			</p>

			<form id="user-form" class="row" style="margin:1rem 0">
				<div class="grow">
					<label for="user-name">Name</label>
					<input id="user-name" placeholder="Alice" required>
				</div>
				<button class="primary" type="submit">Issue a key</button>
			</form>

			<table>
				<thead>
					<tr><th>Name</th><th>Status</th><th>Key</th><th>Addresses</th><th></th></tr>
				</thead>
				<tbody id="users"></tbody>
			</table>
			<p id="users-empty" class="muted small hidden">Nobody has a key yet.</p>
		</section>

		<p class="muted small">
			Everything here also works from the CLI — <span class="mono">npm run keys</span>
			for users and keys, <span class="mono">npm run admins</span> for accounts.
		</p>
	</main>
</div>

<!-- Shown once, immediately after a credential is minted. -->
<dialog id="secret-dialog">
	<h2 id="secret-title"></h2>
	<p class="small muted" id="secret-blurb"></p>
	<pre class="secret mono" id="secret-text"></pre>
	<div class="row" style="justify-content:flex-end">
		<button type="button" id="secret-copy">Copy</button>
		<button type="button" class="primary" id="secret-close">Done</button>
	</div>
</dialog>

<script>
(function () {
	'use strict';

	var $ = function (id) { return document.getElementById(id); };
	var state = null;

	var ROLE = { owner: 'Owner', manager: 'Manager' };

	/* ---------------------------------------------------------------- *
	 * Talking to the Worker
	 * ---------------------------------------------------------------- */

	/*
	 * Every mutating call carries X-Linky-Admin, which the Worker requires and
	 * which no cross-site form can add. same-origin keeps the session cookie on
	 * requests to this origin and nowhere else.
	 */
	function api(path, body) {
		return fetch('/admin/api/' + path, {
			method: body === undefined ? 'GET' : 'POST',
			credentials: 'same-origin',
			headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Linky-Admin': '1' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}).then(function (res) {
			return res.json()
				.catch(function () { return { ok: false, error: 'The server sent something unreadable.' }; })
				.then(function (data) { return { status: res.status, data: data }; });
		});
	}

	function note(message, kind) {
		var el = $('note');
		el.textContent = message;
		el.className = 'note ' + (kind || 'ok');
		el.scrollIntoView({ block: 'nearest' });
	}

	function show(id) {
		['signin', 'change', 'blocked', 'console'].forEach(function (section) {
			$(section).classList.toggle('hidden', section !== id);
		});
	}

	/* ---------------------------------------------------------------- *
	 * Small DOM helpers
	 * ---------------------------------------------------------------- */

	function text(tag, value, className) {
		var el = document.createElement(tag);
		el.textContent = value;
		if (className) { el.className = className; }
		return el;
	}

	function button(label, className, onClick) {
		var el = document.createElement('button');
		el.type = 'button';
		el.textContent = label;
		el.className = className;
		el.addEventListener('click', onClick);
		return el;
	}

	function space() { return document.createTextNode(' '); }
	function day(iso) { return iso ? String(iso).slice(0, 10) : ''; }

	/* ---------------------------------------------------------------- *
	 * Admin accounts
	 * ---------------------------------------------------------------- */

	function accountRow(account) {
		var tr = document.createElement('tr');
		if (!account.active) { tr.className = 'dim'; }

		var email = document.createElement('td');
		email.appendChild(text('span', account.email, 'mono small'));
		if (account.you) { email.appendChild(text('span', ' (you)', 'muted small')); }
		if (account.addedAt) { email.appendChild(text('div', 'added ' + day(account.addedAt), 'muted small')); }
		tr.appendChild(email);

		var role = document.createElement('td');
		role.appendChild(text('span', ROLE[account.role], 'chip ' + account.role));
		tr.appendChild(role);

		var status = document.createElement('td');
		if (!account.active) {
			status.appendChild(text('span', 'suspended', 'chip bad'));
		} else if (account.pending) {
			// Their password is still the one-time code somebody handed them.
			status.appendChild(text('span', 'not signed in yet', 'small muted'));
		} else {
			status.appendChild(text('span', 'active', 'small'));
		}
		tr.appendChild(status);

		var cell = document.createElement('td');
		cell.className = 'actions';

		/*
		 * The Worker worked out that this is the only way back in, so nothing that
		 * would take it away is offered. Removing, demoting and suspending are all
		 * the same act from this row's point of view.
		 */
		var locked = account.lastOwner;
		var why = 'The last owner cannot lose their own access. Make somebody else an owner first.';

		var options = locked ? [] : state.canGrant.filter(function (r) { return r !== account.role; });

		if (options.length) {
			var select = document.createElement('select');
			select.appendChild(new Option('Change role…', ''));
			options.forEach(function (r) { select.appendChild(new Option('→ ' + ROLE[r], r)); });
			select.addEventListener('change', function () {
				if (!select.value) { return; }
				var to = select.value;
				select.value = '';
				act('accounts/role', { email: account.email, role: to },
					account.email + ' is now ' + (to === 'owner' ? 'an owner' : 'a manager') + '.');
			});
			cell.appendChild(select);
			cell.appendChild(space());
		}

		if (state.mode === 'password') {
			cell.appendChild(button('Reset password', '', function () {
				if (!confirm('Reset the password for ' + account.email + '?\n\n'
					+ 'They get a new one-time password and must choose their own. '
					+ 'Any session they have open ends now.')) { return; }

				act('accounts/reset', { email: account.email }, null, function (data) {
					secret('One-time password for ' + data.email,
						'They sign in with this once, then choose their own. It is shown only now.',
						'Email:     ' + data.email + '\nPassword:  ' + data.password);
				});
			}));
			cell.appendChild(space());
		}

		var suspend = account.active
			? button('Suspend', '', function () {
				if (!confirm('Suspend ' + account.email + '?\n\n'
					+ 'They lose access immediately. Their key, if they have one, is untouched. '
					+ 'This is reversible.')) { return; }
				act('accounts/suspend', { email: account.email }, 'Suspended ' + account.email + '.');
			})
			: button('Restore', '', function () {
				act('accounts/restore', { email: account.email }, 'Restored ' + account.email + '.');
			});

		if (locked && account.active) { suspend.disabled = true; suspend.title = why; }

		cell.appendChild(suspend);
		cell.appendChild(space());

		var remove = button('Remove', 'danger', function () {
			if (!confirm('Remove ' + account.email + '?\n\n'
				+ 'They lose access to this page. Nothing else is deleted — any key or '
				+ 'addresses belong to the users they were issued to, not to them.')) { return; }
			act('accounts/remove', { email: account.email }, 'Removed ' + account.email + '.');
		});

		if (locked) { remove.disabled = true; remove.title = why; }

		cell.appendChild(remove);

		if (locked) {
			// Said once, in words, rather than left to three greyed-out buttons and a
			// tooltip nobody hovers.
			cell.appendChild(text('div', 'last owner', 'muted small'));
		}

		tr.appendChild(cell);

		return tr;
	}

	/* ---------------------------------------------------------------- *
	 * Users and keys
	 * ---------------------------------------------------------------- */

	function userRow(user) {
		var tr = document.createElement('tr');
		if (!user.active) { tr.className = 'dim'; }

		var name = document.createElement('td');
		name.appendChild(text('span', user.name));
		name.appendChild(text('div', 'issued ' + day(user.issuedAt), 'muted small'));
		tr.appendChild(name);

		var status = document.createElement('td');
		status.appendChild(user.active ? text('span', 'active', 'small') : text('span', 'revoked', 'chip bad'));
		tr.appendChild(status);

		tr.appendChild(text('td', user.hint ? '…' + user.hint : '—', 'mono small'));

		/*
		 * Addresses are listed, not counted. Removing a user deletes these for
		 * good, and a number is easy to click past in a way that a list of
		 * hostnames you recognise is not.
		 */
		var sites = document.createElement('td');

		if (!user.sites.length) {
			sites.appendChild(text('span', 'none', 'muted small'));
		} else {
			var list = document.createElement('ul');
			list.className = 'sites';
			user.sites.forEach(function (site) {
				var li = document.createElement('li');
				var a = document.createElement('a');
				a.href = site.url;
				a.textContent = site.hostname;
				a.target = '_blank';
				a.rel = 'noreferrer noopener';
				li.appendChild(a);
				if (site.siteName) { li.appendChild(text('span', ' ' + site.siteName, 'muted')); }
				list.appendChild(li);
			});
			sites.appendChild(list);
		}

		tr.appendChild(sites);

		var cell = document.createElement('td');
		cell.className = 'actions';

		cell.appendChild(button('Roll', '', function () {
			if (!confirm('Issue a new key for ' + user.name + '?\n\n'
				+ 'Their old key stops working immediately. Their ' + user.sites.length
				+ ' address(es) carry over unchanged.')) { return; }

			act('keys/roll', { hash: user.hash }, null, function (data) {
				secret('New key for ' + data.name,
					'Send both lines. The old key is dead, and ' + data.addresses
						+ ' address(es) carried over.',
					'Service:  ' + location.host + '\nKey:      ' + data.key);
			});
		}));

		cell.appendChild(space());

		cell.appendChild(user.active
			? button('Revoke', '', function () {
				if (!confirm('Revoke ' + user.name + '?\n\n'
					+ 'Their ' + user.sites.length + ' address(es) stop answering but stay reserved, '
					+ 'and they cannot provision anything new. This is reversible.')) { return; }
				act('keys/revoke', { hash: user.hash }, 'Revoked ' + user.name + '.');
			})
			: button('Restore', '', function () {
				act('keys/restore', { hash: user.hash }, 'Restored ' + user.name + '.');
			}));

		cell.appendChild(space());

		cell.appendChild(button('Remove', 'danger', function () {
			/*
			 * Typing the name is the gate, not a second OK button. Removing deletes
			 * their tunnels, DNS records and Worker routes, which takes down any
			 * webhook URL already registered with a payment provider — and unlike a
			 * revoke there is nothing to undo afterwards.
			 */
			var warning = 'Permanently remove ' + user.name + '?\n\n'
				+ (user.sites.length
					? 'This also deletes ' + user.sites.length
						+ ' address(es) — tunnel, DNS record and Worker route:\n'
						+ user.sites.map(function (s) { return '  ' + s.hostname; }).join('\n')
						+ '\n\nAny webhook registered at those URLs stops working. This cannot be undone.\n\n'
					: 'They hold no addresses.\n\n')
				+ 'Type their name to confirm:';

			var typed = prompt(warning, '');

			if (typed === null) { return; }

			if (typed.trim().toLowerCase() !== String(user.name).toLowerCase()) {
				note('That did not match "' + user.name + '". Nothing was removed.', 'error');
				return;
			}

			// The count travels with the request, so the Worker refuses if somebody
			// provisioned an address since this page was drawn.
			act('keys/remove', { hash: user.hash, expectAddresses: user.sites.length }, null, function (data) {
				var message = 'Removed ' + data.name
					+ (data.addresses ? ' and ' + data.addresses + ' address(es)' : '') + '.';

				if (data.warnings && data.warnings.length) {
					note(message + ' Some resources did not delete — check the Cloudflare dashboard: '
						+ data.warnings.join('; '), 'error');
				} else {
					note(message, 'ok');
				}
			});
		}));

		tr.appendChild(cell);

		return tr;
	}

	/* ---------------------------------------------------------------- *
	 * Drawing
	 * ---------------------------------------------------------------- */

	function render() {
		show('console');

		$('whoami').textContent = state.you.email + ' · ' + ROLE[state.you.role] + ' ';

		// In Access mode signing out is Cloudflare's business, not ours.
		$('signout').classList.toggle('hidden', state.mode !== 'password');

		$('accounts-card').classList.toggle('hidden', !state.canManageAdmins);

		if (state.canManageAdmins) {
			$('accounts-blurb').textContent = state.mode === 'access'
				? 'Signing in goes through Cloudflare Access. Adding somebody here lets them in '
					+ 'once Cloudflare has confirmed who they are.'
				: 'Adding somebody mints a one-time password, shown once. They choose their own on '
					+ 'first sign-in.';

			var roleSelect = $('account-role');
			roleSelect.textContent = '';
			state.canGrant.forEach(function (r) { roleSelect.appendChild(new Option(ROLE[r], r)); });

			$('account-email').placeholder = state.domain ? 'alice@' + state.domain : 'alice@example.com';

			var accounts = $('accounts');
			accounts.textContent = '';
			state.accounts.forEach(function (a) { accounts.appendChild(accountRow(a)); });
		}

		var users = $('users');
		users.textContent = '';
		state.users.forEach(function (u) { users.appendChild(userRow(u)); });
		$('users-empty').classList.toggle('hidden', state.users.length > 0);
	}

	/* ---------------------------------------------------------------- *
	 * Loading and acting
	 * ---------------------------------------------------------------- */

	function refresh() {
		return api('state').then(function (res) {
			if (res.status === 401) {
				// With Access, a 401 means Cloudflare has not vouched for this
				// request — reloading sends the browser back through the login.
				state = null;
				show('signin');
				$('signin-email').focus();
				return;
			}

			if (res.status === 403 || res.status === 503) {
				$('blocked-why').textContent = res.data.error;
				show('blocked');
				return;
			}

			if (!res.data.ok) { note(res.data.error, 'error'); return; }

			if (res.data.mustChangePassword) {
				show('change');
				$('change-password').focus();
				return;
			}

			state = res.data;
			render();
		});
	}

	/** Run an action, report it, then redraw from the server rather than guessing. */
	function act(path, body, okMessage, onOk) {
		return api(path, body).then(function (res) {
			if (!res.data.ok) { note(res.data.error, 'error'); return refresh(); }

			if (onOk) { onOk(res.data); } else if (okMessage) { note(okMessage, 'ok'); }

			return refresh();
		});
	}

	function secret(title, blurb, contents) {
		$('secret-title').textContent = title;
		$('secret-blurb').textContent = blurb;
		$('secret-text').textContent = contents;
		$('secret-copy').textContent = 'Copy';
		$('secret-dialog').showModal();
	}

	/* ---------------------------------------------------------------- *
	 * Wiring
	 * ---------------------------------------------------------------- */

	$('signin-form').addEventListener('submit', function (event) {
		event.preventDefault();

		var problem = $('signin-note');
		problem.classList.add('hidden');

		api('login', { email: $('signin-email').value, password: $('signin-password').value })
			.then(function (res) {
				if (!res.data.ok) {
					problem.textContent = res.data.error;
					problem.classList.remove('hidden');
					return;
				}

				$('signin-password').value = '';
				refresh();
			});
	});

	$('change-form').addEventListener('submit', function (event) {
		event.preventDefault();

		var problem = $('change-note');
		problem.classList.add('hidden');

		var password = $('change-password').value;

		if (password !== $('change-confirm').value) {
			problem.textContent = 'Those two do not match.';
			problem.classList.remove('hidden');
			return;
		}

		api('password', { password: password }).then(function (res) {
			if (!res.data.ok) {
				problem.textContent = res.data.error;
				problem.classList.remove('hidden');
				return;
			}

			$('change-password').value = '';
			$('change-confirm').value = '';
			refresh().then(function () { note('Password saved.', 'ok'); });
		});
	});

	$('signout').addEventListener('click', function () { api('logout', {}).then(refresh); });

	$('account-form').addEventListener('submit', function (event) {
		event.preventDefault();

		var email = $('account-email').value.trim();

		act('accounts/add', { email: email, role: $('account-role').value }, null, function (data) {
			$('account-email').value = '';

			if (data.password) {
				secret('Access for ' + data.email,
					'They sign in with this once, then choose their own password. It is shown only now.',
					'Email:     ' + data.email + '\nPassword:  ' + data.password);
			} else {
				note(data.email + ' can now sign in as ' + (data.role === 'owner' ? 'an owner' : 'a manager') + '.', 'ok');
			}
		});
	});

	$('user-form').addEventListener('submit', function (event) {
		event.preventDefault();

		act('keys/issue', { name: $('user-name').value.trim() }, null, function (data) {
			$('user-name').value = '';
			secret('Key for ' + data.name,
				'Send both lines. Only a hash is stored, so this is the one time it can be shown.',
				'Service:  ' + location.host + '\nKey:      ' + data.key);
		});
	});

	$('secret-close').addEventListener('click', function () { $('secret-dialog').close(); });

	$('secret-copy').addEventListener('click', function () {
		navigator.clipboard.writeText($('secret-text').textContent).then(
			function () { $('secret-copy').textContent = 'Copied'; },
			function () { $('secret-copy').textContent = 'Select it and copy'; }
		);
	});

	refresh();
})();
</script>
</body>
</html>`;
