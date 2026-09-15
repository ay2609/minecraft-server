# minecraft-server

Self-hosted Minecraft server plus an LLM-controlled bot ("Scout") with a decoupled runtime/brain architecture.

## What it is

Two things bundled together:

1. **`blockgame-server/`** — a Dockerized Paper Minecraft server (`compose.yaml`).
2. **Scout** — a mineflayer bot built with a deliberately decoupled design:
   - a **runtime** that owns the actual mineflayer connection, pathfinding, and a fixed vocabulary
     of safe actions (`goto`, `mine`, `craft`, `fight`, ...), exposed over WebSocket, and
   - a **brain**, a separate process that consumes world-state snapshots over WebSocket and calls
     an LLM to decide what to do next, maintaining a persistent goal stack and per-player
     relationship memory (`mcbots/Scout/`).

`GAME_KNOWLEDGE.md` documents the Minecraft mechanics (block drops, etc.) the bot relies on when
planning. `reference_code/` holds three other published Minecraft-agent projects — **Optimus-3**,
**Voyager**, and **mindcraft** — kept as git submodules. These are prior art studied while building
Scout, not original work.

> This is the actively developed LLM-Minecraft-agent project; [`minecraft-bot`](https://github.com/ay2609/minecraft-bot)
> is an earlier, separate experiment toward the same idea.

## Stack

- TypeScript, Bun, mineflayer
- WebSocket protocol with Zod-validated schemas
- Docker (Paper server)

## Credits

- [Optimus-3](https://github.com) , [Voyager](https://github.com), and [mindcraft](https://github.com) — studied as reference implementations, included as submodules in `reference_code/`.
