export function standardEncryptedPdf(options: {
  userPassword: string;
  filter?: string;
  revision?: number;
  permissions?: number;
}): Buffer;

export function standardEncryptedPdfR6(options: { userPassword: string }): Buffer;
