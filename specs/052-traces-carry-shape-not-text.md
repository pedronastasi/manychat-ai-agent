---
status: specified
constitution: [C1, C5, C6, C7]
adr: [0014, 0028]
---

# 052 — Traces Carry Shape, Not Text

Defines what a LangSmith trace of a turn may contain, when tracing is on, and
how the uploader stays out of the turn's way (ADR-0028). It deliberately leaves
out the eval judge, transcription and the learning analyst, which run on the AI
SDK and are not traced; dashboards and alerting; any other tracing vendor; and
the Python code, which follows the same rules in its own repository (ADR-0025).

## Setting LangChain's tracing variable is the leak this spec forbids

The reflexive setup is the one LangSmith documents: set `LANGSMITH_TRACING=true`
and an API key, and every run is uploaded. Every run's inputs are the tenant's
system prompt and catalog plus the contact's fenced messages; every model run's
outputs are the reply and the tool calls, arguments included. That is C1's
tenant data and C5's PII, sent to a vendor by one environment variable.

The library's own switches do not repair it. Read on 2026-10-29 from the
installed `langsmith` 0.11.0 and `@langchain/core` 1.3.0:

| Default, as read                                                                                                                        | Breaks                                         | Required                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `hideInputs`, `hideOutputs` and `hideMetadata` are off unless `LANGSMITH_HIDE_INPUTS`, `_OUTPUTS` or `_METADATA` is `"true"`            | C1, C5                                         | Each is set on the client as a function, never left to the environment (§ A live trace …) |
| `hideOutputs: true` drops the whole output, token counts with it                                                                        | The reason to trace: cost per step             | The output function keeps the token counts and nothing else                               |
| A run's `error` is a plain string, uploaded as-is unless an `anonymizer` is set; a provider's error can echo the request                | C5                                             | The error is replaced by the error's class name (§ A trace names a turn …)                |
| `omitTracedRuntimeInfo` is `false`, so each run carries the SDK, the platform and LangChain's environment variables as metadata         | The metadata allowlist below                   | Set to `true`                                                                             |
| `@langchain/core` awaits its callback handlers when `LANGCHAIN_CALLBACKS_BACKGROUND` is `"false"`; otherwise they run in the background | C7: the upload would sit inside the race       | Boot refuses `LANGCHAIN_CALLBACKS_BACKGROUND="false"` while tracing is on                 |
| `maxIngestMemoryBytes` defaults to 1 GB; past it, runs are dropped                                                                      | A trace queue can grow to a container's memory | Set explicitly; the value is chosen and recorded here when this spec is implemented       |

So the rule is not "turn on LangSmith with the hide flags". It is:

> **A live trace is built from an allowlist.** What leaves the process is a
> projection the service writes, field by field. Anything the projection does
> not name is dropped, so a new field a library adds is dropped too.

## Tracing is on only when this repository's own variable says so

`TRACE_TURNS` takes `off` (the default) or `langsmith`. With `langsmith`,
`LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` are required, and boot stops with
a message naming this spec when either is missing. `LANGSMITH_ENDPOINT` is
optional, for a workspace outside the default region.

The service builds its own LangSmith client from those values and hands the
runner a tracer for that client. It never sets LangChain's global tracing.
`LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2` and their siblings still stop boot,
as `050` requires, whether or not `TRACE_TURNS` is set: the only way to trace is
through the projection.

Each tenant sets its own key and project, so traces land in a workspace the
tenant owns (ADR-0028). No key or project is committed (C1).

## A live trace carries no input and no output

For a live turn, an inbound turn or a nudge, the client's functions are:

| Field    | What is uploaded                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| inputs   | `{}`                                                                                                            |
| outputs  | The run's input, output and total token counts, as numbers, when the run reports them; otherwise `{}`           |
| metadata | Only the keys in the allowlist below                                                                            |
| error    | The error's class name, such as `AbortError`                                                                    |
| events   | None                                                                                                            |
| name     | The run's name as the graph or LangChain sets it: a node name, a model class. Never a string from tenant config |

The metadata allowlist:

| Key                               | Value                                                                      |
| --------------------------------- | -------------------------------------------------------------------------- |
| `conversation`                    | The conversation's random UUID (ADR-0014)                                  |
| `turn_kind`                       | `inbound` or `nudge`                                                       |
| `step`                            | The graph's step counter (`012`)                                           |
| `tools`                           | The names of the tools the step called, as declared, never their arguments |
| `ls_provider`, `ls_model_name`    | As LangChain sets them                                                     |
| `ls_max_tokens`, `ls_temperature` | As LangChain sets them                                                     |

`TENANT_ID` is not on the list. It is a deployment's own string and can be a
business name; the workspace already says whose traces these are.

Timings come from the run's own start and end times, which are not fields the
projection touches.

## A trace names a turn by its conversation ID and an error by its class

The subscriber ID, the contact token, the channel's user ID and anything
derived from them never reach a trace, as they never reach a log (ADR-0014).
The error message is dropped because the C5 redaction runs in the logger, and
the uploader never passes through the logger.

## Eval runs on the fixture tenant are the only traces with text

`pnpm eval` and `pnpm eval:conversations` trace with inputs and outputs in full
when, and only when, `CONFIG_DIR` resolves to `test/fixtures/config` and
`EVAL_DIR` resolves to `evals/golden`. Every string there is invented
(CLAUDE.md § Testing conventions), so nothing a contact or a tenant wrote can
be in it.

Any other combination, such as a tenant's own suite (`009`) or the golden set
pointed at a tenant's `config/`, is traced with the live projection above. The
check is on resolved paths, not on a flag, so no variable can mark a tenant's
config as invented. The server never traces with text, whatever its config.

## How the turn ended is feedback added after the graph returns

The outcome cannot be metadata on the graph's runs. `TurnRecorder` names it
(`TurnOutcome` in `src/contracts/agent.ts`) with one `settle` call once the
graph's result is in, on the inline path and on the deferred one alike, while
the root run's metadata is fixed when the graph is invoked.

So the service gives the graph's root run an ID of its own, a random UUID, in
the invocation's `runId`. When `TurnRecorder` records an outcome for a turn
whose graph ran, the service sends LangSmith one feedback on that run: key
`outcome`, value the `TurnOutcome` value, and nothing else: no score, comment
or correction. It is sent in the background and dropped on failure, exactly as
§ The uploader never holds a turn requires. Every turn whose graph ran gets
exactly one: `superseded` is recorded instead of `answered_inline` or
`deferred` (`046`), never on top of one.

Feedback does not pass through the client's hide functions, so this call is
the one upload the projection does not cover. Its value is drawn from the
`TurnOutcome` enum, which holds no text from a contact or a tenant.

A turn that never runs the graph (`answered_scripted`, `escalated_precheck`,
`media_fallback`, `folded`) has no trace and no feedback.

## The uploader never holds a turn

- The tracer runs as a background callback. Nothing in `TurnHandler`,
  `ReplyDelivery` or `DeferredSettlement` awaits it, and the race (ADR-0001)
  settles the same with tracing on or off.
- An upload that fails is logged once, through the redacting logger, with the
  error's class and status code, and dropped. It is never retried into a later
  turn and never changes a reply or how a turn is recorded (C6).
- On `SIGTERM`, shutdown waits for pending batches within the time the existing
  shutdown already allows, and drops what is left.

## Verification

- **The projection**: a turn is run with the LangSmith transport faked at the
  HTTP boundary. The test reads every uploaded run and asserts each field holds
  only what § A live trace carries no input and no output allows. It also
  asserts that the fixture prompt's text, a catalog item's name, the inbound
  message, the reply and a tool argument appear nowhere in the uploaded bytes.
- **Token counts survive**: in the same upload, a model run's output holds the
  counts the faked model reported.
- **The opt-in**: `TRACE_TURNS=langsmith` without a key or project stops boot;
  `TRACE_TURNS` unset makes no request to the endpoint during a turn.
- **The refusals stand**: each LangChain tracing variable set to `"true"` stops
  boot with `TRACE_TURNS=langsmith` too, and `LANGCHAIN_CALLBACKS_BACKGROUND`
  set to `"false"` stops it while tracing is on.
- **Identity**: a test asserts the subscriber ID and `TENANT_ID` appear nowhere
  in the upload, and `conversation` matches the turn's row.
- **Outcome**: an inbound turn that answers inline sends one feedback, key
  `outcome`, value `answered_inline`, on the run ID the service set; a turn
  that loses the race sends `deferred` once the graph has finished; a reply
  dropped because the contact kept writing sends `superseded` and nothing
  else; a precheck escalation sends no trace and no feedback. The feedback
  body carries no field but the key, the value and the run ID.
- **Errors**: a turn whose model throws an error with a sentence in its message
  uploads the class name and not the sentence.
- **Eval scope**: the fixture tenant on the golden set uploads full inputs; the
  golden set with `CONFIG_DIR` set to a copy of the fixture tenant in another
  directory uploads the live projection.
- **The race**: a faked endpoint that never answers, and one that answers 500,
  leave the reply's text and its time within the bounds an untraced run of the
  same turn meets.

What this misses:

- **Strings the tests do not know.** The byte search looks for the fixture's
  own strings. A field the projection lets through that carries some other
  text would pass. The allowlist is the real defence, and review of any change
  to it is the enforcement.
- **The workspace.** Nothing in code can tell a tenant's own workspace from a
  shared one. Deployment documentation says it; nothing checks it.
- **New library fields.** An allowlist drops a field a new version adds, but a
  new path that uploads without going through the client's functions, such as
  an attachment call, would not be caught. The service's own outcome feedback
  is the one such path, and its test pins the body. Reading the changelog of
  each `langsmith` and `@langchain/core` update is the check.
- **Run names.** The test checks the names a turn produces today. A future
  node named from tenant config would leak through `name`; review is the
  enforcement.

When this is implemented, the tracing row of `050 § Defaults that change
behaviour` and of `026` change in the same pull request: the LangChain
variables are still refused, and the turn's spans are this spec's projection.
