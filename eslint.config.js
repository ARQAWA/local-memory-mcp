import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": ["warn", { allowInterfaces: "with-single-extends" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unnecessary-condition": "warn",
      // Express route handlers are async but Express expects sync — void wrapping is noise
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      // MCP SDK .tool() / .prompt() are deprecated but no alternative yet in SDK version we use
      "@typescript-eslint/no-deprecated": "warn",
      // Async without await is common in Express middleware and callback-based APIs
      "@typescript-eslint/require-await": "warn",
      // Empty functions are common as no-op callbacks
      "@typescript-eslint/no-empty-function": "off",
      // Allow confusing void expressions for express one-liners
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
    },
  },
  {
    // Database connection — typed sync wrapper around node:sqlite.
    files: ["src/db/connection.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
    },
  },
  {
    // SQLite calls are sync, but repositories keep async public contracts.
    files: ["src/repositories/**/*.ts", "src/api/admin-routes.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Tool error handler — single `any` cast for stripUndefined return type
    files: ["src/tools/util.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Server entry point — dynamic imports and SDK interop
    files: ["src/index.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Memory blocks tool — uses any for block metadata operations
    files: ["src/tools/blocks.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    // Test files — relaxed rules for mocks, fixtures, and test utilities
    files: ["tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off", // Allow `any` in mocks and test fixtures
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off", // Allow ! in tests for convenience
      "@typescript-eslint/no-unnecessary-condition": "off", // Allow explicit checks in tests
      "@typescript-eslint/require-await": "off", // Allow async test functions without await
      "@typescript-eslint/unbound-method": "off", // Allow unbound methods in test mocks
      "@typescript-eslint/no-floating-promises": "off", // Allow floating promises in tests (fire and forget)
      "@typescript-eslint/no-require-imports": "off", // Allow require() in test fixtures
      "@typescript-eslint/no-dynamic-delete": "off", // Allow dynamic deletes in test cleanup
      "@typescript-eslint/prefer-nullish-coalescing": "off", // Allow || in tests for flexibility
      "@typescript-eslint/no-unnecessary-type-assertion": "off", // Allow type assertions in tests
      "@typescript-eslint/no-unnecessary-type-parameters": "off", // Allow single-use type params in test helpers
      "@typescript-eslint/array-type": "off", // Allow Array<T> syntax in tests
      "prefer-const": "off", // Allow let in tests even when not reassigned
    },
  },
  { ignores: ["dist/", "node_modules/", "*.config.*", "eslint.config.js"] },
);
