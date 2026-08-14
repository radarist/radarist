/**
 * Type declarations for @impulse/agent package
 *
 * The agent runtime lives in the /agent directory and is built separately.
 * These declarations allow the Next.js app to import from it at runtime
 * (via dynamic import in Inngest functions) without TypeScript errors.
 */
declare module '@impulse/agent/orchestrator' {
  export interface OrchestratorOptions {
    configPath?: string;
    agentsDir?: string;
    apiKey?: string;
    maxBudgetUsd?: number;
    model?: string;
    roleAgent?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
    hooks?: Record<string, unknown>;
    onUsage?: (snapshot: MissionUsageSnapshot) => void;
  }

  /** @deprecated Use OrchestratorOptions instead */
  export type OrchestratorConfig = OrchestratorOptions;

  export interface MissionUsageSnapshot {
    costUsd: number | null;
    tokenUsage: { input: number; output: number };
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUnavailableReason?: string;
  }

  export interface MissionResult {
    success: boolean;
    result?: string;
    tokenUsage: { input: number; output: number };
    costUsd: number | null;
    costUnavailableReason?: string;
    providerReportedCostUsd?: number | null;
    exposureUsd?: number;
    duplicateUsageEvents?: number;
    restatedUsageEvents?: number;
    requestedModel?: string;
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        costUSD?: number;
      }
    >;
    modelSubstitution?: {
      requested: string;
      served: string;
      servedModels: readonly string[];
      authorized: boolean;
      authorizedBy?: 'configured-fallback' | 'explicit-pair' | 'explicit-served';
    };
    failureKind?: 'mcp-preflight-failed' | 'unsupported-model' | 'mcp-credential-containment-failed';
    errors?: string[];
  }

  export interface ChatParams {
    prompt: string;
    systemPrompt?: string;
    maxBudgetUsd?: number;
    userId?: string;
    sessionId?: string;
  }

  export interface SDKMessage {
    type: string;
    [key: string]: unknown;
  }

  export class Orchestrator {
    constructor(options?: OrchestratorOptions);
    runMission(prompt: string): Promise<MissionResult>;
    getUsageSnapshot(): MissionUsageSnapshot;
    streamChat(params: ChatParams): AsyncGenerator<SDKMessage>;
  }
}
