-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ResolveStatus" AS ENUM ('UNRESOLVED', 'RESOLVED', 'NOT_FOUND', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'NOT_OPTED_IN', 'OPTED_IN', 'EXPIRED', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "HistoryStatus" AS ENUM ('UNKNOWN', 'NONE_FOUND', 'CONTACTED');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('NONE', 'INTERESTED', 'NOT_INTERESTED', 'POTENTIAL_CUSTOMER', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "MrrKind" AS ENUM ('UNKNOWN', 'SELF_REPORTED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING_APPROVAL', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED', 'SKIPPED', 'DRY_RUN');

-- CreateEnum
CREATE TYPE "LedgerState" AS ENUM ('RESERVED', 'SENT', 'UNCERTAIN', 'MANUAL', 'VOID');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('OUT', 'IN');

-- CreateEnum
CREATE TYPE "ConvStatus" AS ENUM ('OPEN', 'INTERESTED', 'NOT_INTERESTED', 'POTENTIAL_CUSTOMER', 'CONVERTED', 'DO_NOT_CONTACT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PREVIEWED', 'COMMITTING', 'COMMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'VALID', 'NEW', 'EXISTING', 'DUP_IN_FILE', 'INVALID');

-- CreateEnum
CREATE TYPE "ManualStatus" AS ENUM ('QUEUED', 'CONTACTED', 'REPLIED', 'SKIPPED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSyncAt" TIMESTAMP(3),
    "syncCursor" TEXT,
    "rateLimitedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "x_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "usernameNormalized" TEXT NOT NULL,
    "usernameDisplay" TEXT NOT NULL,
    "xUserId" TEXT,
    "resolveStatus" "ResolveStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "founderName" TEXT,
    "company" TEXT,
    "website" TEXT,
    "product" TEXT,
    "industry" TEXT,
    "location" TEXT,
    "country" TEXT,
    "language" TEXT,
    "bio" TEXT,
    "notes" TEXT,
    "customHook" TEXT,
    "followers" INTEGER,
    "verified" BOOLEAN,
    "lastActiveAt" TIMESTAMP(3),
    "mrr" INTEGER,
    "mrrKind" "MrrKind" NOT NULL DEFAULT 'UNKNOWN',
    "mrrSourceUrl" TEXT,
    "sourceUrl" TEXT,
    "leadSource" TEXT,
    "customerStatus" "CustomerStatus" NOT NULL DEFAULT 'NONE',
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "historyStatus" "HistoryStatus" NOT NULL DEFAULT 'UNKNOWN',
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "manualStatus" "ManualStatus",
    "customFields" JSONB,
    "firstImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_identifiers" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "csv_imports" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "headers" TEXT[],
    "mapping" JSONB,
    "campaignId" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "newRows" INTEGER NOT NULL DEFAULT 0,
    "existingRows" INTEGER NOT NULL DEFAULT 0,
    "dupInFileRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "committedRows" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "csv_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "csv_import_rows" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "usernameNormalized" TEXT,
    "contactId" TEXT,

    CONSTRAINT "csv_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "audience" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "xAccountId" TEXT,
    "templateId" TEXT,
    "templateBody" TEXT,
    "schedule" JSONB NOT NULL,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "autoPaused" BOOLEAN NOT NULL DEFAULT false,
    "pauseReason" TEXT,
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "nextSendAt" TIMESTAMP(3),
    "batchSentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_contacts" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "customMessage" TEXT,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_jobs" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "xAccountId" TEXT NOT NULL,
    "consentRecordId" TEXT,
    "body" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "notBefore" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "apiStatus" INTEGER,
    "errorCategory" TEXT,
    "lastError" TEXT,
    "xEventId" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "message_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_ledger" (
    "id" TEXT NOT NULL,
    "xAccountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "state" "LedgerState" NOT NULL,
    "jobId" TEXT,
    "campaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "campaignId" TEXT,
    "contactId" TEXT NOT NULL,
    "xAccountId" TEXT,
    "conversationId" TEXT,
    "direction" "Direction" NOT NULL,
    "xEventId" TEXT,
    "text" TEXT NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "consentRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "xAccountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "xConversationId" TEXT,
    "lastIncomingAt" TIMESTAMP(3),
    "lastOutgoingAt" TIMESTAMP(3),
    "lastPreview" TEXT,
    "replied" BOOLEAN NOT NULL DEFAULT false,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "status" "ConvStatus" NOT NULL DEFAULT 'OPEN',
    "tags" TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT,
    "scope" TEXT,
    "xAccountId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_list" (
    "id" TEXT NOT NULL,
    "usernameNormalized" TEXT NOT NULL,
    "xUserId" TEXT,
    "contactId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "contactId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("contactId","tagId")
);

-- CreateTable
CREATE TABLE "lead_scores" (
    "contactId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "factors" JSONB NOT NULL,
    "incomplete" BOOLEAN NOT NULL DEFAULT true,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_scores_pkey" PRIMARY KEY ("contactId")
);

-- CreateTable
CREATE TABLE "saved_filters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "contactId" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "contactId" TEXT,
    "campaignId" TEXT,
    "xAccountId" TEXT,
    "jobId" TEXT,
    "apiStatus" INTEGER,
    "errorCategory" TEXT,
    "retryCount" INTEGER,
    "consentRecordId" TEXT,
    "meta" JSONB,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_status" (
    "id" TEXT NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "info" JSONB,

    CONSTRAINT "worker_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "x_accounts_xUserId_key" ON "x_accounts"("xUserId");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_usernameNormalized_key" ON "contacts"("usernameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_xUserId_key" ON "contacts"("xUserId");

-- CreateIndex
CREATE INDEX "contacts_consentStatus_idx" ON "contacts"("consentStatus");

-- CreateIndex
CREATE INDEX "contacts_historyStatus_idx" ON "contacts"("historyStatus");

-- CreateIndex
CREATE INDEX "contacts_company_idx" ON "contacts"("company");

-- CreateIndex
CREATE INDEX "contacts_industry_idx" ON "contacts"("industry");

-- CreateIndex
CREATE INDEX "contacts_createdAt_idx" ON "contacts"("createdAt");

-- CreateIndex
CREATE INDEX "contact_identifiers_contactId_idx" ON "contact_identifiers"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "contact_identifiers_type_value_key" ON "contact_identifiers"("type", "value");

-- CreateIndex
CREATE INDEX "csv_import_rows_importId_status_idx" ON "csv_import_rows"("importId", "status");

-- CreateIndex
CREATE INDEX "csv_import_rows_importId_rowNumber_idx" ON "csv_import_rows"("importId", "rowNumber");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaign_contacts_contactId_idx" ON "campaign_contacts"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_contacts_campaignId_contactId_key" ON "campaign_contacts"("campaignId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "message_jobs_idempotencyKey_key" ON "message_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "message_jobs_status_notBefore_idx" ON "message_jobs"("status", "notBefore");

-- CreateIndex
CREATE INDEX "message_jobs_campaignId_status_idx" ON "message_jobs"("campaignId", "status");

-- CreateIndex
CREATE INDEX "outreach_ledger_contactId_idx" ON "outreach_ledger"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_ledger_xAccountId_contactId_key" ON "outreach_ledger"("xAccountId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "messages_xEventId_key" ON "messages"("xEventId");

-- CreateIndex
CREATE INDEX "messages_contactId_sentAt_idx" ON "messages"("contactId", "sentAt");

-- CreateIndex
CREATE INDEX "messages_campaignId_sentAt_idx" ON "messages"("campaignId", "sentAt");

-- CreateIndex
CREATE INDEX "messages_direction_sentAt_idx" ON "messages"("direction", "sentAt");

-- CreateIndex
CREATE INDEX "conversations_xConversationId_idx" ON "conversations"("xConversationId");

-- CreateIndex
CREATE INDEX "conversations_replied_unread_idx" ON "conversations"("replied", "unread");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_xAccountId_contactId_key" ON "conversations"("xAccountId", "contactId");

-- CreateIndex
CREATE INDEX "consent_records_contactId_createdAt_idx" ON "consent_records"("contactId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_list_usernameNormalized_key" ON "suppression_list"("usernameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_list_xUserId_key" ON "suppression_list"("xUserId");

-- CreateIndex
CREATE UNIQUE INDEX "lead_tags_name_key" ON "lead_tags"("name");

-- CreateIndex
CREATE INDEX "lead_scores_score_idx" ON "lead_scores"("score");

-- CreateIndex
CREATE INDEX "reminders_done_dueAt_idx" ON "reminders"("done", "dueAt");

-- CreateIndex
CREATE INDEX "notifications_read_createdAt_idx" ON "notifications"("read", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_at_idx" ON "activity_logs"("at");

-- CreateIndex
CREATE INDEX "activity_logs_campaignId_at_idx" ON "activity_logs"("campaignId", "at");

-- CreateIndex
CREATE INDEX "activity_logs_contactId_at_idx" ON "activity_logs"("contactId", "at");

-- CreateIndex
CREATE INDEX "activity_logs_type_idx" ON "activity_logs"("type");

-- AddForeignKey
ALTER TABLE "x_accounts" ADD CONSTRAINT "x_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identifiers" ADD CONSTRAINT "contact_identifiers_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "csv_import_rows" ADD CONSTRAINT "csv_import_rows_importId_fkey" FOREIGN KEY ("importId") REFERENCES "csv_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "csv_import_rows" ADD CONSTRAINT "csv_import_rows_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_xAccountId_fkey" FOREIGN KEY ("xAccountId") REFERENCES "x_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_jobs" ADD CONSTRAINT "message_jobs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_jobs" ADD CONSTRAINT "message_jobs_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_jobs" ADD CONSTRAINT "message_jobs_xAccountId_fkey" FOREIGN KEY ("xAccountId") REFERENCES "x_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_ledger" ADD CONSTRAINT "outreach_ledger_xAccountId_fkey" FOREIGN KEY ("xAccountId") REFERENCES "x_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_ledger" ADD CONSTRAINT "outreach_ledger_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "message_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_xAccountId_fkey" FOREIGN KEY ("xAccountId") REFERENCES "x_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "lead_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────────────────────────────────────────────────────────
-- Hand-written guarantees (Prisma cannot express these)
-- ───────────────────────────────────────────────────────────────

-- Only ONE live (non-terminal) job may exist per sender/recipient pair,
-- no matter which campaign created it. Prevents double-queueing at the DB level.
CREATE UNIQUE INDEX "message_jobs_one_live_per_pair"
  ON "message_jobs" ("xAccountId", "contactId")
  WHERE "status" IN ('PENDING_APPROVAL', 'QUEUED', 'SENDING', 'UNCERTAIN');

-- Usernames are always stored normalised (lowercase, no @).
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_username_normalised"
  CHECK ("usernameNormalized" = lower("usernameNormalized") AND "usernameNormalized" ~ '^[a-z0-9_]{1,15}$');

ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_username_normalised"
  CHECK ("usernameNormalized" = lower("usernameNormalized"));

-- Activity log is append-only: block UPDATE and DELETE (use TRUNCATE for retention jobs).
CREATE OR REPLACE FUNCTION activity_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'activity_logs is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER activity_logs_no_update BEFORE UPDATE ON "activity_logs"
  FOR EACH ROW EXECUTE FUNCTION activity_logs_immutable();
