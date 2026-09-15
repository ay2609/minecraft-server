/**
 * Vanilla-accurate melee combat utilities.
 *
 * Provides per-weapon attack cooldowns and a sprint-hit attack function
 * that emulates the knockback bonus from sprint-attacking in vanilla MC.
 */

import type { Bot } from "mineflayer";

const BASE_REACH = 3.0;

const COOLDOWN_TABLE: Record<string, number> = {
  netherite_sword: 625,
  diamond_sword: 625,
  iron_sword: 625,
  golden_sword: 625,
  stone_sword: 625,
  wooden_sword: 625,
  netherite_axe: 1000,
  diamond_axe: 1000,
  golden_axe: 1000,
  iron_axe: 1110,
  stone_axe: 1250,
  wooden_axe: 1250,
};

export function getAttackCooldownMs(bot: Bot): number {
  const held = (bot as any).heldItem?.name || "";
  return COOLDOWN_TABLE[held] ?? 600;
}

export function isInMeleeRange(bot: Bot, target: any, buffer = 0.2): boolean {
  if (!target?.position || !bot?.entity?.position) return false;
  return target.position.distanceTo(bot.entity.position) <= BASE_REACH + buffer;
}

/**
 * Perform a vanilla sprint-hit attack. Toggles sprint off then on before
 * attacking, which grants the extra knockback that vanilla sprint-attacks
 * produce. Aims at the upper body of the target for accurate hit registration.
 *
 * Returns true if the attack was executed, false if the target was invalid
 * or out of range.
 */
export async function sprintHitAttack(
  bot: Bot,
  target: any,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (!(target as any)?.isValid) return false;
  if (!isInMeleeRange(bot, target)) return false;

  try {
    const aimHeight = Math.min(1.6, (target as any).height || 1);
    const aimPoint = target.position.offset(0, aimHeight, 0);
    await bot.lookAt(aimPoint, true);
  } catch { /* best effort */ }

  // Sprint-hit: release sprint, brief pause, then re-enable forward+sprint
  // before attacking. This replicates the vanilla mechanic for bonus knockback.
  if (bot.entity?.onGround) {
    bot.setControlState("sprint", false);
    await sleep(45);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
    await sleep(70);
  }

  await (bot as any).attack(target);

  bot.setControlState("forward", false);
  return true;
}

export const MELEE_REACH = BASE_REACH;
