# Linky Live Worker

The Cloudflare Worker behind [Linky Live](https://github.com/cartpauj/linky-live), the Local add-on that
gives a WordPress site a permanent public HTTPS address.

It wears two hats, chosen by whether the request hostname is a site it has
provisioned:

- **Auth gateway** — sits in front of the tunnel, enforces basic auth, lets
  whitelisted paths and static assets through, and rewrites the site's local
  hostname out of the response body.
- **Control plane** — an authenticated JSON API the add-on calls to allocate,
  reconfigure, and release hostnames.

Setup is in [`SETUP.md`](SETUP.md).

You need both halves: this Worker, and the
[Linky Live](https://github.com/cartpauj/linky-live) add-on that your team
installs into Local.

## Quick start

You need a Cloudflare account and a domain on it. Everything here fits in the
free tier.

```bash
git clone https://github.com/cartpauj/linky-live-worker.git
cd linky-live-worker

cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler whoami                        # copy your account id

$EDITOR wrangler.toml                      # account id, zone, hostname
npx wrangler kv namespace create LINKY     # paste the printed id into wrangler.toml

npx wrangler secret put CF_API_TOKEN       # needs a real terminal — see below
npm run deploy

npm run keys issue "Alice"                 # a key for your first user
```

The KV step comes after editing, because wrangler reads the account id from
`wrangler.toml`.

Two things that are not obvious:

- **The API token is one you create by hand** in the Cloudflare dashboard, with
  three specific permissions. No template matches; you want *Create Custom Token*.
- **`wrangler secret put` prompts**, so it needs a real terminal. Without one it
  stores an empty secret silently, and provisioning later fails with
  `9106: Missing X-Auth-Key…`.

Check it is live — a `401` is the success case, meaning it is running and
rejecting anonymous callers:

```bash
curl -s https://linky-live.example.com/v1/status
```

Then install the [Linky Live](https://github.com/cartpauj/linky-live) add-on in
Local and give it that hostname and a key.

**[`SETUP.md`](SETUP.md) has the full steps**, including the token permissions.

## Architecture

```
Stripe / PayPal / any inbound API
            │
            ▼
   Cloudflare edge  ─────►  Worker  ─────►  <tunnel-id>.cfargotunnel.com
                            (basic auth,              │
                             bypass paths)            ▼
                                              cloudflared
                                          (dev's machine, run
                                           by the Local addon)
                                                      │
                                                      ▼
                                            127.0.0.1:10063
                                              (Local nginx)
```

Two halves:

- **`worker/`** — a Cloudflare Worker wearing two hats. It provisions tunnels
  (control plane) and enforces auth in front of site traffic (gateway).
- **`addon/`** — a Local add-on that runs `cloudflared`, manages two mu-plugins,
  and provides the UI.

**Tunnel data never passes through the Worker's own quota** — Cloudflare's edge
does the forwarding. The Worker sits in the request path only to check auth.

**The Worker holds the privileged Cloudflare API token.** Teammates only ever
hold a key that can say "give me a subdomain for my own site". Nothing reachable
over HTTP can mint, list, or revoke a key.

### Repo layout

```
src/index.js     control plane + auth gateway
src/cf.js        Cloudflare API calls
src/rewrite.js   streaming host rewrite of response bodies
src/util.js      credential generation, validation, timing-safe compare
wrangler.toml    configuration
test/            gateway auth, key boundary, validation, DNS guard, rewriting
```

## Configuration

Copy the template and fill in your own values:

```bash
cp wrangler.example.toml wrangler.toml
```

`wrangler.toml` is gitignored, so nothing account-specific ends up in the repo.

Everything below is in `wrangler.toml`, which holds no credentials — only ids and
hostnames. The one secret, `CF_API_TOKEN`, is set with `wrangler secret put`, and
user keys live in KV (see [Adding people](#adding-people)).

| Setting | Where | What it is |
| --- | --- | --- |
| `name` | top level | The name the Worker deploys under |
| `WORKER_SCRIPT_NAME` | `[vars]` | The same value again — see below |
| `account_id` | top level | Which account to deploy into (`wrangler whoami`) |
| `CF_ACCOUNT_ID` | `[vars]` | The same account id, for the Worker's own API calls |
| `ZONE_NAME` | `[vars]` | The domain links are created on, e.g. `example.com` |
| `CF_ZONE_ID` | `[vars]` | That zone's id, from its Cloudflare overview page |
| `HOSTNAME_PREFIX` | `[vars]` | `linky` gives `linky-k4d8vn.example.com` |
| `id` | `[[kv_namespaces]]` | From `wrangler kv namespace create LINKY` |
| `API_SUBDOMAIN` | `[vars]` | With `ZONE_NAME`, forms the hostname the add-on talks to |

### Why some values appear twice

`name` and `account_id` are wrangler's own build-time settings and are **not
visible to the running Worker**. But the Worker makes Cloudflare API calls of its
own — creating a tunnel, a DNS record, and a route for each site it provisions —
so it needs the same facts at runtime. That is what `WORKER_SCRIPT_NAME` and
`CF_ACCOUNT_ID` are for.

Keep each pair identical. A mismatch still deploys cleanly; it fails later, when
provisioning a site, with a Cloudflare error about an unknown script or account.

`CF_API_TOKEN` is a secret and never goes in the file:

```bash
wrangler secret put CF_API_TOKEN
```

Health check — a `401` is the **success** case here, meaning the Worker is live
and rejecting anonymous callers:

```bash
curl -s https://linky-live.example.com/v1/status
# {"ok": false, "error": "Invalid or missing API key."}
```

Full walkthrough in [`SETUP.md`](SETUP.md).

## Adding people

One key per person, not per site. Keys live in KV and are managed from the
terminal, so nothing needs a deploy and no credential goes in a config file.

```bash
npm run keys issue "Alice"          # generates a key and prints it once
npm run keys list                   # everyone, with a key fragment each
npm run keys search alice           # same, filtered
npm run keys revoke Qw8zT1         # block, keeping the record
npm run keys restore Qw8zT1        # undo a revoke
npm run keys remove Qw8zT1         # delete the record
```

You supply a unique name; the key is generated and printed alongside your service
hostname, so both halves can be sent in one message. Listings show names, status,
and the last six characters of each key — never the key itself, which is stored
only as a hash. A lost key is rolled, not recovered.

Keys are referred to by that fragment, which never changes. A name works too, and
a row number from `list` is accepted for quick one-off use — checked against the
fragment if you pass both, confirmed by name if you do not. That distinction
matters when several admins share the list, since row numbers move when anyone
adds or removes a key: see [`SETUP.md`](SETUP.md#several-people-managing-it).

Only a SHA-256 of each key is stored, so a key can be verified but never read
back. Any number of admins can manage the same team — see
[`SETUP.md`](SETUP.md#7-add-people).

## Worker API

All endpoints need `Authorization: Bearer <team key>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/provision` | `{siteId, siteName, port}` → allocate or reuse a hostname |
| `POST` | `/v1/config` | `{siteId, authUser?, authPass?, bypassPaths?, publicAssets?, regenerate?}` |
| `POST` | `/v1/release` | `{siteId}` → delete tunnel, DNS, route |
| `GET` | `/v1/status` | `?siteId=` for one site, omit for all of yours |

`provision` is **idempotent by `(person, siteId)`** — that is what makes URLs
sticky. Toggling a link off only stops the local process; the tunnel, DNS record,
and route survive.

### KV schema

```
teamkey:<sha256>        → { name, active }     who may use the addon
site:<keyHash>:<siteId> → full site record     addon-facing lookup
host:<hostname>         → auth + bypass subset gateway hot path
```

The `host:` mirror exists so the gateway needs one KV read by hostname and never
has to work out who owns the site.

Keys are stored as `teamkey:<sha256>`, so the Worker can verify one without ever
being able to read it back.

---

## Design decisions worth knowing

These were all learned the hard way; changing them will break things.

**Hostnames are one DNS label** (`linky-k4d8vn.example.com`). Universal SSL covers
`example.com` and `*.example.com` but **nothing deeper**, and wildcard certs only ever
cover one level. A nested `k4d8vn.linky.example.com` would need paid Advanced
Certificate Manager.

**Worker routes are created per exact hostname.** Route patterns forbid infix
wildcards, so `linky-*.example.com/*` is rejected — and the only working wildcard,
`*.example.com/*`, would drag every other `example.com` subdomain through this worker.
One route per hostname keeps it surgical.

**The worker infers its own role** by looking up the request hostname in KV. A
provisioned hostname is site traffic; anything else is an API call. So the API
needs no configured hostname, and a site URL can never expose the control plane.

**Local site nginx has no `server_name`** and listens on its own port, so the
tunnel can forward with any Host header. This is what makes the whole approach
simple.

**A bypass entry is a path prefix.** `/mepr` covers `/mepr`, `/mepr/notify` and
`/meprsdkfjl`. This is broader than segment-boundary matching on purpose: gateway
listeners append all sorts of things to their base path, and a bypass that
silently fails to match loses webhooks invisibly — which stays invisible until a
payment goes astray. Keep entries as specific as the listener allows, since each
one opens everything beneath it.

**An entry may pin query parameters**, which is the only way to whitelist a
listener living at a query string, and the only way to open `/` narrowly:

```
/mepr                    path prefix
/?action=mepr            root, only with action=mepr
/?action=mepr&mode=live  both parameters required
/?mepr-listener          parameter must be present, any value
```

Extra parameters the sender adds are ignored, so `/?action=mepr` matches
`/?action=mepr&foo=bar`. Every parameter named in the entry must be present.

**A query-pinned entry matches its path exactly, never as a prefix.** This is a
security requirement, not a convenience: `/?action=mepr` has a path of `/`, and
every path starts with `/`, so prefix matching would mean "any URL carrying
action=mepr" — and anyone who learned the parameter could append it to
`/wp-admin/` to skip the password. If a prefix *and* a parameter are both wanted,
add the prefix as its own path-only entry.

`/` and `*` are always refused, so no entry can open the whole site.

**Matching is on the raw path**, so percent-encoding can only cause a bypass to
*miss*, never to match something protected: `/%6Depr` does not match `/mepr`. The
failure mode is a webhook that is unexpectedly asked for a password, not a leak.

**Static assets are readable without the password**, controlled per site by
`publicAssets` (default on). This is an **extension allowlist** — `css, js, mjs,
png, jpg, jpeg, gif, webp, avif, svg, ico, bmp, woff, woff2, ttf, otf, eot` — not
a directory rule, because opening `/wp-content` would also expose plugin and
theme source (for a plugin vendor, the product), database dumps that backup
plugins leave there, and `wp-content/debug.log`. `.php`, `.sql`, `.zip`, `.log`,
`.env`, `.json` and friends stay behind auth. Only the final extension counts, so
`x.css.php` is not an asset, and matching is path-only so a query string cannot
disguise anything.

Without this, a bypassed webhook path still renders as a broken page in a
browser: the HTML arrives but every stylesheet behind it returns 401, so the
browser prompts for a password anyway.

**An HTML 404 on a bypassed request is replaced with a bare 404**, on every
method, for unauthenticated callers. WordPress's 404 template names the
WordPress version and every installed plugin and theme, and it is also what
WordPress returns for a missing image. A bare 404 is used rather than an auth
challenge because prompting for a password on a path the user just whitelisted —
or on a missing favicon — looks broken. Only HTML is replaced, so a JSON 404 from
a real endpoint reaches the caller intact, and an authenticated visitor sees the
real page.

**Deletions use IDs from KV, never from the request.** `/v1/release` takes only a
`siteId`. DNS deletion additionally refuses any hostname that is not a
single-label `linky-*` name on the configured zone — that call is the only one that
could damage an unrelated production record.

**The add-on needs no build step.** Local registers process-wide module aliases
for `react`, `react-dom`, and `react-router-dom` (React 16.14, react-router 5.3),
so plain CommonJS with `React.createElement` resolves at runtime from a folder on
disk. `@getflywheel/local-components` is **not** aliased and cannot be resolved
from an add-on, which is why the UI is hand-styled.

**Styling must be theme-aware.** Local toggles a `Theme__Dark` / `Theme__Light`
class on an ancestor. All colour lives in `src/styles.js` behind `--linky-*` custom
properties, injected via the `stylesheets` content hook. A test asserts every
token has a dark-mode value and that no stray hex leaks into the rules.

---

## Gotchas

**`wrangler secret put` cannot prompt without a TTY.** Running it through a
non-interactive shell silently stores an **empty** secret. The symptom is
Cloudflare error `9106: Missing X-Auth-Key, X-Auth-Email or Authorization
headers`. Use the dashboard, or pipe the value in.

**Never pass a token as a CLI argument.** `wrangler secret put <token>` treats it
as the secret *name*, not the value — and puts the token in your shell history.

**Cloudflare authoritative DNS lags 1–3 minutes** after a record is deleted. A
released hostname resolving right after teardown is propagation, not a leak.
Verify with `dig +short @<zone-ns> <hostname>` and be patient.

**A fresh Worker Custom Domain can 500 for a few seconds** after first deploy
(`error code: 1104`) while the cert provisions. It settles by itself.

**Local gives each site only two PHP workers** (`pm.max_children = 2`). Anything
that makes WordPress fetch itself over the public hostname needs a second worker
while the first is still blocked waiting for it, and deadlocks: the work
completes, but the response never returns and the browser hangs forever. This is
why `home` and `siteurl` are left pointing at the local address.

**Reading gateway errors on a site hostname:**

| Code | Meaning |
| --- | --- |
| `401` | Auth blocked the request — working as intended |
| `530` | Auth passed, but no `cloudflared` is connected to the tunnel |
| `502` | Auth passed and the tunnel is up, but nothing is listening on the site's port — **the Local site is stopped** |

`502` is the common one, and it is not a bug in the link. The add-on probes the
site's port and shows a warning banner for exactly this case.

**Bot Fight Mode will intermittently reject webhook POSTs.** Scope a skip rule to
`Hostname starts with linky-` rather than disabling it zone-wide.

---

## Known limitations

**A bypassed path exposes whatever WordPress serves there.** That is the point —
Stripe cannot send a password — but it is the same exposure a production site has
at its webhook endpoint, so keep prefixes narrow. The 404 template is withheld,
but a real page at a bypassed path is public.

**Percent-encoded paths do not match bypass entries.** `/%6Depr` will not match
`/mepr`. This fails closed, so the risk is a webhook being asked for a password
rather than anything leaking.

**Static assets are world-readable when `publicAssets` is on.** Anyone who knows
the hostname can read uploaded images and media. Turn it off per site if that
matters, at the cost of browser password prompts on bypassed pages.

**The API token is zone-wide.** Cloudflare cannot scope a DNS token to a name
prefix. The Worker only ever creates and deletes `linky-` records, but the token
*could* edit anything on `example.com`. A dedicated domain for tunnels removes this —
change `ZONE_NAME`, `CF_ZONE_ID`, and the route pattern.

**Quotas.** 1,000 tunnels per Cloudflare account, and the Worker's free tier
covers gateway traffic. Neither is close for a team.

## Development

```bash
node --test test/          # no install needed
npm run deploy             # passes account_id through to the Worker
npx wrangler tail          # live logs
```

`npm install` is optional: the Worker has no runtime dependencies and wrangler is
the only package, which `npx` fetches on demand. Installing pins it locally.

A deploy applies to everyone at once, so verify against a real site before
considering a change done.

### Versioning

`package.json` is the single source of truth. The bundler inlines it, so the
Worker reports its own version on the authenticated `/v1/status` response:

```bash
curl -s https://linky-live.example.com/v1/status \
  -H "Authorization: Bearer $YOUR_KEY"
# {"ok": true, "version": "0.0.1", "sites": []}
```

That matters because a deploy affects everyone at once, and the Worker shares a
wire contract with the add-on — the `X-Linky-Live` and `X-Local-Host` headers and
the `/v1/*` endpoints. Being able to ask a running Worker which build it is makes
that contract checkable rather than assumed.

The version is only reported to authenticated callers; announcing it publicly
would just help someone fingerprint the deployment.

### Releasing

Pushing a `vX.Y.Z` tag publishes a GitHub release. There is **no artifact** — the
Worker is deployed from source with `wrangler deploy`, so a release exists to
carry a changelog and to mark the contract the add-on can rely on.

```bash
# 1. bump the version in package.json and commit
# 2. tag it, matching exactly
git tag v0.1.0
git push origin v0.1.0
```

The workflow refuses to publish if the tag and `package.json` disagree, since the
Worker reports that version at runtime — a mismatch would have operators reading
a version that was never deployed under that name.

Publishing a release does **not** deploy anything. Deploys stay manual.

### CI

Pushes and pull requests run the test suite, re-run the secret scan on its own so
a failure is unmistakable, and check the config template still lists every
setting.

**Deploys are deliberately manual.** `wrangler.toml` holds your account and zone
ids and is gitignored, so CI has no configuration to deploy with — and a workflow
that could deploy would need a Cloudflare API token stored in the repo. Running
`wrangler deploy` from a machine that already has the config is both simpler and
narrower.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
