import { spawn } from "node:child_process";

export type Result = { code: number; stdout: string; stderr: string };

type RunOptions = { input?: string; timeoutMs?: number };

export function run(
  cmd: string,
  args: string[],
  { input, timeoutMs }: RunOptions = {},
): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export async function localName() {
  const { stdout } = await run("scutil", ["--get", "LocalHostName"]);
  return stdout.trim() || "this Mac";
}

export function interactive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export function lines(
  cmd: string,
  args: string[],
  onLine: (line: string) => boolean | undefined,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
    let buffer = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (line && onLine(line)) child.kill("SIGTERM");
      }
    });
    child.on("error", () => resolve(127));
    child.on("close", (code) => {
      if (buffer) onLine(buffer);
      resolve(code ?? 0);
    });
  });
}
