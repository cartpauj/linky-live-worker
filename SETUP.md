# Setup

Everything here is free: no Advanced Certificate Manager, no Zero Trust seat, no
paid Workers plan.

You need a Cloudflare account and a domain on it. Your team does none of this —
they install the add-on and paste a key.

For an abbreviated version, see the Quick start in the [README](README.md).

## 1. Clone and log in

```bash
git clone https://github.com/cartpauj/linky-live-worker.git
cd linky-live-worker
npx wrangler login
```

`npm install` is optional: wrangler is the only package and `npx` fetches it on
demand. Installing pins it locally.

## 2. Create the API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom
Token**. No template matches.

| Type | Item | Level |
| --- | --- | --- |
| Account | Cloudflare Tunnel | Edit |
| Zone | DNS | Edit |
| Zone | Workers Routes | Edit |

Scope both zone rows to the one zone you will use. Copy the token — it is shown
once.

**Blast radius:** Cloudflare cannot scope a DNS token to a name prefix, so this
token can edit any record on that zone. The Worker only ever touches `linky-`
records. If the zone runs production services, consider a dedicated domain.

## 3. Collect your ids

- **Account id** — `npx wrangler whoami`, or the dashboard sidebar
- **Zone id** — the zone's overview page, bottom right

## 4. Configure

```bash
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create LINKY    # prints an id
$EDITOR wrangler.toml
```

`wrangler.toml` is gitignored. Every field is commented in place; these are the
ones to change:

| Field | Value |
| --- | --- |
| `name` | What to call the Worker, e.g. `linky-live` |
| `WORKER_SCRIPT_NAME` | The same value again — it is not visible to the running Worker otherwise |
| `account_id`, `CF_ACCOUNT_ID` | Your account id |
| `ZONE_NAME` | The domain, e.g. `example.com` |
| `CF_ZONE_ID` | That zone's id |
| `HOSTNAME_PREFIX` | Prefix for generated hostnames, e.g. `linky` |
| `[[kv_namespaces]]` `id` | The id just printed |
| `[[routes]]` `pattern` | The API hostname, e.g. `linky-live.example.com` |
| `TEAM_KEYS` | At least one `Name = key` line — see step 7 |

Hostnames come out as `linky-k4d8vn.example.com`. The prefix is yours to choose;
the flat shape is not — free Universal SSL covers `example.com` and
`*.example.com` but nothing deeper, so a nested `k4d8vn.linky.example.com` would
have no valid certificate.

## 5. Deploy

```bash
npx wrangler secret put CF_API_TOKEN
npx wrangler deploy
```

`wrangler secret put` prompts, so run it in a real terminal. With no terminal
attached it stores an **empty** secret without complaining, and the first attempt
to provision a site fails with `9106: Missing X-Auth-Key, X-Auth-Email or
Authorization headers`. The dashboard works too: Settings → Variables and Secrets.

`custom_domain = true` on the route makes Cloudflare create the DNS record and
certificate for the API hostname itself. Verify — a `401` is the success case:

```bash
curl -s https://linky-live.example.com/v1/status
# {"ok": false, "error": "Invalid or missing API key."}
```

A fresh custom domain can return `500` (`error code: 1104`) for a few seconds
while the certificate provisions.

## 6. Let webhooks past Bot Fight Mode

Check Security → Bots. If it is off, skip this.

If it is on, do **not** turn it off — that changes the whole zone. Add a scoped
rule under Security → WAF → Custom rules:

```
When:  Hostname  starts with  linky-
Then:  Skip → Bot Fight Mode
```

Left on, it intermittently rejects webhook POSTs from Stripe and PayPal.

## 7. Add people

One key per person, not per site. The same key works on all of that person's
sites.

**Workers & Pages → your worker → Settings → Variables → `TEAM_KEYS`**

```
# Team keys
Alice = linky_EXAMPLE_KEY_REPLACE_ME
Bob   = linky_EXAMPLE_KEY_REPLACE_ME
```

- **Add someone** — add a line, save, send them the key
- **Revoke someone** — delete their line, save; locked out immediately
- **See who has access** — read the field

Generate a key:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | sed 's/^/linky_/'
```

Names are labels only and are never read by the Worker; access is decided by the
key alone, so renaming someone is safe. Blank lines and `#` comments are ignored,
and commas work as separators.

> **`wrangler deploy` overwrites this variable** with whatever is in
> `wrangler.toml`, since it is a `[vars]` entry. Either treat `wrangler.toml` as
> the source of truth and deploy after editing, or remove the block from it and
> use `wrangler secret put TEAM_KEYS` — which keeps keys out of the repo and
> survives deploys, but cannot be read back.

Key management is deliberately limited to the dashboard and this file. No HTTP
endpoint creates, lists, or revokes a key, so a leaked teammate key cannot mint
more, and the add-on cannot issue keys at all.

## 8. Install the add-on

Give each person the API hostname and their key. They install
[Linky Live](https://github.com/cartpauj/linky-live) in Local and enter both on
first run.

## How it works

The Worker sits in the request path only to enforce auth; tunnel data itself
rides Cloudflare's network. Each provisioned site gets a tunnel, a proxied CNAME,
and a route for its exact hostname.

See the [README](README.md) for the architecture, the per-site resources, and why
URLs stay stable across restarts.
