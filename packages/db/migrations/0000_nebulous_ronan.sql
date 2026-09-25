CREATE TYPE "public"."classification" AS ENUM('DRIFT', 'INTENTIONAL_DEVIATION', 'NOT_DRIFT');--> statement-breakpoint
CREATE TYPE "public"."risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('nano', 'super', 'ultra');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('PASS', 'REVIEW', 'FAIL', 'UNVERIFIABLE', 'INTENTIONAL_DEVIATION');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"file" text NOT NULL,
	"line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"fingerprint" jsonb NOT NULL,
	"matched_component" text,
	"triage_confidence" real,
	"classification" "classification",
	"rationale" text,
	"prop_mapping" jsonb,
	"unmappable" jsonb,
	"risk" "risk",
	"original_source" text NOT NULL,
	"patched_source" text,
	"verdict" "verdict",
	"delta_ratio" real,
	"verify_log" text,
	"before_url" text,
	"after_url" text,
	"diff_url" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"finding_id" uuid,
	"stage" text NOT NULL,
	"model_id" text NOT NULL,
	"tier" "tier" NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_url" text NOT NULL,
	"ref" text,
	"ds_path" text,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "findings_run_id_idx" ON "findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "findings_run_id_verdict_idx" ON "findings" USING btree ("run_id","verdict");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_run_id_idx" ON "llm_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_run_id_stage_tier_idx" ON "llm_calls" USING btree ("run_id","stage","tier");