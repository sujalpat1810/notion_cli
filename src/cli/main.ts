import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { ExitCode, toCliError } from "../notion/errors";
import { registerAuth } from "./commands/auth";
import { registerDoctor } from "./commands/doctor";
import { Output } from "./output";

const program = new Command()
  .name("notion-cli")
  .description("Build Notion templates and dashboards from YAML specs")
  .version(pkg.version)
  .option("--profile <name>", "credentials profile to use (default: \"default\")")
  .option("--json", "machine-readable output on stdout")
  .option("--debug", "log every Notion HTTP call to the log directory")
  .option("--no-color", "disable colours")
  .showHelpAfterError();

registerAuth(program);
registerDoctor(program);

process.on("SIGINT", () => process.exit(ExitCode.Interrupted));

try {
  await program.parseAsync();
} catch (err) {
  const e = toCliError(err);
  const opts = program.opts<{ json?: boolean; color?: boolean }>();
  new Output(Boolean(opts.json), opts.color !== false).error(e.message, e.hint);
  if (process.env.NOTION_CLI_STACK && e.cause instanceof Error) console.error(e.cause.stack);
  process.exitCode = e.exitCode;
}
