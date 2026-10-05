# Moving a deployment fork to a tenant project

For anyone who deploys this agent from a fork of the repository and syncs it by
merging or rebasing upstream. After the move, your repository holds only your
configuration, evals, tests and deployment. The agent arrives as a published npm
package and container image, and an upgrade is a version bump instead of a sync.

The contract this guide follows is
[spec 033](../../specs/033-tenant-projects-not-forks.md), and the reasoning
behind it is [ADR-0021](../adr/0021-tenants-depend-on-a-package-not-a-fork.md).
Where this guide and the spec disagree, the spec wins.

Throughout, `example-tenant` stands for your project, `<version>` for the
release you move to, and `<owner>` for the GitHub owner of this repository.

## Before you start

- **A release exists.** `manychat-ai-agent@<version>` is on npm and
  `ghcr.io/<owner>/manychat-ai-agent:<version>` is on GHCR. Both come from the
  same tag.
- **The release contains everything your fork runs.** Sync your fork to that
  release first. The image applies database migrations at boot and skips the
  ones already applied, so your existing database carries over unchanged, but
  only if the image is at least as new as the code that last migrated it.
- **Your fork carries no source edits.** This prints nothing when that holds:

  ```sh
  git diff --stat upstream/main...HEAD -- src/ db/
  ```

  Each edit it lists goes upstream as a pull request before you move. One that
  cannot wait becomes a patch (see [Urgent fixes](#urgent-fixes)).

- **Your tests need nothing that is not exported.** List what they import from
  the agent's source:

  ```sh
  grep -rn "src/" test evals --include=*.ts | grep -v "^evals/run.ts\|^evals/cases.ts"
  ```

  Each import must be covered by `manychat-ai-agent/config` (the config
  schemas, their types, `loadTenantConfig`, `loadEnv`, `ConfigStore`,
  `ConfigError`) or `manychat-ai-agent/testing` (the mock model helpers,
  `buildTools`, `ActionStage`), or replaced by `agent config check`. Anything
  else is a gap in the package. Open an issue or pull request upstream and wait
  for the release that closes it.

- **Your suite is green** on the fork as it stands, so a failure after the move
  is the move's.

## 1. Decide what stays

| Keep                                        | Delete                                            |
| ------------------------------------------- | ------------------------------------------------- |
| `config/`                                   | `src/`, `db/`, `scripts/`, `api/`                 |
| `evals/<name>/`, your own suite             | `evals/golden/`, `evals/run.ts`, `evals/cases.ts` |
| Your own tests                              | Upstream's `test/`                                |
| Your deployment workflows and Compose files | `Dockerfile`, upstream's workflows                |
| Your runbook and your own specs             | Upstream's `specs/`, `docs/`, `.vitepress/`       |
| `.env`, which stays uncommitted             | Upstream's `package.json`, lockfile, configs      |

Files you write for yourself, such as `.gitignore`, `README.md` and the
lockfile, may keep the same names. What you delete is upstream's content.

Either start a new repository from the kept files, or delete in place and keep
your history. A new repository is cleaner: the old history still holds every
upstream file and every merge from upstream.

## 2. Depend on the package

Your `package.json` replaces upstream's:

```json
{
  "name": "example-tenant",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "eval": "EVAL_DIR=evals/example agent eval",
    "test": "vitest run"
  },
  "dependencies": {
    "manychat-ai-agent": "^<version>"
  },
  "devDependencies": {
    "vitest": "<the version you use today>"
  }
}
```

Use a caret range, as
[spec 033](../../specs/033-tenant-projects-not-forks.md#a-release-is-a-version-bump-and-a-breaking-config-change-ships-its-migration)
does. Before 1.0 a breaking release moves the minor version, and `^0.14.0`
never crosses into `0.15`, so the range takes patch releases and leaves every
breaking one to you. The lockfile still fixes the exact version CI installs.
Keep `"private": true`: it stops an accidental `npm publish` of your
configuration.

The image tag in your Compose files must be that same exact version, or CI
checks different code from the code production runs. Let Renovate update both
in one pull request:

```json
{
  "packageRules": [
    {
      "matchPackageNames": ["manychat-ai-agent", "ghcr.io/<owner>/manychat-ai-agent"],
      "groupName": "manychat-ai-agent"
    }
  ]
}
```

and have CI fail when they drift:

```sh
locked=$(node -p "JSON.parse(require('fs').readFileSync('node_modules/manychat-ai-agent/package.json', 'utf8')).version")
grep -q "manychat-ai-agent:$locked" docker-compose.yml || { echo "image tag is not $locked"; exit 1; }
```

Then:

```sh
pnpm install
pnpm exec agent config check
```

`agent config check` runs the validation the server runs at startup and exits.
It reads the same environment variables the server does (the
[`.env` table in spec 003](../../specs/003-config-schema.md#env)). Every `agent`
command loads `.env` from the directory you run it in, and a variable already
set in the shell wins over the file. In CI, where there is no `.env`, set
placeholder values (step 5).

`DATABASE_URL=pglite`, the embedded database, works only from a clone of this
repository. From the package, run Postgres for local work too; the Compose file
below includes it.

## 3. Point your tests at the public entry points

```ts
// before
import { loadTenantConfig } from '../../src/config/loader.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';

// after
import { loadTenantConfig } from 'manychat-ai-agent/config';
import { ActionStage, buildTools } from 'manychat-ai-agent/testing';
```

A test that only proves `config/` parses is now `agent config check`; delete it.
Node refuses any other path into the package with
`ERR_PACKAGE_PATH_NOT_EXPORTED`, which is deliberate: an import that needs one
is a missing option or hook, and the fix belongs upstream.

## 4. Run the published image

Replace `build: .` with the image, and mount `config/` as a directory:

```yaml
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: agent
      POSTGRES_PASSWORD: agent
      POSTGRES_DB: agent
    volumes: ['pgdata:/var/lib/postgresql']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U agent']
      interval: 5s
      timeout: 3s
      retries: 10

  agent:
    image: ghcr.io/<owner>/manychat-ai-agent:<version>
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://agent:agent@postgres:5432/agent
      PORT: 3000
    volumes: ['./config:/app/config:ro']
    env_file: [.env]
    ports: ['3000:3000']
    restart: unless-stopped

volumes:
  pgdata:
```

Configuration still reloads without a restart:

```sh
docker compose kill -s HUP agent
```

Mount the directory, not single files. Many editors save by replacing the file,
and a single-file bind mount keeps showing the container the old one.

Your production Compose file changes the same way: `image:` instead of `build:`,
and whatever it already does for secrets and the database stays.

## 5. Replace CI and deployment

Your CI no longer builds the agent. It checks your configuration, runs your
tests and runs your suite:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm exec agent config check
  env:
    AGENT_MODEL: mock:demo
    PUBLIC_BASE_URL: https://ci.example.com
    MANYCHAT_SHARED_SECRET: ci-secret-ci-secret-ci-secret-xx
    DATABASE_URL: postgres://ci:ci@localhost:5432/ci
- run: pnpm test
```

Run `pnpm eval` with the same model and secrets you run your suite with today.
With `AGENT_MODEL=mock:demo` it checks only that the suite loads and runs.

Your deployment workflow stops building an image and starts deploying a tag:
the one in your Compose file.

## 6. Switch production over

1. Deploy to a test environment first, against a copy of production's database.
   Send a message through ManyChat and check the reply arrives.
2. Deploy to production by changing the image the service runs.
3. To roll back, point the service at the image your fork last built. The
   database is compatible as long as `<version>` matches the code your fork ran.

## 7. Cut the link

- Remove the `upstream` remote: `git remote remove upstream`.
- Delete anything copied from upstream that is still in the tree.
- Rewrite your runbook's sync section as an upgrade section (below). Nothing
  about rebasing, merging upstream or force-pushing should remain.

## Upgrading afterwards

1. Read the release's changelog. Before 1.0, a minor version can break things
   ([spec 010](../../specs/010-release-workflow.md)).
2. Renovate's pull request moves the lockfile and the image tag together. For a
   breaking release, also move the range in `package.json` (`^0.14.0` to
   `^0.15.0`); the range alone will not cross it.
3. `pnpm install`, then `pnpm exec agent upgrade`. It rewrites `config/` to
   the new version's shape, and running it twice changes nothing. (Not
   `pnpm upgrade`: that is pnpm's own command for updating dependencies.)
4. `pnpm exec agent config check`. When a new version needs a value only you can supply,
   the upgrade leaves it out and this check names the field.
5. `pnpm test`, `pnpm eval`, then deploy as in step 6.

## Urgent fixes

When a fix cannot wait for a release, patch the installed version and open the
same fix upstream at the same time:

```sh
pnpm patch manychat-ai-agent@<version>
# edit the files in the directory it prints, then
pnpm patch-commit <that directory>
```

pnpm ties the patch to that exact version. When you upgrade, the install fails
with `ERR_PNPM_UNUSED_PATCH` until you delete the patch, which is the moment to
confirm the upstream fix landed. Never set `allowUnusedPatches`: it turns that
check off.

**A patch does not reach production yet.** It changes the npm package, which is
what your CI runs, but production runs the published image, which the patch
does not touch.
[Spec 033](../../specs/033-tenant-projects-not-forks.md#an-urgent-fix-is-a-pnpm-patch-and-an-upstream-pull-request-together)
records this as open. Until it is settled, a fix production needs goes out as
an upstream release.

## When the move is finished

[Spec 033](../../specs/033-tenant-projects-not-forks.md) counts the move as done
when your repository:

- has no `upstream` remote and no file content copied from this repository;
- depends on a published version and runs the image at that version in
  production;
- has tests that import only `manychat-ai-agent/config` and
  `manychat-ai-agent/testing`;
- carries no edits to upstream's `ci.yml` or `.gitignore`, because it has its
  own;
- no longer documents a sync by rebase or force-push.
