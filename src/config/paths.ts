import { join } from "node:path";
import envPaths from "env-paths";

const base = envPaths("notion-cli", { suffix: "" });

/** OS-appropriate directories (on Windows: %APPDATA%\notion-cli\Config, %LOCALAPPDATA%\notion-cli\Data, ...). */
export const paths = {
  config: process.env.NOTION_CLI_CONFIG_DIR ?? base.config,
  data: base.data,
  log: base.log,
  state: process.env.NOTION_CLI_STATE_DIR ?? join(base.data, "state"),
  get configFile() {
    return join(this.config, "config.json");
  },
};
