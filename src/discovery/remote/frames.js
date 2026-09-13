/**
 * The fetch wire format: a length-framed stream of transcript payloads.
 *
 * One frame is a single-line JSON header, a newline, then exactly `header.bytes` raw
 * bytes of body. The stream ends with a `{"end":true}` header carrying no body. Raw
 * bytes rather than JSON strings because file-backed stores ship the transcript file as
 * it is on disk (the analysis agent's raw-transcript escape hatch reads it back), and
 * because a declared byte count is what lets the reader tell a torn connection from a
 * complete one instead of analyzing a truncated session.
 *
 * This module ships to the remote inside the probe bundle, so it stays dependency-free
 * and is the single definition of the format both sides read.
 */

/** The probe wire contract's version. Both sides refuse a response that does not match. */
export const PROTOCOL = 1;

const NEWLINE = 0x0a;

/** The header line (plus its newline) for one frame. */
export function encodeFrameHeader(header) {
  return Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
}

export function encodeEndFrame() {
  return encodeFrameHeader({ end: true });
}

/**
 * Incremental reader. `push` returns the frames completed by this chunk; `ended` turns
 * true once the terminator arrives, so a stream that stops early is distinguishable
 * from one that finished.
 */
export function createFrameReader() {
  /** @type {Buffer<ArrayBufferLike>} */
  let buffer = Buffer.alloc(0);
  /** @type {object | null} */
  let awaiting = null;
  let ended = false;

  function takeLine() {
    const index = buffer.indexOf(NEWLINE);
    if (index === -1) return null;
    const line = buffer.subarray(0, index).toString("utf8");
    buffer = buffer.subarray(index + 1);
    return line;
  }

  return {
    /** @param {Buffer} chunk @returns {{ header: object, body: Buffer }[]} */
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const frames = [];
      for (;;) {
        if (ended) return frames;
        if (!awaiting) {
          const line = takeLine();
          if (line === null) return frames;
          let header;
          try {
            header = JSON.parse(line);
          } catch {
            throw new Error(`probe response unreadable: frame header is not JSON (${line.slice(0, 120)})`);
          }
          if (!header || typeof header !== "object" || Array.isArray(header)) {
            throw new Error("probe response unreadable: frame header is not an object");
          }
          if (header.end === true) {
            ended = true;
            return frames;
          }
          const validFrame =
            typeof header.key === "string" &&
            header.key.length > 0 &&
            typeof header.harness === "string" &&
            header.harness.length > 0 &&
            ["raw", "events", "error"].includes(header.kind) &&
            Number.isSafeInteger(header.bytes) &&
            header.bytes >= 0 &&
            (header.kind !== "error" || (header.bytes === 0 && typeof header.error === "string"));
          if (!validFrame) throw new Error("probe response unreadable: invalid frame header");
          awaiting = header;
        }
        const want = awaiting.bytes;
        if (buffer.length < want) return frames;
        frames.push({ header: awaiting, body: Buffer.from(buffer.subarray(0, want)) });
        buffer = buffer.subarray(want);
        awaiting = null;
      }
    },
    get ended() {
      return ended;
    },
    /** Bytes received for a frame whose body never arrived - a torn stream. */
    get incomplete() {
      return awaiting ? { header: awaiting, received: buffer.length } : null;
    },
  };
}
