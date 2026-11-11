/**
 * 由 `npm run db:schema` 生成，含四张 CRUD 表、codebases、trace_stages、四张 eval 表与三张配置表（仅 schema）；timestamptz 用 date 模式。
 * 索引归 dbmate；BM25/向量仍走 search-lexical/search-vector 的裸 SQL。
 * 不要手改。
 */

import { pgTable, check, uuid, text, jsonb, timestamp, uniqueIndex, bigint, unique, boolean, foreignKey, integer, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const resource_status = pgEnum("resource_status", ['uploading', 'uploaded', 'processing', 'ready', 'upload_failed', 'process_failed'])


export const eval_configs = pgTable("eval_configs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	kind: text().notNull(),
	name: text().notNull(),
	config: jsonb().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, () => [
	check("eval_configs_kind_check", sql`kind = ANY (ARRAY['run'::text, 'metric'::text])`),
	check("eval_configs_name_nonempty", sql`btrim(name) <> ''::text`),
	check("eval_configs_config_object", sql`jsonb_typeof(config) = 'object'::text`),
]);

export const resources = pgTable("resources", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	source: text(),
	data_uri: text().notNull(),
	content_type: text().notNull(),
	status: resource_status().default('uploading').notNull(),
	error_reason: text(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'date' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storage_size_bytes: bigint({ mode: "number" }),
	content_hash: text(),
}, (table) => [
	uniqueIndex("resources_content_hash_uidx").using("btree", table.content_hash.asc().nullsLast().op("text_ops")).where(sql`(content_hash IS NOT NULL)`),
	uniqueIndex("resources_storage_uri_uidx").using("btree", table.data_uri.asc().nullsLast().op("text_ops")).where(sql`(data_uri ~~ 'kc://%'::text)`),
	check("resources_storage_size_nonnegative", sql`(storage_size_bytes IS NULL) OR (storage_size_bytes >= 0)`),
	check("resources_content_hash_sha256", sql`(content_hash IS NULL) OR (content_hash ~ '^[0-9a-f]{64}$'::text)`),
]);

export const providers = pgTable("providers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	kind: text().notNull(),
	base_url: text(),
	api_key_ciphertext: text(),
	headers_ciphertext: text(),
	query: jsonb().default({}).notNull(),
	enabled: boolean().default(true).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	options: jsonb().default({}).notNull(),
	icon: text(),
}, (table) => [
	unique("providers_name_key").on(table.name),
	check("providers_name_format", sql`name ~ '^[a-z0-9][a-z0-9_-]{0,31}$'::text`),
	check("providers_query_object", sql`jsonb_typeof(query) = 'object'::text`),
	check("providers_options_object", sql`jsonb_typeof(options) = 'object'::text`),
	check("providers_kind_check", sql`kind = ANY (ARRAY['deepseek'::text, 'dashscope'::text, 'openai-compatible'::text, 'ollama'::text])`),
	check("providers_base_url_check", sql`((kind = ANY (ARRAY['deepseek'::text, 'dashscope'::text])) AND (base_url IS NULL)) OR ((kind = ANY (ARRAY['openai-compatible'::text, 'ollama'::text])) AND (base_url IS NOT NULL))`),
	check("providers_icon_length", sql`(icon IS NULL) OR ((btrim(icon) <> ''::text) AND (char_length(icon) <= 32))`),
]);

export const models = pgTable("models", {
	id: text().primaryKey().notNull(),
	provider_id: uuid().notNull(),
	model_id: text().notNull(),
	kind: text().notNull(),
	display_name: text().notNull(),
	dimensions: integer(),
	enabled: boolean().default(true).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.provider_id],
			foreignColumns: [providers.id],
			name: "models_provider_id_fkey"
		}).onDelete("cascade"),
	unique("models_provider_model_kind_unique").on(table.provider_id, table.model_id, table.kind),
	check("models_id_nonempty", sql`btrim(id) <> ''::text`),
	check("models_id_kind_shape", sql`((kind = 'default'::text) AND (id = ANY (ARRAY['default'::text, 'embedding'::text]))) OR ((kind <> 'default'::text) AND (id ~~ '%:%'::text))`),
	check("models_model_id_nonempty", sql`btrim(model_id) <> ''::text`),
	check("models_display_name_nonempty", sql`btrim(display_name) <> ''::text`),
	check("models_kind_check", sql`kind = ANY (ARRAY['language'::text, 'embedding'::text, 'default'::text])`),
	check("models_dimensions_check", sql`((kind = 'embedding'::text) AND (dimensions IS NOT NULL) AND ((dimensions >= 1) AND (dimensions <= 16000))) OR ((kind = ANY (ARRAY['language'::text, 'default'::text])) AND (dimensions IS NULL))`),
]);

export const traces = pgTable("traces", {
	id: uuid().primaryKey().notNull(),
	session_id: uuid(),
	resource_id: uuid(),
	route: text().notNull(),
	http_status: integer(),
	started_at: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
	ended_at: timestamp({ withTimezone: true, mode: 'date' }),
	duration_ms: integer(),
	status: text().default('running').notNull(),
	error_code: text(),
	langfuse_trace_id: text(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	payloads: jsonb(),
}, () => [
	check("traces_status_check", sql`status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text, 'cancelled'::text])`),
]);

export const trace_stages = pgTable("trace_stages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	trace_id: uuid().notNull(),
	stage: text().notNull(),
	input: jsonb().notNull(),
	output: jsonb().notNull(),
	duration_ms: integer().notNull(),
	status: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.trace_id],
			foreignColumns: [traces.id],
			name: "trace_stages_trace_id_fkey"
		}).onDelete("cascade"),
	check("trace_stages_status_check", sql`status = ANY (ARRAY['ok'::text, 'error'::text])`),
]);

export const messages = pgTable("messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	session_id: uuid().notNull(),
	role: text().notNull(),
	content: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'date' }),
	parts: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sequence: bigint({ mode: "number" }).generatedAlwaysAsIdentity({ name: "messages_sequence_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	trace_id: uuid(),
}, (table) => [
	foreignKey({
			columns: [table.session_id],
			foreignColumns: [sessions.id],
			name: "messages_session_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.trace_id],
			foreignColumns: [traces.id],
			name: "messages_trace_id_fkey"
		}).onDelete("set null"),
	check("messages_role_check", sql`role = ANY (ARRAY['user'::text, 'assistant'::text])`),
]);

export const sessions = pgTable("sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'date' }),
	group_name: text(),
	model: text(),
});

export const pipeline_defs = pgTable("pipeline_defs", {
	id: text().primaryKey().notNull(),
	kind: text().notNull(),
	version: integer().default(1).notNull(),
	nodes: jsonb().notNull(),
	output_node: text(),
	enabled: boolean().default(true).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, () => [
	check("pipeline_defs_kind_check", sql`kind = 'retrieval'::text`),
	check("pipeline_defs_nodes_array", sql`jsonb_typeof(nodes) = 'array'::text`),
	check("pipeline_defs_version_positive", sql`version >= 1`),
]);

export const codebases = pgTable("codebases", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	original_filename: text().notNull(),
	data_uri: text().notNull(),
	content_type: text().default('application/zip').notNull(),
	status: text().default('uploading').notNull(),
	error_reason: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storage_size_bytes: bigint({ mode: "number" }),
	manifest: jsonb().default([]).notNull(),
	file_count: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	declared_uncompressed_bytes: bigint({ mode: "number" }).default(0).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("codebases_data_uri_uidx").using("btree", table.data_uri.asc().nullsLast().op("text_ops")),
	check("codebases_status_check", sql`status = ANY (ARRAY['uploading'::text, 'processing'::text, 'ready'::text, 'failed'::text])`),
	check("codebases_storage_size_nonnegative", sql`(storage_size_bytes IS NULL) OR (storage_size_bytes >= 0)`),
	check("codebases_storage_size_limit", sql`(storage_size_bytes IS NULL) OR (storage_size_bytes <= 104857600)`),
	check("codebases_manifest_array", sql`jsonb_typeof(manifest) = 'array'::text`),
	check("codebases_file_count_nonnegative", sql`file_count >= 0`),
	check("codebases_declared_uncompressed_nonnegative", sql`declared_uncompressed_bytes >= 0`),
]);

export const eval_datasets = pgTable("eval_datasets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	note: text().default('').notNull(),
	baseline_run_id: uuid(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("eval_datasets_name_uidx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	check("eval_datasets_name_nonempty", sql`btrim(name) <> ''::text`),
]);

export const eval_cases = pgTable("eval_cases", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dataset_id: uuid().notNull(),
	case_key: text().notNull(),
	level: text().notNull(),
	query: text().notNull(),
	negative: boolean().default(false).notNull(),
	note: text().default('').notNull(),
	gold: jsonb().default([]).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	assertions: jsonb().default({"expect":[],"reject":[]}).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.dataset_id],
			foreignColumns: [eval_datasets.id],
			name: "eval_cases_dataset_id_fkey"
		}).onDelete("cascade"),
	unique("eval_cases_dataset_key_unique").on(table.dataset_id, table.case_key),
	check("eval_cases_case_key_nonempty", sql`btrim(case_key) <> ''::text`),
	check("eval_cases_level_nonempty", sql`btrim(level) <> ''::text`),
	check("eval_cases_query_nonempty", sql`btrim(query) <> ''::text`),
	check("eval_cases_gold_array", sql`jsonb_typeof(gold) = 'array'::text`),
	check("eval_cases_negative_empty_gold", sql`(NOT negative) OR (gold = '[]'::jsonb)`),
	check("eval_cases_assertions_object", sql`jsonb_typeof(assertions) = 'object'::text`),
	check("eval_cases_assertions_shape", sql`(jsonb_typeof((assertions -> 'expect'::text)) = 'array'::text) AND (jsonb_typeof((assertions -> 'reject'::text)) = 'array'::text)`),
]);

export const eval_runs = pgTable("eval_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dataset_id: uuid().notNull(),
	status: text().default('queued').notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	run_config_id: uuid(),
	metric_config_id: uuid(),
	snapshot: jsonb().default({}).notNull(),
	results: jsonb().default([]).notNull(),
	started_at: timestamp({ withTimezone: true, mode: 'date' }),
	ended_at: timestamp({ withTimezone: true, mode: 'date' }),
	duration_ms: integer(),
	error_reason: text(),
	human_results: jsonb().default([]).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.dataset_id],
			foreignColumns: [eval_datasets.id],
			name: "eval_runs_dataset_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.run_config_id],
			foreignColumns: [eval_configs.id],
			name: "eval_runs_run_config_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.metric_config_id],
			foreignColumns: [eval_configs.id],
			name: "eval_runs_metric_config_id_fkey"
		}).onDelete("set null"),
	check("eval_runs_status_check", sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text, 'cancelled'::text])`),
	check("eval_runs_snapshot_object", sql`jsonb_typeof(snapshot) = 'object'::text`),
	check("eval_runs_results_array", sql`jsonb_typeof(results) = 'array'::text`),
	check("eval_runs_duration_nonnegative", sql`(duration_ms IS NULL) OR (duration_ms >= 0)`),
	check("eval_runs_human_results_array", sql`jsonb_typeof(human_results) = 'array'::text`),
]);
