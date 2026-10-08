import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", "esbuild.config.mjs"],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["NextSync", "Nextcloud", "WebDAV", "HTTPS"] }],
    },
  },
]);
