CREATE TABLE `article_monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`article_id` text NOT NULL,
	`analyzed_at` integer,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`url` text NOT NULL,
	`author` text NOT NULL,
	`published_at` integer NOT NULL,
	`collected_at` integer NOT NULL,
	`metrics` text NOT NULL,
	`origin_key` text NOT NULL,
	`is_repost` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`status` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`event_key` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`relevance` integer NOT NULL,
	`credibility` text NOT NULL,
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`score` integer NOT NULL,
	`score_reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`notified_at` integer,
	`revision` integer NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `article_metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`sampled_at` integer NOT NULL,
	`metrics` text NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`keywords` text NOT NULL,
	`aliases` text NOT NULL,
	`excludes` text NOT NULL,
	`sources` text NOT NULL,
	`rss_urls` text NOT NULL,
	`interval_minutes` integer NOT NULL,
	`min_relevance` integer NOT NULL,
	`notify_unverified` integer NOT NULL,
	`cooldown_minutes` integer NOT NULL,
	`active` integer NOT NULL,
	`scan_requested` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer NOT NULL,
	`last_status` text DEFAULT 'idle' NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`monitor_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`email_status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`monitor_name` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`reports` text NOT NULL,
	`analyzed_count` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
