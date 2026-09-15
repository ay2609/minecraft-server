import { z } from "zod";
import { Vec3 } from "vec3";
import { goals } from "mineflayer-pathfinder";
import type { ToolContext, ToolDefinition } from "./types.js";
import {
  collectNearbyDrops,
  equipBestByKeyword,
  findItemByName,
  findItemByNameLike,
  gotoNear,
  isSolidBlock,
  neighborOffsets,
  throwIfAborted,
} from "./helpers.js";
import {
  getAttackCooldownMs,
  isInMeleeRange,
  sprintHitAttack,
  MELEE_REACH,
} from "../combat/melee.js";
import type { Bot } from "mineflayer";
import { sleep } from "../../shared/utils.js";

const HOSTILE_MOBS = new Set([
  "zombie",
  "skeleton",
  "creeper",
  "spider",
  "enderman",
  "witch",
  "drowned",
  "husk",
  "pillager",
  "vindicator",
  "evoker",
  "phantom",
]);
const GoalNear = goals.GoalNear;
const GoalFollow = goals.GoalFollow;
const DIG_MAX_ATTEMPTS = 3;
const DIG_RETRY_DELAY_MS = 120;
const DIG_APPROACH_RADIUS = 2;

function blockPosKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function findNearestBlock(
  bot: Bot,
  matchingIds: number[],
  maxDistance: number,
  skipped: Set<string>,
  count = 64,
): ReturnType<Bot["blockAt"]> {
  const positions = bot.findBlocks({
    matching: matchingIds,
    maxDistance,
    count,
  });

  const botPos = bot.entity.position;
  let nearest: ReturnType<Bot["blockAt"]> = null;
  let nearestDist = Infinity;

  for (const pos of positions) {
    const key = blockPosKey(pos);
    if (skipped.has(key)) continue;
    const dist = botPos.distanceTo(pos);
    if (dist < nearestDist) {
      const block = bot.blockAt(pos);
      if (block && block.name !== "air") {
        nearest = block;
        nearestDist = dist;
      }
    }
  }

  return nearest;
}

function distanceFromEyeToBlockCenter(context: ToolContext, pos: Vec3): number {
  const eyeHeight = (context.bot.entity as any).eyeHeight ?? 1.62;
  const eyePos = context.bot.entity.position.offset(0, eyeHeight, 0);
  const center = pos.offset(0.5, 0.5, 0.5);
  return eyePos.distanceTo(center);
}

function computeNavY(context: ToolContext, blockPos: Vec3): number {
  const botY = context.bot.entity.position.y;
  if (blockPos.y <= botY + 1) return blockPos.y;

  for (let y = blockPos.y - 1; y >= blockPos.y - 8; y--) {
    const below = context.bot.blockAt(new Vec3(blockPos.x, y, blockPos.z));
    if (below && below.boundingBox === "block") {
      return y + 1;
    }
  }
  return botY;
}

async function digWithRetries(
  context: ToolContext,
  blockPos: Vec3,
  source: "mine" | "chop",
): Promise<{ ok: true; blockName: string } | { ok: false; reason: string }> {
  let approachRadius = DIG_APPROACH_RADIUS;
  let lastError = "dig_failed";

  for (let attempt = 1; attempt <= DIG_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(context.signal);

    const navY = computeNavY(context, blockPos);

    try {
      await gotoNear(context.movement, blockPos.x, navY, blockPos.z, approachRadius, context.signal);
    } catch (navError) {
      if (context.signal.aborted) {
        throw navError;
      }
      lastError = `nav_failed:${navError instanceof Error ? navError.message.slice(0, 60) : String(navError).slice(0, 60)}`;
      context.emit("tool_progress", {
        source,
        phase: "dig_retry",
        attempt,
        reason: "nav_failed",
        error: lastError,
      });
      approachRadius = Math.max(0, approachRadius - 1);
      await sleep(DIG_RETRY_DELAY_MS, context.signal);
      continue;
    }

    const target = context.bot.blockAt(blockPos);
    if (!target || target.name === "air") {
      return { ok: false, reason: "target_missing" };
    }

    if (!context.bot.canDigBlock(target)) {
      return { ok: false, reason: `cannot_dig:${target.name}` };
    }

    const distance = distanceFromEyeToBlockCenter(context, target.position);
    if (distance > 4.6) {
      context.emit("tool_progress", {
        source,
        phase: "dig_retry",
        attempt,
        reason: "out_of_reach",
        distance: Number(distance.toFixed(2)),
      });
      approachRadius = Math.max(0, approachRadius - 1);
      await sleep(DIG_RETRY_DELAY_MS, context.signal);
      continue;
    }

    try {
      await context.bot.dig(target, true, 'raycast');

      await sleep(100, context.signal);
      const after = context.bot.blockAt(blockPos);
      if (after && after.name !== "air") {
        lastError = `dig_rejected_by_server:${after.name}`;
        context.emit("tool_progress", {
          source,
          phase: "dig_retry",
          attempt,
          reason: "server_rejected",
          block: after.name,
        });
        approachRadius = Math.max(0, approachRadius - 1);
        await sleep(DIG_RETRY_DELAY_MS, context.signal);
        continue;
      }

      return { ok: true, blockName: target.name };
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
      context.emit("tool_progress", {
        source,
        phase: "dig_retry",
        attempt,
        reason: "dig_throw",
        error: lastError,
      });
      approachRadius = Math.max(0, approachRadius - 1);
      await sleep(DIG_RETRY_DELAY_MS, context.signal);
    }
  }

  return { ok: false, reason: lastError };
}

const moveNearPlayerTool: ToolDefinition = {
  name: "move_near_player",
  description: "Pathfind to a nearby player by username.",
  argsHint: { name: "player username", radius: "distance 1..6" },
  argsSchema: z.object({ name: z.string().min(1), radius: z.number().min(1).max(6).default(2) }),
  preconditions: ["player must be visible"],
  run: async (args, context) => {
    const parsed = moveNearPlayerTool.argsSchema.parse(args);
    const desiredRadius = Math.max(1, parsed.radius);
    const maxDurationMs = Math.min(Math.max(12_000, context.timeoutMs - 5_000), 45_000);
    const startedAt = Date.now();
    const trackingEmitMinIntervalMs = 1_000;
    let lastDistance = Number.POSITIVE_INFINITY;
    let lastTrackingDist = Number.POSITIVE_INFINITY;
    let lastTrackingEmitAt = 0;
    let lastProgressAt = startedAt;
    let repathCount = 0;

    const onAbort = () => {
      context.bot.pathfinder.setGoal(null);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (Date.now() - startedAt < maxDurationMs) {
        throwIfAborted(context.signal);

        const target = context.bot.players[parsed.name]?.entity;
        if (!target) {
          throw new Error(`player_not_found:${parsed.name}`);
        }

        const selfPos = context.bot.entity.position;
        const targetPos = target.position;
        const dx = targetPos.x - selfPos.x;
        const dz = targetPos.z - selfPos.z;
        const dy = targetPos.y - selfPos.y;
        const horizontalDist = Math.hypot(dx, dz);
        const distRounded = Number(horizontalDist.toFixed(2));
        const goalY = Math.abs(dy) > 2 ? selfPos.y : targetPos.y;

        const now = Date.now();
        const shouldEmitTracking =
          now - lastTrackingEmitAt >= trackingEmitMinIntervalMs || Math.abs(horizontalDist - lastTrackingDist) >= 0.75;
        if (shouldEmitTracking) {
          context.emit("tool_progress", {
            source: "move_near_player",
            phase: "tracking",
            target: parsed.name,
            radius: desiredRadius,
            dist: distRounded,
            verticalGap: Number(Math.abs(dy).toFixed(2)),
          });
          lastTrackingEmitAt = now;
          lastTrackingDist = horizontalDist;
        }

        if (horizontalDist <= desiredRadius + 0.35) {
          context.bot.pathfinder.setGoal(null);
          return {
            reached: parsed.name,
            radius: desiredRadius,
            dist: distRounded,
            repaths: repathCount,
          };
        }

        if (horizontalDist + 0.2 < lastDistance) {
          lastDistance = horizontalDist;
          lastProgressAt = Date.now();
        } else if (horizontalDist < lastDistance) {
          lastDistance = horizontalDist;
        }

        context.bot.pathfinder.setGoal(new GoalNear(targetPos.x, goalY, targetPos.z, desiredRadius), true);

        if (Date.now() - lastProgressAt > 6_000) {
          repathCount += 1;
          context.emit("tool_progress", {
            source: "move_near_player",
            phase: "stalled_repath",
            target: parsed.name,
            radius: desiredRadius,
            dist: distRounded,
            repathCount,
          });
          lastTrackingEmitAt = Date.now();
          lastTrackingDist = horizontalDist;
          context.bot.pathfinder.setGoal(null);
          await sleep(120, context.signal);
          lastProgressAt = Date.now();
        }

        await sleep(250, context.signal);
      }

      throw new Error(`move_near_player_timeout:${parsed.name}`);
    } finally {
      context.bot.pathfinder.setGoal(null);
      context.signal.removeEventListener("abort", onAbort);
    }
  },
};

const followPlayerTool: ToolDefinition = {
  name: "follow_player",
  description:
    "Follow a player by username using direct entity tracking. Continuously tracks the moving player until the plan is cancelled. " +
    "Use when a player explicitly asks you to follow them — smoother than repeated gotos. For one-shot navigation to a player's current position, use move_near_player instead.",
  argsHint: { name: "player username", distance: "follow distance 1..6, default 2" },
  argsSchema: z.object({ name: z.string().min(1), distance: z.number().min(1).max(6).default(2) }),
  preconditions: ["player must be visible"],
  run: async (args, context) => {
    const parsed = followPlayerTool.argsSchema.parse(args);
    const desiredDistance = Math.max(1, parsed.distance);

    const entity = context.bot.players[parsed.name]?.entity;
    if (!entity) {
      throw new Error(`follow_target_missing:${parsed.name}`);
    }

    const onAbort = () => {
      context.bot.pathfinder.setGoal(null);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // Set goal ONCE. The pathfinder handles dynamic tracking internally via GoalFollow.hasChanged().
      // Re-calling setGoal every tick would trigger resetPath('goal_updated') and clearControlStates(),
      // which wipes movement every 350ms and prevents the bot from ever moving.
      context.bot.pathfinder.setGoal(new GoalFollow(entity, desiredDistance), true);

      while (!context.signal.aborted) {
        throwIfAborted(context.signal);
        // Re-check entity still exists (player may have disconnected)
        const currentEntity = context.bot.players[parsed.name]?.entity;
        if (!currentEntity) {
          throw new Error(`follow_target_missing:${parsed.name}`);
        }
        await sleep(500, context.signal);
      }
      return { followed: parsed.name, stopped: "aborted" };
    } finally {
      context.bot.pathfinder.setGoal(null);
      context.signal.removeEventListener("abort", onAbort);
    }
  },
};

const gotoTool: ToolDefinition = {
  name: "goto",
  description: "Navigate to world coordinates.",
  argsHint: { x: "target x", y: "target y", z: "target z", radius: "arrival radius, default 2" },
  argsSchema: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    radius: z.number().min(0).max(12).default(2),
  }),
  preconditions: ["path must be reachable"],
  run: async (args, context) => {
    const parsed = gotoTool.argsSchema.parse(args);
    await gotoNear(context.movement, parsed.x, parsed.y, parsed.z, parsed.radius, context.signal);

    const pos = context.bot.entity.position;
    return {
      arrived: true,
      position: {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2)),
      },
    };
  },
};

const pickupTool: ToolDefinition = {
  name: "pickup",
  description: "Collect dropped item entities nearby.",
  argsHint: { radius: "search radius, default 24", limit: "max entities to collect, default 12" },
  argsSchema: z.object({
    radius: z.number().min(3).max(64).default(24),
    limit: z.number().int().min(1).max(32).default(12),
  }),
  preconditions: ["dropped item entities must be nearby"],
  run: async (args, context) => {
    const parsed = pickupTool.argsSchema.parse(args);
    const collected = await collectNearbyDrops(context.bot, context.movement, context.signal, parsed.radius, parsed.limit);
    return { collected };
  },
};

const mineTool: ToolDefinition = {
  name: "mine",
  description: "Mine blocks by Minecraft ID and optionally collect drops. IDs use underscore format: coal_ore, iron_ore, gold_ore, diamond_ore, deepslate_coal_ore, stone, cobblestone, dirt, gravel, sand, oak_log. Partial matching supported.",
  argsHint: {
    blockName: "Minecraft block ID (underscore_format). E.g. 'coal_ore', 'iron_ore', 'stone', 'oak_log'. No spaces. Partial match OK.",
    count: "number of blocks to mine (default 1)",
    radius: "search radius in blocks (default 32)",
    collectDrops: "collect drops after each block (default true)",
  },
  argsSchema: z.object({
    blockName: z.string().min(1),
    count: z.number().int().min(1).max(64).default(1),
    radius: z.number().min(3).max(64).default(32),
    collectDrops: z.boolean().default(true),
  }),
  preconditions: ["matching blocks must exist within radius", "pickaxe recommended for ore/stone"],
  run: async (args, context) => {
    const parsed = mineTool.argsSchema.parse(args);

    // Smart tool selection based on what we're mining
    const bn = parsed.blockName;
    if (bn.includes("ore") || bn.includes("stone") || bn.includes("cobble") || bn.includes("deepslate") || bn.includes("obsidian") || bn.includes("netherrack") || bn.includes("basalt") || bn.includes("terracotta") || bn.includes("brick")) {
      await equipBestByKeyword(context.bot, "pickaxe");
    } else if (bn.includes("log") || bn.includes("wood") || bn.includes("plank") || bn.includes("fence") || bn.includes("door")) {
      await equipBestByKeyword(context.bot, "axe");
    } else if (bn.includes("dirt") || bn.includes("sand") || bn.includes("gravel") || bn.includes("clay") || bn.includes("soul") || bn.includes("snow") || bn.includes("mud") || bn.includes("mycelium") || bn.includes("podzol")) {
      await equipBestByKeyword(context.bot, "shovel");
    } else {
      await equipBestByKeyword(context.bot, "pickaxe");
    }

    const blockEntries = Object.values((context.bot.registry as any).blocksByName ?? {}) as Array<{ id: number; name: string }>;
    const matchingIds = blockEntries
      .filter((block) => block.name.includes(parsed.blockName))
      .map((block) => block.id);

    if (matchingIds.length === 0) {
      throw new Error(`no_block_match:${parsed.blockName}`);
    }

    const mined: string[] = [];
    const skipped = new Set<string>();
    let attempts = 0;
    const maxAttempts = Math.max(parsed.count * 6, 12);
    let anyBlockFound = false;
    let searchExpansions = 0;
    const MAX_SEARCH_EXPANSIONS = 2;

    while (mined.length < parsed.count && attempts < maxAttempts) {
      throwIfAborted(context.signal);
      attempts += 1;

      const target = findNearestBlock(context.bot, matchingIds, parsed.radius, skipped);

      if (!target) {
        if (searchExpansions < MAX_SEARCH_EXPANSIONS) {
          searchExpansions++;
          context.emit("tool_progress", {
            source: "mine",
            phase: "expanding_search",
            expansion: searchExpansions,
            blockName: parsed.blockName,
          });
          const pos = context.bot.entity.position;
          const angle = Math.random() * Math.PI * 2;
          const dx = Math.cos(angle) * 32;
          const dz = Math.sin(angle) * 32;
          try {
            await gotoNear(context.movement, pos.x + dx, pos.y, pos.z + dz, 5, context.signal);
          } catch { /* best effort — just try to move */ }
          continue;
        }
        break;
      }

      anyBlockFound = true;
      const targetPos = target.position.clone();
      const targetKey = blockPosKey(targetPos);

      context.emit("tool_progress", {
        source: "mine",
        phase: "approaching",
        mined: mined.length,
        target: parsed.count,
        block: target.name,
        position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      });

      // Re-equip the appropriate tool before each block
      const tn = target.name;
      if (tn.includes("ore") || tn.includes("stone") || tn.includes("cobble") || tn.includes("deepslate") || tn.includes("obsidian") || tn.includes("netherrack") || tn.includes("basalt") || tn.includes("terracotta") || tn.includes("brick")) {
        await equipBestByKeyword(context.bot, "pickaxe");
      } else if (tn.includes("log") || tn.includes("wood") || tn.includes("plank") || tn.includes("fence") || tn.includes("door")) {
        await equipBestByKeyword(context.bot, "axe");
      } else if (tn.includes("dirt") || tn.includes("sand") || tn.includes("gravel") || tn.includes("clay") || tn.includes("soul") || tn.includes("snow") || tn.includes("mud") || tn.includes("mycelium") || tn.includes("podzol")) {
        await equipBestByKeyword(context.bot, "shovel");
      } else {
        await equipBestByKeyword(context.bot, "pickaxe");
      }

      const dig = await digWithRetries(context, targetPos, "mine");
      if (dig.ok === false) {
        skipped.add(targetKey);
        context.emit("tool_progress", {
          source: "mine",
          phase: "skip_target",
          reason: dig.reason,
          position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
        });
        continue;
      }

      mined.push(dig.blockName);
      context.emit("tool_progress", {
        source: "mine",
        phase: "mined",
        mined: mined.length,
        target: parsed.count,
        block: dig.blockName,
      });

      if (parsed.collectDrops) {
        await sleep(120, context.signal);
        await collectNearbyDrops(context.bot, context.movement, context.signal, 4, 4);
      }

      if (context.bot.entity.position.distanceTo(targetPos) > parsed.radius * 2) {
        break;
      }
    }

    if (mined.length === 0) {
      if (!anyBlockFound) {
        throw new Error(`mine_failed:no_${parsed.blockName}_within_r${parsed.radius}`);
      }
      throw new Error(`mine_failed:could_not_reach_any_${parsed.blockName}`);
    }

    return { mined: mined.length, blocks: mined };
  },
};

const craftTool: ToolDefinition = {
  name: "craft",
  description:
    "Craft an item using its Minecraft ID. Automatically finds or places a crafting table when needed. " +
    "Works for any valid Minecraft recipe if you have the ingredients.",
  argsHint: {
    itemName: "Minecraft item ID (underscore_format). E.g. 'wooden_pickaxe', 'torch', 'stick', 'bread', 'wooden_sword'",
    count: "quantity to craft (default 1)",
  },
  argsSchema: z.object({
    itemName: z.string().min(1),
    count: z.number().int().min(1).max(64).default(1),
  }),
  preconditions: ["required ingredients must be in inventory"],
  run: async (args, context) => {
    const parsed = craftTool.argsSchema.parse(args);
    const bot = context.bot;

    const item = (bot.registry as any).itemsByName?.[parsed.itemName];
    if (!item) {
      throw new Error(`unknown_item:${parsed.itemName}`);
    }

    const countBefore = bot.inventory.items()
      .filter((i) => i.type === item.id)
      .reduce((sum, i) => sum + i.count, 0);

    // Helper: find or place a crafting table, navigate to it, return the Block
    const acquireTable = async (): Promise<any> => {
      let table = bot.findBlock({
        matching: (block: any) => block?.name === "crafting_table",
        maxDistance: 32,
      });

      if (!table) {
        const tableItem = findItemByName(bot, "crafting_table");
        if (!tableItem) {
          throw new Error("crafting_table_needed_but_missing");
        }

        for (const offset of neighborOffsets()) {
          throwIfAborted(context.signal);
          const floorPos = bot.entity.position.offset(offset.x, -1, offset.z).floored();
          const abovePos = floorPos.offset(0, 1, 0);
          const floor = bot.blockAt(floorPos);
          const above = bot.blockAt(abovePos);
          if (!isSolidBlock(floor) || !above || above.name !== "air") continue;
          try {
            await bot.equip(tableItem, "hand");
            await bot.placeBlock(floor, new Vec3(0, 1, 0));
            table = bot.findBlock({
              matching: (block: any) => block?.name === "crafting_table",
              maxDistance: 8,
            });
            if (table) break;
          } catch { /* try next position */ }
        }
      }

      if (!table) throw new Error("crafting_table_unavailable");
      await gotoNear(context.movement, table.position.x, table.position.y, table.position.z, 3, context.signal);
      return table;
    };

    // Strategy: try WITH a table first (covers 3x3 recipes), fall back to without.
    // This is necessary because mineflayer's recipesFor(id,null,1,null) can
    // incorrectly return 3x3 recipes on some versions, causing bot.craft() to
    // silently fail when table is null.
    let crafted = false;

    // 1) Try with crafting table (handles all recipe sizes)
    try {
      const table = await acquireTable();
      const tableRecipes = bot.recipesFor(item.id, null, 1, table);
      if (tableRecipes.length > 0) {
        await bot.craft(tableRecipes[0], parsed.count, table);
        crafted = true;
      }
    } catch {
      // No table available or navigation failed — try without
    }

    // 2) Verify table craft actually worked
    if (crafted) {
      const countAfter = bot.inventory.items()
        .filter((i) => i.type === item.id)
        .reduce((sum, i) => sum + i.count, 0);
      if (countAfter > countBefore) {
        return { crafted: countAfter - countBefore, item: parsed.itemName };
      }
      crafted = false; // table craft silently failed
    }

    // 3) Fall back to 2x2 inventory crafting (planks, sticks, etc.)
    const simpleRecipes = bot.recipesFor(item.id, null, 1, null);
    if (simpleRecipes.length > 0) {
      await bot.craft(simpleRecipes[0], parsed.count, null);
      const countAfter = bot.inventory.items()
        .filter((i) => i.type === item.id)
        .reduce((sum, i) => sum + i.count, 0);
      if (countAfter > countBefore) {
        return { crafted: countAfter - countBefore, item: parsed.itemName };
      }
    }

    throw new Error(`craft_failed:${parsed.itemName}_not_produced — check ingredients or crafting table access`);
  },
};

const buildTool: ToolDefinition = {
  name: "build",
  description: "Place a block at the requested coordinates.",
  argsHint: {
    blockName: "inventory block id or partial name",
    x: "target x",
    y: "target y",
    z: "target z",
  },
  argsSchema: z.object({
    blockName: z.string().min(1),
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
  preconditions: ["block must exist in inventory", "target must have adjacent support"],
  run: async (args, context) => {
    const parsed = buildTool.argsSchema.parse(args);

    const item = findItemByName(context.bot, parsed.blockName) ?? findItemByNameLike(context.bot, parsed.blockName);
    if (!item) {
      throw new Error(`missing_block_item:${parsed.blockName}`);
    }

    const targetPos = new Vec3(Math.floor(parsed.x), Math.floor(parsed.y), Math.floor(parsed.z));
    const existing = context.bot.blockAt(targetPos);
    if (isSolidBlock(existing)) {
      throw new Error(`target_occupied:${existing.name}`);
    }

    await gotoNear(context.movement, targetPos.x, targetPos.y, targetPos.z, 2, context.signal);
    await context.bot.equip(item, "hand");

    for (const offset of neighborOffsets()) {
      throwIfAborted(context.signal);

      const refPos = targetPos.plus(offset);
      const refBlock = context.bot.blockAt(refPos);
      if (!isSolidBlock(refBlock)) {
        continue;
      }

      const face = new Vec3(-offset.x, -offset.y, -offset.z);
      await context.bot.placeBlock(refBlock, face);
      return {
        placed: true,
        block: item.name,
        position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      };
    }

    throw new Error("no_adjacent_support_block");
  },
};

const chopTool: ToolDefinition = {
  name: "chop",
  description: "Chop nearby logs and collect drops.",
  argsHint: {
    radius: "search radius",
    maxLogs: "maximum logs to break",
  },
  argsSchema: z.object({
    radius: z.number().min(6).max(64).default(24),
    maxLogs: z.number().int().min(1).max(64).default(12),
  }),
  preconditions: ["tree logs must be nearby"],
  run: async (args, context) => {
    const parsed = chopTool.argsSchema.parse(args);
    await equipBestByKeyword(context.bot, "axe");

    const logIds = Object.values((context.bot.registry as any).blocksByName ?? {})
      .filter((block: any) => block.name.includes("_log"))
      .map((block: any) => block.id);

    if (logIds.length === 0) {
      throw new Error("log_block_registry_empty");
    }

    const chopped: string[] = [];
    const skipped = new Set<string>();
    let attempts = 0;
    const maxAttempts = Math.max(parsed.maxLogs * 8, 16);
    let anyLogFound = false;
    let chopExpansions = 0;
    const MAX_CHOP_EXPANSIONS = 2;

    while (chopped.length < parsed.maxLogs && attempts < maxAttempts) {
      throwIfAborted(context.signal);
      attempts += 1;

      const target = findNearestBlock(context.bot, logIds, parsed.radius, skipped);

      if (!target) {
        if (chopExpansions < MAX_CHOP_EXPANSIONS) {
          chopExpansions++;
          context.emit("tool_progress", {
            source: "chop",
            phase: "expanding_search",
            expansion: chopExpansions,
          });
          const pos = context.bot.entity.position;
          const angle = Math.random() * Math.PI * 2;
          const dx = Math.cos(angle) * 32;
          const dz = Math.sin(angle) * 32;
          try {
            await gotoNear(context.movement, pos.x + dx, pos.y, pos.z + dz, 5, context.signal);
          } catch { /* best effort */ }
          continue;
        }
        break;
      }

      anyLogFound = true;
      const targetPos = target.position.clone();
      const targetKey = blockPosKey(targetPos);

      context.emit("tool_progress", {
        source: "chop",
        phase: "approaching",
        chopped: chopped.length,
        target: parsed.maxLogs,
        block: target.name,
        position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      });

      await equipBestByKeyword(context.bot, "axe");

      const dig = await digWithRetries(context, targetPos, "chop");
      if (dig.ok === false) {
        skipped.add(targetKey);
        context.emit("tool_progress", {
          source: "chop",
          phase: "skip_target",
          reason: dig.reason,
          position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
        });
        continue;
      }

      chopped.push(dig.blockName);
      context.emit("tool_progress", {
        source: "chop",
        phase: "chopped",
        chopped: chopped.length,
        target: parsed.maxLogs,
        block: dig.blockName,
      });
      await sleep(100, context.signal);
      await collectNearbyDrops(context.bot, context.movement, context.signal, 6, 6);
    }

    if (chopped.length === 0) {
      if (!anyLogFound) {
        throw new Error(`chop_failed:no_logs_within_r${parsed.radius}`);
      }
      throw new Error("chop_failed:could_not_reach_any_log");
    }

    return { chopped: chopped.length, logs: chopped };
  },
};

const fightTool: ToolDefinition = {
  name: "fight",
  description: "Engage nearby hostiles with melee attacks.",
  argsHint: { radius: "engagement radius", maxKills: "maximum kills to attempt" },
  argsSchema: z.object({
    radius: z.number().min(4).max(48).default(16),
    maxKills: z.number().int().min(1).max(30).default(6),
  }),
  preconditions: ["hostile mobs nearby", "adequate health/gear recommended"],
  run: async (args, context) => {
    const parsed = fightTool.argsSchema.parse(args);

    const weapons = context.bot.inventory
      .items()
      .filter((item) => item.name.includes("sword") || item.name.includes("_axe"));

    if (weapons.length > 0) {
      weapons.sort((a, b) => {
        const aSword = a.name.includes("sword") ? 0 : 1;
        const bSword = b.name.includes("sword") ? 0 : 1;
        if (aSword !== bSword) {
          return aSword - bSword;
        }
        const tier = ["netherite", "diamond", "iron", "golden", "stone", "wooden"];
        const ai = tier.findIndex((name) => a.name.includes(name));
        const bi = tier.findIndex((name) => b.name.includes(name));
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      await context.bot.equip(weapons[0], "hand").catch(() => undefined);
    }

    const killed: string[] = [];
    let lastAttackAt = 0;
    const skippedIds = new Set<number>();
    const abortableSleep = (ms: number) => sleep(ms, context.signal);

    for (let i = 0; i < parsed.maxKills; i += 1) {
      throwIfAborted(context.signal);

      const target = Object.values(context.bot.entities)
        .filter((entity) => entity.type === "mob" && HOSTILE_MOBS.has(entity.name) && !skippedIds.has(entity.id) && entity.position.distanceTo(context.bot.entity.position) < parsed.radius)
        .sort((a, b) => a.position.distanceTo(context.bot.entity.position) - b.position.distanceTo(context.bot.entity.position))[0];

      if (!target) {
        break;
      }

      try {
        await gotoNear(context.movement, target.position.x, target.position.y, target.position.z, 3, context.signal);
      } catch (navError) {
        if (context.signal.aborted) throw navError;
        skippedIds.add(target.id);
        i -= 1;
        continue;
      }

      while ((target as any).isValid && target.position.distanceTo(context.bot.entity.position) < parsed.radius + 2) {
        throwIfAborted(context.signal);

        const dist = target.position.distanceTo(context.bot.entity.position);
        if (dist > MELEE_REACH + 0.5) {
          context.bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2), true);
        } else {
          context.bot.pathfinder.setGoal(null);
        }

        const now = Date.now();
        const cooldown = getAttackCooldownMs(context.bot);
        if (now - lastAttackAt >= cooldown && isInMeleeRange(context.bot, target)) {
          const hit = await sprintHitAttack(context.bot, target, abortableSleep);
          if (hit) lastAttackAt = Date.now();
        }

        await sleep(50, context.signal);
      }

      context.bot.pathfinder.setGoal(null);
      if (!(target as any).isValid) {
        killed.push(target.name);
      }
    }

    return { killed: killed.length, mobs: killed };
  },
};

const farmTool: ToolDefinition = {
  name: "farm",
  description: "Harvest mature crops and replant when seeds are available.",
  argsHint: { radius: "search radius" },
  argsSchema: z.object({
    radius: z.number().min(4).max(48).default(16),
  }),
  preconditions: ["mature crops nearby"],
  run: async (args, context) => {
    const parsed = farmTool.argsSchema.parse(args);

    const cropInfo: Record<string, { maxAge: number; seed: string }> = {
      wheat: { maxAge: 7, seed: "wheat_seeds" },
      carrots: { maxAge: 7, seed: "carrot" },
      potatoes: { maxAge: 7, seed: "potato" },
      beetroots: { maxAge: 3, seed: "beetroot_seeds" },
    };

    const cropIds = Object.keys(cropInfo)
      .map((name) => (context.bot.registry as any).blocksByName?.[name]?.id)
      .filter(Boolean);

    const positions = context.bot.findBlocks({
      matching: cropIds,
      maxDistance: parsed.radius,
      count: 100,
    });

    const mature = positions.filter((position) => {
      const block = context.bot.blockAt(position);
      if (!block) {
        return false;
      }
      const info = cropInfo[block.name];
      return Boolean(info && Number(block.metadata) === info.maxAge);
    });

    let harvested = 0;
    let replanted = 0;

    for (const pos of mature) {
      throwIfAborted(context.signal);

      const block = context.bot.blockAt(pos);
      if (!block || !cropInfo[block.name]) {
        continue;
      }

      try {
        await gotoNear(context.movement, pos.x, pos.y, pos.z, 3, context.signal);
      } catch (navError) {
        if (context.signal.aborted) {
          throw navError;
        }
        continue;
      }

      const freshBlock = context.bot.blockAt(pos);
      if (!freshBlock || !cropInfo[freshBlock.name]) {
        continue;
      }

      try {
        await context.bot.dig(freshBlock, true, 'raycast');
      } catch (digError) {
        if (context.signal.aborted) {
          throw digError;
        }
        continue;
      }
      harvested += 1;
      await sleep(150, context.signal);

      const info = cropInfo[block.name];
      const seed = findItemByName(context.bot, info.seed);
      const farmland = context.bot.blockAt(pos.offset(0, -1, 0));
      if (!seed || !farmland || farmland.name !== "farmland") {
        continue;
      }

      await context.bot.equip(seed, "hand");
      await context.bot.placeBlock(farmland, new Vec3(0, 1, 0));
      replanted += 1;
      await sleep(80, context.signal);
    }

    return { harvested, replanted };
  },
};

const smeltTool: ToolDefinition = {
  name: "smelt",
  description: "Smelt items in a furnace (places one if needed). Supported inputs: raw_iron, raw_gold, raw_copper, iron_ore, gold_ore, cobblestone, sand, clay_ball, raw_beef, raw_porkchop, raw_chicken, raw_cod, raw_salmon, potato, kelp, ancient_debris.",
  argsHint: {
    inputName: "Minecraft item ID to smelt. E.g. 'raw_iron', 'raw_beef', 'cobblestone', 'sand'",
    count: "how many items to smelt (default 1)",
  },
  argsSchema: z.object({
    inputName: z.string().min(1),
    count: z.number().int().min(1).max(64).default(1),
  }),
  preconditions: ["input and fuel must exist in inventory"],
  run: async (args, context) => {
    const parsed = smeltTool.argsSchema.parse(args);

    const smeltMap: Record<string, string> = {
      raw_iron: "iron_ingot",
      raw_gold: "gold_ingot",
      raw_copper: "copper_ingot",
      iron_ore: "iron_ingot",
      gold_ore: "gold_ingot",
      copper_ore: "copper_ingot",
      cobblestone: "stone",
      sand: "glass",
      red_sand: "glass",
      clay_ball: "brick",
      netherrack: "nether_brick",
      raw_cod: "cooked_cod",
      raw_salmon: "cooked_salmon",
      raw_beef: "cooked_beef",
      raw_porkchop: "cooked_porkchop",
      raw_chicken: "cooked_chicken",
      raw_mutton: "cooked_mutton",
      raw_rabbit: "cooked_rabbit",
      potato: "baked_potato",
      kelp: "dried_kelp",
      ancient_debris: "netherite_scrap",
    };

    const output = smeltMap[parsed.inputName];
    if (!output) {
      throw new Error(`no_smelt_recipe:${parsed.inputName}`);
    }

    const inputItem = findItemByName(context.bot, parsed.inputName);
    if (!inputItem || inputItem.count < parsed.count) {
      throw new Error(`insufficient_input:${parsed.inputName}`);
    }

    const fuelPriority = [
      { name: "coal", smelts: 8 },
      { name: "charcoal", smelts: 8 },
      { name: "oak_planks", smelts: 1.5 },
      { name: "spruce_planks", smelts: 1.5 },
      { name: "birch_planks", smelts: 1.5 },
      { name: "jungle_planks", smelts: 1.5 },
      { name: "acacia_planks", smelts: 1.5 },
      { name: "dark_oak_planks", smelts: 1.5 },
      { name: "stick", smelts: 0.5 },
    ];

    let fuelItem: any = null;
    let fuelNeeded = 0;
    for (const fuel of fuelPriority) {
      const candidate = findItemByName(context.bot, fuel.name);
      if (!candidate) {
        continue;
      }
      const needed = Math.ceil(parsed.count / fuel.smelts);
      if (candidate.count >= needed) {
        fuelItem = candidate;
        fuelNeeded = needed;
        break;
      }
    }

    if (!fuelItem) {
      throw new Error("missing_fuel");
    }

    const furnaceNames = new Set(["furnace", "blast_furnace", "smoker"]);
    let furnaceBlock = context.bot.findBlock({
      matching: (block) => Boolean(block && furnaceNames.has(block.name)),
      maxDistance: 32,
    });

    if (!furnaceBlock) {
      const furnaceItem =
        findItemByName(context.bot, "furnace") ??
        findItemByName(context.bot, "blast_furnace") ??
        findItemByName(context.bot, "smoker");
      if (!furnaceItem) {
        throw new Error("missing_furnace");
      }

      for (const offset of neighborOffsets()) {
        throwIfAborted(context.signal);
        const floorPos = context.bot.entity.position.offset(offset.x, -1, offset.z).floored();
        const abovePos = floorPos.offset(0, 1, 0);
        const floor = context.bot.blockAt(floorPos);
        const above = context.bot.blockAt(abovePos);
        if (!isSolidBlock(floor) || !above || above.name !== "air") {
          continue;
        }
        try {
          await context.bot.equip(furnaceItem, "hand");
          await context.bot.placeBlock(floor, new Vec3(0, 1, 0));
          furnaceBlock = context.bot.findBlock({
            matching: (block) => Boolean(block && furnaceNames.has(block.name)),
            maxDistance: 8,
          });
          if (furnaceBlock) {
            break;
          }
        } catch {
          // keep trying nearby placements
        }
      }
    }

    if (!furnaceBlock) {
      throw new Error("furnace_unavailable");
    }

    await gotoNear(
      context.movement,
      furnaceBlock.position.x,
      furnaceBlock.position.y,
      furnaceBlock.position.z,
      2,
      context.signal,
    );

    const furnace: any = await (context.bot as any).openFurnace(furnaceBlock);
    await furnace.putFuel(fuelItem.type, null, fuelNeeded);
    await furnace.putInput(inputItem.type, null, parsed.count);

    const timeoutMs = parsed.count * 12_000 + 15_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(context.signal);
      const out = furnace.outputItem?.();
      if (out && out.count >= parsed.count) {
        break;
      }
      await sleep(500, context.signal);
    }

    const finalOutput = furnace.outputItem?.();
    if (!finalOutput || finalOutput.count === 0) {
      furnace.close();
      throw new Error("smelt_timeout_or_failed");
    }

    await furnace.takeOutput();
    furnace.close();

    return { smelted: Math.min(parsed.count, finalOutput.count), item: output };
  },
};

/* ── ensureTool ────────────────────────────────────────────────────── */

const TOOL_TIERS = ["netherite", "diamond", "iron", "golden", "stone", "wooden"] as const;
type ToolTier = typeof TOOL_TIERS[number];
type ToolType = "pickaxe" | "axe" | "shovel" | "sword";

function invCount(bot: Bot, name: string): number {
  return bot.inventory.items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0);
}

function invCountLike(bot: Bot, substr: string): number {
  return bot.inventory.items()
    .filter((i) => i.name.includes(substr))
    .reduce((sum, i) => sum + i.count, 0);
}

/**
 * Internal: gather a resource type by finding and digging matching blocks.
 * Simpler than mineTool — just enough to bootstrap tool crafting.
 */
async function gatherBlocks(
  context: ToolContext,
  namePattern: string,
  count: number,
  searchRadius: number,
  toolKeyword?: "pickaxe" | "axe" | "shovel",
): Promise<{ gathered: number }> {
  if (toolKeyword) {
    await equipBestByKeyword(context.bot, toolKeyword);
  }

  const blockEntries = Object.values((context.bot.registry as any).blocksByName ?? {}) as Array<{ id: number; name: string }>;
  const matchingIds = blockEntries
    .filter((b) => b.name.includes(namePattern))
    .map((b) => b.id);
  if (matchingIds.length === 0) return { gathered: 0 };

  let gathered = 0;
  const skipped = new Set<string>();
  let attempts = 0;
  const maxAttempts = count * 6;

  while (gathered < count && attempts < maxAttempts) {
    throwIfAborted(context.signal);
    attempts++;

    const target = findNearestBlock(context.bot, matchingIds, searchRadius, skipped);
    if (!target) break;

    const targetPos = target.position.clone();
    const dig = await digWithRetries(context, targetPos, "mine");
    if (!dig.ok) {
      skipped.add(blockPosKey(targetPos));
      continue;
    }

    gathered++;
    await sleep(120, context.signal);
    await collectNearbyDrops(context.bot, context.movement, context.signal, 6, 4);
  }

  return { gathered };
}

/**
 * Internal: try to craft an item. Uses table-first strategy and verifies
 * the item actually appears in inventory (guards against silent craft failures).
 */
async function tryCraft(
  context: ToolContext,
  itemName: string,
  count: number,
): Promise<boolean> {
  const bot = context.bot;
  const item = (bot.registry as any).itemsByName?.[itemName];
  if (!item) return false;

  const countBefore = bot.inventory.items()
    .filter((i) => i.type === item.id)
    .reduce((sum, i) => sum + i.count, 0);

  // 1) Try with a crafting table first (covers all recipe sizes)
  let table: any = bot.findBlock({
    matching: (block: any) => block?.name === "crafting_table",
    maxDistance: 32,
  });

  if (!table) {
    const tableItem = findItemByName(bot, "crafting_table");
    if (tableItem) {
      for (const offset of neighborOffsets()) {
        throwIfAborted(context.signal);
        const floorPos = bot.entity.position.offset(offset.x, -1, offset.z).floored();
        const abovePos = floorPos.offset(0, 1, 0);
        const floor = bot.blockAt(floorPos);
        const above = bot.blockAt(abovePos);
        if (!isSolidBlock(floor) || !above || above.name !== "air") continue;
        try {
          await bot.equip(tableItem, "hand");
          await bot.placeBlock(floor, new Vec3(0, 1, 0));
          table = bot.findBlock({
            matching: (block: any) => block?.name === "crafting_table",
            maxDistance: 8,
          });
          if (table) break;
        } catch { /* try next */ }
      }
    }
  }

  if (table) {
    try {
      await gotoNear(context.movement, table.position.x, table.position.y, table.position.z, 3, context.signal);
      const tableRecipes = bot.recipesFor(item.id, null, count, table);
      if (tableRecipes.length > 0) {
        await bot.craft(tableRecipes[0], count, table);
        const countAfter = bot.inventory.items()
          .filter((i) => i.type === item.id)
          .reduce((sum, i) => sum + i.count, 0);
        if (countAfter > countBefore) return true;
      }
    } catch { /* fall through to 2x2 */ }
  }

  // 2) Fall back to 2x2 inventory crafting (planks, sticks, etc.)
  try {
    const simpleRecipes = bot.recipesFor(item.id, null, count, null);
    if (simpleRecipes.length > 0) {
      await bot.craft(simpleRecipes[0], count, null);
      const countAfter = bot.inventory.items()
        .filter((i) => i.type === item.id)
        .reduce((sum, i) => sum + i.count, 0);
      if (countAfter > countBefore) return true;
    }
  } catch { /* failed */ }

  return false;
}

const ensureToolTool: ToolDefinition = {
  name: "ensure_tool",
  description:
    "Ensure a specific tool type is available at a minimum tier. " +
    "Automatically gathers materials and crafts the full dependency chain " +
    "(logs → planks → sticks → crafting table → tool). " +
    "Will equip the tool when done. Use this before mining or chopping when " +
    "the bot has no tools.",
  argsHint: {
    toolType: "pickaxe | axe | shovel | sword",
    minTier: "wooden | stone | iron (default: wooden)",
  },
  argsSchema: z.object({
    toolType: z.enum(["pickaxe", "axe", "shovel", "sword"]),
    minTier: z.enum(["wooden", "stone", "iron"]).default("wooden"),
  }),
  preconditions: [],
  run: async (args, context) => {
    const parsed = ensureToolTool.argsSchema.parse(args) as {
      toolType: ToolType;
      minTier: "wooden" | "stone" | "iron";
    };
    const { toolType, minTier } = parsed;
    const tierIdx = TOOL_TIERS.indexOf(minTier as ToolTier);

    // 1) Check if we already have a suitable tool
    const existing = context.bot.inventory.items().filter((i) => {
      if (toolType === "axe") return i.name.includes("_axe");
      return i.name.includes(toolType);
    });

    if (existing.length > 0) {
      existing.sort((a, b) => {
        const ai = TOOL_TIERS.findIndex((t) => a.name.includes(t));
        const bi = TOOL_TIERS.findIndex((t) => b.name.includes(t));
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      const bestIdx = TOOL_TIERS.findIndex((t) => existing[0].name.includes(t));
      if (bestIdx !== -1 && bestIdx <= tierIdx) {
        try { await context.bot.equip(existing[0], "hand"); } catch { /* ok */ }
        return { equipped: existing[0].name, crafted: false, hadExisting: true };
      }
    }

    context.emit("tool_progress", {
      source: "ensure_tool",
      phase: "bootstrapping",
      toolType,
      minTier,
    });

    // 2) Ensure sticks (need at least 2)
    if (invCount(context.bot, "stick") < 2) {
      // Need planks for sticks (at least 2 planks → 4 sticks)
      if (invCountLike(context.bot, "planks") < 2) {
        // Need logs for planks
        if (invCountLike(context.bot, "log") < 1) {
          context.emit("tool_progress", {
            source: "ensure_tool",
            phase: "gathering_logs",
            toolType,
          });
          await equipBestByKeyword(context.bot, "axe");
          const logResult = await gatherBlocks(context, "_log", 3, 32, "axe");
          if (logResult.gathered === 0) {
            throw new Error("ensure_tool_failed:cannot_find_logs");
          }
        }

        // Craft logs → planks
        const logItem = context.bot.inventory.items().find((i) => i.name.includes("log"));
        if (logItem) {
          const plankName = logItem.name.replace("_log", "_planks");
          const crafted = await tryCraft(context, plankName, 2)
            || await tryCraft(context, "oak_planks", 2);
          if (!crafted) {
            throw new Error("ensure_tool_failed:cannot_craft_planks");
          }
        }
      }

      // Craft planks → sticks
      const crafted = await tryCraft(context, "stick", 1);
      if (!crafted) {
        throw new Error("ensure_tool_failed:cannot_craft_sticks");
      }
    }

    // 3) Ensure crafting table exists if we need a 3x3 recipe
    const needsTable = true; // All tools are 3x3
    if (needsTable) {
      const existingTable = context.bot.findBlock({
        matching: (block: any) => block?.name === "crafting_table",
        maxDistance: 32,
      });

      if (!existingTable && !findItemByName(context.bot, "crafting_table")) {
        // Need to craft one (4 planks)
        if (invCountLike(context.bot, "planks") < 4) {
          if (invCountLike(context.bot, "log") < 1) {
            await gatherBlocks(context, "_log", 2, 32, "axe");
          }
          const logItem = context.bot.inventory.items().find((i) => i.name.includes("log"));
          if (logItem) {
            const plankName = logItem.name.replace("_log", "_planks");
            await tryCraft(context, plankName, 2) || await tryCraft(context, "oak_planks", 2);
          }
        }

        const tableCrafted = await tryCraft(context, "crafting_table", 1);
        if (!tableCrafted) {
          throw new Error("ensure_tool_failed:cannot_craft_crafting_table");
        }
      }
    }

    // 4) For stone tier: ensure cobblestone
    if (minTier === "stone") {
      if (invCount(context.bot, "cobblestone") < 3) {
        context.emit("tool_progress", {
          source: "ensure_tool",
          phase: "gathering_cobblestone",
          toolType,
        });
        // We might need a wooden pickaxe first to mine stone
        const hasPickaxe = context.bot.inventory.items().some((i) => i.name.includes("pickaxe"));
        if (!hasPickaxe) {
          const wpCrafted = await tryCraft(context, "wooden_pickaxe", 1);
          if (wpCrafted) {
            await equipBestByKeyword(context.bot, "pickaxe");
          }
        } else {
          await equipBestByKeyword(context.bot, "pickaxe");
        }
        const stoneResult = await gatherBlocks(context, "stone", 3, 16, "pickaxe");
        if (stoneResult.gathered === 0 && invCount(context.bot, "cobblestone") < 3) {
          throw new Error("ensure_tool_failed:cannot_mine_stone");
        }
      }
    }

    // 5) For iron tier: check if we have enough ingots (smelting not automated here)
    if (minTier === "iron") {
      if (invCount(context.bot, "iron_ingot") < 3) {
        throw new Error("ensure_tool_failed:need_3_iron_ingot_use_smelt_tool_first");
      }
    }

    // 6) Craft the target tool
    const toolName = `${minTier}_${toolType}`;
    context.emit("tool_progress", {
      source: "ensure_tool",
      phase: "crafting",
      item: toolName,
    });

    const crafted = await tryCraft(context, toolName, 1);
    if (!crafted) {
      throw new Error(`ensure_tool_failed:craft_${toolName}_failed`);
    }

    // 7) Equip it
    const newTool = context.bot.inventory.items().find((i) => i.name === toolName);
    if (newTool) {
      try { await context.bot.equip(newTool, "hand"); } catch { /* ok */ }
    }

    return { equipped: toolName, crafted: true, tier: minTier, type: toolType };
  },
};

/* ── survey ────────────────────────────────────────────────────────── */

const ANIMAL_TYPES = new Set([
  "cow", "pig", "sheep", "chicken", "horse", "donkey", "mule",
  "rabbit", "fox", "wolf", "cat", "ocelot", "bee", "goat",
  "llama", "turtle", "dolphin", "squid", "cod", "salmon",
  "axolotl", "frog", "camel", "sniffer",
]);

const surveyTool: ToolDefinition = {
  name: "survey",
  description:
    "Scan the area for resources, mobs, animals, dropped items, players, and hazards. " +
    "Returns block counts, nearest positions, entity lists, and ore breakdown. " +
    "Use before deciding what to do next.",
  argsHint: { radius: "scan radius in blocks (default 48, max 64)" },
  argsSchema: z.object({
    radius: z.number().min(8).max(64).default(48),
  }),
  preconditions: [],
  run: async (args, context) => {
    const parsed = surveyTool.argsSchema.parse(args);
    const bot = context.bot;
    const p = bot.entity.position;
    const r = parsed.radius;
    const registry = bot.registry as any;

    const nearest = (positions: any[]) => {
      if (positions.length === 0) return null;
      let best = positions[0];
      let bestDist = best.distanceTo(p);
      for (let i = 1; i < positions.length; i++) {
        const d = positions[i].distanceTo(p);
        if (d < bestDist) { best = positions[i]; bestDist = d; }
      }
      return { x: best.x, y: best.y, z: best.z };
    };

    // Logs
    const logIds = Object.values(registry.blocksByName ?? {})
      .filter((b: any) => b.name.includes("log"))
      .map((b: any) => b.id);
    const logs = bot.findBlocks({ matching: logIds, maxDistance: r, count: 500 });

    // Ores
    const oreIds = Object.values(registry.blocksByName ?? {})
      .filter((b: any) => b.name.includes("ore"))
      .map((b: any) => b.id);
    const ores = bot.findBlocks({ matching: oreIds, maxDistance: r, count: 500 });
    const oreCounts: Record<string, number> = {};
    const nearestOre: Record<string, { x: number; y: number; z: number }> = {};
    for (const pos of ores) {
      const block = bot.blockAt(pos);
      if (!block) continue;
      oreCounts[block.name] = (oreCounts[block.name] || 0) + 1;
      if (!nearestOre[block.name]) {
        nearestOre[block.name] = { x: pos.x, y: pos.y, z: pos.z };
      }
    }

    // Water & lava
    const waterId = registry.blocksByName?.water?.id;
    const water = waterId ? bot.findBlocks({ matching: waterId, maxDistance: r, count: 200 }) : [];
    const lavaId = registry.blocksByName?.lava?.id;
    const lava = lavaId ? bot.findBlocks({ matching: lavaId, maxDistance: r, count: 200 }) : [];

    // Entities
    const entities = Object.values(bot.entities) as any[];
    const nearby = entities.filter((e: any) => e !== bot.entity && e.position.distanceTo(p) < r);

    const players = nearby
      .filter((e: any) => e.type === "player")
      .map((e: any) => ({
        name: e.username || e.name,
        position: { x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1) },
        distance: +e.position.distanceTo(p).toFixed(1),
      }));

    const hostiles = nearby
      .filter((e: any) => e.type === "mob" && HOSTILE_MOBS.has(e.name))
      .sort((a: any, b: any) => a.position.distanceTo(p) - b.position.distanceTo(p))
      .slice(0, 12)
      .map((e: any) => ({
        name: e.name,
        position: { x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1) },
        distance: +e.position.distanceTo(p).toFixed(1),
      }));

    const animals = nearby
      .filter((e: any) => ANIMAL_TYPES.has(e.name))
      .sort((a: any, b: any) => a.position.distanceTo(p) - b.position.distanceTo(p))
      .slice(0, 12)
      .map((e: any) => ({
        name: e.name,
        position: { x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1) },
        distance: +e.position.distanceTo(p).toFixed(1),
      }));

    const droppedItems = nearby
      .filter((e: any) => e.name === "item" || e.name === "item_stack")
      .sort((a: any, b: any) => a.position.distanceTo(p) - b.position.distanceTo(p))
      .slice(0, 15)
      .map((e: any) => {
        const dropped = (e as any).getDroppedItem?.();
        return {
          name: dropped?.name || "unknown",
          count: dropped?.count || 1,
          distance: +e.position.distanceTo(p).toFixed(1),
        };
      });

    // Hazards
    const hazards: string[] = [];
    if (lava.length > 0) hazards.push(`lava_nearby(${lava.length})`);
    if (bot.health <= 8) hazards.push("low_health");
    if (bot.food <= 6) hazards.push("low_food");
    if (hostiles.length > 0) hazards.push(`hostiles_nearby(${nearby.filter((e: any) => e.type === "mob" && HOSTILE_MOBS.has(e.name)).length})`);

    return {
      position: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) },
      radius: r,
      blocks: {
        logs: logs.length,
        water: water.length,
        lava: lava.length,
        ores: oreCounts,
      },
      nearest: {
        log: nearest(logs),
        water: nearest(water),
        lava: nearest(lava),
        ores: nearestOre,
      },
      entities: {
        players,
        hostiles: { count: nearby.filter((e: any) => e.type === "mob" && HOSTILE_MOBS.has(e.name)).length, nearest: hostiles },
        animals: { count: nearby.filter((e: any) => ANIMAL_TYPES.has(e.name)).length, nearest: animals },
        droppedItems: { count: nearby.filter((e: any) => e.name === "item" || e.name === "item_stack").length, nearest: droppedItems },
      },
      hazards,
      biome: (() => {
        try {
          const block = bot.blockAt(p);
          if (!block?.biome) return "unknown";
          const b = (block as any).biome;
          const id = typeof b === "object" ? b.id : b;
          return (registry as any).biomes?.[id]?.name || `biome:${id}`;
        } catch { return "unknown"; }
      })(),
      time: (bot as any).time?.isDay ? "day" : "night",
    };
  },
};

/* ── recipes ───────────────────────────────────────────────────────── */

const recipesTool: ToolDefinition = {
  name: "recipes",
  description:
    "Check if an item is craftable with current inventory. " +
    "Returns required ingredients, what you have, what's missing, and whether a crafting table is needed. " +
    "Use before crafting to plan material gathering.",
  argsHint: { itemName: "Minecraft item ID (underscore_format). E.g. 'wooden_pickaxe', 'iron_ingot', 'torch'" },
  argsSchema: z.object({
    itemName: z.string().min(1),
  }),
  preconditions: [],
  run: async (args, context) => {
    const parsed = recipesTool.argsSchema.parse(args);
    const bot = context.bot;
    const registry = bot.registry as any;
    const item = registry.itemsByName?.[parsed.itemName];
    if (!item) {
      throw new Error(`unknown_item:${parsed.itemName}`);
    }

    const invCounts: Record<string, number> = {};
    for (const invItem of bot.inventory.items()) {
      invCounts[invItem.name] = (invCounts[invItem.name] || 0) + invItem.count;
    }

    // Try without table first
    const withoutTable = bot.recipesFor(item.id, null, 1, null);
    const tableBlock = bot.findBlock({
      matching: (block: any) => block?.name === "crafting_table",
      maxDistance: 32,
    });
    const withTable = tableBlock ? bot.recipesFor(item.id, null, 1, tableBlock) : [];
    const recipes = withoutTable.length > 0 ? withoutTable : withTable;

    if (recipes.length === 0) {
      // Check if a recipe exists at all in the data
      const allRecipes = registry.recipes?.[item.id];
      if (allRecipes && allRecipes.length > 0) {
        const r = allRecipes[0];
        const ingredients: Record<string, number> = {};
        const inputs = r.inShape ? r.inShape.flat() : r.ingredients || [];
        for (const ing of inputs) {
          if (!ing) continue;
          const id = typeof ing === "object" ? ing.id : ing;
          if (id < 0) continue;
          const name = registry.items?.[id]?.name || `id:${id}`;
          ingredients[name] = (ingredients[name] || 0) + 1;
        }
        const missing: Record<string, number> = {};
        for (const [name, needed] of Object.entries(ingredients)) {
          const have = invCounts[name] || 0;
          if (have < (needed as number)) {
            missing[name] = (needed as number) - have;
          }
        }
        const is3x3 = r.inShape && (r.inShape.length > 2 || (r.inShape[0]?.length || 0) > 2);
        return {
          item: parsed.itemName,
          craftable: false,
          needsTable: !!is3x3,
          ingredients,
          have: invCounts,
          missing,
          reason: Object.keys(missing).length > 0 ? "missing_ingredients" : "no_crafting_table_nearby",
        };
      }
      return { item: parsed.itemName, craftable: false, reason: "no_recipe_exists" };
    }

    // We can craft it
    const recipe = recipes[0];
    const ingredients: Record<string, number> = {};
    for (const row of recipe.delta) {
      if (row.count < 0) {
        const name = registry.items?.[row.id]?.name || `id:${row.id}`;
        ingredients[name] = (ingredients[name] || 0) + Math.abs(row.count);
      }
    }
    return {
      item: parsed.itemName,
      craftable: true,
      needsTable: withoutTable.length === 0,
      ingredients,
    };
  },
};

/* ── dig (precision) ───────────────────────────────────────────────── */

const digTool: ToolDefinition = {
  name: "dig",
  description:
    "Dig a single block at exact coordinates. Navigates to reach, " +
    "equips the best tool for the block type, then breaks it. " +
    "Use for precision work at known positions.",
  argsHint: {
    x: "block x coordinate",
    y: "block y coordinate",
    z: "block z coordinate",
  },
  argsSchema: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
  preconditions: ["block must exist at the given coordinates"],
  run: async (args, context) => {
    const parsed = digTool.argsSchema.parse(args);
    const blockPos = new Vec3(Math.floor(parsed.x), Math.floor(parsed.y), Math.floor(parsed.z));
    const block = context.bot.blockAt(blockPos);
    if (!block || block.name === "air") {
      throw new Error(`no_block_at:${blockPos.x},${blockPos.y},${blockPos.z}`);
    }

    // Auto-equip appropriate tool
    const name = block.name;
    if (name.includes("ore") || name.includes("stone") || name.includes("cobble") || name.includes("deepslate") || name.includes("obsidian")) {
      await equipBestByKeyword(context.bot, "pickaxe");
    } else if (name.includes("log") || name.includes("wood") || name.includes("plank")) {
      await equipBestByKeyword(context.bot, "axe");
    } else if (name.includes("dirt") || name.includes("sand") || name.includes("gravel") || name.includes("clay") || name.includes("soul")) {
      await equipBestByKeyword(context.bot, "shovel");
    }

    const result = await digWithRetries(context, blockPos, "mine");
    if (result.ok === false) {
      throw new Error(`dig_failed:${result.reason}`);
    }
    return { dug: true, block: result.blockName, position: { x: blockPos.x, y: blockPos.y, z: blockPos.z } };
  },
};

/* ── block_info ────────────────────────────────────────────────────── */

const blockInfoTool: ToolDefinition = {
  name: "block_info",
  description:
    "Inspect the block at specific coordinates. " +
    "Returns block name, type, hardness, whether it's diggable, and bounding box. " +
    "Use to check what's at a position before acting.",
  argsHint: {
    x: "block x coordinate",
    y: "block y coordinate",
    z: "block z coordinate",
  },
  argsSchema: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
  preconditions: [],
  run: async (args, _context) => {
    const parsed = blockInfoTool.argsSchema.parse(args);
    const pos = new Vec3(Math.floor(parsed.x), Math.floor(parsed.y), Math.floor(parsed.z));
    const block = _context.bot.blockAt(pos);
    if (!block) {
      return { name: "unloaded", chunkLoaded: false, position: { x: pos.x, y: pos.y, z: pos.z } };
    }
    return {
      name: block.name,
      type: block.type,
      hardness: (block as any).hardness,
      diggable: block.diggable,
      boundingBox: block.boundingBox,
      metadata: block.metadata,
      position: { x: pos.x, y: pos.y, z: pos.z },
      chunkLoaded: true,
    };
  },
};

/* ── equip ─────────────────────────────────────────────────────────── */

const equipTool: ToolDefinition = {
  name: "equip",
  description:
    "Equip a specific item from inventory to a slot. " +
    "Slot is 'hand' by default. Use exact item name from inventory.",
  argsHint: {
    itemName: "exact Minecraft item name from inventory. E.g. 'diamond_sword', 'iron_pickaxe'",
    slot: "equipment slot: hand, head, torso, legs, feet (default: hand)",
  },
  argsSchema: z.object({
    itemName: z.string().min(1),
    slot: z.enum(["hand", "head", "torso", "legs", "feet"]).default("hand"),
  }),
  preconditions: ["item must be in inventory"],
  run: async (args, context) => {
    const parsed = equipTool.argsSchema.parse(args);
    const item = findItemByName(context.bot, parsed.itemName)
      ?? findItemByNameLike(context.bot, parsed.itemName);
    if (!item) {
      throw new Error(`item_not_in_inventory:${parsed.itemName}`);
    }
    await context.bot.equip(item, parsed.slot);
    return { equipped: item.name, slot: parsed.slot };
  },
};

/* ── drop ──────────────────────────────────────────────────────────── */

const dropTool: ToolDefinition = {
  name: "drop",
  description:
    "Drop an item stack from inventory onto the ground. " +
    "Optionally specify a count to drop only part of a stack.",
  argsHint: {
    itemName: "exact Minecraft item name from inventory",
    count: "number to drop (default: entire stack)",
  },
  argsSchema: z.object({
    itemName: z.string().min(1),
    count: z.number().int().min(1).max(64).optional(),
  }),
  preconditions: ["item must be in inventory"],
  run: async (args, context) => {
    const parsed = dropTool.argsSchema.parse(args);
    const item = findItemByName(context.bot, parsed.itemName)
      ?? findItemByNameLike(context.bot, parsed.itemName);
    if (!item) {
      throw new Error(`item_not_in_inventory:${parsed.itemName}`);
    }
    const amount = parsed.count ?? item.count;
    await context.bot.toss(item.type, null, Math.min(amount, item.count));
    return { dropped: item.name, count: Math.min(amount, item.count) };
  },
};

/* ── give ──────────────────────────────────────────────────────────── */

const GIVE_DROP_REACH = 4;

const giveTool: ToolDefinition = {
  name: "give",
  description:
    "Walk to a player and drop items for them to pick up. " +
    "If no item specified, drops all matching items.",
  argsHint: {
    playerName: "player username to give items to",
    itemName: "item name to give (optional, gives all if omitted)",
  },
  argsSchema: z.object({
    playerName: z.string().min(1),
    itemName: z.string().min(1).optional(),
  }),
  preconditions: ["player must be visible", "item must be in inventory"],
  run: async (args, context) => {
    const parsed = giveTool.argsSchema.parse(args);

    const getEntity = () => context.bot.players[parsed.playerName]?.entity;
    let target = getEntity();
    if (!target) {
      throw new Error(`player_not_found:${parsed.playerName}`);
    }

    // Only navigate if not already close enough for item pickup
    const dist = context.bot.entity.position.distanceTo(target.position);
    if (dist > GIVE_DROP_REACH) {
      // Use the player's live position (they may be moving)
      target = getEntity();
      if (!target) throw new Error(`player_not_found:${parsed.playerName}`);
      await gotoNear(
        context.movement,
        target.position.x, target.position.y, target.position.z,
        GIVE_DROP_REACH, context.signal,
      );
    }

    // Look at the player before tossing so items fly toward them
    target = getEntity();
    if (target) {
      try { await context.bot.lookAt(target.position.offset(0, 1, 0)); } catch { /* best effort */ }
    }

    const items = parsed.itemName
      ? context.bot.inventory.items().filter((i) => i.name === parsed.itemName || i.name.includes(parsed.itemName!))
      : context.bot.inventory.items();

    if (items.length === 0) {
      throw new Error(`no_matching_items:${parsed.itemName ?? "any"}`);
    }

    const countsBefore = new Map<number, number>();
    for (const item of items) {
      countsBefore.set(item.type, (countsBefore.get(item.type) ?? 0) + item.count);
    }

    for (const item of items) {
      throwIfAborted(context.signal);
      try {
        await context.bot.toss(item.type, null, item.count);
      } catch { /* best effort */ }
    }

    await sleep(150, context.signal);

    const given: Array<{ name: string; count: number }> = [];
    for (const item of items) {
      const after = context.bot.inventory.items()
        .filter((i) => i.type === item.type)
        .reduce((sum, i) => sum + i.count, 0);
      const before = countsBefore.get(item.type) ?? 0;
      const actuallyGiven = before - after;
      if (actuallyGiven > 0) {
        given.push({ name: item.name, count: actuallyGiven });
      }
    }

    if (given.length === 0) {
      throw new Error(`give_failed:items_did_not_leave_inventory`);
    }

    return { gave: given, to: parsed.playerName };
  },
};

export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition>;

  constructor() {
    const toolList = [
      moveNearPlayerTool,
      followPlayerTool,
      gotoTool,
      pickupTool,
      mineTool,
      craftTool,
      buildTool,
      chopTool,
      fightTool,
      farmTool,
      smeltTool,
      ensureToolTool,
      surveyTool,
      recipesTool,
      digTool,
      blockInfoTool,
      equipTool,
      dropTool,
      giveTool,
    ];
    this.tools = new Map(toolList.map((tool) => [tool.name, tool]));
  }

  listMetadata(): Array<{ name: string; description: string; args: string }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      args: Object.entries(tool.argsHint)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; "),
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async run(name: string, args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`unknown_tool:${name}`);
    }

    const parsed = tool.argsSchema.parse(args);
    return tool.run(parsed as Record<string, unknown>, context);
  }
}
