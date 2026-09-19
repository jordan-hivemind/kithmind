"use client";

// The edit form for a fact's value. Editing is a correction
// (`PATCH /api/kith/facts/:id`, `memory.updateFact` with
// `changeKind: "corrected"`): the old value stays in history, and only the
// value changes -- subject and predicate are the fact's own and are shown as
// read-only context, not editable fields.
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

export type EditableFactValue = Extract<
  memory.FactValue,
  { type: "text" | "date" | "number" | "boolean" }
>;

export type FactDraft = {
  statement: string;
  subject: string;
  predicate: string;
  value: EditableFactValue;
};

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
  onSave: (value: EditableFactValue) => Promise<void>;
}) {
  const [draft, setDraft] = useState<FactDraft>(initial);
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  const valid = draft.value.type !== "text" || draft.value.value.trim() !== "";

  const submit = async () => {
    if (!valid) return;
    await onSave(draft.value);
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
