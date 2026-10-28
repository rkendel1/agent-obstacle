---
name: feltkit-agent
description: Work a FeltKit application as an agent through its MCP endpoint and FeltDB's native agent state — discover capabilities, claim tasks handed off from FeltKit Studio, propose actions that run through AppPort, and read evidence-backed checkpoints. Use when connected to a FeltKit /mcp endpoint, when the user asks you to operate, diagnose, or fix a running FeltKit app, or mentions feltkit_agent_* tools, agent tasks, handoffs, or approvals.
---

# FeltKit: operate an application as an agent

A running FeltKit app (`feltkit dev`) serves MCP at `POST <url>/mcp` (Streamable HTTP, JSON). Its tools are the
application's AppPort capabilities plus the FeltKit agent tools below. Every call runs **as your session's
principal**, with that principal's roles. You cannot see or do more than they allow, and nothing here changes that.

## Connect

The user creates an agent session (you never invent one):

```sh
npx feltkit session create --id my-agent --role <role> --type agent
```

Use the printed token as `Authorization: Bearer <token>` on `/mcp`. An AppPort Services API key also works when
`services.apiKeys` is enabled. The role must grant `feltkit.agent.read` / `feltkit.agent.write` to use the agent tools.

## Tools

| Tool | What it does |
|---|---|
| `feltkit_context` | Collections, every capability with `allowed` (for you) and `effect`, service states, recent errors and denials |
| `feltkit_agent_tasks` | Tasks and open handoffs |
| `feltkit_agent_claim` | Claim a handoff from Studio; you become the task owner; returns FeltDB's context bundle (`feltdb.agent-context@1`) |
| `feltkit_agent_create` | Start your own task. `playbook`: `diagnose-job`, `diagnose-delivery`, `inspect-app`, `invoke`, `handoff` |
| `feltkit_agent_propose` | Propose an action on a task you own: `{ taskId, capability, input, reason }` |
| `feltkit_agent_get` | A task, its checkpoints with evidence, its FeltDB execution record, pending actions |
| `feltkit_agent_note` | Record progress and decisions |
| `feltkit_agent_complete` | Finish with a summary |

Application capabilities are also tools directly (their MCP names come from the capability names).

## Workflow

1. `feltkit_context` first. Prefer capabilities with `allowed: true`. Do not try others to "see what happens".
2. Claim the task you were given (`feltkit_agent_tasks` → `feltkit_agent_claim`), or create one.
3. Gather facts with **observations** (`effect: "observation"`): they run immediately and are recorded with evidence.
4. Propose **consequential** actions with a clear `reason`. They do not run until a person approves them in
   Studio's Agent screen. **There is no approve tool, and you must not ask for one or route around it.** Tell the
   user what is waiting and why.
5. After approval, read `feltkit_agent_get`: each action has a `state` (`proposed`, `approved`, `executing`,
   `succeeded`, `failed`, `interrupted`, `rejected`, `cancelled`), who proposed, approved, and ran it, and its
   outcome; the checkpoint cites the activity record FeltDB verified at commit. Report from that evidence, never
   from your expectation.
   - `failed`: the call returned an error. Propose again or ask the user to retry it in Studio; a retry needs
     approval again.
   - `interrupted`: the outcome is **unknown** (a timeout, a cancellation, or a restart while it ran). It may have
     taken effect. Never propose the same action again to "make sure"; tell the user, who settles it in Studio
     after checking.
6. `feltkit_agent_complete` with a factual summary. Completion is refused while any action is open (proposed,
   approved, executing, or interrupted).

Example: diagnose a failed job.

```json
{ "name": "feltkit_agent_create", "arguments": { "objective": "Why did job 7f3… fail?", "playbook": "diagnose-job", "target": "7f3…" } }
```

The playbook reads the job through `jobs.read`, its runs from the activity log, the handler mapping, and proposes
`jobs.retry` only when a retry can help (not when the handler is missing or the enqueuer can no longer act).

## What you can trust

- `ok`/`isError` on a tool result says what AppPort returned. A checkpoint's `evidence` entries with
  `verified: true` were checked by FeltDB inside the commit.
- Outputs are redacted: API-key plaintext and session tokens never appear. Do not try to recover them.
- Actions run as the task **owner**. An approval by a person never widens the owner's permissions: an action the
  owner may not perform is refused at approval, and the proposal stays pending with the reason in its history.

## Writing code instead

If the fix is a code change (a handler bug, a missing job handler, a role), use the feltkit-build skill to change
the source, run `npx feltkit test`, and let the user review. Record what you changed with `feltkit_agent_note`.

## Compatibility

`@feltdb/feltkit` 0.1.x, development server. FeltDB 0.13.0 agent state. There is no planner: decisions are yours, a
playbook's, or the environment's model choosing among options the application built (a `decide` task); a model's
choice is a proposal like yours. Verified in Claude Code only.
