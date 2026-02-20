export type MasterIntent =
  | "greet"
  | "status"
  | "explain"
  | "strategy"
  | "reflective"
  | "unknown";

export type AxyChannel =
  | "shared"
  | "dm"
  | "hush"
  | "build"
  | "game-chat"
  | "night-protocol-day"
  | "my-home-note"
  | "unknown";

export type InitiativeLevel = "low" | "medium" | "high";

export type ChannelPolicy = {
  maxSentences: number;
  maxChars: number;
  allowsFollowQuestion: boolean;
  initiative: InitiativeLevel;
};

export type NearDuplicateOptions = {
  threshold?: number;
  formulaicGuard?: boolean;
  formulaicPhrases?: string[];
};

export type MissionIdeaCandidate = {
  title?: string;
  key?: string;
  problem?: string;
  goal?: string;
  scope?: string[];
  publish_summary?: string;
  publishSummary?: string;
  artifact_language?: string;
  artifactLanguage?: string;
  utility?: number;
  implementability?: number;
  novelty?: number;
};

export type MissionIdeaScore = {
  valid: boolean;
  title: string;
  key: string;
  problem: string;
  goal: string;
  scope: string[];
  publishSummary: string;
  artifactLanguage: string;
  utility: number;
  implementability: number;
  novelty: number;
  total: number;
  duplicateByKey: boolean;
  duplicateByTitle: boolean;
};

export type MissionBundleQuality = {
  ok: boolean;
  qualityScore: number;
  issues: string[];
};

export const MASTER_INTENTS: MasterIntent[];
export const AXY_CHANNELS: AxyChannel[];
export const CHANNEL_POLICIES: Record<AxyChannel, ChannelPolicy>;

export function detectMasterIntent(message: string): MasterIntent;
export function resolveAxyChannel(input: string): AxyChannel;
export function getAxyChannelPolicy(channel: string): ChannelPolicy;

export function normalizeForSimilarity(text: string): string;
export function jaccardSimilarity(a: string, b: string): number;
export function isNearDuplicate(
  candidate: string,
  recentReplies?: string[],
  options?: NearDuplicateOptions
): boolean;
export function maxDuplicateScore(candidate: string, recentReplies?: string[]): number;

export function looksLikeQuestionText(text: string): boolean;
export function ensureQuestionMark(text: string): string;
export function ensureQuestionPunctuation(input: string): string;
export function normalizeIdeaKey(input: string): string;
export function scoreMissionIdea(
  idea: MissionIdeaCandidate,
  options?: { usedIdeaKeys?: string[]; usedIdeaTitles?: string[] }
): MissionIdeaScore;
export function pickBestMissionIdea(
  ideas: MissionIdeaCandidate[],
  options?: { usedIdeaKeys?: string[]; usedIdeaTitles?: string[] }
): MissionIdeaScore | null;
export function scoreMissionBundleQuality(
  bundle: {
    readme?: string;
    spec?: string;
    implementation?: string;
    artifactPath?: string;
    artifactContent?: string;
    publishSummary?: string;
    usageSteps?: string[];
  },
  options?: {
    minReadme?: number;
    minSpec?: number;
    minImplementation?: number;
    minArtifact?: number;
  }
): MissionBundleQuality;
