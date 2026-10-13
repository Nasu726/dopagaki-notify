export type SourceName = 'qiita' | 'wikipedia' | 'arxiv' | 'openalex' | 'zenn' | 'youtube'; // arXiv, Zenn, YouTube follow.

export interface ContentItem {
  id: string;
  title: string;
  url: string;
  publishedAt: number; // publication time for news; recommendation time for Wikipedia discovery
  imageUrl?: string; // optional RSS/OG image, enriched at delivery; not stored in D1
  thumbnailUrl?: string; // Qiita author icon fallback when article OGP is unavailable (transient)
  discoveryKind?: 'featured' | 'random'; // transient Wikipedia selection metadata (not persisted)
}
export interface Monitor {
  id: string;
  source: SourceName;
  query: string;
  intervalMinutes: number;
  enabled: boolean;
  weeklyJstDay?: string; // optional fixed weekday for weekly YouTube polling
  youtubeChannelId?: string; // optional pinned UC... ID, preserving query/monitor identity
  youtubeVideoType?: 'all' | 'videos'; // opt-in RSS videos-only (UULF), no Shorts/live
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
  /** Optional complete private monitor configuration as a Worker Secret. */
  MONITOR_CONFIG_JSON?: string;
  /** Optional private JST delivery hours, e.g. 09:00-20:00; unset = 24h. */
  NOTIFICATION_WINDOW_JST?: string;
  /** Operator's publicly reachable HTTPS contact for Wikimedia requests. */
  WIKIMEDIA_CONTACT_URL?: string;
  DISCORD_WEBHOOK_QIITA?: string;
  DISCORD_WEBHOOK_WIKIPEDIA?: string;
  DISCORD_WEBHOOK_ARXIV?: string;
  DISCORD_WEBHOOK_OPENALEX?: string;
  /** Optional free OpenAlex API key; keyless quota works for small monitoring. */
  OPENALEX_API_KEY?: string;
  DISCORD_WEBHOOK_ZENN?: string;
  DISCORD_WEBHOOK_YOUTUBE?: string;
  /** Optional official YouTube Data API key. Absent = RSS; present = Data API. */
  YOUTUBE_API_KEY?: string;
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
