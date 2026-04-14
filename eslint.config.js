import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import sonarjs from "eslint-plugin-sonarjs";
import tailwindcss from "eslint-plugin-tailwindcss";
import tseslint from "typescript-eslint";

const reactHooksConfig = reactHooks.configs.flat["recommended-latest"];
const tailwindcssConfigs = tailwindcss.configs["flat/recommended"].map(
  (config) => ({
    ...config,
    files: ["src/**/*.{ts,tsx}"],
  }),
);
const tsTypeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map(
  (config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  }),
);
const sonarjsRecommendedConfig = sonarjs.configs?.recommended ?? {
  plugins: { sonarjs },
};

export default [
  { ignores: ["dist", "worker-configuration.d.ts"] },
  js.configs.recommended,
  ...tsTypeCheckedConfigs,
  sonarjsRecommendedConfig,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumber: false,
          allowRegExp: false,
        },
      ],
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-arguments": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  ...tailwindcssConfigs,
  {
    files: ["src/**/*.{ts,tsx}"],
    settings: {
      tailwindcss: {
        config: {},
      },
    },
    rules: {
      "tailwindcss/classnames-order": "off",
      "tailwindcss/enforces-shorthand": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      ...reactHooksConfig.plugins,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooksConfig.rules,
      ...reactRefresh.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["worker/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.serviceworker,
      },
    },
  },
  {
    files: ["vite.config.ts", "vitest.config.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
];
