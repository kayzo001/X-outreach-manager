-- AlterTable
ALTER TABLE "x_accounts" ADD COLUMN     "oauthClientId" TEXT;

-- CreateTable
CREATE TABLE "integration_credentials" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_credentials_provider_key" ON "integration_credentials"("provider");

-- Defence in depth: the secret column only ever accepts our AES-GCM envelope ("c1.<iv>.<tag>.<ct>"), never plaintext.
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_secret_encrypted"
  CHECK ("clientSecretEnc" IS NULL OR "clientSecretEnc" ~ '^c1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
