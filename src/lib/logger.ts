import fs from "fs";
import path from "path";
import { PATHS } from "../config";

/** Logger simple a consola + archivo, para poder monitorear el progreso de corridas largas. */
export class Logger {
  private filePath: string;

  constructor(runName: string) {
    fs.mkdirSync(PATHS.logDir, { recursive: true });
    this.filePath = path.join(PATHS.logDir, `${runName}.log`);
  }

  private write(level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    fs.appendFileSync(this.filePath, line + "\n", "utf-8");
  }

  info(msg: string): void {
    this.write("INFO", msg);
  }

  warn(msg: string): void {
    this.write("WARN", msg);
  }

  error(msg: string): void {
    this.write("ERROR", msg);
  }
}
