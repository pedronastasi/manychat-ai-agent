---
status: implemented
implemented: 2026-10-30
constitution: [C1, C5, C6, C7]
adr: [0014, 0028, 0029]
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

| Default, as read                                                                                                                                            | Breaks                                                                | Required                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `hideInputs`, `hideOutputs` and `hideMetadata` are off unless `LANGSMITH_HIDE_INPUTS`, `_OUTPUTS` or `_METADATA` is `"true"`                                | C1, C5                                                                | No client and no hide flag: the service projects each run itself and uploads only the projection (§ A live trace …, ADR-0029) |
| `hideOutputs: true` drops the whole output, token counts with it                                                                                            | The reason to trace: cost per step                                    | The projection keeps a model run's token counts and nothing else                                                              |
| A run's `error` is a plain string, uploaded as-is unless an `anonymizer` is set; a provider's error can echo the request                                    | C5                                                                    | The error is replaced by its class name, read before LangChain turns it into a string (§ A trace names a turn …)              |
| `omitTracedRuntimeInfo` is `false`, so each run carries the SDK, the platform and LangChain's environment variables as metadata                             | The metadata allowlist below                                          | Not sent: the projection names no runtime field                                                                               |
| `@langchain/core` awaits its callback handlers when `LANGCHAIN_CALLBACKS_BACKGROUND` is `"false"`; otherwise they run in the background                     | C7: the upload would sit inside the race                              | Boot refuses `LANGCHAIN_CALLBACKS_BACKGROUND="false"` while tracing is on                                                     |
| `maxIngestMemoryBytes` defaults to 1 GB; past it, runs are dropped                                                                                          | A trace queue can grow to a container's memory                        | The uploader's own queue holds at most 1,000 entries (`TRACE_QUEUE_LIMIT`, chosen 2026-10-30) and drops the oldest past it    |
| The client reports an upload failure with `console.error` and `console.warn`; with `LANGSMITH_FAILED_TRACES_DIR` set it writes the batch to disk for replay | C5: past the logger; § The uploader never holds a turn: never retried | The official client is not used (ADR-0029). A failure is logged through the redacting logger and dropped                      |

So the rule is not "turn on LangSmith with the hide flags". It is:

> **A live trace is built from an allowlist.** What leaves the process is a
> projection the service writes, field by field. Anything the projection does
> not name is dropped, so a new field a library adds is dropped too.

## Tracing is on only when this repository's own variable says so

`TRACE_TURNS` takes `off` (the default) or `langsmith`. With `langsmith`,
`LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` are required, and boot stops with
a message naming this spec when either is missing. `LANGSMITH_ENDPOINT` is
optional, for a workspace outside the default region.

The service builds its own uploader from those values (ADR-0029) and hands
the runner a tracer that projects into it. It never sets LangChain's global
tracing. `LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2` and their siblings still
stop boot, as `050` requires, whether or not `TRACE_TURNS` is set: the only way
to trace is through the projection.

Each tenant sets its own key and project, so traces land in a workspace the
tenant owns (ADR-0028). No key or project is committed (C1).

## A live trace carries no input and no output

For a live turn, an inbound turn or a nudge, each run is projected to:

| Field    | What is uploaded                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| inputs   | `{}`                                                                                                                  |
| outputs  | A model run's input, output and total token counts, as numbers; the `tools` node's tool names (below); otherwise `{}` |
| metadata | Only the keys in the allowlist below                                                                                  |
| error    | The error's class name, such as `AbortError`                                                                          |
| events   | None                                                                                                                  |
| name     | The run's name as the graph or LangChain sets it: a node name, a model class. Never a string from tenant config       |

The metadata allowlist:

| Key                                | Value                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `conversation`                     | The conversation's random UUID (ADR-0014)                                    |
| `turn_kind`                        | `inbound` or `nudge`                                                         |
| `langgraph_step`, `langgraph_node` | As LangGraph sets them on each node's run: the superstep and the node's name |
| `ls_provider`, `ls_model_name`     | As LangChain sets them                                                       |
| `ls_max_tokens`, `ls_temperature`  | As LangChain sets them                                                       |

`TENANT_ID` is not on the list. It is a deployment's own string and can be a
business name; the workspace already says whose traces these are.

Timings come from the run's own start and end times, which are not fields the
projection touches.

Tool names are the one exception to empty outputs. The tools node does not run
tools as LangChain runs (`050`, ADR-0027), so no run is named after a tool, and
a model run's metadata is fixed before it calls any. Instead, the `tools`
node's run output is projected to `{ tools: [...] }`: the `name` of each tool
call it handled, in order, never its arguments or result. A name is kept only
when it is a key of the tool set offered that turn, built-in or from a plugin
(`036`); any other name the model produced becomes `unknown_tool`, because a
name the model made up is model output and can carry text.

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

## One traced turn is one root run

A turn can call the model outside the graph: when a draft carries working
notes, `PromptedRunner` asks for one rewrite (`001`, C6), and
`LangGraphRunner.rewrite` invokes the model directly. Traced as it stands, that
call would be a second root run with no turn around it; left untraced, its
tokens and time would be missing from the turn's cost.

So the service opens one root run per traced turn, named `turn`, with an ID of
its own, a random UUID, and with `conversation` and `turn_kind` as its
metadata. The graph invocation and the rewrite, when there is one, run inside
it as children, so they inherit that metadata and their token counts and times
sit under the same turn. Nothing the runner does is traced outside it.

## How the turn ended is feedback added after the graph returns

The outcome cannot be metadata on any of the turn's runs. `TurnRecorder` names
it (`TurnOutcome` in `src/contracts/agent.ts`) with one `settle` call once the
runner's result is in, on the inline path and on the deferred one alike, while
a run's metadata is fixed when the run starts.

When `TurnRecorder` records an outcome for a turn whose graph ran, the service
sends LangSmith one feedback on the turn's root run: key
`outcome`, value the `TurnOutcome` value, and nothing else: no score, comment
or correction. It is sent in the background and dropped on failure, exactly as
§ The uploader never holds a turn requires. Every turn whose graph ran gets
exactly one: `superseded` is recorded instead of `answered_inline` or
`deferred` (`046`), never on top of one.

Feedback is not a run, so this call is the one upload the projection does
not build. Its value is drawn from the
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
- The queue holds at most 1,000 runs and feedbacks. Past it the oldest is
  dropped, logged once until the queue drains. One upload carries at most 100
  runs and gives up after 10 s, the bound every other outbound call outside the
  race has (`022`).
- On `SIGTERM`, shutdown sends what is queued once, after the server has
  closed, and drops what is left.

## Verification

- **The projection**: a turn is run with the LangSmith transport faked at the
  HTTP boundary. The test reads every uploaded run and asserts each field holds
  only what § A live trace carries no input and no output allows. It also
  asserts that the fixture prompt's text, a catalog item's name, the inbound
  message, the reply and a tool argument appear nowhere in the uploaded bytes.
- **Token counts survive**: in the same upload, a model run's output holds the
  counts the faked model reported.
- **Step and tools**: a turn whose faked model calls two tools, then answers,
  uploads node runs whose `langgraph_step` rises and whose `langgraph_node` is
  `model`, `tools`, `model`; the `tools` run's output is exactly the two names
  in order. A tool call whose name is not in the offered set uploads
  `unknown_tool`.
- **The opt-in**: `TRACE_TURNS=langsmith` without a key or project stops boot;
  `TRACE_TURNS` unset makes no request to the endpoint during a turn.
- **The refusals stand**: each LangChain tracing variable set to `"true"` stops
  boot with `TRACE_TURNS=langsmith` too, and `LANGCHAIN_CALLBACKS_BACKGROUND`
  set to `"false"` stops it while tracing is on.
- **Identity**: a test asserts the subscriber ID and `TENANT_ID` appear nowhere
  in the upload, and `conversation` matches the turn's row.
- **One root run**: a turn whose faked model's first draft carries working
  notes uploads exactly one root run, named `turn`; the rewrite's model run is
  its descendant, carries the same `conversation`, and its output holds the
  rewrite's token counts.
- **Outcome**: an inbound turn that answers inline sends one feedback, key
  `outcome`, value `answered_inline`, on the root run's ID the service set; a
  turn that loses the race sends `deferred` once the graph has finished; a reply
  dropped because the contact kept writing sends `superseded` and nothing else;
  a precheck escalation sends no trace and no feedback. The feedback body
  carries no field but the key, the value and the run ID.
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
- **New library fields.** The projection drops a field a new
  `@langchain/core` or LangGraph version adds to a run, and nothing uploads
  except the service's own uploader (ADR-0029). What it cannot see is a field
  it already passes starting to carry text, such as a node name or
  `ls_model_name`. The outcome feedback is the one upload the projection does
  not build, and its test pins the body. Reading the changelog of each
  `@langchain/core` and `@langchain/langgraph` update is the check.
- **Run names.** The test checks the names a turn produces today. A future
  node named from tenant config would leak through `name`; review is the
  enforcement.

The tracing rows of `050 § Defaults that change behaviour` and of `026`
changed with this implementation: the LangChain variables are still refused,
and the turn's spans are this spec's projection.
