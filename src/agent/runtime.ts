import type {
  AgentHarness,
  AgentHarnessEvent,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { EpisodeSource } from "../diary/service.js";
import type { AgentChatType, SessionPolicyConfig } from "../config.js";
import type { ToolGuard } from "./toolGuard.js";

export interface HarnessEntry {
  harness: AgentHarness;
  scopeId: string;
  chatType: AgentChatType;
  profileName: string;
  modelId: string;
  runId?: string;
  lastActivityAt: number;
  activeToolNames: string[];
  toolGuard: ToolGuard;
  segmentStartedAt: string | null;
  segmentEndedAt: string | null;
  currentEpisodeSource: EpisodeSource | null;
  sessionPolicyKey: keyof SessionPolicyConfig | null;
  sessionRowId: string | null;
}

export interface HarnessModelProfile {
  name: string;
  model: Model<any>;
  apiKey: string;
  streamOptions: import("@earendil-works/pi-agent-core").AgentHarnessStreamOptions;
}

export interface AgentCloseSegment {
  scopeId: string;
  startedAt: string;
  endedAt: string;
}

export class AgentRuntime {
  constructor(private readonly entry: HarnessEntry) {}

  prompt(input: string) {
    return this.entry.harness.prompt(input);
  }

  subscribe(
    listener: (
      event: AgentHarnessEvent,
      signal?: AbortSignal,
    ) => Promise<void> | void,
  ): () => void {
    return this.entry.harness.subscribe(listener);
  }

  compact(customInstructions?: string) {
    return this.entry.harness.compact(customInstructions);
  }

  getModel(): Model<any> {
    return this.entry.harness.getModel();
  }

  getActiveTools(): AgentTool[] {
    return this.entry.harness.getActiveTools();
  }

  blockTools(names: string[], reason: string): void {
    this.entry.toolGuard.block(names, reason);
  }

  resetTools(): void {
    this.entry.toolGuard.reset();
  }

  get scopeId(): string {
    return this.entry.scopeId;
  }

  get chatType(): AgentChatType {
    return this.entry.chatType;
  }

  get profileName(): string {
    return this.entry.profileName;
  }

  get modelId(): string {
    return this.entry.modelId;
  }

  get runId(): string | undefined {
    return this.entry.runId;
  }

  set runId(runId: string | undefined) {
    this.entry.runId = runId;
  }

  get sessionPolicyKey(): keyof SessionPolicyConfig | null {
    return this.entry.sessionPolicyKey;
  }

  get sessionRowId(): string | null {
    return this.entry.sessionRowId;
  }

  get currentEpisodeSource(): EpisodeSource | null {
    return this.entry.currentEpisodeSource;
  }

  set currentEpisodeSource(source: EpisodeSource | null) {
    this.entry.currentEpisodeSource = source;
  }

  get lastActivityAt(): number {
    return this.entry.lastActivityAt;
  }

  touchActivity(): void {
    this.entry.lastActivityAt = Date.now();
  }

  recordActivity(occurredAt: string): void {
    this.entry.lastActivityAt = Date.now();
    this.entry.segmentStartedAt ??= occurredAt;
    this.entry.segmentEndedAt = occurredAt;
  }

  get segmentStartedAt(): string | null {
    return this.entry.segmentStartedAt;
  }

  get segmentEndedAt(): string | null {
    return this.entry.segmentEndedAt;
  }

  consumeCloseSegment(): AgentCloseSegment | null {
    if (!this.entry.segmentStartedAt || !this.entry.segmentEndedAt) return null;
    const segment = {
      scopeId: this.entry.scopeId,
      startedAt: this.entry.segmentStartedAt,
      endedAt: this.entry.segmentEndedAt,
    };
    this.entry.segmentStartedAt = null;
    this.entry.segmentEndedAt = null;
    return segment;
  }
}
