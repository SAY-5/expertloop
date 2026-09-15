import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", sourcemap: false },
  // the self-check imports the compiler and executor fixtures the Python suite writes to
  // ../samples/expected, which is outside this package
  server: { fs: { allow: [".."] } },
});
