import { handleGoogleOAuthCallback } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return await handleGoogleOAuthCallback(request);
}
