-- Optional public article media for queued Qiita/Zenn deliveries.
-- Safe additive migration: nullable columns; old receipts and delivery state untouched.
ALTER TABLE deliveries ADD COLUMN image_url TEXT;
ALTER TABLE deliveries ADD COLUMN thumbnail_url TEXT;
