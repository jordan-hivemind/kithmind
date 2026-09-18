// The gateway's configuration health, by variable name and never by value.
//
// i2 split the report in two, so that the `MCP_JWT_ISSUER` rename notice could
// not take a working deployment out of rotation. i7b deleted that variable with
// the JWT bridge, and with it the only non-blocking issue there was, so every
// issue left is a fault again.

import { validateMcpEnvironment } from "@/lib/mcp/environment";

export const dynamic = "force-dynamic";

export async function GET() {
  const issues = validateMcpEnvironment();

  if (issues.length > 0) {
    return Response.json(
      {
        status: "misconfigured",
        service: "open-brain-mcp",
        issues,
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }

  return Response.json({
    status: "ok",
    service: "open-brain-mcp",
    timestamp: new Date().toISOString(),
  });
}
