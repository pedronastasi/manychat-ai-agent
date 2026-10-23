# ADR-0027 — The bounded tool loop is a LangGraph.js graph the service draws, not a prebuilt agent

**Status:** accepted · **Date:** 2026-10-22

## Context

ADR-0026 moves the TypeScript model layer to LangChain.js to rehearse the
Python implementation of ADR-0025. The tool loop is the other half of that
implementation: `026` draws it as a LangGraph graph in Python, and the same
reasoning applies here. Rehearsing only the model calls would leave the graph,
the part of `026` with the most ways to go wrong, to be built for the first
time in the Python repository.

The reflexive choice is LangGraph's prebuilt agent, `createReactAgent` with a
`ToolNode`. Its case is real: it is the least code, it is how the framework
documents an agent, and it handles the call, execute and repeat cycle that the
runner writes by hand today. It is rejected because a `ToolNode` runs a tool's
function when the model calls it and runs one step's calls concurrently. That
performs writes mid-generation, before guardrails and before the model has set
`escalate`, which ADR-0010 and C6 forbid, and it loses the staging order `012`
fixes. Its recursion limit counts supersteps, not the model steps `012` caps.

## Decision

The runner's loop is a LangGraph.js `StateGraph` the service draws itself: a
model node and a tools node of its own, in which writes stage (ADR-0010), reads
and inbound flows perform (ADR-0016, ADR-0019), calls are handled one at a time
in the order the model made them, and the step cap of `012` is a counter in the
graph's state.

## Consequences

- The graph `026` specifies for Python exists and is tested in TypeScript
  first, under the same specs, so the Python implementation translates a
  working graph instead of designing one.
- The loop's shape becomes visible: the nodes and edges are declared, where
  today they are implied by `stopWhen` and the order of callbacks.
- Cost: no checkpointer. History stays in `turns` (`018`, `019`), so LangGraph's
  persistence, resumption and interrupts are not used, and the graph is a
  runtime for one turn only.
- Cost: `recursionLimit` is set on every invocation to what the step cap allows,
  and hitting it fails closed. Leaving it at the library default would let the
  graph outrun `012` before anything noticed.
- Cost: a graph runtime sits on the latency-critical path, inside the race. The
  abort signal is passed to every invocation, and a test asserts the graph
  stops when it fires.
- Cost: `@langchain/langgraph` is another dependency whose defaults change
  between versions, and each upgrade re-reads them.
- Revisit together with ADR-0026, on the same trigger. A four-step loop with
  one branch does not need a graph runtime for its own sake.
