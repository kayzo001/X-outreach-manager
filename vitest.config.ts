import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      DATABASE_URL: "postgresql://kayzo@localhost:5432/xom_test",
      REDIS_URL: "redis://localhost:6379/9",
      ENCRYPTION_KEY: "0".repeat(64),
      CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64),
      SESSION_SECRET: "test-session-secret-test-session-secret",
      X_PROVIDER: "mock",
    },
  },
});
