// This file is loaded by Pi only for a Backpass analysis of a large transcript.
// It deliberately exposes a query tool, not the source path or an arbitrary file reader.

import {
  createInspectorState,
  inspectTranscript,
  readInspectorManifest,
  TRANSCRIPT_INSPECTOR_TOOL,
} from "./transcript-inspector.js";

const PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Literal text to find in the current transcript. Search before asking for context.",
    },
    role: {
      type: "string",
      enum: ["user", "assistant", "tool"],
      description: "Optional event role filter.",
    },
    contextTurns: {
      type: "integer",
      minimum: 0,
      maximum: 2,
      description: "Include up to this many neighboring turns around each match. Defaults to 0.",
    },
    maxMatches: {
      type: "integer",
      minimum: 1,
      maximum: 8,
      description: "Maximum matching events to return. Defaults to 8.",
    },
    maxChars: {
      type: "integer",
      minimum: 512,
      maximum: 8192,
      description: "Maximum response size. Defaults to 8192 characters.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

export default function registerBackpassTranscriptInspector(pi) {
  const manifestPath = process.env.BACKPASS_TRANSCRIPT_INSPECTOR_MANIFEST;
  let manifest = null;
  let loadError = null;
  if (manifestPath) {
    try {
      manifest = readInspectorManifest(manifestPath);
    } catch (error) {
      loadError = error.message;
    }
  } else {
    loadError = "the Backpass transcript inspector manifest was not provided";
  }

  const state = createInspectorState();
  pi.registerTool({
    name: TRANSCRIPT_INSPECTOR_TOOL,
    label: "Inspect transcript",
    description:
      "Search the current large Backpass transcript for exact evidence. This is the only supported access to omitted transcript text. Use a focused literal query, then quote the returned text verbatim. Responses and total session access are hard-capped.",
    parameters: PARAMETERS,
    async execute(_id, params) {
      if (!manifest) {
        return {
          content: [{ type: "text", text: `Transcript inspector unavailable: ${loadError}` }],
          details: { error: true },
        };
      }
      return inspectTranscript(manifest, params, state);
    },
  });
}
