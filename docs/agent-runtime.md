# Agent Runtime architecture

The Agent runtime is split into a platform-neutral core and Firefox adapters.
Dependency arrows must point from adapters toward the core, never back from the
core into privileged browser APIs.

## Layers

1. **AgentRuntimeCore** owns in-memory thread state, event reduction,
   subscriptions, confirmation state, cancellation, and window reservations.
   It has no Firefox imports and is directly testable in Node.
2. **AgentLoop** is the decision engine. It receives an LLM client, a tool
   router, messages, limits, and callbacks. It does not know which browser or
   operating system executes a tool.
3. **LlmClient + LlmTransport** adapt provider protocols and stream responses.
   Fetch, abort controllers, and timers are supplied through the transport port.
4. **AgentSession** is the application service. It coordinates projection,
   persistence, usage accounting, checkpoints, and automatic continuation while
   preserving the public singleton API used by the sidebar and MCP bridge.
5. **FirefoxAgentRuntimeHost** is the privileged composition root. It owns the
   Firefox timer adapter, application-shutdown observer, ToolRouter singleton,
   and browser backend graph.
6. **Backends and AgentEvalChild** implement capabilities. These are outside the
   runtime core and are reached only through ToolRouter dispatch.

## Runtime flow

```text
AgentPanel
  -> AgentSession
     -> AgentRuntimeCore
     -> LlmClient -> LlmTransport
     -> AgentLoop -> ToolRouter -> Firefox backends -> JSWindowActor/Gecko
```

## Boundary rules

- Do not import `ChromeUtils`, `Services`, `IOUtils`, `PathUtils`, XPCOM,
  or browser backends from `AgentRuntimeCore`, `AgentLoop`, `LlmClient`, or
  `LlmTransport`.
- Pass the selected window, workspace, and cancellation signal through tool
  context instead of reading global focus state.
- Keep provider protocol conversion in `LlmClient`; keep credentials and model
  profiles in `ConfigStore`.
- Keep session persistence in `AgentSession`/conversation ports, not in the
  state kernel.
- New privileged capabilities must be implemented as backends and registered in
  `Tools.sys.mjs`; they must not be called directly by the decision engine.
- A non-Firefox host can reuse the core by supplying timers, lifecycle hooks, an
  LLM transport, a router, and persistence adapters.

## Extension points

- **New scheduling policy:** change or wrap `AgentLoop.runAgentTurn`.
- **New model protocol:** add protocol codecs in `LlmClient`; transport stays
  unchanged.
- **Proxy, replay, or offline inference:** inject a different `LlmTransport`.
- **New browser capability:** add a backend, wire it in `Backends.sys.mjs`, and
  declare its public schema in `Tools.sys.mjs`.
- **New host application:** compose `AgentRuntimeCore` with a host adapter
  equivalent to `FirefoxAgentRuntimeHost`.
