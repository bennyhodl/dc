import type { Readable } from "node:stream";

const LF = 0x0a;

/**
 * Calls onLine with each record of a JSON-lines stream, without its LF. Splits
 * on LF only, as Pi's RPC framing requires: U+2028 and U+2029 may appear
 * inside records. Resolves when the stream ends.
 */
export function readLines(stream: Readable, onLine: (line: Buffer) => void): Promise<void> {
  return new Promise((resolve) => {
    let partial: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      let start = 0;
      for (let lf = chunk.indexOf(LF); lf !== -1; lf = chunk.indexOf(LF, start)) {
        partial.push(chunk.subarray(start, lf));
        onLine(partial.length === 1 ? partial[0]! : Buffer.concat(partial));
        partial = [];
        start = lf + 1;
      }
      if (start < chunk.length) partial.push(chunk.subarray(start));
    });
    stream.on("end", () => {
      if (partial.length) onLine(Buffer.concat(partial));
      resolve();
    });
    stream.on("error", () => resolve());
  });
}
