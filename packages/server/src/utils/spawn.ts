import type { ChildProcess, SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcess as spawnCli, execCommand as execCli } from "@getpaseo/plugin/server";
import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> & ExternalEnvOptions;

interface ExecCommandOptions extends ExternalEnvOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Point PWD at the child's real cwd, as a shell does on `cd`. Otherwise the child inherits the
 * daemon's PWD (often `/` under launchd), and tools that prefer $PWD over getcwd() — context-mode
 * resolves its project dir that way — run everything from the wrong directory.
 */
function withChildPwd(env: NodeJS.ProcessEnv, cwd: string | URL | undefined): NodeJS.ProcessEnv {
  if (cwd === undefined) {
    return env;
  }
  return { ...env, PWD: resolve(typeof cwd === "string" ? cwd : fileURLToPath(cwd)) };
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  return spawnCli(command, args, {
    ...spawnOptions,
    env: withChildPwd(childEnv, spawnOptions.cwd),
    signal: options?.signal,
  });
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const { baseEnv, env, envOverlay } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  return execCli(command, args, {
    cwd: options?.cwd,
    env: withChildPwd(childEnv, options?.cwd),
    shell: options?.shell,
    encoding: options?.encoding ?? "utf8",
    signal: options?.signal,
    killSignal: options?.killSignal,
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer,
  }) as Promise<ExecCommandResult>;
}
