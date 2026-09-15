import type { Bot } from "mineflayer";
import type { RuntimeConfig } from "../../shared/config.js";
import type { BotAction } from "../../shared/protocol.js";
import { sleep } from "../../shared/utils.js";
import { ToolRegistry } from "../tools/registry.js";
import { MovementController } from "../movement/controller.js";

export class ActionHandlers {
  constructor(
    private readonly bot: Bot,
    private readonly config: RuntimeConfig,
    private readonly tools: ToolRegistry,
    private readonly movement: MovementController,
    private readonly emitToolEvent: (event: string, data: Record<string, unknown>) => void,
  ) {}

  async run(action: BotAction, signal: AbortSignal): Promise<Record<string, unknown>> {
    switch (action.type) {
      case "say":
        this.throwIfAborted(signal);
        this.bot.chat(action.message);
        return { said: action.message };
      case "wait":
        await sleep(action.ms, signal);
        return { waitedMs: action.ms };
      case "goto":
        return this.runGoto(action.x, action.y, action.z, action.radius ?? 1, signal);
      case "follow":
        await this.runFollow(action.name, action.distance ?? 2, signal);
        return { followed: action.name };
      case "flee":
        return this.runFlee(action.from as { x: number; y: number; z: number }, action.radius, signal);
      case "run_tool":
        return this.runTool(action.name, action.args, signal);
      case "idle":
        return this.runIdle(action.behavior, signal);
      default:
        throw new Error("unsupported_action");
    }
  }

  private async runGoto(x: number, y: number, z: number, radius: number, signal: AbortSignal) {
    const result = await this.movement.goto(x, y, z, radius, signal);
    return { reached: result.reached, target: { x, y, z, radius }, reason: result.reason, finalPos: result.finalPos, distRemaining: result.distRemaining };
  }

  private async runFollow(name: string, distance: number, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const desiredDistance = Math.max(1, distance);
    const followTickMs = 400;
    let consecutiveFails = 0;

    while (!signal.aborted) {
      const entity = this.bot.players[name]?.entity;
      if (!entity) {
        throw new Error(`follow_target_missing:${name}`);
      }

      const selfPos = this.bot.entity.position;
      const targetPos = entity.position;
      const horizontalDist = Math.hypot(targetPos.x - selfPos.x, targetPos.z - selfPos.z);

      if (horizontalDist <= desiredDistance + 0.35) {
        consecutiveFails = 0;
        await sleep(followTickMs, signal);
        continue;
      }

      const result = await this.movement.goto(targetPos.x, targetPos.y, targetPos.z, desiredDistance, signal);
      if (result.reached) {
        consecutiveFails = 0;
      } else {
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          throw new Error(`follow_stuck:${name}`);
        }
      }

      await sleep(followTickMs, signal);
    }
    throw new Error("aborted");
  }

  private async runFlee(from: { x: number; y: number; z: number }, radius: number, signal: AbortSignal) {
    this.throwIfAborted(signal);
    const current = this.bot.entity.position;
    const dx = current.x - from.x;
    const dz = current.z - from.z;
    const norm = Math.hypot(dx, dz) || 1;
    const tx = current.x + (dx / norm) * radius;
    const tz = current.z + (dz / norm) * radius;

    return this.runGoto(tx, current.y, tz, 2, signal);
  }

  private async runTool(name: string, rawArgs: Record<string, unknown>, signal: AbortSignal) {
    this.throwIfAborted(signal);

    // LLMs sometimes double-wrap args as { args: { playerName: ... } }
    let args = rawArgs;
    if (args && typeof args.args === "object" && args.args !== null && Object.keys(args).length === 1) {
      args = args.args as Record<string, unknown>;
    }

    const emit = (event: string, data: Record<string, unknown>) => {
      this.emitToolEvent(event, { tool: name, ...data });
    };

    emit("tool_started", { args });
    try {
      const result = await this.tools.run(name, args, {
        bot: this.bot,
        movement: this.movement,
        signal,
        emit,
        timeoutMs: this.config.actionTimeoutMs,
      });
      emit("tool_done", { result });
      return result;
    } catch (error) {
      emit("tool_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async runIdle(behavior: "wander" | "guard_home" | "standby", signal: AbortSignal) {
    this.throwIfAborted(signal);

    if (behavior === "standby") {
      await sleep(1_000, signal);
      return { behavior, waited: 1000 };
    }

    if (behavior === "guard_home") {
      if (this.config.homePos) {
        return this.runGoto(this.config.homePos.x, this.config.homePos.y, this.config.homePos.z, 2, signal);
      }
      await sleep(700, signal);
      return { behavior, fallback: "no_home" };
    }

    const base = this.bot.entity.position;
    const offsetX = (Math.random() - 0.5) * 8;
    const offsetZ = (Math.random() - 0.5) * 8;
    try {
      await this.runGoto(base.x + offsetX, base.y, base.z + offsetZ, 2, signal);
    } catch {
      // Wander target was unreachable — stand still rather than failing.
      if (signal.aborted) {
        throw new Error("aborted");
      }
    }
    await sleep(400, signal);
    return { behavior, wandered: true };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error("aborted");
    }
  }
}
