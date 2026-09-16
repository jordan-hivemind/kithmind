// The gateway's configuration health, by variable name and never by value.
//
// i2 splits the report in two. A `deprecated` issue means the deployment is
// working and reading the public origin from `MCP_JWT_ISSUER`, which i7 removes;
// that is a notice, not a fault, and reporting it as `misconfigured` with a 503
// would take a healthy deployment out of rotation over a variable name. Every
// other issue still fails the check.

import {
  blockingMcpEnvironmentIssues,
  validateMcpEnvironment,
} from "@/lib/mcp/environment";

export const dynamic = "force-dynamic";

export async function GET() {
  const reported = validateMcpEnvironment();
  const issues = blockingMcpEnvironmentIssues(reported);
  const notices = reported.filter((issue) => issue.problem === "deprecated");

  if (issues.length > 0) {
    return Response.json(
      {
        status: "misconfigured",
        service: "open-brain-mcp",
        issues,
        ...(notices.length > 0 ? { notices } : {}),
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }

  return Response.json({
    status: "ok",
    service: "open-brain-mcp",
    ...(notices.length > 0 ? { notices } : {}),
    timestamp: new Date().toISOString(),
  });
}
