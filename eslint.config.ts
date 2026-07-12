import defaultConfig from "@gingacodemonkey/config/eslint";
import type { Linter } from "eslint";

export const extraRules: Array<Linter.Config> = [{
  rules: {
    "sonarjs/deprecation":"off",
  },
}];

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
