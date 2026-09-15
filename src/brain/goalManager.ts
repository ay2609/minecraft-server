import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface Goal {
  id: string;
  description: string;
  priority: number;
  status: "active" | "paused" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  source: "agent" | "player_request" | "discovery" | "system";
  notes?: string;
}

const MAX_ACTIVE_GOALS = 10;
const MAX_TOTAL_GOALS = 30;

export class GoalManager {
  private goals: Goal[] = [];
  private readonly goalsPath: string;
  private readonly baseDir: string;

  constructor(botName: string) {
    this.baseDir = path.resolve("mcbots", botName);
    this.goalsPath = path.resolve(this.baseDir, "goals.json");
  }

  async load(): Promise<void> {
    // Fresh session: discard all goals from previous runs so the bot starts
    // with a clean slate and no stale context leaking across restarts.
    this.goals = [];
    try {
      await mkdir(this.baseDir, { recursive: true });
      await writeFile(this.goalsPath, "[]", "utf8");
    } catch {
    }
  }

  async persist(): Promise<void> {
    try {
      await mkdir(this.baseDir, { recursive: true });
      const tempPath = `${this.goalsPath}.tmp`;
      await writeFile(tempPath, JSON.stringify(this.goals, null, 2), "utf8");
      await rename(tempPath, this.goalsPath);
    } catch {
    }
  }

  add(
    description: string,
    priority: number,
    source: Goal["source"],
    notes?: string,
  ): Goal {
    const now = Date.now();
    const activeCount = this.goals.filter((g) => g.status === "active").length;
    if (activeCount >= MAX_ACTIVE_GOALS) {
      // Fail the lowest-priority active goal to make room
      const sorted = this.goals
        .filter((g) => g.status === "active")
        .sort((a, b) => a.priority - b.priority);
      if (sorted.length > 0) {
        sorted[0].status = "failed";
        sorted[0].updatedAt = now;
        sorted[0].notes = (sorted[0].notes ? sorted[0].notes + "; " : "") + "evicted to make room";
      }
    }

    const goal: Goal = {
      id: randomUUID().slice(0, 8),
      description: description.slice(0, 200),
      priority: Math.max(1, Math.min(10, Math.round(priority))),
      status: "active",
      createdAt: now,
      updatedAt: now,
      source,
      notes: notes?.slice(0, 200),
    };

    this.goals.push(goal);
    this.prune();
    return goal;
  }

  complete(id: string, notes?: string): boolean {
    const goal = this.goals.find((g) => g.id === id);
    if (!goal) {
      return false;
    }
    goal.status = "completed";
    goal.updatedAt = Date.now();
    if (notes) {
      goal.notes = (goal.notes ? goal.notes + "; " : "") + notes.slice(0, 200);
    }
    return true;
  }

  fail(id: string, notes?: string): boolean {
    const goal = this.goals.find((g) => g.id === id);
    if (!goal) {
      return false;
    }
    goal.status = "failed";
    goal.updatedAt = Date.now();
    if (notes) {
      goal.notes = (goal.notes ? goal.notes + "; " : "") + notes.slice(0, 200);
    }
    return true;
  }

  update(
    id: string,
    changes: { description?: string; priority?: number; notes?: string },
  ): boolean {
    const goal = this.goals.find((g) => g.id === id);
    if (!goal) {
      return false;
    }
    if (changes.description !== undefined) {
      goal.description = changes.description.slice(0, 200);
    }
    if (changes.priority !== undefined) {
      goal.priority = Math.max(1, Math.min(10, Math.round(changes.priority)));
    }
    if (changes.notes !== undefined) {
      goal.notes = changes.notes.slice(0, 200);
    }
    goal.updatedAt = Date.now();
    return true;
  }

  getActive(): Goal[] {
    return this.goals
      .filter((g) => g.status === "active")
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_ACTIVE_GOALS);
  }

  getAll(): Goal[] {
    return this.goals.slice(0, MAX_TOTAL_GOALS);
  }

  private prune(): void {
    if (this.goals.length <= MAX_TOTAL_GOALS) {
      return;
    }
    // Remove oldest completed/failed goals first
    const terminal = this.goals
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.status === "completed" || g.status === "failed")
      .sort((a, b) => a.g.updatedAt - b.g.updatedAt);

    const toRemove = this.goals.length - MAX_TOTAL_GOALS;
    const removeIndices = new Set(terminal.slice(0, toRemove).map(({ i }) => i));
    this.goals = this.goals.filter((_, i) => !removeIndices.has(i));
  }
}
