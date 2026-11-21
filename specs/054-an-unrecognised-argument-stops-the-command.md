---
status: specified
constitution: [C1, C6, C8]
---

# 054 — An Unrecognised Argument Stops the Command

Defines how `agent` reads its command line: an argument it does not recognise
ends the run before any work begins, and `--help` is answered rather than
executed. It deliberately leaves out which flags each command takes — each
command's own spec owns its vocabulary ([`009`](009-tenant-eval-suites.md),
[`043`](043-complete-conversation-evals.md)) — and the wording of the usage
text.

## Ignoring an unknown argument is the reflexive parse, and here it bills for the privilege

The obvious way to dispatch a subcommand is to look at the first argument, match
it against a table, and hand the rest to the command. `src/cli/run.ts` does
exactly that:

```ts
function command(args: string[]): string | undefined {
  const two = args.slice(0, 2).join(' ');
  if (two in COMMANDS) return two;
  if (args[0] !== undefined && args[0] in COMMANDS) return args[0];
  return undefined;
}
```

Every argument after the matched name is discarded unless the command asks for
it, and `eval` does not ask: `runEval()` takes no parameters. So
`agent eval --help` is read as "run the eval suite". It does not print usage. It
loads the tenant config, calls the configured model once per case, and bills the
account — against a suite of any size, at whatever the provider charges.

That is not a hypothetical. It happened on 2026-11-21 while someone was looking
for the flag list, and the run was only stopped by closing the pipe.

A parse that silently accepts anything is not permissive, it is lossy. The
operator typed something to change what would happen; the CLI threw it away and
did the expensive thing anyway. Nothing in the output says an argument was
ignored, so the first evidence is the bill.

## `--help` is a question, not a command

A help flag anywhere in the arguments stops dispatch. The CLI prints the usage
that `usage()` already builds from `COMMANDS` and exits **0**: the operator
asked a question and got an answer, so this is not a failure.

`agent --help`, `agent eval --help` and `agent insights activate -h` all print
the same usage and run nothing. The flag does not have to come first, because
the operator reaching for it has already typed the command name — that is
precisely the moment they want to know what it accepts.

An argument the CLI does not recognise is the other case, and exits **2**. The
distinction is for CI: a script that runs `agent eval --help` expecting a help
text has a bug either way, but only a non-zero exit fails the build. A help
request that exited 2 would make `agent --help` unusable in any `set -e` script,
and an unrecognised flag that exited 0 would let a typo pass review.

## The commands that would do damage are the ones that take arguments

If this were only about `eval` it would be a bug, not a spec. The table in
`COMMANDS` is a list of operations that change things:

| Command             | What a discarded argument buys you                  |
| ------------------- | --------------------------------------------------- |
| `eval`              | A paid model call per case, against the whole suite |
| `upgrade`           | `config/` and every eval suite rewritten in place   |
| `tokens backfill`   | A token issued to every existing contact            |
| `insights activate` | A playbook version put live                         |
| `serve` / `worker`  | A process started against whatever config resolved  |

Each of these is reached by name alone. `agent upgrade --dry-run`, which does
not exist, runs the real migration today — the flag is dropped and the command
proceeds. C6 requires failing closed toward a human, and a command line is the
one place where the human is already present and typing: refusing an argument
costs them one line of output, and accepting it silently costs them a migration
they did not intend.

C6 is written about the agent at runtime — uncertainty in a conversation
escalating to a person rather than being guessed at. This spec claims the clause
by analogy, not by letter: the subject is an operator rather than a customer,
and the uncertainty is about what they typed rather than what they asked. The
principle transfers exactly, and the resolution is easier here, because the
human the clause wants consulted is already at the keyboard. Fail closed means
the command does not start.

## Each command's own spec owns its flags

054 governs the parse, not the vocabulary. Which flags a command accepts is
defined by the spec that owns the command: `043` defines
`agent eval conversations --validate` and `--gate`, and
[`055`](055-a-run-can-name-the-cases-it-wants.md) defines the eval case filter.
A new flag is specified there, and this spec requires only that anything outside
that vocabulary stops the run.

Keeping it that way is deliberate. A central registry of every flag in the CLI
would have to be edited by every spec that adds one, and would drift from the
commands it claims to describe. The parse needs to know only whether the command
recognised what it was given.

## An error names what was rejected and nothing else

The error prints the argument the operator typed, and the usage text. It does
not enumerate what would have been valid instead.

For most commands that is merely terse. For `eval` it is C1. The valid values
for the case filter are the ids in the tenant's own `cases.jsonl`, and those ids
describe a real business: `price-foundation`, `objection-too-expensive`,
`payment-by-transfer`. A "did you mean…?" that lists them prints tenant data to
the terminal, and in CI into a build log that outlives the run and is readable by
anyone with repository access. `009` already argues that a tenant's cases are
tenant configuration in everything but file extension; their ids are the index
of that configuration.

So the helpful affordance is refused on purpose. The operator has the suite in
front of them and can read it; the CI log must not.

## Verification

- A unit test calls the dispatcher with `--help` in each position —
  `['--help']`, `['eval', '--help']`, `['insights', 'activate', '-h']` — and
  asserts usage is printed, the exit code is 0, and no command function is
  invoked. The last assertion is the one that matters: a test that only checked
  the output would pass against a CLI that printed usage _and_ ran the eval.
- A unit test asserts an unrecognised argument on a known command exits 2
  without invoking the command.
- A unit test asserts the error text contains the rejected argument and does not
  contain any case id from the suite it was run against.
- `agent` with no arguments continues to print usage and exit 2, unchanged.

**What this does not prove.** The tests cover the dispatcher, not each command's
own parsing. A command that accepts an argument and then misreads it is outside
this spec — `009` and `043` own that for their own flags. Nor does this catch an
argument that is valid for one command and meaningless for another: `agent serve
--validate` is recognised vocabulary somewhere in the CLI, and whether `serve`
rejects it depends on `serve` declaring what it takes. The guard is only as tight
as each command's declared vocabulary, and today most commands declare none.
