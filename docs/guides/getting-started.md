# Starting a new agent

For anyone deploying this agent for their own business. You do not clone or
fork this repository: you generate a project of your own that holds your
configuration, evals, tests and deployment, and depends on the agent as a
published npm package and container image. An upgrade is then a version bump.

The contract this guide follows is
[spec 035](../../specs/035-create-scaffolds-a-tenant-project.md), and the
reasoning behind it is
[ADR-0021](../adr/0021-tenants-depend-on-a-package-not-a-fork.md). Where this
guide and the spec disagree, the spec wins. Already running a fork? Follow
[Moving a deployment fork to a tenant project](moving-a-fork-to-a-tenant-project.md)
instead.

Throughout, `my-agent` stands for your project.

## Before you start

- Node.js 22 or later, and pnpm.
- Somewhere private to keep the project. Its `config/` holds your prompt, prices
  and schedule, so it is tracked in git, and the generated CI fails on a public
  repository.

## Generate the project

```sh
npm create manychat-ai-agent@latest my-agent
```

The name becomes the directory, the package name and the eval suite's
directory, so it takes lowercase letters, digits, `.`, `_` and `-`. The
directory must be empty or not exist yet; nothing is ever written over a file.

It writes:

| Path                       | What it is                                                                    |
| -------------------------- | ----------------------------------------------------------------------------- |
| `config/`                  | The fictional demo tenant: `prompt.md`, `catalog.json`, `rules.json`          |
| `.env`                     | Offline settings: the mock model, an embedded database, a random secret       |
| `evals/my-agent/`          | A few eval cases against the demo tenant                                      |
| `package.json`             | Depends on `manychat-ai-agent` at the scaffolder's version; `private`         |
| `docker-compose.yml`       | Postgres and the agent's image at the same version                            |
| `.github/workflows/ci.yml` | Fails on a public repository, then checks `config/`, runs the evals and tests |
| `renovate.json`            | Brings each release as a pull request                                         |
| `.gitignore`               | Excludes `.env`; tracks `config/`                                             |

## Run it offline

Nothing below needs an account or an API key:

```sh
cd my-agent
pnpm install
pnpm check && pnpm eval
```

`pnpm check` validates `config/` and `.env` the way the server does at startup,
and `pnpm eval` runs your eval suite against the mock model. To talk to it,
start the server:

```sh
pnpm exec agent serve
```

and, in another terminal, send it a message as ManyChat would:

```sh
pnpm exec agent simulate "how much is the foundation course?"
```

`pnpm exec agent` with no command lists the rest.

## Make it yours

1. **Replace `config/`** with your own prompt, catalog and rules. What each file
   holds, and the optional `tools.json`, is in the
   [configuration guide](../../config/README.md). `pnpm check` tells you when a
   file does not parse.
2. **Rewrite the eval cases** in `evals/my-agent/cases.jsonl` for your catalog,
   so `pnpm eval` tests your agent rather than the demo.
3. **Choose a model.** Set `AGENT_MODEL` in `.env` and the matching API key,
   then run `pnpm eval` again: against a real model it costs money, so CI keeps
   to the mock. The comments in `.env` describe every other setting.
4. **Commit and push** to your private repository. CI runs the same checks on
   every pull request.

## Deploy

`docker-compose.yml` runs Postgres and the agent's published image, with
`config/` mounted read-only and credentials from `.env`:

```sh
docker compose up -d
```

It enforces contact tokens whatever `.env` says, so the offline default never
reaches a deployment. Before the first real conversation, set
`MANYCHAT_API_TOKEN` and `PUBLIC_BASE_URL` in `.env`, then connect ManyChat as
[Connecting ManyChat](connecting-manychat.md) describes: the Dynamic Block, its
`Authorization` header and the `ai_token` field. The header carries the
`MANYCHAT_SHARED_SECRET` that `create` already generated at random.

Edits to `config/` take effect on `SIGHUP`, without a restart:

```sh
docker compose kill -s HUP agent
```

## Upgrading

Each release arrives as a Renovate pull request that moves the package and the
image together. Your CI runs `config check` and the evals against it before you
merge. If a release changes the shape of `config/`, run
`pnpm exec agent upgrade` to migrate it.
