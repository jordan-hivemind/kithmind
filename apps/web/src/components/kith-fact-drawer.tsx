"use client";

// The edit form for a fact's value. Only the value changes -- subject and
// predicate are the fact's own and are shown as read-only context, not
// editable fields.
//
// Editing goes through the existing versioning path
// (`PATCH /api/kith/facts/:id`, `memory.updateFact`) under one of its two
// `changeKind`s, chosen by the "Changed" / "Was wrong" segmented control:
//
//   * "Changed" (default): the old value was true once and stays reachable
//     as history (`status: 'superseded'`).
//   * "Was wrong": the old value was never true and is withheld even from
//     history (`status: 'retracted'`).
//
// See `memory.UpdateFactArgs`'s own comment for the store-side rule this
// mirrors. `validFrom` is optional and travels with either choice, though it
// is most meaningful for "Changed" (when the new value took effect).
//
// Only `text`, `date`, `number` and `boolean` values have a form here.
// `entity` and `datetime` are not offered an Edit action at all (see the
// browse table's kebab), so this component never has to render one.

import { type memory } from "@repo/kith-store";
import { useEffect, useState } from "react";

import {
  buttonClass,
  Drawer,
  Field,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type EditableFactValue = Extract<
  memory.FactValue,
  { type: "text" | "date" | "number" | "boolean" }
>;

export type FactChangeKind = "changed" | "corrected";

export type FactDraft = {
  statement: string;
  subject: string;
  predicate: string;
  value: EditableFactValue;
  changeKind: FactChangeKind;
  /** `YYYY-MM-DD`, or empty for none. */
  validFrom: string;
};

const CHANGE_KIND_OPTIONS: {
  value: FactChangeKind;
  label: string;
  detail: string;
}[] = [
  {
    value: "changed",
    label: "Changed",
    detail: "The old value was true once and stays in history",
  },
  {
    value: "corrected",
    label: "Was wrong",
    detail: "The old value was never true and is withheld, even from history",
  },
];

/** Square segmented control, matching the browse page's own `Segment`
 * (`kith-browse.tsx`) but buttons rather than links, and with a tooltip per
 * option instead of explanatory text. */
function ChangeKindControl({
  value,
  onChange,
}: {
  value: FactChangeKind;
  onChange: (value: FactChangeKind) => void;
}) {
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <div className="flex rounded-tag border border-gray-300 text-xs">
        {CHANGE_KIND_OPTIONS.map((option) => (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={value === option.value}
                onClick={() => onChange(option.value)}
                className={`px-3 py-1 ${
                  value === option.value
                    ? "bg-accent-600 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {option.label}
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {option.detail}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

export function FactDrawer({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: FactDraft;
  /** Resolves when the write has been sent. The drawer closes on success. */
  onSave: (
    value: EditableFactValue,
    options: { changeKind: FactChangeKind; validFrom?: number },
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState<FactDraft>(initial);
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  const valid = draft.value.type !== "text" || draft.value.value.trim() !== "";

  const submit = async () => {
    if (!valid) return;
    await onSave(draft.value, {
      changeKind: draft.changeKind,
      ...(draft.validFrom === ""
        ? {}
        : {
            validFrom: new Date(`${draft.validFrom}T00:00:00.000Z`).getTime(),
          }),
    });
    onOpenChange(false);
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Edit fact"
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Subject">
          <p className="text-xs text-gray-700">{draft.subject}</p>
        </Field>
        <Field label="Predicate">
          <p className="text-xs text-gray-700">{draft.predicate}</p>
        </Field>
        {draft.value.type === "text" ? (
          <Field label="Value">
            <input
              className={inputClass}
              value={draft.value.value}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: { type: "text", value: event.target.value },
                })
              }
            />
          </Field>
        ) : draft.value.type === "date" ? (
          <Field label="Value">
            <input
              type="date"
              className={inputClass}
              value={draft.value.value}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: { type: "date", value: event.target.value },
                })
              }
            />
          </Field>
        ) : draft.value.type === "boolean" ? (
          <Field label="Value">
            <select
              className={inputClass}
              value={draft.value.value ? "true" : "false"}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: {
                    type: "boolean",
                    value: event.target.value === "true",
                  },
                })
              }
            >
              <option value="true">yes</option>
              <option value="false">no</option>
            </select>
          </Field>
        ) : (
          <Field label="Value">
            <input
              inputMode="decimal"
              className={inputClass}
              value={String(draft.value.value)}
              onChange={(event) => {
                const numeric = Number(event.target.value);
                setDraft({
                  ...draft,
                  value: {
                    type: "number",
                    value: Number.isFinite(numeric) ? numeric : 0,
                    ...(draft.value.type === "number" && draft.value.unit
                      ? { unit: draft.value.unit }
                      : {}),
                  },
                });
              }}
            />
          </Field>
        )}
        <ChangeKindControl
          value={draft.changeKind}
          onChange={(changeKind) => setDraft({ ...draft, changeKind })}
        />
        <Field label="Effective from">
          <input
            type="date"
            className={inputClass}
            value={draft.validFrom}
            onChange={(event) =>
              setDraft({ ...draft, validFrom: event.target.value })
            }
          />
        </Field>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            className={buttonClass}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid}
            className={primaryButtonClass}
          >
            Save
          </button>
        </div>
      </form>
    </Drawer>
  );
}
