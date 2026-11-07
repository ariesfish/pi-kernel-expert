import { execFile } from "node:child_process";

/** A HostExec backed by real processes, for tests that need git. */
export function processExec() {
  return {
    exec(command, args, options = {}) {
      return new Promise((resolve) => {
        execFile(
          command,
          args,
          { cwd: options.cwd, timeout: options.timeout ?? 30_000, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              killed: Boolean(error?.killed),
              truncated: false,
            });
          },
        );
      });
    },
  };
}
