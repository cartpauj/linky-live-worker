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
$EDITOR wrangler.toml
```

The file has **four placeholders**, numbered `── 1 ──` to `── 4 ──` in the order
they are filled. You type the first three; the fourth is filled in for you.
Everything else is marked *Fixed* and can be left alone.

So do 1 through 3 by hand, then:

```bash
npm run kv
```

That creates the KV namespace and writes its id into `wrangler.toml` as
placeholder 4, so there is nothing to copy across. Running it again is safe: an
id already in the file is left alone, and an existing namespace is reused rather
than a second one created.

It has to come after step 1, because wrangler reads the account id from
`wrangler.toml` to know which account to create the namespace in. With the
placeholder still there, plain wrangler fails with `Could not route to
/client/v4/accounts/YOUR_ACCOUNT_ID/... [code: 7003]`, which does not point at
the cause — `npm run kv` checks first and says which field to set.

Then check nothing is left:

```bash
npm run check
```

`WORKER_SCRIPT_NAME` repeats `name`, because wrangler uses `name` to deploy and
does not expose it to the running Worker, which needs its own name to route a
hostname to itself. `npm run check` verifies the two agree.

Neither the account id nor the domain is entered twice. TOML has no variable
references, so `npm run deploy` reads `account_id` and `ZONE_NAME` and passes
them through — the account id as a variable the Worker can read, and the API
hostname (`API_SUBDOMAIN` + `ZONE_NAME`) as a custom domain.

Generated hostnames look like `linky-k4d8vn.example.com`. `HOSTNAME_PREFIX` is
yours to change; the flat shape is not — free Universal SSL covers `example.com`
and `*.example.com` but nothing deeper, so a nested `k4d8vn.linky.example.com`
would have no valid certificate.

## 5. Deploy

```bash
npx wrangler secret put CF_API_TOKEN
npm run deploy
```

`npm run deploy` is a thin wrapper. It reads `account_id` and passes it to the
Worker, which cannot see it otherwise, and composes the API hostname from
`API_SUBDOMAIN` and `ZONE_NAME` so the domain is not written out twice. It prints
both before deploying.

Plain `wrangler deploy` still works, but attaches no custom domain — the Worker
would then only answer on its `workers.dev` URL.

`preview_urls = false` in the template turns off the per-version preview
hostnames. Without it, wrangler warns on every deploy and creates one each time,
and since any hostname that is not a provisioned `linky-*` site is served by the
control plane, each is another way in to the API. They are still key-protected,
so this closes surface rather than a hole.

`wrangler secret put` prompts, so run it in a real terminal. With no terminal
attached it stores an **empty** secret without complaining, and the first attempt
to provision a site fails with `9106: Missing X-Auth-Key, X-Auth-Email or
Authorization headers`. The dashboard works too: Settings → Variables and Secrets.

It also asks something alarming the first time:

```
✔ There doesn't seem to be a Worker called "linky-live". Do you want to create a
  new Worker with that name and add secrets to it? … yes
```

**Say yes.** A secret belongs to a Worker, and this runs before the first deploy,
so there is nothing to attach it to yet — wrangler creates an empty placeholder to
hold it. `npm run deploy` then uploads the real code over that placeholder, and
the secret stays where it is.

The secret comes first only because it is the step that needs a terminal, and it
is better done while you obviously have one. Setting it after `npm run deploy`
works exactly the same and skips the question.

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
npm run keys issue "Alice"          # generates a key and prints it once
npm run keys list                   # everyone, with a key fragment each
npm run keys search alice           # same, filtered

npm run keys sites                  # every address, grouped by owner
npm run keys sites Qw8zT1          # just theirs

npm run keys roll Qw8zT1           # replace a lost key, addresses intact
npm run keys revoke Qw8zT1         # stop their addresses answering
npm run keys restore Qw8zT1        # undo a revoke
npm run keys remove Qw8zT1         # delete them and their addresses
```

The fragment shown in `list` is what identifies someone. It never changes, so it
is unambiguous even when several people are making changes at once.

`list` prints it as `…Qw8zT1`; the leading ellipsis is decoration and is stripped
if you paste it, so `Qw8zT1` and `…Qw8zT1` both work.

You supply a name; the key is generated and printed **together with your service
hostname**, so you can send someone everything they need in one message:

```
Key for Alice — send both lines:

  Service:  linky-live.example.com
  Key:      linky_EXAMPLE_KEY_SHOWN_ONCE
```

Names must be unique. `issue` refuses a name that is taken and shows how to roll
it, which is what keeps `remove "Alice"` unambiguous.

Listings show the name, status, date, and the **last six characters** of the key.
That fragment is both how you answer "which of these is mine?" when one person has
keys on several machines, and how you refer to a key in the commands above. The
key itself is never stored, so a lost key is rolled:

```bash
npm run keys roll "Alice"
```

`roll` prints a new key and moves that person's addresses onto it. Site records
are keyed by the hash of their owner's key, so this is what keeps every URL they
registered working — a new key on its own would leave the addresses under a hash
nobody holds.

### Seeing what is out there

```bash
npm run keys sites                  # everything, grouped by owner
npm run keys sites Qw8zT1          # one person's
```

Each row is one address: the URL, the Local site it belongs to, when it was
allocated, and any bypass paths. This reads KV only, so it needs no Cloudflare
token.

Whether a link is currently up is not part of it. That depends on the tunnel
running on its owner's machine, which the service does not track — their Linky
Live tab is where that shows.

### Revoking and removing

`revoke` stops that person's addresses answering — `403` on every path, bypass
paths included — and blocks anything new being provisioned. The hostnames stay
reserved, and `restore` puts both back. It reaches links that are already running:
the gateway reads the owner's status from the hostname record, and revoking
rewrites it.

`remove` deletes the person and their addresses outright — tunnel, DNS record,
Worker route, KV entries — so every URL they registered stops resolving. Deleting
those is an account operation, so it needs the API token:

```bash
CF_API_TOKEN=your-token npm run keys remove Qw8zT1
```

Without it, `remove` refuses for anyone who holds an address rather than deleting
the key alone and stranding the resources.

`revoke`, `restore` and `remove` accept, safest first:

| Form | Behaviour |
| --- | --- |
| `remove Qw8zT1` | **Preferred.** The fragment identifies one key and never changes |
| `remove "Alice"` | A name, confirmed by naming who it matched |
| `remove 3 Qw8zT1` | A row number, checked against the fragment beside it |
| `remove 3` | A row number alone, confirmed by naming who it matched |

Row numbers exist for quick one-off use and are checked or confirmed, never acted
on blindly. Add `--yes` to skip a prompt.

Revoking reaches running links, not just new provisioning. The tunnel on that
person's machine stays up; the gateway in front of it refuses every request, so
nothing reaches the site.

Allow up to a minute for it to bite. The gateway reads the hostname record from
KV, which is cached at each edge location for up to 60 seconds, so a request that
just read the old value keeps being served from it until that expires. Restoring
is immediate, because writing a key clears the cached copy.

### Several people managing it

Everything is stored in the shared KV namespace, so any number of admins can
manage the same team. Each needs Cloudflare access to the account and a
`wrangler.toml` with the same account, zone, and KV ids.

Each person's key is a separate KV entry, so two admins issuing at the same time
cannot clobber each other.

**Numbers can shift**: they are positions in a shared list, so if someone else
adds or removes a key between your `list` and your `remove`, every number after
theirs moves by one. Two things handle that:

- **Pass the fragment as well** — `remove 3 Qw8zT1`. If the list moved, `#3` no
  longer has that fragment and the command refuses, telling you who is there now
  and who actually holds the fragment.
- **Or pass the fragment alone** — `remove Qw8zT1`. Fragments do not shift, so
  this is unambiguous no matter what anyone else did.

A bare number still works and is confirmed by naming who it matched, which is
enough when you are the only one making changes.

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
