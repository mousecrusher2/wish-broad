import { defineConfig, type PluginOption } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

const ReactCompilerConfig = {/* ... */};

export default defineConfig(({ mode }) => {
  const isAnalyzeMode = mode === "analyze";
  const plugins: PluginOption[] = [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset(ReactCompilerConfig)] }),
    cloudflare(),
  ];

  if (isAnalyzeMode) {
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Rollup visualizer and Rolldown expose incompatible plugin types.
    const analyzePlugin = visualizer({
      brotliSize: true,
      emitFile: true,
      filename: "bundle-analysis.html",
      gzipSize: true,
      open: false,
      sourcemap: true,
      template: "treemap",
    });
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Vite accepts this Rollup-compatible plugin at runtime.
    plugins.push(analyzePlugin);
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
