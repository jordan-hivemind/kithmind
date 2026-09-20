import { handleGoogleOAuthStart } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return await handleGoogleOAuthStart(request);
}
