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

One key per person, not per site — the same key works on all of that person's
sites. Keys live in KV, so nothing here needs a deploy and nothing lands in a
config file.

```bash
npm run keys issue "Alice"     # generates a key and prints it once
npm run keys list              # everyone, numbered
npm run keys search alice      # matches, keeping those numbers
npm run keys revoke 3          # block, keeping the record
npm run keys restore 3         # undo a revoke
npm run keys remove 3          # delete the record
```

You supply a name; the key is generated and printed **together with your service
hostname**, so you can send someone everything they need in one message:

```
Key for Alice — send both lines:

  Service:  linky-live.example.com
  Key:      linky_EXAMPLE_KEY_SHOWN_ONCE
```

Names must be unique. `issue` refuses a name that is taken and shows how to roll
it, which is what keeps `remove "Alice"` unambiguous.

Listings show the name, status, date, and the **last six characters** of the key —
enough to answer "which of these is mine?" when one person has keys on several
machines. The key itself is never stored, so a lost key is rolled:

```bash
npm run keys remove "Alice" && npm run keys issue "Alice"
```

`revoke`, `restore` and `remove` accept a number from `list`, a name, or a hash
prefix, and confirm first by naming who they matched. Add `--yes` to skip the
prompt.

Revoking blocks new provisioning at once. Links already running keep running
until stopped, so release any hostnames you also want reclaimed.

### Several people managing it

Everything is stored in the shared KV namespace, so any number of admins can
manage the same team. Each needs Cloudflare access to the account and a
`wrangler.toml` with the same account, zone, and KV ids.

Each person's key is a separate KV entry, so two admins issuing at the same time
cannot clobber each other. **Numbers can shift, though**: they are positions in a
shared list, so if someone else adds or removes a key between your `list` and
your `remove`, every number after theirs moves by one. That is why destructive
commands name who they matched before doing anything — read that line rather than
trusting the number.

### Only admins can add or revoke keys

Key management needs Cloudflare account access. No HTTP endpoint creates, lists,
or revokes a key, so a leaked teammate key cannot mint more, and the add-on cannot
issue keys at all.

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
