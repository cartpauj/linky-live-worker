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

The file has **five placeholders**, numbered `── 1 ──` to `── 5 ──` in the order
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

**Send them your `wrangler.toml`.** It holds no credentials — the account id, the
zone name and id, the KV namespace id, the Worker name and the subdomain, and
nothing else. `CF_API_TOKEN` is stored on the Worker and never appears in the
file. Those ids are not passwords, but they do name your account and zone and are
no use to anyone without Cloudflare access, so hand the file over directly rather
than posting it. It is gitignored, which is what keeps it out of the repo.

With that file and `npx wrangler login`, a new admin can run `issue`, `list`,
`search`, `sites`, `roll`, `revoke`, `restore` and `deploy`.

**`remove` needs an API token as well**, since deleting a tunnel, a DNS record and
a route are account operations that a wrangler login does not cover. Have each
admin create their own with the three permissions from [step 2](#2-create-the-api-token)
rather than sharing one — a token you can revoke on its own is worth the two
minutes.

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

### A teammate key can never manage keys

The add-on's own API has no endpoint that creates, lists, or revokes a key, so a
leaked teammate key cannot mint more. Key management lives behind Cloudflare
account access at a terminal, or behind an admin login at `/admin` — never behind
the bearer token the add-on holds.

## 8. The admin area

There is a web UI at `https://<your API hostname>/admin` for everything in step 7,
plus the accounts allowed to use it. It is optional — the CLI does the same
things — but it is how you give somebody key management without giving them your
Cloudflare account.

Two roles. An **owner** manages admin accounts and everything below; a **manager**
manages users and their keys only. Owners manage other owners and themselves, so
handing over does not need a terminal — except that the last active owner cannot
remove, demote or suspend themselves, since nobody would be left to let anyone
back in.

An admin account is not a team key, and the two are managed separately:

| | Admin account | User and key |
| --- | --- | --- |
| Identified by | an email address | a name, and a key hash |
| Used for | signing in at `/admin` | running the add-on |
| Taken away with | `suspend` or `remove` | `revoke` or `remove` |
| Managed by | `npm run admins` | `npm run keys` |

Removing an account deletes nobody's key; removing a user deletes nobody's login.
The same person may well have both, and they still have nothing to do with each
other.

### Signing in with a password

The default. Put your address in `BOOTSTRAP_OWNER_EMAIL` (placeholder `── 4 ──`),
then:

```bash
npm run admins init
```

Run it any time after `npm run kv` — it writes to KV through wrangler and does
not need the Worker — though the sign-in link it prints only works once you have
deployed.

It prints a one-time password. Sign in with it once, and the page makes you
choose your own before it will do anything else. Check it answers:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://linky-live.example.com/admin
# 200
```

From there, add colleagues in the browser or from the terminal:

```bash
npm run admins list
npm run admins add alice@example.com manager
npm run admins role alice@example.com owner
npm run admins passwd alice@example.com     # reset to a one-time password
npm run admins suspend alice@example.com
npm run admins remove alice@example.com
```

Set `ADMIN_EMAIL_DOMAIN` to restrict accounts to one domain, e.g. `example.com`.

**Nothing here sends email**, so there is no "forgot password" link. A lost
password is reset from a terminal with `npm run admins passwd <email>`, which
mints a fresh one-time password and ends any session that account had open. Keep
a second owner, or keep wrangler access — those are the only two ways back in.

Passwords are hashed with PBKDF2-SHA256 at 100,000 iterations. That is the
ceiling Workers enforce rather than a number chosen freely; anything higher is
refused at runtime. It is below what OWASP asks of PBKDF2, which is part of why
`admins add` mints a random password rather than letting anyone pick one — and
why Cloudflare Access below is worth the extra setup if you have an identity
provider already.

### Signing in with Cloudflare Access

The advanced option: Google, Okta, or any other identity provider, with no
password stored anywhere. In Cloudflare Zero Trust:

1. **Settings → Custom Pages** shows your team domain, e.g.
   `yourteam.cloudflareaccess.com`. Put it in `ACCESS_TEAM_DOMAIN`.
2. **Settings → Authentication** → add Google (or your IdP) as a login method.
3. **Access → Applications** → *Add an application* → *Self-hosted*.
   - Application domain: your API hostname, path `admin`.
   - Add a policy: *Allow*, with the rule **Emails ending in** `@example.com`.
4. Open the application's overview and copy its **Application Audience (AUD)
   tag** into `ACCESS_AUD`.
5. Set `ADMIN_EMAIL_DOMAIN` to the same domain, and `AUTH_MODE = "access"`.
6. `npm run deploy`, then `npm run admins init` to create the first owner —
   which in this mode just records the role, since Cloudflare handles the login.

The Worker verifies the signed token itself on every request. That is not
belt-and-braces: an Access application is attached to a hostname on your zone,
and the Worker also answers on its `workers.dev` URL, which no Access policy
covers. A Worker that trusted the presence of a header would be wide open at that
second address. It also re-checks the email domain in code, so a policy widened
by a stray click in the dashboard cannot let in more than `ADMIN_EMAIL_DOMAIN`
allows.

If `AUTH_MODE` is `access` and any of the three settings is missing, `/admin`
returns a 503 saying which — it fails closed rather than falling back to
passwords.

## 9. Install the add-on

Give each person the API hostname and their key. They install
[Linky Live](https://github.com/cartpauj/linky-live) in Local and enter both on
first run.

## How it works

The Worker sits in the request path only to enforce auth; tunnel data itself
rides Cloudflare's network. Each provisioned site gets a tunnel, a proxied CNAME,
and a route for its exact hostname.

See the [README](README.md) for the architecture, the per-site resources, and why
URLs stay stable across restarts.
