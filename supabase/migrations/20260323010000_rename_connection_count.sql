-- Rename connection_count to has_network_connections (boolean)
-- No data exists in connection_count yet, so safe to drop and recreate
ALTER TABLE job_postings DROP COLUMN IF EXISTS connection_count;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS has_network_connections BOOLEAN;
