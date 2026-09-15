import type { Bot } from "mineflayer";
import type { RuntimeConfig } from "../../shared/config.js";
import type { SnapshotData } from "../../shared/protocol.js";
import { toFixedNumber } from "../../shared/utils.js";
import type { ExecutorStatus } from "../executor/executor.js";

// Resource scanning is expensive: 25 findBlocks calls × up to 20-block radius each.
// Cache the result and only re-scan every 3s — resources don't change fast enough
// to warrant blocking the event loop on every 1s snapshot tick.
let cachedNearbyResources: Record<string, number> | undefined;
let lastResourceScanMs = 0;
const RESOURCE_SCAN_INTERVAL_MS = 3_000;

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

export function buildSnapshot(bot: Bot, config: RuntimeConfig, executorStatus: ExecutorStatus): SnapshotData {
  const entity = bot.entity;
  const pos = entity.position;

  const players = Object.values(bot.players)
    .filter((player) => player.username && player.entity)
    .map((player) => {
      const p = player.entity!.position;
      return {
        name: player.username,
        dist: toFixedNumber(pos.distanceTo(p), 2),
        pos: { x: toFixedNumber(p.x), y: toFixedNumber(p.y), z: toFixedNumber(p.z) },
      };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 12);

  const hostiles = Object.values(bot.entities)
    .filter((other) => other.type === "mob" && HOSTILE_MOBS.has(other.name))
    .map((other) => ({
      type: other.name,
      dist: toFixedNumber(pos.distanceTo(other.position), 2),
      pos: {
        x: toFixedNumber(other.position.x),
        y: toFixedNumber(other.position.y),
        z: toFixedNumber(other.position.z),
      },
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 12);

  const hazards: string[] = [];
  if (bot.health <= 8) {
    hazards.push("low_health");
  }
  if (bot.food <= 6) {
    hazards.push("low_food");
  }
  if ((bot.entity as any).isInWater) {
    hazards.push("drowning_risk");
  }
  if (bot.entity.position.y < 1) {
    hazards.push("void_drop");
  }

  const lava = bot.findBlock({
    matching: (block) => block?.name?.includes("lava") ?? false,
    maxDistance: 4,
  });
  if (lava) {
    hazards.push("lava_nearby");
  }

  const notable: string[] = [];
  const names = ["crafting_table", "furnace", "chest", "bed", "anvil"];
  for (const name of names) {
    const block = bot.findBlock({
      matching: (candidate) => candidate?.name === name,
      maxDistance: 10,
    });
    if (block) {
      notable.push(name);
    }
  }

  const RESOURCE_BLOCKS = [
    "dirt", "grass_block", "stone", "cobblestone", "gravel", "sand", "sandstone",
    "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log",
    "oak_leaves", "birch_leaves", "spruce_leaves",
    "coal_ore", "deepslate_coal_ore",
    "iron_ore", "deepslate_iron_ore",
    "gold_ore", "deepslate_gold_ore",
    "diamond_ore", "deepslate_diamond_ore",
    "water",
  ];

  // Only re-scan if the cache is stale. This cuts event loop blocking by ~3×
  // since buildSnapshot is called every 1s but resources rarely change.
  const now = Date.now();
  if (now - lastResourceScanMs >= RESOURCE_SCAN_INTERVAL_MS) {
    lastResourceScanMs = now;
    const freshResources: Record<string, number> = {};
    for (const resourceName of RESOURCE_BLOCKS) {
      const blockType = bot.registry.blocksByName[resourceName];
      if (!blockType) {
        continue;
      }
      const found = bot.findBlocks({
        matching: blockType.id,
        maxDistance: 20,
        count: 20,
      });
      if (found.length > 0) {
        freshResources[resourceName] = found.length;
      }
    }
    cachedNearbyResources = Object.keys(freshResources).length > 0 ? freshResources : undefined;
  }
  const nearbyResources = cachedNearbyResources;

  const items = bot.inventory
    .items()
    .map((item) => ({ name: item.name, count: item.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 48);

  return {
    self: {
      pos: { x: toFixedNumber(pos.x), y: toFixedNumber(pos.y), z: toFixedNumber(pos.z) },
      yaw: toFixedNumber(entity.yaw),
      pitch: toFixedNumber(entity.pitch),
      health: bot.health,
      food: bot.food,
      biome: undefined,
      dimension: bot.game?.dimension,
      timeOfDay: bot.time?.timeOfDay,
    },
    inventory: {
      items,
      equipped: {
        hand: bot.heldItem?.name,
        head: bot.inventory.slots[5]?.name,
        torso: bot.inventory.slots[6]?.name,
        legs: bot.inventory.slots[7]?.name,
        feet: bot.inventory.slots[8]?.name,
      },
    },
    entities: {
      players,
      hostiles,
    },
    environment: {
      hazards,
      notableBlocks: notable.slice(0, 16),
      nearbyResources,
    },
    planStatus: {
      planId: executorStatus.planId,
      stepIndex: executorStatus.stepIndex,
      currentAction: executorStatus.currentAction,
      executorState: executorStatus.state,
    },
  };
}
