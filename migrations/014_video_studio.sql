BEGIN;

ALTER TABLE cockpit_agents DROP CONSTRAINT IF EXISTS cockpit_agents_id_check;
ALTER TABLE cockpit_agents ADD CONSTRAINT cockpit_agents_id_check
  CHECK (id IN ('ceo','product','design_conversion','engineering','qa_safety','growth','content_brand','video_creator','sales_partnerships','customer_care','finance_risk','reliability_privacy'));

INSERT INTO cockpit_agents (id, display_name, role)
VALUES ('video_creator','Short-form Video Creator','specialist')
ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, enabled = true;

INSERT INTO agent_policies
  (agent_id, policy_version, enabled, allowed_tools, allowed_scopes, allowed_risks,
   max_calls_per_run, max_calls_per_day, max_cost_usd_micros_per_day)
VALUES
  ('video_creator',1,true,
   ARRAY['product_facts.read','content.read','brand_assets.read','video.brief.write','video.render.local'],
   ARRAY['facts:approved','artifacts:content','assets:licensed','artifacts:video','render:local'],
   ARRAY['read','draft','write_safe'],12,20,1000000)
ON CONFLICT (agent_id, policy_version) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  allowed_tools = EXCLUDED.allowed_tools,
  allowed_scopes = EXCLUDED.allowed_scopes,
  allowed_risks = EXCLUDED.allowed_risks,
  max_calls_per_run = EXCLUDED.max_calls_per_run,
  max_calls_per_day = EXCLUDED.max_calls_per_day,
  max_cost_usd_micros_per_day = EXCLUDED.max_cost_usd_micros_per_day;

CREATE TABLE video_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid UNIQUE REFERENCES cockpit_tasks(id) ON DELETE SET NULL,
  run_id uuid UNIQUE REFERENCES cockpit_runs(id) ON DELETE SET NULL,
  subject text NOT NULL CHECK (octet_length(subject) BETWEEN 3 AND 2000),
  goal text NOT NULL CHECK (goal IN ('awareness','education','conversion')),
  language text NOT NULL CHECK (language IN ('fr','en')),
  template text NOT NULL CHECK (template IN ('problem_reveal_solution','quick_list','before_after')),
  requested_duration_seconds integer NOT NULL CHECK (requested_duration_seconds BETWEEN 15 AND 60),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','briefing','voice','rendering','quality_check','completed','failed','cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage_label text NOT NULL DEFAULT 'En attente de l''agent vidéo' CHECK (octet_length(stage_label) BETWEEN 1 AND 300),
  brief jsonb CHECK (brief IS NULL OR octet_length(brief::text) <= 65536),
  selected_hook text CHECK (selected_hook IS NULL OR octet_length(selected_hook) <= 2000),
  caption text CHECK (caption IS NULL OR octet_length(caption) <= 8000),
  hashtags text[] NOT NULL DEFAULT '{}',
  heuristic_score integer CHECK (heuristic_score IS NULL OR heuristic_score BETWEEN 0 AND 100),
  quality_report jsonb CHECK (quality_report IS NULL OR octet_length(quality_report::text) <= 32768),
  video_object_key text CHECK (video_object_key IS NULL OR video_object_key ~ '^videos/[0-9a-f-]{36}/[a-z0-9._-]+$'),
  thumbnail_object_key text CHECK (thumbnail_object_key IS NULL OR thumbnail_object_key ~ '^videos/[0-9a-f-]{36}/[a-z0-9._-]+$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{3,120}$'),
  brief_attempt_count integer NOT NULL DEFAULT 0 CHECK (brief_attempt_count BETWEEN 0 AND 2),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX video_one_active_job_idx ON video_jobs ((true))
  WHERE state IN ('queued','briefing','voice','rendering','quality_check');
CREATE INDEX video_jobs_created_idx ON video_jobs (created_at DESC);
CREATE INDEX video_jobs_worker_idx ON video_jobs (state, updated_at) WHERE state IN ('voice','rendering','quality_check');

ALTER TABLE ops_collaborator_presence DROP CONSTRAINT IF EXISTS ops_collaborator_presence_active_view_check;
ALTER TABLE ops_collaborator_presence ADD CONSTRAINT ops_collaborator_presence_active_view_check
  CHECK (active_view IN ('overview', 'work', 'team', 'video', 'health', 'integrations'));

COMMIT;
