/**
 * P2-104d: the synthetic `pdf_docqa_v1` parser output pair every test that
 * needs a durable artifact pair without the Docling runtime builds from here.
 *
 * The bytes are generated, not captured. No real document, person, account or
 * balance is described here, and no sample file enters the repository.
 *
 * The pair is the smallest one the real validators in `parserProcess.ts`
 * accept: one page, a few single-provenance text items, no tables, no
 * pictures and no mapping gaps. `mappingFormat` moves only the extraction
 * configuration, so v2 and v3 share byte-identical `lossless.json`.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Mirrors EXPECTED_RUNTIME_VERSIONS in packages/pipeline/src/parserProcess.ts.
const RUNTIME_VERSIONS = {
  docling: "2.126.0",
  "docling-core": "2.95.0",
  "docling-ibm-models": "4.0.2",
  "docling-parse": "7.17.0",
  onnxruntime: "1.23.2",
  rapidocr: "3.9.2",
  pypdfium2: "5.13.0",
  numpy: "2.5.3",
};

const PARSER_IMPLEMENTATION_SHA256 = "1".repeat(64);
const EXTRACTION_IMPLEMENTATION_SHA256 = "2".repeat(64);
const DEFAULT_MODEL_MANIFEST_SHA256 = "3".repeat(64);
const DEFAULT_PAGE_TEXTS = [
  "Synthetic heading",
  "Synthetic body line one.",
  "Synthetic body line two.",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * The descriptor fingerprint the validator recomputes: canonical JSON of every
 * field but `fingerprint`. The parser descriptor is hashed the way Python
 * emitted it, with `timeoutSeconds` as a float.
 */
function descriptorFingerprint(fields, pythonTimeoutFloat = false) {
  let encoded = canonicalJson(fields);
  if (pythonTimeoutFloat) {
    const needle = `"timeoutSeconds":${fields.configuration.timeoutSeconds}`;
    encoded = encoded.replace(needle, `${needle}.0`);
  }
  return sha256(Buffer.from(encoded, "utf8"));
}

function describe(fields, pythonTimeoutFloat = false) {
  return {
    ...fields,
    fingerprint: descriptorFingerprint(fields, pythonTimeoutFloat),
  };
}

/**
 * Builds the artifact bytes.
 *
 * @param {object} input
 * @param {{ sha256: string }} input.capture - a CapturedPdf.
 * @param {"docling_utf16_pages_v2" | "docling_utf16_pages_v3"} [input.mappingFormat]
 *   Moves the extraction configuration fingerprint only. `lossless.json` is
 *   byte-identical across both.
 * @param {string} [input.modelManifestSha256] - moves the parser fingerprint.
 * @param {string[]} [input.pageTexts] - the segment texts of the single page,
 *   in order. This is the only knob that moves the raw bytes.
 */
export function doclingArtifactBytes({
  capture,
  mappingFormat = "docling_utf16_pages_v3",
  modelManifestSha256 = DEFAULT_MODEL_MANIFEST_SHA256,
  pageTexts = DEFAULT_PAGE_TEXTS,
}) {
  const provenance = pageTexts.map((text, index) => ({
    bbox: {
      b: 60 + index * 20,
      coord_origin: "BOTTOMLEFT",
      l: 72,
      r: 520,
      t: 76 + index * 20,
    },
    charspan: [0, Array.from(text).length],
    page_no: 1,
  }));

  // `children` is required on every node the body traversal reaches, leaf
  // text items included. `tables` is required even when it is empty.
  const texts = pageTexts.map((text, index) => ({
    self_ref: `#/texts/${index}`,
    children: [],
    prov: [provenance[index]],
    text,
  }));

  const raw = {
    body: {
      self_ref: "#/body",
      children: texts.map((_, index) => ({ $ref: `#/texts/${index}` })),
    },
    texts,
    tables: [],
  };
  const rawBytes = Buffer.from(JSON.stringify(raw), "utf8");
  const rawSha256 = sha256(rawBytes);

  const parser = describe(
    {
      schemaVersion: 2,
      runtime: { python: "3.12.12", versions: RUNTIME_VERSIONS },
      modelManifestSha256,
      implementationSha256: PARSER_IMPLEMENTATION_SHA256,
      configuration: {
        maxInputBytes: 16 * 1024 * 1024,
        maxConversionPages: 64,
        outputFormat: "docling_lossless_canonical_json_v1",
        timeoutSeconds: 240,
        tableStructure: "on",
      },
    },
    true,
  );
  const extractionConfiguration = {
    mappingFormat,
    maxPages: 64,
    maxRetainedUtf8Bytes: 1024 * 1024,
    maxBundleBytes: 4 * 1024 * 1024,
  };
  const extractionConfigurationFingerprint = descriptorFingerprint({
    schemaVersion: 1,
    parserFingerprint: parser.fingerprint,
    implementationSha256: EXTRACTION_IMPLEMENTATION_SHA256,
    configuration: extractionConfiguration,
  });
  const extractionFingerprint = createHash("sha256")
    .update(Buffer.from("kith-parsed-extraction:v1\0", "utf8"))
    .update(
      Buffer.from(
        canonicalJson([
          parser.fingerprint,
          rawSha256,
          extractionConfigurationFingerprint,
        ]),
        "utf8",
      ),
    )
    .digest("hex");

  // The page text is the segment sequence joined by newlines; the offsets the
  // validator recomputes follow from that.
  const pageText = pageTexts.join("\n");
  let offset = 0;
  const segments = pageTexts.map((text, index) => {
    const startUtf16 = offset;
    offset += text.length + 1;
    return {
      id: `docling-item-1-${index}`,
      text,
      startUtf16,
      endUtf16: startUtf16 + text.length,
      citable: true,
      locator: {
        kind: "docling_item",
        itemRef: `#/texts/${index}`,
        provenance: provenance[index],
        doclingCharspanSemantics: "item_local_python_codepoints_not_evidence",
      },
    };
  });

  const bundle = {
    schemaVersion: 1,
    candidate: "docling-standard-cpu-ocr",
    sourceSha256: capture.sha256,
    parserFingerprint: parser,
    pages: [{ page: 1, text: pageText, segments }],
    mappingGaps: [],
    extractionFingerprint: {
      schemaVersion: 2,
      parserFingerprint: parser.fingerprint,
      parserArtifactSha256: rawSha256,
      extractionConfigurationFingerprint,
      implementationSha256: EXTRACTION_IMPLEMENTATION_SHA256,
      configuration: extractionConfiguration,
      fingerprint: extractionFingerprint,
    },
  };

  return {
    raw: rawBytes,
    bundle: Buffer.from(JSON.stringify(bundle), "utf8"),
    parserFingerprint: parser.fingerprint,
    extractionConfigurationFingerprint,
    extractionFingerprint,
    rawSha256,
  };
}

export async function writeDoclingArtifacts(outputDirectory, artifacts) {
  await writeFile(join(outputDirectory, "lossless.json"), artifacts.raw, {
    mode: 0o600,
  });
  await writeFile(join(outputDirectory, "bundle.json"), artifacts.bundle, {
    mode: 0o600,
  });
}
