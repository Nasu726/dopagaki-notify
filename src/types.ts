export type SourceName = 'qiita' | 'wikipedia'; // arXiv, Zenn, YouTube follow.

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
}
export interface MonitorState {
  id: string;
  initialized_at: number | null;
  next_due_at: number;
}
export interface Delivery {
  item_id: string;
  title: string;
  url: string;
  published_at: number;
  attempts: number;
}
