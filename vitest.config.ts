import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      SECRET_KEY: "test-secret-key",
      DATA_DIR: "./data-test",
      DEFAULT_MODEL: "claude-opus-5",
      ALLOWED_MODELS: "claude-opus-5,claude-sonnet-5,claude-haiku-4-5",
      DEFAULT_RESPOND_AUTOMATICALLY: "true",
      ENFORCE_SPEND_LIMITS: "true",
      LOG_LEVEL: "error",
    },
  },
});
