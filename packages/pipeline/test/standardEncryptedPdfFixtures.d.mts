export function standardEncryptedPdf(options: {
  userPassword: string;
  filter?: string;
  revision?: number;
  permissions?: number;
  version?: number;
  keyLengthBytes?: number;
  declaredLength?: number;
  encryptMetadata?: boolean;
  cryptFilterMethod?: string;
}): Buffer;

export function standardEncryptedPdfR6(options: { userPassword: string }): Buffer;
