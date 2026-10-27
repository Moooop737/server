/**
 * 由 `npm run db:schema` 生成，含四张 CRUD 表、codebases 与 trace_stages（仅 schema）；timestamptz 用 date 模式。
 * 索引归 dbmate；BM25/向量仍走 search-lexical/search-vector 的裸 SQL。
 * 不要手改。
 */

import { pgTable, uniqueIndex, check, uuid, text, timestamp, bigint, foreignKey, jsonb, integer, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const resource_status = pgEnum("resource_status", ['uploading', 'uploaded', 'processing', 'ready', 'upload_failed', 'process_failed'])


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

export const sessions = pgTable("sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'date' }),
});

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
}, (table) => [
	foreignKey({
			columns: [table.session_id],
			foreignColumns: [sessions.id],
			name: "messages_session_id_fkey"
		}).onDelete("cascade"),
	check("messages_role_check", sql`role = ANY (ARRAY['user'::text, 'assistant'::text])`),
]);

export const trace_stages = pgTable("trace_stages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	trace_id: text().notNull(),
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

export const traces = pgTable("traces", {
	id: text().primaryKey().notNull(),
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
