import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";

const ReactCompilerConfig = {/* ... */};

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
    react(),
    babel({ presets: [reactCompilerPreset(ReactCompilerConfig)] }),
    cloudflare(),
  ],
});
