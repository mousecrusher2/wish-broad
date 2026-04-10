import { defineConfig, type PluginOption } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

const ReactCompilerConfig = {
  /* ... */
};

export default defineConfig(({ mode }) => {
  const isAnalyzeMode = mode === "analyze";
  const plugins: PluginOption[] = [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset(ReactCompilerConfig)] }),
    cloudflare(),
  ];

  if (isAnalyzeMode) {
    plugins.push(
      visualizer({
        brotliSize: true,
        emitFile: true,
        filename: "bundle-analysis.html",
        gzipSize: true,
        open: false,
        sourcemap: true,
        template: "treemap",
      }) as PluginOption,
    );
  }

  return {
    build: {
      sourcemap: isAnalyzeMode,
    },
    environments: {
      whip_worker: {
        build: {
          minify: true,
          sourcemap: isAnalyzeMode,
        },
      },
    },
    plugins,
  };
});
