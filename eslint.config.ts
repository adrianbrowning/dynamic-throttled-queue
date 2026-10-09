import defaultConfig from "@gingacodemonkey/config/eslint";
import type { Linter } from "eslint";

export const extraRules: Array<Linter.Config> = [
  {rules: {
    "perfectionist/sort-object-types": "off"
    }},
    {
  files: [ "eslint.config.ts", "eslint.config.style.ts" ],
  languageOptions: {
    parserOptions: {
      projectService: { allowDefaultProject: [ "eslint.config.ts", "eslint.config.style.ts" ] },
    },
  },
}];

const config: Array<Linter.Config> = [
  ...defaultConfig,
  ...extraRules,
];

export default config;
