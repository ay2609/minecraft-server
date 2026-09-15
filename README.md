# Minecraft Bot Runtime + Brain (Bun + TypeScript + mineflayer)

This project implements a streaming runtime/brain architecture for a single mineflayer bot.

## Components

- `src/runtime/main.ts`
  - Owns mineflayer bot and pathfinder.
  - Hosts WebSocket endpoints:
    - `ws://<host>:<port>/events` (runtime -> brain events/snapshots)
    - `ws://<host>:<port>/control` (brain -> runtime queue/control commands)
  - Runs deterministic executor/action queue and tool execution.
  - Produces snapshots, event deltas, salience filtering, coalescing.
  - Emits executor/tool/pathfinder events.

- `src/brain/main.ts`
  - Connects to runtime WS streams.
  - Maintains blackboard world model.
  - Runs reactive and thinking loops.
  - Calls LLM with strict JSON parsing + single retry.
  - Converts LLM outputs to control commands (`replaceQueue`, `prependActions`, etc).
  - Maintains relationship memory atomically at `mcbots/<bot>/relationships.md`.

- `src/shared/*`
  - Shared protocol/action schemas, message envelope contracts, validation, and config.

## Action Vocabulary

The executor accepts these actions only:

- `say`
- `wait`
- `goto`
- `follow`
- `flee`
- `run_tool`
- `idle`

No direct bot control is allowed outside the runtime executor/tools.

## Data Files

- Persona: `mcbots/<botName>/SOUL.md`
- Relationship memory: `mcbots/<botName>/relationships.md`
- Optional metadata: `mcbots/<botName>/metadata.json`

## Environment

See `.env.example` for all runtime/brain settings.

### Fireworks + MiniMax

The brain client uses an OpenAI-compatible chat-completions API. To use Fireworks with MiniMax:

- Set `LLM_PROVIDER=fireworks`
- Set `OPENAI_BASE_URL=https://api.fireworks.ai/inference/v1`
- Set `OPENAI_MODEL=fireworks/minimax-m2p5`
- Set `OPENAI_API_KEY=<your_fireworks_api_key>`

The variable names remain `OPENAI_*` because the client is OpenAI-compatible.

## Run

```bash
# install deps
npm install

# runtime (Bun)
bun run runtime

# brain (Bun)
bun run brain
```

## Protocol

Defined in `src/shared/protocol.ts` with Zod validation:

- Runtime -> Brain: `event`, `snapshot`, `ack`
- Brain -> Runtime: `control`

Control commands:

- `replaceQueue`
- `prependActions`
- `cancelCurrent`
- `setIdleBehavior`
- `requestSnapshot`

## Notes

- Reactive subsystem can issue urgent interrupts (prepend/cancel).
- Thinking subsystem handles short-horizon plans, social replies, and memory updates.
- If repeated action failures occur within the configured window, runtime emits `repeated_failure`.

## Runtime Tools (`run_tool`)

Current deterministic tools in the runtime registry:

- `look_around`
- `move_near_player`
- `goto`
- `pickup`
- `mine`
- `craft`
- `build`
- `chop`
- `fight`
- `farm`
- `smelt`
