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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const analyzePlugin = visualizer({
      brotliSize: true,
      emitFile: true,
      filename: "bundle-analysis.html",
      gzipSize: true,
      open: false,
      sourcemap: true,
      template: "treemap",
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
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
