import { config as defaultConfig } from "@gingacodemonkey/config/styled";
import type { Linter } from "eslint";
import { extraRules } from "./eslint.config.ts";

const config: Array<Linter.Config> = [
  ...defaultConfig,
  ...extraRules,
];

export default config;
