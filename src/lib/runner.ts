import { spawn, type ChildProcess } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  signal?: AbortSignal;
}

export function run(
  command: string,
  args: string[],
  optionsOrCwd?: string | RunOptions,
): Promise<CommandResult> {
  const options: RunOptions =
    typeof optionsOrCwd === "string"
      ? { cwd: optionsOrCwd }
      : (optionsOrCwd ?? {});

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    let stdout = "";
    let stderr = "";

    if (options.signal) {
      if (options.signal.aborted) {
        try {
          child.kill();
        } catch {}
      } else {
        options.signal.addEventListener(
          "abort",
          () => {
            try {
              child.kill();
            } catch {}
          },
          { once: true },
        );
      }
    }

    if (options.stdin !== undefined) {
      if (typeof (options.stdin as any).pipe === "function") {
        (options.stdin as any).pipe(child.stdin);
      } else {
        child.stdin.end(options.stdin);
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export interface StreamOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer | NodeJS.ReadableStream;
  onLine?: (line: string) => void;
  onChunk?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export type StreamPromise = Promise<CommandResult> & { child: ChildProcess };

export function stream(
  command: string,
  args: string[],
  options: StreamOptions = {},
): StreamPromise {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });

  if (options.stdin !== undefined) {
    if (typeof (options.stdin as any).pipe === "function") {
      (options.stdin as any).pipe(child.stdin);
    } else {
      child.stdin.end(options.stdin);
    }
  }

  if (options.signal) {
    if (options.signal.aborted) {
      child.kill();
    } else {
      options.signal.addEventListener(
        "abort",
        () => {
          try {
            child.kill();
          } catch {}
        },
        { once: true },
      );
    }
  }

  const p = new Promise<CommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      const value = chunk.toString();
      if (target === "stdout") {
        stdout += value;
        if (options.onStdout) options.onStdout(value);
      } else {
        stderr += value;
        if (options.onStderr) options.onStderr(value);
      }

      if (options.onChunk) {
        options.onChunk(value);
      }
      if (options.onLine) {
        for (const line of value.split(/\r?\n/)) {
          if (line) options.onLine(line);
        }
      }
    };

    child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk) => consume(chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  }) as StreamPromise;

  p.child = child;
  return p;
}
