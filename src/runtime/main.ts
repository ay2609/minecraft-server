import { createRequire } from "node:module";
import mineflayer from "mineflayer";
import { pathfinder, Movements } from "mineflayer-pathfinder";
import type { WebSocket } from "ws";

const require = createRequire(import.meta.url);
import { loadRuntimeConfig } from "../shared/config.js";
import { readBotMetadata } from "../shared/botData.js";
import {
  createEnvelopeBase,
  parseControlMessage,
  ReplaceQueueDataSchema,
  PrependActionsDataSchema,
  CancelCurrentDataSchema,
  SetIdleBehaviorDataSchema,
  RequestSnapshotDataSchema,
} from "../shared/protocol.js";
import { RuntimeWsServer } from "./ws/runtimeWsServer.js";
import { EventPipeline } from "./perception/eventPipeline.js";
import { buildSnapshot } from "./perception/snapshot.js";
import { ToolRegistry } from "./tools/registry.js";
import { ActionHandlers } from "./executor/actionHandlers.js";
import { Executor } from "./executor/executor.js";
import { MovementController } from "./movement/controller.js";
import { patchDigging } from "./patches/patchDigging.js";

const config = loadRuntimeConfig();
const metadata = readBotMetadata(config.botName);
if (!config.homePos && metadata?.home) {
  config.homePos = metadata.home;
}
const bot = mineflayer.createBot({
  host: config.mcHost,
  port: config.mcPort,
  username: config.mcUsername,
  auth: config.mcAuth,
  ...(config.mcVersion ? { version: config.mcVersion } : {}),
});

patchDigging(bot);
bot.loadPlugin(pathfinder);

const wsServer = new RuntimeWsServer(config.botName);
const eventPipeline = new EventPipeline(
  config.botName,
  config,
  {
    broadcast: (message) => wsServer.broadcast(message),
  },
);

const tools = new ToolRegistry();
const movement = new MovementController(bot);
const actionHandlers = new ActionHandlers(bot, config, tools, movement, (event, data) => {
  const salience =
    event === "tool_failed"
      ? 0.95
      : event === "tool_done"
        ? 0.65
        : event === "tool_started"
          ? 0.55
          : event === "tool_progress"
            ? 0.35
            : 0.5;
  eventPipeline.emit("tool", { event, ...data }, salience);
});

const executor = new Executor(
  bot,
  config,
  actionHandlers,
  (event, data, salience) => eventPipeline.emit("executor", { event, ...data }, salience),
);

let snapshotSeq = 0;
let runtimeReady = false;

function sendSnapshot() {
  const snapshot = {
    ...createEnvelopeBase(config.botName),
    kind: "snapshot",
    seq: snapshotSeq++,
    data: buildSnapshot(bot, config, executor.getStatus()),
  };
  wsServer.broadcast(snapshot);
}

function emitRuntimeReady() {
  eventPipeline.emit(
    "executor",
    {
      event: "runtime_ready",
      toolRegistry: tools.listMetadata(),
    },
    0.8,
  );
}

function summarizeInventory() {
  return bot.inventory
    .items()
    .map((item) => ({ name: item.name, count: item.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 24);
}

function installMineflayerSubscriptions() {
  const seenPlayers = new Set<string>();
  const seenEntities = new Set<number>();
  const spawnedAt = Date.now();
  const CHAT_GRACE_MS = 3_000;

  // Stuck jump fallback: when pathfinding and running into a block (forward pressed,
  // on ground, velocity near zero), add jump after a short delay. Helps with 1-block
  // steps the pathfinder sometimes misses.
  let stuckSince = 0;
  const STUCK_JUMP_THRESHOLD_MS = 400;
  const VEL_NEAR_ZERO = 0.02;

  bot.on("physicsTick", () => {
    const pf = bot.pathfinder as any;
    const hasGoal = pf?.goal != null;
    const forward = bot.getControlState("forward");
    const onGround = bot.entity.onGround;
    const vx = bot.entity.velocity.x;
    const vz = bot.entity.velocity.z;
    const velNearZero = Math.abs(vx) < VEL_NEAR_ZERO && Math.abs(vz) < VEL_NEAR_ZERO;

    if (hasGoal && forward && onGround && velNearZero && !(bot.entity as any).isInWater) {
      if (stuckSince === 0) stuckSince = Date.now();
      if (Date.now() - stuckSince >= STUCK_JUMP_THRESHOLD_MS) {
        bot.setControlState("jump", true);
        // Keep holding jump until we're no longer stuck (in air or moved)
      }
    } else {
      stuckSince = 0;
    }
  });

  bot.on("chat", (username, message) => {
    if (username === bot.username) {
      return;
    }
    if (Date.now() - spawnedAt < CHAT_GRACE_MS) {
      return;
    }
    eventPipeline.emit("chat", {
      username,
      message,
      directed: message.toLowerCase().includes(config.botName.toLowerCase()),
    });
  });

  bot.on("whisper", (username, message) => {
    if (username === bot.username) {
      return;
    }
    if (Date.now() - spawnedAt < CHAT_GRACE_MS) {
      return;
    }
    eventPipeline.emit("whisper", { username, message }, 1);
  });

  bot.on("entitySpawn", (entity) => {
    if (entity.type === "player" && entity.username && !seenPlayers.has(entity.username)) {
      seenPlayers.add(entity.username);
      eventPipeline.emit("playerSeen", {
        name: entity.username,
        dist: bot.entity.position.distanceTo(entity.position),
      }, 0.7);
      return;
    }

    if (!seenEntities.has(entity.id)) {
      seenEntities.add(entity.id);
      eventPipeline.emit("entitySeen", {
        id: entity.id,
        kind: entity.name,
        dist: bot.entity.position.distanceTo(entity.position),
      }, 0.45);
    }
  });

  bot.on("entityGone", (entity) => {
    if (entity.type === "player" && entity.username) {
      seenPlayers.delete(entity.username);
      eventPipeline.emit("playerGone", { name: entity.username }, 0.6);
    }

    seenEntities.delete(entity.id);
    eventPipeline.emit("entityGone", { id: entity.id, kind: entity.name }, 0.4);
  });

  let healthPrev = bot.health;
  bot.on("health", () => {
    const delta = bot.health - healthPrev;
    eventPipeline.emit("health", { health: bot.health, food: bot.food, delta }, Math.abs(delta) > 2 ? 0.95 : 0.5);
    if (delta < -2) {
      eventPipeline.emit("hurt", { health: bot.health, delta }, 1);
    }
    healthPrev = bot.health;
  });

  bot.on("death", () => {
    eventPipeline.emit("death", { at: Date.now() }, 1);
  });

  bot.on("entityMoved", (entity) => {
    if (entity.type === "player" && entity.username !== bot.username) {
      const dist = bot.entity.position.distanceTo(entity.position);
      eventPipeline.emit("entityMove", {
        id: entity.id,
        kind: "player",
        name: entity.username,
        dist,
        pos: {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z,
        },
      });
      return;
    }

    if (entity.type === "mob") {
      const dist = bot.entity.position.distanceTo(entity.position);
      eventPipeline.emit("entityMove", {
        id: entity.id,
        kind: entity.name,
        dist,
      });
    }
  });

  const queueInventory = () => {
    eventPipeline.queueInventoryEvent({
      items: summarizeInventory(),
    });
  };

  bot.on("windowOpen", queueInventory);
  bot.on("windowClose", queueInventory);
  bot.on("setSlot" as any, queueInventory);
  bot.on("heldItemChanged" as any, queueInventory);
  bot.on("playerCollect", queueInventory);

  setInterval(queueInventory, 1500);

  setInterval(() => {
    seenPlayers.clear();
    seenEntities.clear();
  }, 5 * 60 * 1000);

  const pathfinderAny = bot.pathfinder as any;
  if (pathfinderAny?.on) {
    pathfinderAny.on("path_update", (result: any) => {
      if (!result) {
        return;
      }
      if (result.status === "noPath" || result.status === "timeout") {
        eventPipeline.emit("pathfinder", { status: result.status, visitedNodes: result.visitedNodes ?? 0 }, 0.9);
      }
    });

    pathfinderAny.on("goal_reached", () => {
      eventPipeline.emit("pathfinder", { status: "goal_reached" }, 0.5);
    });
  }

  setInterval(() => {
    const lava = bot.findBlock({
      matching: (block) => block?.name?.includes("lava") ?? false,
      maxDistance: 4,
    });
    if (lava) {
      eventPipeline.emit(
        "blockHazard",
        {
          hazard: "lava_nearby",
          pos: { x: lava.position.x, y: lava.position.y, z: lava.position.z },
        },
        0.9,
      );
    }
  }, 1200);
}

async function handleControl(raw: string, ws: WebSocket): Promise<void> {
  const message = parseControlMessage(raw);

  switch (message.cmd) {
    case "replaceQueue": {
      const data = ReplaceQueueDataSchema.parse(message.data ?? {});
      executor.replaceQueue(data.actions, data.planId, data.reason);
      const ackData = {
        queueSize: data.actions.length,
        queue: executor.getQueueSnapshot(),
      };
      wsServer.sendAck(ws, true, message.id, ackData);
      return;
    }
    case "prependActions": {
      const data = PrependActionsDataSchema.parse(message.data ?? {});
      executor.prependActions(data.actions, data.priority, data.reason);
      const ackData = {
        queued: data.actions.length,
        priority: data.priority,
        queue: executor.getQueueSnapshot(),
      };
      wsServer.sendAck(ws, true, message.id, ackData);
      return;
    }
    case "cancelCurrent": {
      const data = CancelCurrentDataSchema.parse(message.data ?? {});
      executor.cancelCurrent(data.reason);
      const ackData = {
        canceled: true,
        queue: executor.getQueueSnapshot(),
      };
      wsServer.sendAck(ws, true, message.id, ackData);
      return;
    }
    case "setIdleBehavior": {
      const data = SetIdleBehaviorDataSchema.parse(message.data ?? {});
      executor.setIdleBehavior(data.behavior);
      const ackData = {
        behavior: data.behavior,
        queue: executor.getQueueSnapshot(),
      };
      wsServer.sendAck(ws, true, message.id, ackData);
      return;
    }
    case "requestSnapshot": {
      RequestSnapshotDataSchema.parse(message.data ?? {});
      sendSnapshot();
      const ackData = { snapshotSeq };
      wsServer.sendAck(ws, true, message.id, ackData);
      return;
    }
    default: {
      wsServer.sendAck(ws, false, message.id, undefined, "unknown command");
    }
  }
}

async function main() {
  wsServer.setControlHandler(handleControl);
  wsServer.setEventsConnectHandler(() => {
    if (runtimeReady) {
      emitRuntimeReady();
    }
  });
  await wsServer.start(config.wsHost, config.wsPort);

  bot.once("spawn", () => {
    const mcData = require("minecraft-data")(bot.version);
    const movements = new Movements(bot);
    // Allow pathfinder to break obstructing blocks when routing to goals.
    movements.canDig = true;
    // Disable allowFreeMotion: when true, GoalFollow uses a straight-line shortcut that only sets
    // forward — never jump. The bot runs into 1-block steps instead of jumping. With false, we use
    // full pathfinding which has proper jump logic (canSprintJump, canWalkJump).
    movements.allowFreeMotion = false;
    movements.allow1by1towers = true;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.maxDropDown = 4;
    movements.scafoldingBlocks = [
      mcData.blocksByName.dirt?.id,
      mcData.blocksByName.cobblestone?.id,
      mcData.blocksByName.oak_planks?.id,
    ].filter(Boolean);
    bot.pathfinder.setMovements(movements);

    const pfAny = bot.pathfinder as any;
    // 2s think budget — gives up on unfindable paths 2.5× faster than before (was 5000ms).
    // The real-time stuck detector in MovementController catches stuck bots in ≤3s anyway,
    // so there's no benefit to letting pathfinder search for 5s on impossible routes.
    pfAny.thinkTimeout = 2000;
    pfAny.tickTimeout = 40;
    pfAny.searchRadius = 256;
    pfAny.enablePathShortcut = true;
    // Keep pathfinder from using moveToEdge() placement logic that can press "back".
    pfAny.LOSWhenPlacingBlocks = false;

    // Wrap goto to clear stale stopPathing flag before each new navigation.
    // setGoal(null) is synchronous and sufficient; the prior setTimeout(r,0) yield
    // was defensive overhead that added ~1ms per leg start unnecessarily.
    const origGoto = bot.pathfinder.goto.bind(bot.pathfinder);
    (bot.pathfinder as any).goto = (goal: any) => {
      bot.pathfinder.setGoal(null);
      return origGoto(goal);
    };

    movement.installPathListener();

    installMineflayerSubscriptions();
    executor.start();

    setInterval(sendSnapshot, config.snapshotIntervalMs);
    sendSnapshot();
    runtimeReady = true;
    emitRuntimeReady();
  });

  bot.on("error", (error) => {
    eventPipeline.emit("executor", { event: "bot_error", error: error.message }, 1);
  });

  bot.on("end", (reason) => {
    eventPipeline.emit("executor", { event: "bot_end", reason }, 1);
  });
}

main().catch((error) => {
  process.exit(1);
});
