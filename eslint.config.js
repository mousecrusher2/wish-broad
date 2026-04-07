import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const reactHooksConfig = reactHooks.configs.flat["recommended-latest"];

export default tseslint.config(
  { ignores: ["dist", "worker-configuration.d.ts"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
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
);
