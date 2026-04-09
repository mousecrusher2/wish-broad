import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

const ReactCompilerConfig = {
  /* ... */
};

export default defineConfig({
  environments: {
    whip_worker: {
      build: {
        minify: true,
      },
    },
  },
  plugins: [
    tailwindcss(),
    react({
      babel: { plugins: ["babel-plugin-react-compiler", ReactCompilerConfig] },
    }),
    cloudflare(),
  ],
});
