export type CaptureResponse = {
  thoughtId?: string;
  metadata: {
    type: string;
    topics: string[];
    people: string[];
    actionItems: string[];
    summary: string;
  };
  disposition:
    | "stored"
    | "duplicate"
    | "superseded"
    | "corrected"
    | "needs_confirmation"
    | "skipped";
  operationSummary?: string;
};

export async function captureThought(
  content: string,
): Promise<CaptureResponse> {
  const response = await fetch("/api/kith/thoughts/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (response.status === 401)
    throw new Error("Sign in again to capture a thought.");
  if (!response.ok)
    throw new Error("Failed to capture thought. Please try again.");
  return (await response.json()) as CaptureResponse;
}
