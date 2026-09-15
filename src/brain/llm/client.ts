import type { z } from "zod";

interface LlmRequestOptions<T> {
  task: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  temperature?: number;
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
}
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKENS = 800;
const BUILTIN_ACTION_TYPES = new Set(["say", "wait", "goto", "follow", "flee", "run_tool", "idle"]);
const CONTROL_COMMANDS = new Set(["replaceQueue", "prependActions", "cancelCurrent", "setIdleBehavior"]);
const RETRY_JSON_ONLY_GUIDANCE =
  "Return ONLY a strict JSON object matching the required schema. Do not include markdown, prose, backticks, or explanations. If uncertain, return {}.";

export class JsonLlmClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  enabled(): boolean {
    return Boolean(this.apiKey);
  }

  async completeJson<T>(options: LlmRequestOptions<T>): Promise<T | null> {
    if (!this.apiKey) {
      return null;
    }

    const contractHint = this.outputContractHint(options.task);
    const firstPrompt = `${options.userPrompt}\n\n${contractHint}`;
    const first = await this.callOpenAi(options.systemPrompt, firstPrompt, options.temperature ?? 0.2);
    const parsedFirst = this.parseResponse(first, options.schema, options.task);
    if (parsedFirst) {
      return parsedFirst;
    }

    const retryPrompt = `${options.userPrompt}\n\n${contractHint}\n\n${RETRY_JSON_ONLY_GUIDANCE}`;
    const second = await this.callOpenAi(options.systemPrompt, retryPrompt, options.temperature ?? 0.1);
    const parsedSecond = this.parseResponse(second, options.schema, options.task);
    if (!parsedSecond) {
      return null;
    }

    return parsedSecond;
  }

  private async callOpenAi(systemPrompt: string, userPrompt: string, temperature: number): Promise<string> {
    const modelCandidates = this.resolveModelCandidates();
    let lastError: Error | null = null;

    for (let i = 0; i < modelCandidates.length; i += 1) {
      const model = modelCandidates[i];
      try {
        return await this.callOpenAiForModel(model, systemPrompt, userPrompt, temperature);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(message);

        const hasNext = i + 1 < modelCandidates.length;
        if (!hasNext || !this.shouldTryNextModelAlias(message)) {
          break;
        }
      }
    }

    throw lastError ?? new Error("LLM request failed");
  }

  private async callOpenAiForModel(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    temperature: number,
  ): Promise<string> {
    const baseBody = {
      model,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    let response = await this.postCompletions({
      ...baseBody,
      response_format: { type: "json_object" },
    });

    if (!response.ok) {
      const text = await response.text();

      if (this.shouldRetryWithoutResponseFormat(response.status, text)) {
        response = await this.postCompletions(baseBody);
      } else {
        throw new Error(`LLM HTTP ${response.status}: ${text}`);
      }
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${text}`);
    }

    const payload = (await response.json()) as OpenAiResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("LLM response missing content");
    }

    return content;
  }

  private postCompletions(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        max_tokens: MAX_TOKENS,
        ...body,
      }),
      signal: controller.signal,
    })
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`LLM timeout after ${REQUEST_TIMEOUT_MS}ms`);
        }
        throw error;
      })
      .finally(() => {
        clearTimeout(timeout);
      });
  }

  private resolveModelCandidates(): string[] {
    const model = this.model.trim();
    const candidates = [model];

    if (model.startsWith("fireworks/")) {
      candidates.push(`accounts/fireworks/models/${model.slice("fireworks/".length)}`);
    } else if (model.startsWith("accounts/fireworks/models/")) {
      candidates.push(`fireworks/${model.slice("accounts/fireworks/models/".length)}`);
    }

    return [...new Set(candidates.filter((name) => name.length > 0))];
  }

  private shouldRetryWithoutResponseFormat(status: number, body: string): boolean {
    if (status !== 400 && status !== 422) {
      return false;
    }

    return /(response_format|json_object|structured output|schema)/i.test(body);
  }

  private shouldTryNextModelAlias(message: string): boolean {
    return /(unknown model|invalid model|model.*(not found|does not exist|unsupported)|NO_MODEL)/i.test(message);
  }

  private parseResponse<T>(raw: string, schema: z.ZodType<T>, task: string): T | null {
    const candidates = this.buildJsonCandidates(raw);
    const diagnostics: string[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(candidate);
      } catch (error) {
        diagnostics.push(`candidate_${index + 1}: json_parse_error:${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const normalized = this.normalizeCommonShape(parsedJson);
      const validated = schema.safeParse(normalized);
      if (validated.success) {
        return validated.data;
      }
      diagnostics.push(`candidate_${index + 1}: invalid:${this.summarizeValidationError(validated.error)}`);

      const repaired = this.repairCommonShape(normalized);
      if (repaired.repairs.length === 0) {
        continue;
      }

      const validatedRepaired = schema.safeParse(repaired.value);
      if (validatedRepaired.success) {
        return validatedRepaired.data;
      }
      diagnostics.push(`candidate_${index + 1}: invalid_after_repair:${this.summarizeValidationError(validatedRepaired.error)}`);
    }
    return null;
  }

  private outputContractHint(task: string): string {
    if (task !== "agent") {
      return RETRY_JSON_ONLY_GUIDANCE;
    }

    return [
      "Output contract:",
      "return a single JSON object with optional keys thoughts, say, control, memoryUpdate, goalUpdates.",
      "If control exists, control.cmd must be one of replaceQueue, prependActions, cancelCurrent, setIdleBehavior.",
      "For tool calls inside actions, use {\"type\":\"run_tool\",\"name\":\"tool_name\",\"args\":{}}.",
      "Do not place cmd/actions at the top level.",
      "Do not use markdown fences.",
    ].join(" ");
  }

  private summarizeValidationError(error: z.ZodError): string {
    return error.issues
      .slice(0, 3)
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${path}:${issue.message}`;
      })
      .join(" | ");
  }

  private normalizeCommonShape(value: unknown): unknown {
    const obj = this.asObject(value);
    if (!obj) {
      return value;
    }

    const normalized = { ...obj };
    if (typeof normalized.say === "string") {
      normalized.say = [normalized.say];
    }

    const controlObj = this.asObject(normalized.control);
    if (controlObj && typeof controlObj.cmd === "string") {
      if ((controlObj.cmd === "replaceQueue" || controlObj.cmd === "prependActions") && Array.isArray(controlObj.actions)) {
        controlObj.actions = this.normalizeActionList(controlObj.actions as unknown[]);
      }
      if (controlObj.cmd === "prependActions" && controlObj.priority !== "urgent" && controlObj.priority !== "normal") {
        controlObj.priority = "normal";
      }
      normalized.control = controlObj;
      return normalized;
    }

    if (controlObj && typeof controlObj.setIdleBehavior === "string") {
      normalized.control = {
        cmd: "setIdleBehavior",
        behavior: controlObj.setIdleBehavior,
      };
    }

    return normalized;
  }

  private repairCommonShape(value: unknown): { value: unknown; repairs: string[] } {
    const obj = this.asObject(value);
    if (!obj) {
      return { value, repairs: [] };
    }

    const repaired = { ...obj };
    const repairs: string[] = [];

    if (typeof repaired.say === "string") {
      repaired.say = [repaired.say];
      repairs.push("say_string_to_array");
    } else if (Array.isArray(repaired.say)) {
      const normalizedSay = (repaired.say as unknown[])
        .map((entry) => {
          if (typeof entry === "string") {
            return entry.trim();
          }
          const entryObj = this.asObject(entry);
          if (!entryObj) {
            return "";
          }
          if (typeof entryObj.message === "string") {
            return entryObj.message.trim();
          }
          if (typeof entryObj.text === "string") {
            return entryObj.text.trim();
          }
          return "";
        })
        .filter((line) => line.length > 0);
      if (normalizedSay.length !== (repaired.say as unknown[]).length) {
        repairs.push("say_entries_cleaned");
      }
      if (normalizedSay.length > 0) {
        repaired.say = normalizedSay;
      } else {
        delete repaired.say;
        repairs.push("say_dropped_empty");
      }
    }

    if (!repaired.control) {
      const topLevelCmd = typeof repaired.cmd === "string" ? repaired.cmd : "";
      if (topLevelCmd.length > 0) {
        repaired.control = {
          cmd: topLevelCmd,
          actions: repaired.actions,
          action: repaired.action,
          priority: repaired.priority,
          reason: repaired.reason,
          behavior: repaired.behavior,
          name: repaired.name,
          tool: repaired.tool,
          toolName: repaired.toolName,
          args: repaired.args,
        };
        repairs.push("wrapped_top_level_cmd_into_control");
      } else if (Array.isArray(repaired.actions)) {
        repaired.control = {
          cmd: "replaceQueue",
          actions: repaired.actions,
        };
        repairs.push("wrapped_top_level_actions_into_control");
      } else if (repaired.action !== undefined) {
        repaired.control = {
          cmd: "replaceQueue",
          actions: [repaired.action],
        };
        repairs.push("wrapped_top_level_action_into_control");
      }
    }

    const controlObj = this.asObject(repaired.control);
    if (controlObj) {
      const controlRepair = this.repairControlShape(controlObj);
      repairs.push(...controlRepair.repairs);
      if (controlRepair.control) {
        repaired.control = controlRepair.control;
      } else {
        delete repaired.control;
      }
    }

    if (repaired.goalUpdates && !Array.isArray(repaired.goalUpdates) && this.asObject(repaired.goalUpdates)) {
      repaired.goalUpdates = [repaired.goalUpdates];
      repairs.push("goal_updates_object_to_array");
    }

    if (Object.hasOwn(repaired, "memoryUpdate")) {
      const memoryRepair = this.repairMemoryUpdate(repaired.memoryUpdate);
      repairs.push(...memoryRepair.repairs);
      if (memoryRepair.drop) {
        delete repaired.memoryUpdate;
      } else {
        repaired.memoryUpdate = memoryRepair.value;
      }
    }

    return {
      value: this.normalizeCommonShape(repaired),
      repairs,
    };
  }

  private repairControlShape(control: Record<string, unknown>): { control: Record<string, unknown> | null; repairs: string[] } {
    const controlObj = { ...control };
    const repairs: string[] = [];

    if (typeof controlObj.command === "string" && typeof controlObj.cmd !== "string") {
      controlObj.cmd = controlObj.command;
      repairs.push("control_command_to_cmd");
    }

    if (typeof controlObj.cmd !== "string") {
      const nestedReplace = this.asObject(controlObj.replaceQueue);
      const nestedPrepend = this.asObject(controlObj.prependActions);
      const nestedCancel = this.asObject(controlObj.cancelCurrent);
      const nestedIdle = this.asObject(controlObj.setIdleBehavior);

      if (nestedReplace) {
        Object.assign(controlObj, nestedReplace);
        controlObj.cmd = "replaceQueue";
        repairs.push("unwrapped_control_replaceQueue");
      } else if (nestedPrepend) {
        Object.assign(controlObj, nestedPrepend);
        controlObj.cmd = "prependActions";
        repairs.push("unwrapped_control_prependActions");
      } else if (nestedCancel) {
        Object.assign(controlObj, nestedCancel);
        controlObj.cmd = "cancelCurrent";
        repairs.push("unwrapped_control_cancelCurrent");
      } else if (nestedIdle) {
        Object.assign(controlObj, nestedIdle);
        controlObj.cmd = "setIdleBehavior";
        repairs.push("unwrapped_control_setIdleBehavior");
      } else if (typeof controlObj.setIdleBehavior === "string") {
        controlObj.cmd = "setIdleBehavior";
        controlObj.behavior = controlObj.setIdleBehavior;
        repairs.push("set_idle_behavior_short_form");
      } else if (Array.isArray(controlObj.actions)) {
        controlObj.cmd = "replaceQueue";
        repairs.push("missing_cmd_default_replaceQueue");
      }
    }

    const cmd = typeof controlObj.cmd === "string" ? controlObj.cmd : "";
    if (!cmd) {
      return { control: null, repairs };
    }

    if (!CONTROL_COMMANDS.has(cmd)) {
      if (cmd === "run_tool" || cmd === "tool" || cmd === "tool_call") {
        const toolName = this.firstString(controlObj.name, controlObj.tool, controlObj.toolName);
        if (toolName) {
          const args = this.asObject(controlObj.args) ?? this.asObject(controlObj.params) ?? {};
          controlObj.cmd = "replaceQueue";
          controlObj.actions = [{ type: "run_tool", name: toolName, args }];
          repairs.push("control_cmd_tool_call_to_replace_queue");
        }
      } else if (BUILTIN_ACTION_TYPES.has(cmd)) {
        const { cmd: actionType, ...rest } = controlObj;
        controlObj.cmd = "replaceQueue";
        controlObj.actions = [{ type: actionType, ...rest }];
        repairs.push("control_cmd_action_to_replace_queue");
      } else {
        const { cmd: toolName, ...rest } = controlObj;
        controlObj.cmd = "replaceQueue";
        controlObj.actions = [{ type: "run_tool", name: toolName, args: rest }];
        repairs.push("control_cmd_unknown_to_run_tool");
      }
    }

    const fixedCmd = typeof controlObj.cmd === "string" ? controlObj.cmd : "";
    if (!CONTROL_COMMANDS.has(fixedCmd)) {
      repairs.push("dropped_unknown_control_cmd");
      return { control: null, repairs };
    }

    if (fixedCmd === "replaceQueue" || fixedCmd === "prependActions") {
      if (!Array.isArray(controlObj.actions) && controlObj.action !== undefined) {
        controlObj.actions = [controlObj.action];
        repairs.push("control_action_wrapped_into_actions");
      }
      if (!Array.isArray(controlObj.actions) && typeof controlObj.name === "string") {
        controlObj.actions = [{ type: "run_tool", name: controlObj.name, args: this.asObject(controlObj.args) ?? {} }];
        repairs.push("control_name_to_run_tool_action");
      }
      if (Array.isArray(controlObj.actions)) {
        const normalizedActions = this.normalizeActionList(controlObj.actions as unknown[]);
        if (normalizedActions.length > 0) {
          controlObj.actions = normalizedActions;
          if (fixedCmd === "prependActions" && controlObj.priority !== "urgent" && controlObj.priority !== "normal") {
            controlObj.priority = "normal";
            repairs.push("prepend_priority_defaulted");
          }
        } else {
          repairs.push("dropped_empty_actions_control");
          return { control: null, repairs };
        }
      }
    }

    if (fixedCmd === "setIdleBehavior" && typeof controlObj.behavior !== "string") {
      if (typeof controlObj.setIdleBehavior === "string") {
        controlObj.behavior = controlObj.setIdleBehavior;
        repairs.push("idle_behavior_from_setIdleBehavior");
      } else {
        return { control: null, repairs };
      }
    }

    return {
      control: controlObj,
      repairs,
    };
  }

  private repairMemoryUpdate(value: unknown): { value: unknown; repairs: string[]; drop: boolean } {
    const repairs: string[] = [];

    if (typeof value === "string") {
      const content = value.trim();
      if (content.length === 0) {
        return { value, repairs: ["memory_update_dropped_empty_string"], drop: true };
      }
      return {
        value: {
          mode: "append",
          content,
        },
        repairs: ["memory_update_string_to_object"],
        drop: false,
      };
    }

    const memoryObj = this.asObject(value);
    if (!memoryObj) {
      return { value, repairs: ["memory_update_dropped_invalid_shape"], drop: true };
    }

    const fixed = { ...memoryObj };
    if (typeof fixed.content !== "string") {
      if (typeof fixed.text === "string") {
        fixed.content = fixed.text;
        repairs.push("memory_update_text_to_content");
      } else if (typeof fixed.note === "string") {
        fixed.content = fixed.note;
        repairs.push("memory_update_note_to_content");
      }
    }

    if (typeof fixed.mode !== "string" || (fixed.mode !== "append" && fixed.mode !== "replace")) {
      fixed.mode = "append";
      repairs.push("memory_update_mode_defaulted");
    }

    if (typeof fixed.content === "string") {
      const trimmedContent = fixed.content.trim();
      fixed.content = trimmedContent;
      if (trimmedContent.length === 0) {
        repairs.push("memory_update_dropped_empty_content");
        return { value: fixed, repairs, drop: true };
      }
    } else {
      repairs.push("memory_update_dropped_missing_content");
      return { value: fixed, repairs, drop: true };
    }

    return {
      value: fixed,
      repairs,
      drop: false,
    };
  }

  private normalizeActionList(actions: unknown[]): unknown[] {
    return actions
      .map((action) => this.normalizeActionCandidate(action))
      .filter((action): action is unknown => action !== null && action !== undefined);
  }

  private normalizeActionCandidate(action: unknown): unknown {
    if (typeof action === "string") {
      const raw = action.trim();
      if (!raw) {
        return null;
      }

      if (raw.startsWith("say:")) {
        const message = raw.slice(4).trim();
        return message ? { type: "say", message } : null;
      }

      if (raw.startsWith("run_tool:")) {
        const name = raw.slice("run_tool:".length).trim();
        return name ? { type: "run_tool", name, args: {} } : null;
      }

      if (raw.startsWith("wait:")) {
        const ms = Number(raw.slice("wait:".length).trim());
        if (Number.isFinite(ms)) {
          return { type: "wait", ms: Math.max(0, Math.floor(ms)) };
        }
      }

      return { type: "run_tool", name: raw, args: {} };
    }

    if (!action || typeof action !== "object" || Array.isArray(action)) {
      return action;
    }

    const actionObj = { ...(action as Record<string, unknown>) };
    if (typeof actionObj.action === "string" && typeof actionObj.type !== "string") {
      actionObj.type = actionObj.action;
    }
    if (typeof actionObj.command === "string" && typeof actionObj.type !== "string") {
      actionObj.type = actionObj.command;
    }

    if (typeof actionObj.type !== "string" && typeof actionObj.name === "string") {
      actionObj.type = "run_tool";
    }

    const type = typeof actionObj.type === "string" ? actionObj.type : "";
    if (!type) {
      return actionObj;
    }

    if (type === "goto") {
      const pos = this.asObject(actionObj.pos);
      if (pos) {
        if (typeof actionObj.x !== "number" && typeof pos.x === "number") actionObj.x = pos.x;
        if (typeof actionObj.y !== "number" && typeof pos.y === "number") actionObj.y = pos.y;
        if (typeof actionObj.z !== "number" && typeof pos.z === "number") actionObj.z = pos.z;
      }
      return actionObj;
    }

    if (type === "run_tool") {
      const name = this.firstString(actionObj.name, actionObj.tool, actionObj.toolName);
      if (name) {
        actionObj.name = name;
      }
      if (!this.asObject(actionObj.args)) {
        actionObj.args = this.asObject(actionObj.params) ?? {};
      }
      return actionObj;
    }

    if (BUILTIN_ACTION_TYPES.has(type)) {
      return actionObj;
    }

    const { type: toolName, ...rest } = actionObj;
    return {
      type: "run_tool",
      name: toolName,
      args: rest,
    };
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private firstString(...values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  }

  private buildJsonCandidates(raw: string): string[] {
    const cleaned = raw.trim();
    const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const fromFence = fenceMatch ? fenceMatch[1].trim() : "";
    const embedded = this.extractFirstJsonObject(cleaned);

    return [...new Set([cleaned, fromFence, embedded].filter((value) => value.length > 0))];
  }

  private extractFirstJsonObject(text: string): string {
    const start = text.indexOf("{");
    if (start === -1) {
      return "";
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1).trim();
        }
      }
    }

    return "";
  }
}
