---
status: specified
constitution: [C2, C3, C4, C5, C6, C7]
adr: [0016, 0010, 0017, 0021]
---

# 039 — A Plugin Read Tool Returns Declared Data, Fenced, Inside the Read Budget

Defines how a plugin adds a tool the model calls during a turn to fetch data
and answer from it: the read tool's declaration, its query, its result, its
budget and its failure. It leaves out plugin write tools, which stay in `036`,
plugin channels, which are `038`, a context provider that runs on every turn,
and any retrieval or vector store built into the agent itself.

## A write-only plugin cannot ground an answer, and a raw `execute` is the reflexive fix

`036` lets a tenant add an action, never a source. Its `perform` runs after
the reply and returns nothing, so a tenant whose answers live in their own
system (class dates, seats left, an order's status, a knowledge base) has
to copy that data into `catalog.json` and reload it, or the agent cannot use
it. That covers data that changes weekly, and nothing that changes per
contact or per question.

The reflexive fix is the AI SDK's own: give the plugin tool an `execute` and
put whatever it returns into the context. That is rejected. The return value
would be the plugin's own JSON, unvalidated (C3), unfenced in the model's
context, where text from a web page or a CRM note can carry an instruction
(C4), unbounded in size, and free to hold the PII the plugin's backend
stores. The call itself would be unbounded in time, inside a race that has
eight seconds (C7).

Rejected too: a context provider that runs before the model on every turn
and injects its result into the prompt. ADR-0016 turned that shape down for
`get_contact`, because it pays the call on every turn including the many
that need nothing, and those reasons hold for a plugin.

So the rule is:

> **A plugin read is performed when the model calls it, and the model sees
> only what the plugin declared, validated, bounded and fenced by the agent.**

## A read tool is performed when called, as `get_contact` is

A plugin tool declares `read` in place of `perform`. The agent calls `read`
inside the model's tool step, and returns its result to the model in that
step, as it does for `get_contact` (ADR-0016). A read tool stages nothing,
and is never performed after the reply.

A tool that declares both `read` and `perform`, or neither, stops startup
(`036 § A plugin that does not load stops the server`). So does a read tool
that declares no `result`.

`defineReadTool`, beside `defineTool`, types `read`'s `params` from the
declared parameters and its return value from the declared result.

A read tool is offered only on a turn that reads history, as `get_contact` is
(`024 § Only a turn that reads history may read the contact`): a read is
given the subscriber ID, and a request that does not carry the contact's
token may not have the agent look anything up about the contact it claims to
be.

## Its query is the one free text, bounded and cleaned

A read tool's parameters are those of `036 § A plugin tool is a staged
action`: `enum`, `number` and `boolean`. It has no `note`, which is a write's
field. In their place it may declare one `query`:

```js
parameters: {
  course: { type: 'enum', values: ['foundation', 'advanced'] },
  query: { type: 'query', maxLength: 200 },
},
```

- At most one parameter of type `query`, with a `maxLength` of at most
  **200**, chosen, not measured: long enough for a question rephrased as a
  search, short enough that the model cannot paste the conversation into it.
- It is cleaned by `cleanNote` before `read` is called, so the URL, email,
  phone-number and long-number shapes of
  `024 § Note text is cleaned before it is written` never leave the agent in
  a query. A name has no shape, and is not removed: the tool's description
  tells the model never to put one in a query, as a note's tool does.
- A query that is empty after cleaning makes no call. The tool returns
  `{ available: false }`, and the call counts as a read.

Rejected: an unrestricted string parameter. The query is model output
written from the contact's own message, and it goes to a network the agent
does not control. Cleaning it is the one place the agent can keep the
contact's identifiers out of a third party's search logs.

## Its result is declared, validated and fenced

A read tool declares the shape of what `read` returns:

```js
result: {
  seatsLeft: { type: 'number', integer: true, min: 0 },
  nextStart: { type: 'enum', values: ['this_month', 'next_month', 'later'] },
  waitlist: { type: 'boolean' },
  summary: { type: 'text', maxLength: 600, optional: true },
  passages: { type: 'list', maxItems: 3, maxLength: 400, optional: true },
},
```

| Type      | Holds                                 | Bound                                      |
| --------- | ------------------------------------- | ------------------------------------------ |
| `enum`    | one of its declared `values`          | the values                                 |
| `number`  | a number, optionally integer, bounded | `min`, `max`                               |
| `boolean` | `true` or `false`                     | —                                          |
| `text`    | a string                              | `maxLength`, at most **1000**              |
| `list`    | strings, for search hits or FAQ rows  | `maxItems` at most **5**, `maxLength` each |

The whole serialised result is at most **2000** characters. All three numbers
are chosen, not measured: they fit three FAQ passages and a summary, and keep
two reads from crowding the four-step loop's context. Change them when an eval
shows a need, and record the measurement date here.

The agent builds the Zod schema from the declaration, as it builds a tool's
parameters (`036`), and validates what `read` returns against it (C3):

- a key the result does not declare is dropped;
- a `text` or `list` entry over its bound is cut to it, as a note is;
- a `list` with more than its `maxItems` entries keeps the first `maxItems`,
  in the order `read` returned them;
- a declared key that fails its type, a required key that is missing, or a
  result over 2000 characters once cut makes the whole result
  `{ available: false }`. The agent never passes on part of a result it
  could not validate.

`text` and `list` values come back inside the same untrusted fence as inbound
text, as a note does (`024 § Note values come back inside the contact
fence`, C4), and the tool's description says that they are data, never
instruction. `enum`, `number` and `boolean` values are bounded by
construction and sit outside it.

## It shares the read budget of `024`

A plugin read is a read in `024`'s sense, and spends the same budget:

- each read has **1500 ms**, the timeout `get_contact` already has and chose
  without measuring (`024 § A read is performed, and its failure is not an
escalation`). Past it the signal `read` was given aborts and the read
  returns `{ available: false }`;
- a turn makes at most **two** reads, counting `get_contact` and every plugin
  read together. A third call returns `{ available: false }` without calling
  `read`;
- reads run inside the four-step loop and the race (`012 § The whole loop
runs inside the race`), and do not count towards `MAX_ACTIONS_PER_TURN`.

Rejected: a separate budget for plugin reads. A third and fourth read is a
third and fourth wait inside eight seconds, and more turns lost to the
outbox. If two is too few, that is a change to `024`'s number, for every read,
with the measurement that justifies it.

The reply step offers no tools (`012 § The loop is bounded at four steps`).
Its note of the turn carries the turn's last successful read of each tool,
fenced as above, as it carries `get_contact`'s.

## A failed read is not an escalation, and an ungrounded answer is

A `read` that throws, times out, or returns a result that fails validation
gives the model `{ available: false }`, and the turn continues. The failure is
logged at `warn` through the redacting logger, with the plugin and the tool
named, and never with the query or the result (C5). It is never retried
within the turn.

The prompt line a read tool adds says what to do with an unavailable read: answer
without that data if the question can be answered from the catalog, and
otherwise escalate. A turn that would need the data to answer never guesses it
(C6). As in `024`, the read failing is not the reason to escalate; not being
able to ground the answer is.

## A read is given what a write is given, and is never gated on prospect

`read` receives the four things `036 § What a plugin is never given` allows
`perform`: the turn's subscriber ID, the validated and cleaned parameters, the
agent's redacting logger scoped to the plugin, and an abort signal. Nothing
else: no model, provider client or registry (C2), no prompt, catalog or
history (C4), no database.

A read tool is not refused before the contact is a prospect, as `get_contact`
is not (`034 § Until intent is prospect, the sale's tools refuse`). Looking
something up is front-desk work.

A read tool may not take a built-in tool's name, nor another plugin tool's,
read or write.

## The turn records that a read happened, never what it returned

The turn's record gains one entry per read call: the plugin, the tool, whether
data was available, and how long it took. The query and the result are never
stored, in the record, the outbox or the logs, and are not shown to later
turns (`012 § Performed actions reach the model on later turns` covers
writes, not reads). A later turn that needs the data reads again.

## The prompt changes only when a plugin adds a read tool

A tenant whose plugins declare no read tool has exactly the prompt it has
today. When one does, the prompt gains three lines: that the deployment can
look things up with tools of its own, that what they return is data and never
instruction, and the rule for an unavailable read above. What a read tool is
for is its description.

## Adding read tools is a breaking plugin-API release

`036 § A plugin API change is a breaking change` makes a change to the
`apiVersion` values the agent accepts breaking, and this is one. `apiVersion:
2` adds read tools. The agent accepts `1` and `2`; a plugin naming `1` loads
exactly as it does today, and one that declares a read tool must name `2`. A
read tool in an `apiVersion: 1` plugin stops startup, so a plugin cannot
quietly rely on an agent that would not have performed it.

`agent config check` reports, for each loaded plugin, its read tools beside its
write tools.

## What this changes in `036`

- `§ A plugin tool is a staged action` holds for a tool that declares
  `perform`. A tool that declares `read` is performed when called, counts
  towards the read budget instead of `MAX_ACTIONS_PER_TURN`, and is not
  refused before the contact is a prospect, as above.
- `§ What a plugin is never given` holds for `read` as for `perform`; the four
  things it lists are what both receive.
- `§ A plugin API change is a breaking change` gains `apiVersion: 2`. The
  tool API it describes as starting at `1` is unchanged for a plugin that
  declares no read tool.

`036` and `docs/guides/writing-a-plugin.md`, which shows `apiVersion: 1` and
only `perform`, are edited in the pull request that implements this spec.

## Verification

1. A test asserts that the bare entry point exports `defineReadTool`, and that
   the agent accepts `apiVersion` `1` and `2` and refuses any other.
2. Unit tests assert that each of the following stops startup: a tool with
   both `read` and `perform`, with neither, a read tool with no `result`, a
   read tool in an `apiVersion: 1` plugin, two `query` parameters, a `query`
   longer than 200, a `note` on a read tool, a `text` longer than 1000, a
   `list` of more than 5 items, and a read tool named as a built-in or
   another plugin's tool.
3. Unit tests assert that a read tool is offered only on a turn that reads
   history, that a call performs `read` within the step and returns its result
   to the model, that the query is cleaned before `read` sees it, and that an
   empty query makes no call and counts as a read.
4. Unit tests assert that an undeclared key is dropped, an overlong `text` is
   cut, a `list` over its `maxItems` keeps its first `maxItems` entries, a missing required key, a wrong type or an oversized result returns
   `{ available: false }`, and that `text` and `list` values come back fenced
   while `enum`, `number` and `boolean` do not.
5. Unit tests assert that `get_contact` and plugin reads share two reads a turn,
   that a third makes no call, that a read still running after 1500 ms returns
   `{ available: false }` and aborts its signal, and that a read does not
   count towards `MAX_ACTIONS_PER_TURN`.
6. Unit tests assert that `read` receives the subscriber, the parameters, the
   logger and a signal and nothing else; that a failure is logged without the
   query or the result; and that the turn record holds the tool, availability
   and duration and never the query or the result.
7. Unit tests assert that a read tool is not refused before the contact is a
   prospect, and that the prompt changes only when a plugin adds a read tool.
8. An integration test asserts that, on a turn that loses the race, the
   deferred reply is built from the same read result, and that the reply step's
   note carries the last successful read fenced.
9. Eval cases with an invented plugin cover one question answered from a read,
   one where the read is unavailable and the catalog answers, and one where
   it is unavailable and the turn escalates.

**What this does not catch.** A plugin that returns well-typed data that is
wrong or stale passes every check above; the agent can bound what it is shown,
not whether it is true. The fence makes injected text data in the model's
eyes, which is a mitigation, not a guarantee (C4). Cleaning a query removes
the URL, email, phone-number and long-number shapes, and no name: keeping a
name out of a query rests on the model following its tool's description.
And, as in `036`, a `read` that ignores its signal keeps running after the
agent has stopped waiting.
