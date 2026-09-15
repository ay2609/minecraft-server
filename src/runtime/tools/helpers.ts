import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { sleep } from "../../shared/utils.js";
import { MovementController } from "../movement/controller.js";

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("aborted");
  }
}

export async function gotoNear(
  movement: MovementController,
  x: number,
  y: number,
  z: number,
  radius: number,
  signal: AbortSignal,
): Promise<void> {
  const result = await movement.goto(x, y, z, radius, signal);
  if (!result.reached) {
    throw new Error(`nav_failed:${result.reason}:target=${x},${y},${z}:dist=${result.distRemaining}`);
  }
}

export function findItemByName(bot: Bot, itemName: string) {
  return bot.inventory.items().find((item) => item.name === itemName);
}

export function findItemByNameLike(bot: Bot, partialName: string) {
  const needle = partialName.toLowerCase();
  return bot.inventory.items().find((item) => item.name.toLowerCase().includes(needle));
}

export async function equipBestByKeyword(
  bot: Bot,
  keyword: "pickaxe" | "axe" | "sword" | "shovel",
): Promise<string | null> {
  const tier = ["netherite", "diamond", "iron", "golden", "stone", "wooden"];
  const options = bot.inventory.items().filter((item) => {
    if (keyword === "axe") {
      return item.name.includes("_axe");
    }
    return item.name.includes(keyword);
  });

  if (options.length === 0) {
    return null;
  }

  options.sort((a, b) => {
    const aTier = tier.findIndex((name) => a.name.includes(name));
    const bTier = tier.findIndex((name) => b.name.includes(name));
    return (aTier === -1 ? 99 : aTier) - (bTier === -1 ? 99 : bTier);
  });

  try {
    await bot.equip(options[0], "hand");
    return options[0].name;
  } catch {
    return null;
  }
}

export async function collectNearbyDrops(
  bot: Bot,
  movement: MovementController,
  signal: AbortSignal,
  radius = 10,
  limit = 8,
): Promise<number> {
  const drops = Object.values(bot.entities)
    .filter((entity) => entity.name === "item" && entity.position.distanceTo(bot.entity.position) <= radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    .slice(0, limit);

  let collected = 0;
  for (const drop of drops) {
    throwIfAborted(signal);
    if (!(drop as any).isValid) {
      continue;
    }

    try {
      await gotoNear(movement, drop.position.x, drop.position.y, drop.position.z, 1, signal);
      await sleep(120, signal);
      if (!(drop as any).isValid) {
        collected += 1;
      }
    } catch {
      bot.pathfinder.setGoal(null);
    }
  }

  return collected;
}

export function isSolidBlock(block: any): boolean {
  return Boolean(block && block.name !== "air" && block.boundingBox === "block");
}

export function neighborOffsets(): Vec3[] {
  return [
    new Vec3(0, -1, 0),
    new Vec3(0, 1, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(1, -1, 0),
    new Vec3(-1, -1, 0),
    new Vec3(0, -1, 1),
    new Vec3(0, -1, -1),
  ];
}
