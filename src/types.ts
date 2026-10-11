export type SourceName = 'qiita' | 'wikipedia' | 'arxiv' | 'zenn' | 'youtube'; // arXiv, Zenn, YouTube follow.

export interface ContentItem {
  id: string;
  title: string;
  url: string;
  publishedAt: number; // creation, not modification time
}
export interface Monitor {
  id: string;
  source: SourceName;
  query: string;
  intervalMinutes: number;
  enabled: boolean;
}
export interface D1Prepared {
  bind(...parameters: unknown[]): D1Prepared;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface Database {
  prepare(statement: string): D1Prepared;
}
export interface Env {
  DB: Database;
  DISCORD_WEBHOOK_QIITA?: string;
  DISCORD_WEBHOOK_WIKIPEDIA?: string;
  DISCORD_WEBHOOK_ARXIV?: string;
  DISCORD_WEBHOOK_ZENN?: string;
  DISCORD_WEBHOOK_YOUTUBE?: string;
}
export interface MonitorState {
  id: string;
  initialized_at: number | null;
  next_due_at: number;
  scan_cursor: string | null;
  scan_started_at: number | null;
  last_complete_at: number | null;
  config_identity: string | null;
  last_incomplete_at: number | null;
  incomplete_count: number;
  webhook_cooldown_until: number;
  webhook_blocked_status: number | null;
  webhook_blocked_at: number | null;
}
export interface Delivery {
  item_id: string;
  title: string;
  url: string;
  published_at: number;
  attempts: number;
}
