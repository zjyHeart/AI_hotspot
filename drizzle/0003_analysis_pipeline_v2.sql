CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`stage` text NOT NULL,
	`day` text NOT NULL,
	`model` text NOT NULL,
	`state` text NOT NULL,
	`reserved_tokens` integer NOT NULL,
	`tokens` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `ai_call_day` ON `ai_calls` (`day`);--> statement-breakpoint
CREATE TABLE `analysis_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`stage` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`payload` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`batch_limit` integer DEFAULT 3 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_due` ON `analysis_jobs` (`state`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `analysis_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`article_id` text NOT NULL,
	`digest` text NOT NULL,
	`state` text NOT NULL,
	`reason` text DEFAULT '等待 AI 初筛' NOT NULL,
	`relevance` integer,
	`value` integer,
	`group_key` text,
	`assessment` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `candidate_monitor_state` ON `analysis_candidates` (`monitor_id`,`state`);--> statement-breakpoint
CREATE INDEX `candidate_group` ON `analysis_candidates` (`monitor_id`,`group_key`);--> statement-breakpoint
CREATE TABLE `event_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`verdict` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `events` ADD `details` text DEFAULT '{}' NOT NULL;