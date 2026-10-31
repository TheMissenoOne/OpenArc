// ponytail: the two Node APIs the extension uses, declared here instead of adding @types/node.
declare module "child_process" {
  export function execFile(file: string, args: string[], options: { cwd: string; shell?: boolean },
    callback: (error: Error | null, stdout: string, stderr: string) => void): unknown;
}
declare const process: { platform: string };
declare class TextDecoder { decode(input: Uint8Array): string }
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
