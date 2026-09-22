// Builds the Plaid SDK client from resolved credentials. This is the one
// place `plaid` (Configuration/PlaidApi/PlaidEnvironments) is constructed, so
// every command shares the same headers and base path.

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

import type { PlaidCredentials } from "./config.js";

export function createPlaidClient(credentials: PlaidCredentials): PlaidApi {
  const basePath = PlaidEnvironments[credentials.env];
  if (basePath === undefined) {
    throw new Error(
      `Unknown PLAID_ENV "${credentials.env}"; expected one of ${Object.keys(
        PlaidEnvironments,
      ).join(", ")}`,
    );
  }
  const configuration = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": credentials.clientId,
        "PLAID-SECRET": credentials.secret,
      },
    },
  });
  return new PlaidApi(configuration);
}
