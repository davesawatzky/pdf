import { defineConfig, lazyPlugins } from "vite-plus";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  base: "./",
  plugins: lazyPlugins(() => [vue()]),
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022", outDir: "dist" },
  test: {
    include: ["./tests/**/*.spec.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.vue"],
      exclude: ["src/env.d.ts", "src/main.ts"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
