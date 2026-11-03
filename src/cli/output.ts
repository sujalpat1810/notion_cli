import pc from "picocolors";

export type Colors = ReturnType<typeof pc.createColors>;

/**
 * Human output goes to stderr in --json mode so stdout stays machine-readable.
 */
export class Output {
  readonly c: Colors;
  constructor(
    readonly json: boolean,
    color: boolean,
  ) {
    this.c = pc.createColors(color && !json && pc.isColorSupported);
  }

  info(message: string): void {
    this.#human(message);
  }
  success(message: string): void {
    this.#human(`${this.c.green("✔")} ${message}`);
  }
  warn(message: string): void {
    this.#human(`${this.c.yellow("▲")} ${message}`);
  }
  error(message: string, hint?: string): void {
    console.error(`${this.c.red("✖")} ${message}`);
    if (hint) console.error(`  ${this.c.dim(hint)}`);
  }

  /** Prints the command's result: JSON on stdout in --json mode, nothing otherwise. */
  result(value: unknown): void {
    if (this.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  table(rows: string[][], header?: string[]): void {
    const all = header ? [header, ...rows] : rows;
    const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => visibleLength(r[i] ?? "")))) ?? [];
    const line = (r: string[]) =>
      r.map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat(widths[i]! - visibleLength(cell)))).join("  ");
    if (header) {
      this.#human(this.c.bold(line(header)));
    }
    for (const r of rows) this.#human(line(r));
  }

  #human(message: string): void {
    if (this.json) console.error(message);
    else console.log(message);
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Length without ANSI colour codes, so coloured cells align. */
function visibleLength(s: string): number {
  return s.replace(ANSI, "").length;
}
