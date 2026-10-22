-- ============================================================
-- Adaptive Testing Feature — Database Migration
-- Apply this to your Supabase project via:
--   Dashboard > SQL Editor > Run
-- OR via Supabase CLI:
--   supabase db push
-- ============================================================

-- ── 1. interviews — adaptive mode settings ───────────────────

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS "adaptiveMode"    boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "adaptiveConfig"  jsonb       DEFAULT NULL;

COMMENT ON COLUMN interviews."adaptiveMode"   IS 'Toggle adaptive testing mode for this interview.';
COMMENT ON COLUMN interviews."adaptiveConfig" IS 'AdaptiveConfig JSON: startingDifficulty, learningRate, masteryThreshold, floorThreshold, minQuestionsPerCompetency, maxQuestionsPerCompetency.';

-- ── 2. questions — adaptive tagging ─────────────────────────

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS "difficultyLevel"  integer DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "skillTag"         text    DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS "competencyGroup"  text    DEFAULT 'general';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'questions_difficulty_level_range'
  ) THEN
    ALTER TABLE questions
      ADD CONSTRAINT questions_difficulty_level_range
        CHECK ("difficultyLevel" >= 1 AND "difficultyLevel" <= 10);
  END IF;
END $$;

COMMENT ON COLUMN questions."difficultyLevel" IS 'Adaptive: difficulty 1-10. 1-3=EASY, 4-7=MEDIUM, 8-10=HARD.';
COMMENT ON COLUMN questions."skillTag"        IS 'Adaptive: fine-grained skill label, e.g. system_design, communication.';
COMMENT ON COLUMN questions."competencyGroup" IS 'Adaptive: broad competency group, e.g. technical, behavioral, leadership.';

-- Index for fast pool queries during adaptive question selection
CREATE INDEX IF NOT EXISTS idx_questions_adaptive
  ON questions ("interviewId", "competencyGroup", "difficultyLevel");

-- ── 3. sessions — live adaptive state & report ───────────────

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS "adaptiveState"   jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "adaptiveReport"  jsonb DEFAULT NULL;

COMMENT ON COLUMN sessions."adaptiveState"  IS 'Live adaptive state: θ ability estimates, question history, mastery/floor flags.';
COMMENT ON COLUMN sessions."adaptiveReport" IS 'Post-session adaptive report: competency heatmap, path, percentile, narrative.';

-- ── 4. adaptive_question_responses — per-question adaptive trail ─

CREATE TABLE IF NOT EXISTS adaptive_question_responses (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "sessionId"       uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  "questionId"      uuid        NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  "questionOrder"   integer,
  "difficultyServed" integer,
  "aiScore"         numeric(4, 2),
  "scoreReasoning"  text,
  "thetaBefore"     numeric(4, 2),
  "thetaAfter"      numeric(4, 2),
  "skillTag"        text,
  "competencyGroup" text,
  "servedAt"        timestamptz NOT NULL DEFAULT now()
);

-- Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_aqr_session
  ON adaptive_question_responses ("sessionId");

CREATE INDEX IF NOT EXISTS idx_aqr_competency
  ON adaptive_question_responses ("competencyGroup");

COMMENT ON TABLE adaptive_question_responses IS
  'Immutable audit trail of every question served adaptively — θ before/after, AI score, reasoning.';

-- ── 5. Row-level security (mirror sessions RLS) ───────────────

-- Enable RLS
ALTER TABLE adaptive_question_responses ENABLE ROW LEVEL SECURITY;

-- Service role bypass (for server-side writes via supabaseAdmin)
DROP POLICY IF EXISTS "service_role_all_aqr" ON adaptive_question_responses;
CREATE POLICY "service_role_all_aqr"
  ON adaptive_question_responses
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
