// P2-77: standard security handler, empty user password.
//
// A tiny from-scratch encoder for the standard security handler's
// revision-3 key derivation (ISO 32000-1 Algorithm 2) and its `/U` value
// (Algorithm 3.5), plus the revision-6 hardened hash (Algorithm 2.B), so
// tests can build a PDF whose encryption validates against a chosen user
// password without any PDF-writing dependency. This mirrors, but does not
// import, filesystem.ts's own implementation - each fixture constructs the
// expected bytes independently of the code under test.
import { createCipheriv, createHash } from "node:crypto";

const PDF_PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff,
  0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function paddedPassword(password) {
  const pw = Buffer.from(password, "utf8");
  if (pw.length >= 32) return pw.subarray(0, 32);
  return Buffer.concat([pw, PDF_PAD.subarray(0, 32 - pw.length)]);
}

function standardKeyR3(
  paddedPw,
  o,
  p,
  id,
  keyLenBytes,
  revision = 3,
  encryptMetadata = true,
) {
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(p, 0);
  const parts = [paddedPw, o, pBytes, id];
  if (revision >= 4 && !encryptMetadata) {
    parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  }
  let digest = createHash("md5").update(Buffer.concat(parts)).digest();
  for (let round = 0; round < 50; round += 1) {
    digest = createHash("md5").update(digest.subarray(0, keyLenBytes)).digest();
  }
  return digest.subarray(0, keyLenBytes);
}

function userValueR3(key, id) {
  let value = createHash("md5").update(Buffer.concat([PDF_PAD, id])).digest();
  value = rc4(key, value);
  for (let round = 1; round <= 19; round += 1) {
    const roundKey = Buffer.from(key.map((byte) => byte ^ round));
    value = rc4(roundKey, value);
  }
  // The spec only requires the first 16 bytes to match; pad to the
  // conventional 32-byte /U length with arbitrary bytes.
  return Buffer.concat([value, Buffer.alloc(16)]);
}

/** A revision-3, 40-bit standard-handler PDF whose `/O` and `/U` validate
 * `userPassword` (an empty string producing a permissions-only file).
 *
 * `keyLengthBytes` is the real key length used to compute `/U`, while
 * `declaredLength` is whatever the `/Length` entry claims: P2-80e's owner
 * samples are `/V 4 /R 4` AESV2 files whose `/Length` is the crypt filter's
 * byte count (16) rather than the spec's bit count (128). */
export function standardEncryptedPdf({
  userPassword,
  filter = "Standard",
  revision = 3,
  permissions = -44,
  version = 2,
  keyLengthBytes = 5,
  declaredLength,
  encryptMetadata = true,
  cryptFilterMethod,
}) {
  const id = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  const owner = Buffer.alloc(32, 0x41);
  const key = standardKeyR3(
    paddedPassword(userPassword),
    owner,
    permissions,
    id,
    keyLengthBytes,
    revision,
    encryptMetadata,
  );
  const uValue = userValueR3(key, id);
  const idHex = id.toString("hex");
  const entries = [
    `/Filter /${filter}`,
    `/V ${version}`,
    `/R ${revision}`,
    `/O <${owner.toString("hex")}>`,
    `/U <${uValue.toString("hex")}>`,
    `/P ${permissions}`,
    ...(declaredLength === undefined ? [] : [`/Length ${declaredLength}`]),
    ...(encryptMetadata ? [] : ["/EncryptMetadata false"]),
    ...(cryptFilterMethod === undefined
      ? []
      : [
          `/CF << /StdCF << /CFM /${cryptFilterMethod} /AuthEvent /DocOpen /Length ${keyLengthBytes} >> >>`,
          "/StmF /StdCF",
          "/StrF /StdCF",
        ]),
  ];
  const encryptObj = `2 0 obj\n<< ${entries.join(" ")} >>\nendobj\n`;
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.from("1 0 obj\n<< /Type /Catalog >>\nendobj\n"),
    Buffer.from(encryptObj),
    Buffer.from("xref\n0 3\n0000000000 65535 f \n"),
    Buffer.from(
      `trailer\n<< /Size 3 /Root 1 0 R /Encrypt 2 0 R /ID [<${idHex}><${idHex}>] >>\n`,
    ),
    Buffer.from("startxref\n9\n%%EOF\n"),
  ]);
}

function hardenedHash(password, salt, extra) {
  let k = createHash("sha256")
    .update(Buffer.concat([password, salt, extra]))
    .digest();
  for (let round = 0; ; round += 1) {
    const k1Block = Buffer.concat([password, k, extra]);
    const k1 = Buffer.concat(Array(64).fill(k1Block));
    const cipher = createCipheriv(
      "aes-128-cbc",
      k.subarray(0, 16),
      k.subarray(16, 32),
    );
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(k1), cipher.final()]);
    let sum = 0;
    for (let i = 0; i < 16; i += 1) sum += e[i];
    const mod = sum % 3;
    k =
      mod === 0
        ? createHash("sha256").update(e).digest()
        : mod === 1
          ? createHash("sha384").update(e).digest()
          : createHash("sha512").update(e).digest();
    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}

/** A revision-6 (AESV3, hardened SHA-256) standard-handler PDF whose 48-byte
 * `/U` validates `userPassword`. */
export function standardEncryptedPdfR6({ userPassword }) {
  const validationSalt = Buffer.from("abcdefgh");
  const keySalt = Buffer.from("12345678");
  const hash = hardenedHash(
    Buffer.from(userPassword, "utf8"),
    validationSalt,
    Buffer.alloc(0),
  );
  const uValue = Buffer.concat([hash, validationSalt, keySalt]);
  const owner = Buffer.alloc(48, 0x41);
  const encryptObj = `2 0 obj\n<< /Filter /Standard /V 5 /R 6 /O <${owner.toString("hex")}> /U <${uValue.toString("hex")}> /P -44 >>\nendobj\n`;
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from("1 0 obj\n<< /Type /Catalog >>\nendobj\n"),
    Buffer.from(encryptObj),
    Buffer.from("xref\n0 3\n0000000000 65535 f \n"),
    Buffer.from(
      "trailer\n<< /Size 3 /Root 1 0 R /Encrypt 2 0 R /ID [<00><00>] >>\n",
    ),
    Buffer.from("startxref\n9\n%%EOF\n"),
  ]);
}
