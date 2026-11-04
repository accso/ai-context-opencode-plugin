/**
 * Newline-delimited JSON over a unix socket between the plugin (client)
 * and the shared embedding worker (ADR-0021).
 */
export type EmbedPrefix = "query" | "document";

export interface EmbedRequest {
  id: number;
  op: "embed";
  prefix: EmbedPrefix;
  text: string;
}

export interface RerankRequest {
  id: number;
  op: "rerank";
  query: string;
  texts: string[];
}

export interface EmbedResponse {
  id: number;
  vector?: number[];
  scores?: number[];
  error?: string;
}

export interface WorkerEvent {
  event: "model-loading";
  loading: boolean;
}

export function encodeMessage(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

/** Reassembles messages from arbitrary socket chunks (multi-byte safe). */
export function createLineDecoder(onMessage: (message: any) => void) {
  let buffered = Buffer.alloc(0);
  return {
    push(chunk: Buffer) {
      buffered = Buffer.concat([buffered, chunk]);
      let newline: number;
      while ((newline = buffered.indexOf(0x0a)) !== -1) {
        const line = buffered.subarray(0, newline).toString("utf8");
        buffered = buffered.subarray(newline + 1);
        if (line.trim() === "") continue;
        try {
          onMessage(JSON.parse(line));
        } catch {
          // a corrupt line must not take the connection down
        }
      }
    },
  };
}
