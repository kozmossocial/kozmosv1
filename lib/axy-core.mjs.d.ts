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
