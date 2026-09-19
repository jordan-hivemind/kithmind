// Parsing the change stream, and deciding what a change invalidates.

import { describe, expect, test } from "vitest";

import {
  invalidatedKeys,
  type LiveChange,
  parseEventBlock,
  splitEventBlocks,
} from "@/lib/kith/live-changes";

const CHANGE_BLOCK =
  'id: 42\nevent: change\ndata: {"table":"source_roots","rowId":"abc","op":"update"}';

describe("parsing an event block", () => {
  test("a change becomes a change frame", () => {
    expect(parseEventBlock(CHANGE_BLOCK)).toEqual({
      kind: "change",
      change: { id: "42", table: "source_roots", rowId: "abc", op: "update" },
    });
  });

  test("the end event carries the cursor to resume from", () => {
    expect(parseEventBlock("id: 99\nevent: end\ndata: {}")).toEqual({
      kind: "end",
      cursor: "99",
    });
  });

  test("comments, retry hints and unknown events are ignored", () => {
    expect(parseEventBlock(": heartbeat")).toBeNull();
    expect(parseEventBlock("retry: 2000\n: open")).toBeNull();
    expect(parseEventBlock("id: 1\nevent: something\ndata: {}")).toBeNull();
  });

  test("a malformed or truncated change is dropped, not thrown on", () => {
    expect(parseEventBlock("id: 1\nevent: change\ndata: {not json")).toBeNull();
    expect(parseEventBlock('id: 1\nevent: change\ndata: {"table":"x"}')).toBeNull();
    // An operation the client does not model is not invented into one.
    expect(
      parseEventBlock('id: 1\nevent: change\ndata: {"table":"x","rowId":"y","op":"truncate"}'),
    ).toBeNull();
    // A change with no id has no cursor, so it cannot be resumed from.
    expect(parseEventBlock('event: change\ndata: {"table":"x","rowId":"y","op":"insert"}')).toBeNull();
  });
});

describe("splitting a chunked body", () => {
  test("a chunk that cuts an event in half keeps the remainder", () => {
    const first = splitEventBlocks(`${CHANGE_BLOCK}\n\nid: 43\nevent: ch`);
    expect(first.blocks).toEqual([CHANGE_BLOCK]);
    expect(first.rest).toBe("id: 43\nevent: ch");

    const second = splitEventBlocks(`${first.rest}ange\ndata: {}\n\n`);
    expect(second.blocks).toEqual(["id: 43\nevent: change\ndata: {}"]);
    expect(second.rest).toBe("");
  });

  test("a body with no complete event yields no blocks", () => {
    expect(splitEventBlocks("id: 1\n")).toEqual({ blocks: [], rest: "id: 1\n" });
  });
});

describe("invalidation by table name", () => {
  const watched = {
    sources: ["source_accounts", "source_roots"],
    investments: ["investments", "investment_entries"],
  } as const;

  function change(table: string): LiveChange {
    return { id: "1", table, rowId: "r", op: "insert" };
  }

  test("only the keys whose tables changed are invalidated", () => {
    expect(invalidatedKeys([change("source_roots")], watched)).toEqual(["sources"]);
    expect(invalidatedKeys([change("investment_entries")], watched)).toEqual([
      "investments",
    ]);
  });

  test("many rows on one table invalidate its key once", () => {
    expect(
      invalidatedKeys([change("source_roots"), change("source_accounts")], watched),
    ).toEqual(["sources"]);
  });

  test("a table nothing watches invalidates nothing", () => {
    expect(invalidatedKeys([change("chunks")], watched)).toEqual([]);
    expect(invalidatedKeys([], watched)).toEqual([]);
  });
});
