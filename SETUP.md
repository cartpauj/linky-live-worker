# One-time setup (you only)

Nobody on the team does any of this. They install the addon and paste a key.

Everything below is free. There is no Advanced Certificate Manager, no Zero
Trust seat, and no paid Workers plan involved.

---

## 1. Pick the hostname shape

Allocated addresses look like:

```
https://linky-k4d8vn.example.com
```

**One DNS label, deliberately.** Universal SSL covers `example.com` and
`*.example.com`, but nothing deeper — and wildcard certificates only ever cover a
single level. A nested shape like `k4d8vn.linky.example.com` would need Advanced
Certificate Manager (a paid add-on) to get a working certificate. The `linky-`
prefix gives the same visual grouping for free.

## 2. Create the API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**.

| Scope | Resource | Permission |
| --- | --- | --- |
| Account | Cloudflare Tunnel | Edit |
| Zone | DNS | Edit |
| Zone | Workers Routes | Edit |

Restrict both zone scopes to `example.com` only.

**Note on blast radius.** Cloudflare cannot scope a DNS token to a name prefix —
zone level is the finest granularity available. This token can therefore edit any
record on `example.com`, even though the worker only ever creates and deletes
`linky-` prefixed ones.

If `example.com` runs production services, consider a cheap dedicated domain for
tunnels instead. The token is then scoped to a zone that hosts nothing else, and
your production zone is never touched at all. Change `ZONE_NAME`, `CF_ZONE_ID`,
and the route pattern to match.

This token can create and delete DNS records on `example.com`, so it stays in
worker secrets and never goes near a teammate's machine. That separation is the
main reason the worker exists at all.

## 3. Collect your IDs

- **Account ID** — Cloudflare dashboard sidebar, or `npx wrangler whoami`
- **Zone ID** — the `example.com` overview page, bottom right

## 4. Configure and deploy

```bash
npm install

# Create the KV namespace and copy the printed id into wrangler.toml
npx wrangler kv namespace create LINKY

# Fill in CF_ACCOUNT_ID, CF_ZONE_ID and the KV id
$EDITOR wrangler.toml

# Store the API token as a secret
npx wrangler secret put CF_API_TOKEN

npx wrangler deploy
```

## 5. The API hostname

The addon talks to a fixed hostname, set in `wrangler.toml`:

```toml
[[routes]]
pattern = "linky-live.example.com"
custom_domain = true
```

`custom_domain = true` means **Cloudflare creates and manages the DNS record and
certificate itself** on deploy. There is nothing to add by hand.

It is one specific hostname, so it cannot affect anything else on the zone. A
fixed name also means the addon keeps working if the worker is ever renamed or
moved between accounts — which is why the addon does not point at the
`workers.dev` URL, even though that also works and stays enabled as a debugging
fallback.

Verify it after deploying:

```bash
curl -s https://linky-live.example.com/v1/status
# {"ok": false, "error": "Invalid or missing API key."}
```

That error is the success case: the worker is live and rejecting anonymous calls.

## 6. Let webhooks past Bot Fight Mode

Bot Fight Mode challenges non-browser traffic, which will intermittently reject
webhook POSTs from Stripe and PayPal.

**Check whether it is even on**: Security → Bots. If it is off, skip this.

If it is on, **do not turn it off** — that would change behaviour for the whole
zone. Add a scoped skip rule instead, under Security → WAF → Custom rules:

```
When incoming requests match:
  Hostname   starts with   linky-

Then:
  Skip → Bot Fight Mode
```

That affects only the live link hostnames and leaves the rest of `example.com`
exactly as it was.

## 7. Add people

Keys are per person, not per site. One key works on all of that person's sites.

### The dashboard way (recommended)

**Workers & Pages → linky-live → Settings → Variables → `TEAM_KEYS`**

One person per line:

```
# Company live link keys
Paul = linky_EXAMPLE_KEY_REPLACE_ME
Dave = linky_EXAMPLE_KEY_REPLACE_ME
Ana  = linky_EXAMPLE_KEY_REPLACE_ME
```

Save and it takes effect immediately — Cloudflare redeploys for you.

- **Add someone**: add a line, save, send them the key.
- **Revoke someone**: delete their line, save. Locked out at once.
- **See who has access**: read the field.

Make up keys however you like, as long as they are long and random. To generate
one:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | sed 's/^/linky_/'
```

Names are labels only, for your own reference — the key after the `=` is the
secret. Blank lines and `#` comments are ignored, and commas work as separators
too if you would rather keep it on one line.

> **`wrangler deploy` overwrites this variable** with whatever is in
> `wrangler.toml`, because it is a `[vars]` entry. Either treat `wrangler.toml` as
> the source of truth and deploy after editing it, or remove the block from
> `wrangler.toml` and set it with `wrangler secret put TEAM_KEYS` — which keeps it
> out of the repo and survives deploys, at the cost of not being readable back.

### Only admins can add or revoke keys

Keys live in a Cloudflare dashboard variable, which requires account access to
edit. There is **no HTTP endpoint** that creates, lists, or revokes a key, so a
leaked teammate key cannot be used to mint more, and the add-on cannot issue keys
at all.

The Worker only ever reads that variable. Everything it writes lives under the `site:` and `host:` namespaces.
A teammate key can only:

- allocate or reuse a hostname for one of **its own** sites
- change that site's password and bypass paths
- release that site's hostname

It cannot see another person's sites, cannot alter any key, and never receives
the privileged Cloudflare API token. `test/key-boundary.test.mjs` asserts
all of this, so a future change that opens a key-minting route fails the tests.

---

## How it fits together

```
Stripe / PayPal
      |
      v
Cloudflare edge  ──►  this Worker  ──►  <tunnel-id>.cfargotunnel.com
                      (basic auth,              |
                       bypass paths)            v
                                        teammate's cloudflared
                                                |
                                                v
                                      127.0.0.1:10063  (Local nginx)
```

The worker is in the request path only to enforce auth. Tunnel data itself
rides Cloudflare's network, so there is no bandwidth cost and no request-size
limit from the worker.

### Per-site resources

Each provisioned site gets a tunnel, a proxied CNAME to
`<tunnel-id>.cfargotunnel.com`, and a worker route for its exact hostname.

The route has to be per-hostname: route patterns forbid infix wildcards, so
`linky-*.example.com/*` is rejected outright, and the only working wildcard —
`*.example.com/*` — would drag every other `example.com` subdomain through this worker.

Cloudflare allows 1,000 tunnels per account, which is far more than a team will
ever use.

### Why URLs are sticky

Provisioning is keyed on (teammate, site id) and is idempotent. Toggling a link
off only stops the local process; the tunnel, DNS record, and route all survive,
so switching it back on returns the identical address.

That is what makes registering a webhook with Stripe a one-time job. Only the
explicit **Release address** button tears those resources down.
