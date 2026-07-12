import { config as defaultConfig } from "@gingacodemonkey/config/styled";
import type { Linter } from "eslint";
import { extraRules } from "./eslint.config.ts";

const config: Array<Linter.Config> = [
  { ignores: [ "commitlint.config.js" ] },
  ...defaultConfig,
  {
    files: [ "eslint.config.ts", "eslint.config.style.ts" ],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: [ "eslint.config.ts", "eslint.config.style.ts" ] },
      },
    },
  },
  ...extraRules,
];

export default config;