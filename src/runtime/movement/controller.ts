import { goals } from "mineflayer-pathfinder";
import type { Bot } from "mineflayer";

const GoalNear = goals.GoalNear;

export interface MoveResult {
  reached: boolean;
  reason?: "arrived" | "close_enough" | "stalled" | "no_path" | "aborted" | "max_legs" | "stuck";
  finalPos: { x: number; y: number; z: number };
  distRemaining: number;
  legs?: number;
}

interface LegResult {
  ok: boolean;
  moved: number;
  error?: string;
}

// Larger legs = fewer pathfinder restarts = less cold-start overhead.
// At 64 blocks/leg, a 500-block trip needs only ~8 restarts vs ~25 before.
const DEFAULT_LEG_SIZE = 64;
// Slightly more time per leg since legs are 3× larger.
const DEFAULT_LEG_TIMEOUT_MS = 18_000;
// 30 legs × 64 blocks = 1920 blocks max range (vs 80×20=1600 before).
const DEFAULT_MAX_LEGS = 30;
// How often to poll position inside a leg for stuck detection.
const PROGRESS_CHECK_MS = 750;
// Declare stuck if the bot hasn't moved this many blocks in STUCK_TIMEOUT_MS.
const STUCK_TIMEOUT_MS = 2_500;
// Minimum movement per PROGRESS_CHECK_MS interval to not be "stuck".
const STALL_THRESHOLD_BLOCKS = 0.35;
// Oscillation: if no net horizontal progress for this many legs, soft-reset.
const NO_PROGRESS_MAX_LEGS = 3;

export class MovementController {
  private pathListenerInstalled = false;

  constructor(private readonly bot: Bot) {}

  installPathListener(): void {
    if (this.pathListenerInstalled) return;
    this.pathListenerInstalled = true;
  }

  async goto(
    x: number,
    y: number,
    z: number,
    radius: number,
    signal: AbortSignal,
  ): Promise<MoveResult> {
    this.throwIfAborted(signal);

    const tx = Number(x);
    const ty = Number(y);
    const tz = Number(z);
    const goalNearRange = Math.max(Math.floor(radius), 1);
    let noProgressLegs = 0;
    let lastHDist = Infinity;
    let totalLegs = 0;

    const onAbort = () => {
      this.bot.pathfinder.setGoal(null);
      this.bot.clearControlStates();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (!signal.aborted) {
        const pos = this.bot.entity.position;
        const dx = tx - pos.x;
        const dy = ty - pos.y;
        const dz = tz - pos.z;
        const hDist = Math.sqrt(dx ** 2 + dz ** 2);

        if (hDist <= radius && Math.abs(dy) <= Math.max(radius, 2)) {
          return this.buildResult(tx, ty, tz, radius, true, "arrived", totalLegs);
        }

        if (totalLegs >= DEFAULT_MAX_LEGS) {
          return this.buildResult(tx, ty, tz, radius, false, "max_legs", totalLegs);
        }

        // Compute intermediate waypoint for this leg
        let goalX = tx, goalY = ty, goalZ = tz;
        if (hDist > DEFAULT_LEG_SIZE) {
          const ratio = DEFAULT_LEG_SIZE / hDist;
          goalX = Math.floor(pos.x + dx * ratio);
          goalY = Math.floor(pos.y + dy * ratio);
          goalZ = Math.floor(pos.z + dz * ratio);
        }

        // No settle delay between legs — runtime wraps pathfinder.goto and clears
        // stale state via setGoal(null) before each new navigation call.
        const legResult = await this.runLeg(goalX, goalY, goalZ, goalNearRange, signal);
        totalLegs++;

        if (legResult.ok) {
          // Check for arrival at final destination after this leg
          const finalDist = this.hDistTo(tx, tz);
          const finalDy = Math.abs(this.bot.entity.position.y - ty);
          if (finalDist <= radius && finalDy <= Math.max(radius, 2)) {
            return this.buildResult(tx, ty, tz, radius, true, "arrived", totalLegs);
          }

          // Oscillation detection — detect circling without net progress
          const curHDist = this.hDistTo(tx, tz);
          if (curHDist < lastHDist - 0.3) {
            noProgressLegs = 0;
          } else {
            noProgressLegs++;
          }
          lastHDist = curHDist;

          if (noProgressLegs >= NO_PROGRESS_MAX_LEGS) {
            // Soft reset when we appear to be oscillating: clear transient
            // path/control state, then continue re-pathing.
            noProgressLegs = 0;
            this.bot.pathfinder.setGoal(null);
            this.bot.clearControlStates();
          }
        } else {
          // Leg failed (stuck/timeout/no path). runLeg already called
          // pathfinder.stop(); clear controls and retry without manual movement hacks.
          this.bot.pathfinder.setGoal(null);
          this.bot.clearControlStates();
          noProgressLegs = 0;
        }
      }

      return this.buildResult(tx, ty, tz, radius, false, "aborted", totalLegs);
    } finally {
      this.bot.pathfinder.setGoal(null);
      this.bot.clearControlStates();
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Run a single pathfinding leg with two independent failure modes:
   *
   * 1. Real-time stuck detection: a setInterval polls position every PROGRESS_CHECK_MS.
   *    If the bot hasn't moved STALL_THRESHOLD_BLOCKS in STUCK_TIMEOUT_MS, the leg is
   *    aborted immediately — no need to wait for the full 18s leg timeout. This fires in
   *    2.5–3.25s vs the old 15s.
   *
   * 2. Hard leg timeout: failsafe in case pathfinder loops or hangs (18s).
   *
   * Throws Error("aborted") if signal fires. Resolves (not throws) for all other failures
   * so the outer goto() loop can apply recovery logic.
   */
  private async runLeg(
    goalX: number,
    goalY: number,
    goalZ: number,
    range: number,
    signal: AbortSignal,
  ): Promise<LegResult> {
    const startPos = this.bot.entity.position.clone();

    return new Promise<LegResult>((resolve, reject) => {
      let settled = false;
      let lastPos = this.bot.entity.position.clone();
      let lastMovedMs = Date.now();

      const settle = (result: LegResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(legTimer);
        clearInterval(stuckInterval);
        signal.removeEventListener("abort", abortHandler);
        resolve(result);
      };

      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(legTimer);
        clearInterval(stuckInterval);
        signal.removeEventListener("abort", abortHandler);
        reject(new Error("aborted"));
      };

      // Hard per-leg failsafe timeout
      const legTimer = setTimeout(() => {
        this.bot.pathfinder.stop();
        const moved = startPos.distanceTo(this.bot.entity.position);
        settle({ ok: false, moved, error: "leg_timeout" });
      }, DEFAULT_LEG_TIMEOUT_MS);

      // Real-time stuck detection — fires every 750ms.
      // Detects stuck 6–18× faster than the old per-leg stall check.
      const stuckInterval = setInterval(() => {
        if (settled) return;
        const pos = this.bot.entity.position;
        const moved = pos.distanceTo(lastPos);
        if (moved >= STALL_THRESHOLD_BLOCKS) {
          lastMovedMs = Date.now();
          lastPos = pos.clone();
        } else if (Date.now() - lastMovedMs > STUCK_TIMEOUT_MS) {
          this.bot.pathfinder.stop();
          const totalMoved = startPos.distanceTo(this.bot.entity.position);
          settle({ ok: false, moved: totalMoved, error: "stuck" });
        }
      }, PROGRESS_CHECK_MS);

      // Abort signal
      if (signal.aborted) {
        abort();
        return;
      }
      const abortHandler = () => {
        this.bot.pathfinder.stop();
        abort();
      };
      signal.addEventListener("abort", abortHandler, { once: true });

      // Start pathfinder for this leg
      this.bot.pathfinder.goto(new GoalNear(goalX, goalY, goalZ, range)).then(
        () => {
          const moved = startPos.distanceTo(this.bot.entity.position);
          settle({ ok: true, moved });
        },
        (e: any) => {
          if (settled) return; // already resolved via stuck/timeout/abort
          const moved = startPos.distanceTo(this.bot.entity.position);
          settle({ ok: false, moved, error: e?.message || String(e) });
        },
      );
    });
  }

  private hDistTo(x: number, z: number): number {
    const pos = this.bot.entity.position;
    return Math.sqrt((pos.x - x) ** 2 + (pos.z - z) ** 2);
  }

  private distTo(x: number, y: number, z: number): number {
    const pos = this.bot.entity.position;
    return Math.hypot(pos.x - x, pos.y - y, pos.z - z);
  }

  private posOf(pos: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    return {
      x: +pos.x.toFixed(1),
      y: +pos.y.toFixed(1),
      z: +pos.z.toFixed(1),
    };
  }

  private buildResult(
    x: number,
    y: number,
    z: number,
    radius: number,
    reached: boolean,
    reason: MoveResult["reason"],
    legs: number,
  ): MoveResult {
    return {
      reached,
      reason,
      finalPos: this.posOf(this.bot.entity.position),
      distRemaining: Number(this.distTo(x, y, z).toFixed(2)),
      legs,
    };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("aborted");
  }
}
