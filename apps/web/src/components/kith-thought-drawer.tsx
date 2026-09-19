"use client";

// The edit form for a thought, shared by the dashboard's "Recent thoughts"
// table and the browse page's "Thoughts" table -- the two screens' own
// mutations differ (their cached data has different shapes), but the form
// itself does not, so it lives once here, the way `InvestmentDrawer` does for
// the investments screen's two tables.
//
// Only the fields the owner's edit surface offers: content, type, topics,
// people. `PATCH /api/kith/thoughts/:id` (`memory.updateThought`) carries
// `actionItems` and `summary` over from the edited thought untouched, so this
// form does not show them.

import { type memory } from "@repo/kith-store";
import { useEffect, useState } from "react";

import {
  buttonClass,
  Drawer,
  Field,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import { label } from "@/lib/kith/format";

const THOUGHT_TYPES: readonly memory.ThoughtType[] = [
  "decision",
  "person_note",
  "idea",
  "meeting_note",
  "task",
  "reference",
];

export type ThoughtDraft = {
  content: string;
  type: memory.ThoughtType;
  topics: string;
  people: string;
};

export function emptyThoughtDraft(): ThoughtDraft {
  return { content: "", type: "reference", topics: "", people: "" };
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function ThoughtDrawer({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ThoughtDraft;
  /** Resolves when the write has been sent. The drawer closes on success. */
  onSave: (draft: {
    content: string;
    type: memory.ThoughtType;
    topics: string[];
    people: string[];
  }) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ThoughtDraft>(initial);
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  const valid = draft.content.trim() !== "";

  const submit = async () => {
    if (!valid) return;
    await onSave({
      content: draft.content.trim(),
      type: draft.type,
      topics: commaList(draft.topics),
      people: commaList(draft.people),
    });
    onOpenChange(false);
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Edit thought"
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Thought">
          <textarea
            className={`${inputClass} h-24 resize-none py-1`}
            value={draft.content}
            onChange={(event) =>
              setDraft({ ...draft, content: event.target.value })
            }
          />
        </Field>
        <Field label="Type">
          <select
            className={inputClass}
            value={draft.type}
            onChange={(event) =>
              setDraft({
                ...draft,
                type: event.target.value as memory.ThoughtType,
              })
            }
          >
            {THOUGHT_TYPES.map((type) => (
              <option key={type} value={type}>
                {label(type)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Topics">
          <input
            className={inputClass}
            placeholder="comma separated"
            value={draft.topics}
            onChange={(event) =>
              setDraft({ ...draft, topics: event.target.value })
            }
          />
        </Field>
        <Field label="People">
          <input
            className={inputClass}
            placeholder="comma separated"
            value={draft.people}
            onChange={(event) =>
              setDraft({ ...draft, people: event.target.value })
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
