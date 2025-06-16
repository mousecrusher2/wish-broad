import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";

const ReactCompilerConfig = {
  /* ... */
};

export default defineConfig({
  plugins: [
    react({
      babel: { plugins: ["babel-plugin-react-compiler", ReactCompilerConfig] },
    }),
    cloudflare(),
  ],
});
