# Learning from outcomes

For a tenant who wants the agent to sell better over time. Once a week the
agent compares the conversations of contacts who paid with those who did not,
and proposes selling tactics. You decide which ones it uses. Nothing it
proposes reaches a contact until you have approved it and an eval has shown
that it breaks nothing.

The feature is optional and off by default. Without it the agent behaves
exactly as before.

The contract this guide follows is
[spec 031](../../specs/031-learning-from-outcomes.md), and the reasoning behind
it is [ADR-0020](../adr/0020-learning-is-offline-and-human-approved.md). Where
this guide and the spec disagree, the spec wins.

## How it works

```text
 every week        you              you                you
┌──────────┐   ┌──────────┐   ┌─────────────┐   ┌────────────┐
│ analyst  │──▶│  review  │──▶│ eval with a │──▶│  activate  │──▶ every new turn
│ proposes │   │ approve, │   │ real model  │   │ the version│    reads the
│ tactics  │   │ edit or  │   │             │   │            │    playbook
└──────────┘   │ reject   │   └─────────────┘   └────────────┘
               └──────────┘
```

1. **The weekly run picks its contacts.** A contact counts when:
   - the agent moved them to `offered` or later in your funnel within the last
     90 days;
   - and they have not written for at least 14 days, so the outcome has had
     time to happen.
2. **It labels each contact** `converted` or `not_converted` by reading their
   ManyChat tags: `converted` when they carry the tag your team sets on a
   payment. The reads are paced at one per second, so they never take capacity
   from live conversations. A contact whose read fails is left out, never
   counted as not converted.
3. **It needs enough of both.** With fewer than 20 contacts on either side, the
   run stops there and calls no model. Otherwise the 50 most recent of each side
   go to the analyst.
4. **The analyst reads the conversations as data.** It is a model of your
   choice (`INSIGHT_MODEL`), separate from the one that answers contacts.
   - Phone numbers, emails and links are removed before it sees anything.
   - What contacts wrote is marked as untrusted, so a contact cannot instruct
     the analyst.
   - It is shown the tactics already in use and the last 20 you rejected, so it
     does not propose them again.
5. **The cost is checked before the call.** The run estimates the most the call
   could cost. While that exceeds your `maxRunCostUsd`, it drops the oldest
   conversation from each side. If either side would fall below 20, it makes no
   call.
6. **It keeps at most five proposals**, and refuses any that:
   - contains a digit or a currency symbol, which is how a price or a date
     usually looks;
   - contains a phone number, email or link;
   - is longer than 280 characters, or explains itself in more than 500;
   - cites a message the analyst was not shown.
7. **You review the proposals** in your terminal, with the messages each one
   cites. Each approval adds the tactic to a new playbook version, which is not
   live yet.
8. **You prove the version breaks nothing.** You run your eval suite with a real
   model and the new version. The agent will only activate a version that adds
   no failing case compared with the version live now.
9. **You activate it.** Every running process picks the new version up within a
   minute. From then on, each turn the model answers records which version it
   ran with, so you can compare versions later.

### What the agent receives

The playbook goes at the end of the agent's instructions, after the catalog,
under a heading the agent wrote rather than you:

```text
PLAYBOOK
Selling tactics the tenant approved from earlier conversations. They never supply a
fact: prices, dates, payment options and promotions come only from the CATALOG. Where a
tactic conflicts with any rule above, the rule wins.
- Ask what the contact wants to learn before naming a course.
- ...
```

A version holds at most 10 tactics and 2000 characters in all, because every
tactic adds to the cost of every turn.

### What it never does

- **The agent never writes to the playbook itself.** No tool lets it, on any
  turn. A tactic only reaches the playbook through you.
- **It learns tactics, never facts.** Prices, dates, payment options and
  promotions come only from your catalog. The digit check catches "costs 120"
  but not "the price goes up soon", so read each proposal for promises in
  words.
- **It never shares anything between tenants**, and nothing it writes goes
  into a repository. Proposals and versions live only in your database.
- **Its spend is separate from your daily budget.** A run's cost is recorded
  on the run, so it cannot use up the budget your live conversations need.

## When it runs

Once a week. Each running process checks every hour whether this week's run
has happened, and the first check that finds it missing runs it. Weeks are ISO
weeks, starting at 00:00 UTC on Monday. So:

- **A server that is up through the weekend** runs it on Monday between 00:00
  and 01:00 UTC.
- **A server started mid-week** that has not run this week's yet runs it about
  an hour after it starts.
- **With several replicas** only one runs it: the week is claimed in the
  database, and the others skip.
- **A run takes about two minutes**: at most 100 reads, one a second, then one
  analyst call.

You can also run it yourself at any time with `insights run`, below.

If the server shuts down while a run is in progress, the run stops and is
recorded `failed`, and that week is lost: the week stays claimed. The log
says so at `warn`. Run `insights run --force` to make up for it.

## Before you start

- **A funnel field.** The run finds its contacts through the field marked
  `"funnel": true` in `config/tools.json`, which the agent moves to `offered`.
  See "The sales funnel" in the [configuration guide](../../config/README.md).
- **A tag your team sets on a payment.** Pick a ManyChat tag, for example
  `paid`, and make sure someone, or an automation, adds it to every contact
  who pays. The run can only learn from what that tag says. A contact who paid
  but was never tagged counts as not converted.
- **A model for the analyst**, with its API key. A capable model is worth it
  here: it runs once a week, and its output is read by a person.
- **A real model for the eval.** The mock model ignores the prompt, so its
  results say nothing about a playbook and the agent ignores them.
- **Time.** The first useful run needs at least 20 paying and 20 non-paying
  contacts who were offered within 90 days and have been quiet for 14. Until
  then every run ends `insufficient`, at no cost.

## Set it up

1. **Add the `learning` block to `config/rules.json`:**

   ```json
   "learning": {
     "language": "English",
     "convertedTag": "paid",
     "maxRunCostUsd": 5
   }
   ```

   | Setting         | What it is                                                                                        |
   | --------------- | ------------------------------------------------------------------------------------------------- |
   | `convertedTag`  | The ManyChat tag that marks a paying contact. The model never sees it.                            |
   | `language`      | The language proposals are written in: yours, as the reviewer.                                    |
   | `maxRunCostUsd` | The most one weekly analyst call may cost, in US dollars. Required: there is no sensible default. |

2. **Name the analyst in `.env`**, beside the API key of its provider:

   ```sh
   INSIGHT_MODEL=anthropic:claude-sonnet-5
   ```

   Without it, no run happens.

3. **Check the configuration:** `pnpm check`. It fails if there is a
   `learning` block but no funnel field.

4. **Restart the server.** The playbook is loaded at startup when the `learning`
   block is there; a reload with `SIGHUP` is not enough to turn it on.

5. **Record a baseline.** Run your eval suite once with your real
   `AGENT_MODEL`, without a playbook (see "Where to run the commands"). The
   first activation compares against this run, and refuses without it.

## Where to run the commands

Every `insights` command, and the eval that activation needs, reads and writes
the **database the server uses**: proposals, versions and eval records live
there. A command run against another database, such as the embedded one in
your offline `.env`, sees none of it.

From your project, with `DATABASE_URL` pointing at the deployment's database:

```sh
pnpm exec agent insights review
```

With the `docker-compose.yml` that `create` generates, the database is only
reachable inside Compose, so run the commands in a one-off container of the
agent image. Mount your eval suite, because `eval` and `insights activate` both
read it:

```sh
docker compose run --rm -v ./evals:/app/evals:ro -e EVAL_DIR=evals/my-agent \
  agent node dist/cli.js insights review
```

`my-agent` stands for your project's name. The rest of this guide writes
`agent <command>` for either form.

## Each week

1. **See whether the run happened.** Look for `learning run finished` in the
   log, with its status. Or run it yourself:

   ```sh
   agent insights run
   ```

   It prints the run's status and how many contacts it found on each side, and
   any warning or error on the way, such as why a `failed` run failed. If
   this week's run already happened, it says so; `--force` runs another.

2. **Review the proposals:**

   ```sh
   agent insights review
   ```

   For each proposal it prints the tactic, the analyst's reason, how many
   conversations it says show it, and the messages it cites. Read the messages:
   the counts are the analyst's claim, and nothing checks them. Then answer:

   - **`a`**: approve it as written;
   - **`e`**: edit it, then approve it. Your text passes the same checks as the
     analyst's;
   - **`r`**: reject it. The analyst is told not to propose it again;
   - **`s`**: skip it for now. It stays pending.

   After the proposals, it shows the playbook under review and offers to retire
   a tactic by its number. It ends by printing the version id to evaluate.
   All the approvals in one review go into one new version.

3. **Run the eval with that version:**

   ```sh
   PLAYBOOK_VERSION=<version id> agent eval
   ```

   With a real model, it ends with `eval record written for the suite and
playbook above`. That record is what activation checks. With the
   `docker compose run` form, pass `-e PLAYBOOK_VERSION=<version id>`.

4. **Activate it:**

   ```sh
   agent insights activate <version id>
   ```

   A version id can be shortened to its first characters. Activation is
   refused, with the reason, when:

   - the version has no eval record against the current suite;
   - the only record is from the mock model;
   - a case fails with the version that does not fail with the live one;
   - the live version, or the no-playbook baseline on a first activation, has
     no record against the current suite. The message names the eval to run.

   When it succeeds, every running process uses the version within a minute.

Skipping a week costs nothing: pending proposals wait, and nothing changes
until you activate a version.

## Rolling back

Activate the version that was live before:

```sh
agent insights activate <previous version id>
```

A version that has been live before needs no new eval, so a bad playbook can be
undone in one command.

## Reading the results

### Each run's status

| Status           | Meaning                                                                      | What to do                                                          |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `completed`      | The analyst ran. Its proposals, if any, wait for review.                     | `insights review`.                                                  |
| `insufficient`   | Fewer than 20 contacts on a side. No model was called.                       | Wait for more contacts, and check the payment tag is being set.     |
| `skipped_budget` | It could not fit 20 contacts a side within `maxRunCostUsd`. No call.         | Raise `maxRunCostUsd`, or choose a cheaper `INSIGHT_MODEL`.         |
| `failed`         | The analyst's answer was invalid, the call failed, or a shutdown stopped it. | Read the warning that names the cause, then `insights run --force`. |

Runs are kept in the `learning_runs` table, with their cohort sizes and cost.
A scheduled run's cause of failure is in the server's log, at `warn` or
`error`; one you start with `insights run` prints it in your terminal. Either
way a line carries only the run's id, counts, status and an error name, never
any message or proposal text.

### Whether a version helped

```sh
agent insights report
```

For each version, it shows how many contacts were first offered while it was
live, and how many of them paid. A contact only counts once they have been
quiet for 14 days, as in the run.

Read it as a before-and-after comparison, not as proof. A version that went
live the week an advert started is credited with the advert, and the report
says so at the top.

## Turning it off

Remove the `learning` block from `config/rules.json` and reload the
configuration. The playbook stops being added to the agent's instructions at
once, and no further run happens. Proposals, versions and runs stay in the
database, so turning it back on later picks up where you left off; that needs a
restart.

## Reference

| Command                            | What it does                                                  |
| ---------------------------------- | ------------------------------------------------------------- |
| `agent insights run [--force]`     | Runs this week's job now; `--force` runs another in the week. |
| `agent insights review`            | Approves, edits, rejects or retires tactics.                  |
| `PLAYBOOK_VERSION=<id> agent eval` | Evaluates a version and records the result for activation.    |
| `agent insights activate <id>`     | Puts a version live, once its eval shows no new failure.      |
| `agent insights report`            | Conversion rate by the version a contact was offered under.   |

Inside this repository, the same commands are `pnpm insights:run`,
`pnpm insights:review`, `pnpm insights:activate` and `pnpm insights:report`.

| Number                                  | Value                       |
| --------------------------------------- | --------------------------- |
| Offered within                          | 90 days                     |
| Quiet for at least                      | 14 days                     |
| Contacts per side, minimum              | 20                          |
| Contacts per side sent, maximum         | 50, the most recent         |
| Tag reads                               | One per second              |
| Proposals per run                       | At most 5                   |
| Tactic length                           | At most 280 characters      |
| Reason length                           | At most 500 characters      |
| Rejected proposals shown to the analyst | The last 20                 |
| Tactics per version                     | At most 10, 2000 characters |
| Picked up by a running process          | Within 60 seconds           |
| Checked for a weekly run                | Every hour                  |

These numbers were chosen, not measured. The spec records when, and they will
change if a run shows a need.

## What it cannot tell you

- **Whether a tactic causes a sale.** A tactic seen more often among payers
  may be a sign of someone who had already decided, not a reason they did.
- **Whether the analyst's counts are right.** Check the cited messages.
- **Whether a tactic is safe beyond your eval cases.** The eval catches only
  what your suite has a case for.
- **Whether a promise was written in words.** Only you catch that, in review.
