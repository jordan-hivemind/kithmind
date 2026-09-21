"use client";

import type {
  FinanceReviewActionOutcome,
  FinanceReviewItem,
  FinanceReviewItemDetail,
} from "@repo/finance-archive";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Tag } from "@/components/ui/data-table";
import {
  buttonClass,
  Drawer,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import {
  financeReviewCanAct,
  type FinanceReviewMutationResult,
  financeReviewProblem,
  financeReviewResolution,
  humanizeFinanceReview,
} from "@/lib/kith/finance-reviews";

async function responseProblem(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? "Request failed";
}

async function fetchDetail(id: string): Promise<FinanceReviewItemDetail> {
  const params = new URLSearchParams({ reviewId: id });
  const response = await fetch(`/api/kith/finance-reviews?${params}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await responseProblem(response));
  return (await response.json()) as FinanceReviewItemDetail;
}

function candidateName(
  candidate: FinanceReviewItemDetail["instrumentCandidates"][number],
): string {
  return (
    candidate.name ??
    candidate.symbol ??
    candidate.cusip ??
    candidate.isin ??
    candidate.id
  );
}

function accountName(
  account: FinanceReviewItemDetail["accountCandidates"][number],
): string {
  const last4 = account.last4 === null ? "" : ` ••••${account.last4}`;
  return `${account.displayName ?? humanizeFinanceReview(account.accountType ?? "account")}${last4}`;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-kith-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-kith-text">{children}</dd>
    </div>
  );
}

export function FinanceReviewDrawer({
  item,
  onOpenChange,
  onChanged,
}: {
  item: FinanceReviewItem;
  onOpenChange: (open: boolean) => void;
  onChanged: (outcome: FinanceReviewActionOutcome) => void;
}) {
  const { data, error } = useQuery({
    queryKey: ["finance-review-detail", item.id],
    queryFn: () => fetchDetail(item.id),
  });
  const detail = data ?? null;
  const current = detail?.item ?? item;
  const [accountId, setAccountId] = useState("");
  const [aliasKind, setAliasKind] = useState<"statement_number" | "api_key">(
    "statement_number",
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<FinanceReviewActionOutcome | null>(
    null,
  );
  const [dismissalLabel, setDismissalLabel] = useState<string | null>(null);
  const displayed =
    outcome === null
      ? current
      : {
          ...current,
          status: outcome.status,
          resolutionNote: dismissalLabel ?? current.resolutionNote,
        };
  const canAct = (kind: Parameters<typeof financeReviewCanAct>[1]) =>
    outcome === null && financeReviewCanAct(current, kind);
  const matchedCandidate = useMemo(
    () =>
      detail?.instrumentCandidates.find(
        (candidate) => candidate.id === current.matchedInstrumentId,
      ) ?? null,
    [detail, current.matchedInstrumentId],
  );

  async function act(body: Record<string, unknown>, dismissal?: string) {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/kith/finance-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, reviewItemId: current.id }),
      });
      if (!response.ok) throw new Error(await responseProblem(response));
      const result = (await response.json()) as FinanceReviewMutationResult;
      setDismissalLabel(dismissal ?? null);
      setOutcome(result.outcome);
      onChanged(result.outcome);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      title={financeReviewProblem(displayed)}
    >
      <div className="flex flex-col gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone="accent">finance</Tag>
          <Tag>{humanizeFinanceReview(current.kind)}</Tag>
          <Tag tone={displayed.status === "open" ? "warn" : "neutral"}>
            {displayed.status}
          </Tag>
        </div>

        <dl className="flex flex-col gap-1.5">
          <Field label="Problem">{current.guidance.summary}</Field>
          <Field label="Reason">
            {current.reasonCode === null ? (
              current.reason
            ) : (
              <>
                {current.reason} ({humanizeFinanceReview(current.reasonCode)})
              </>
            )}
          </Field>
          <Field label="Resolution">{financeReviewResolution(displayed)}</Field>
          {displayed.status === "open" ? (
            <Field label="Next action">{current.guidance.nextAction}</Field>
          ) : null}
          {current.rawValue === null ? null : (
            <Field label="Original value">{current.rawValue}</Field>
          )}
          {current.occurrenceCount === null ? null : (
            <Field label="Occurrences">{current.occurrenceCount}</Field>
          )}
          {current.resolutionNote === null ? null : (
            <Field label="Audit outcome">{current.resolutionNote}</Field>
          )}
        </dl>

        {error === null ? null : (
          <div role="alert" className="text-kith-danger">
            {error instanceof Error ? error.message : "Detail unavailable"}
          </div>
        )}
        {detail === null ? null : (
          <>
            <section aria-labelledby="finance-review-context">
              <h3 id="finance-review-context" className="mb-1 font-medium">
                Context
              </h3>
              <dl className="flex flex-col gap-1.5">
                <Field label="Institution">
                  {detail.institution?.name ?? "Not identified"}
                </Field>
                <Field label="Account">
                  {detail.account === null
                    ? "Not identified"
                    : `${detail.account.displayName ?? humanizeFinanceReview(detail.account.accountType ?? "account")}${detail.account.last4 === null ? "" : ` ••••${detail.account.last4}`}`}
                </Field>
                <Field label="Document">
                  {detail.sourceDocument === null
                    ? "Not linked"
                    : `${humanizeFinanceReview(detail.sourceDocument.docType)}${detail.sourceDocument.docDate === null ? "" : ` • ${detail.sourceDocument.docDate}`}`}
                </Field>
                {current.sourceLocator === null ? null : (
                  <Field label="Source location">{current.sourceLocator}</Field>
                )}
              </dl>
            </section>

            <section aria-labelledby="finance-review-evidence">
              <h3 id="finance-review-evidence" className="mb-1 font-medium">
                Source evidence
              </h3>
              {detail.evidence.length === 0 ? (
                <div className="text-kith-text-muted">No retained excerpt</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {detail.evidence.map((evidence, index) => (
                    <div
                      key={`${evidence.format}-${index}`}
                      className="rounded-control border border-kith-border-subtle bg-kith-surface-muted p-2"
                    >
                      <div className="mb-1 flex gap-2 text-kith-text-muted">
                        <span>{evidence.format}</span>
                        {evidence.field === null ? null : (
                          <span>{evidence.field}</span>
                        )}
                        {evidence.retainedText.available ? (
                          <span>
                            {evidence.retainedText.verified
                              ? "verified"
                              : "unverified"}
                          </span>
                        ) : null}
                      </div>
                      {evidence.retainedText.available ? (
                        <blockquote className="whitespace-pre-wrap text-kith-text">
                          {evidence.retainedText.quote}
                          {evidence.retainedText.truncated ? "…" : ""}
                        </blockquote>
                      ) : (
                        <div className="text-kith-text-muted">
                          Retained text unavailable
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {detail.canonicalRows.length === 0 ? null : (
              <section aria-labelledby="finance-review-records">
                <h3 id="finance-review-records" className="mb-1 font-medium">
                  Current archive records
                </h3>
                <div className="flex flex-col gap-1">
                  {detail.canonicalRows.map((row) => (
                    <div
                      key={`${row.recordType}-${row.id}`}
                      className="break-words"
                    >
                      <span className="text-kith-text-muted">
                        {humanizeFinanceReview(row.recordType)}
                      </span>{" "}
                      {JSON.stringify(row.values)}
                    </div>
                  ))}
                  {detail.canonicalRowsTruncated ? (
                    <div className="text-kith-text-muted">
                      Additional related records omitted
                    </div>
                  ) : null}
                </div>
              </section>
            )}

            {detail.instrumentCandidates.length === 0 ? null : (
              <section aria-labelledby="finance-review-instruments">
                <h3
                  id="finance-review-instruments"
                  className="mb-1 font-medium"
                >
                  Security candidates
                </h3>
                <div className="flex flex-col gap-1">
                  {detail.instrumentCandidates.map((candidate) => (
                    <div key={candidate.id}>
                      {candidateName(candidate)}
                      {candidate.symbol === null
                        ? ""
                        : ` • ${candidate.symbol}`}
                      {candidate.cusip === null
                        ? ""
                        : ` • CUSIP ${candidate.cusip}`}
                      {candidate.isin === null
                        ? ""
                        : ` • ISIN ${candidate.isin}`}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {canAct("confirm_instrument_match") ? (
              <button
                type="button"
                className={primaryButtonClass}
                disabled={busy || matchedCandidate === null}
                onClick={() =>
                  void act({
                    kind: "confirm_instrument_match",
                    matchedInstrumentId: current.matchedInstrumentId,
                  })
                }
              >
                Confirm{" "}
                {matchedCandidate === null
                  ? "stored security"
                  : candidateName(matchedCandidate)}
              </button>
            ) : null}

            {canAct("map_account_key") ? (
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-kith-text-muted">Account</span>
                  <select
                    className={inputClass}
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                  >
                    <option value="">Choose an account</option>
                    {detail.accountCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {accountName(candidate)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-kith-text-muted">Source key type</span>
                  <select
                    className={inputClass}
                    value={aliasKind}
                    onChange={(event) =>
                      setAliasKind(event.target.value as typeof aliasKind)
                    }
                  >
                    <option value="statement_number">Statement number</option>
                    <option value="api_key">Institution key</option>
                  </select>
                </label>
                <button
                  type="button"
                  className={primaryButtonClass}
                  disabled={busy || accountId === ""}
                  onClick={() =>
                    void act({
                      kind: "map_account_key",
                      targetAccountId: accountId,
                      aliasKind,
                    })
                  }
                >
                  Save account mapping
                </button>
              </div>
            ) : null}

            {canAct("acknowledge_safeguard") ? (
              <button
                type="button"
                className={primaryButtonClass}
                disabled={busy}
                onClick={() => void act({ kind: "acknowledge_safeguard" })}
              >
                Confirm safeguard
              </button>
            ) : null}
          </>
        )}

        {displayed.status === "open" &&
        current.guidance.actionKinds.every((kind) => kind === "dismiss") ? (
          <div className="rounded-control border border-amber-200 bg-amber-50 p-2 text-amber-900">
            <div className="font-medium">Resolution not yet supported</div>
            <div>{current.guidance.nextAction}</div>
          </div>
        ) : null}

        {canAct("dismiss") ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void act(
                  {
                    kind: "dismiss",
                    note: "Not enough information to resolve safely",
                  },
                  "Not enough information to resolve safely",
                )
              }
            >
              Not enough information
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void act(
                  {
                    kind: "dismiss",
                    note: "Not needed for this archive",
                  },
                  "Not needed for this archive",
                )
              }
            >
              Not needed
            </button>
          </div>
        ) : null}

        {problem === null ? null : (
          <div role="alert" className="text-kith-danger">
            {problem}
          </div>
        )}
        {outcome === null ? null : (
          <div
            role="status"
            className="rounded-control border border-green-200 bg-green-50 p-2 text-green-900"
          >
            <div>{outcome.description}</div>
            {outcome.remainingAction === null ? null : (
              <div className="mt-1">{outcome.remainingAction}</div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}
