-- Cache successful @handle -> UC... resolutions and avoid repeated channel-page downloads.
CREATE TABLE IF NOT EXISTS youtube_channel_cache (
  reference TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  resolved_at INTEGER NOT NULL
);
