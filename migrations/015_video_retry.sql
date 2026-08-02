BEGIN;

ALTER TABLE video_jobs
  ADD COLUMN IF NOT EXISTS brief_attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE video_jobs DROP CONSTRAINT IF EXISTS video_jobs_brief_attempt_count_check;
ALTER TABLE video_jobs ADD CONSTRAINT video_jobs_brief_attempt_count_check
  CHECK (brief_attempt_count BETWEEN 0 AND 2);

UPDATE video_jobs SET brief_attempt_count = 1 WHERE task_id IS NOT NULL AND brief_attempt_count = 0;

COMMIT;
