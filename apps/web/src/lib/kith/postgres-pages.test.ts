// The i5 page loaders on PostgreSQL, against a real database.
//
// One synthetic two-user fixture: `userA` is a member only of their own
// personal space and a shared space they own; `userB` is a member only of
// their own personal space. Every loader is checked for three things:
//
//   * Unauthenticated. A missing or forged cookie returns `null`, which is
//     what each page turns into a redirect to `/sign-in`.
//   * Space isolation. `userA`'s session never sees a row from `userB`'s
//     space, and a `?space=` naming a space `userA` does not belong to falls
//     back rather than leaking `userB`'s membership detail.
//   * One transaction. Every loader call opens exactly one
//     `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, recorded the same
//     way `lib/mcp/postgres-reads.test.ts` records it.

import { randomBytes } from "node:crypto";

import {
  applyKithSchema,
  createKithPool,
  memory,
  newKithId,
  withKithTransaction,
} from "@repo/kith-store";
import {
  createSharedSpace,
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  sessionCookie,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { setKithPool } from "@/lib/kith/pool";

// ADM-2. Only `resolveFinanceArchive` is replaced: `readFinanceArchive` stays
// real, so the membership check, the contract's own `authorizeFinanceRead-
// Request` and `parseAuthorizedFinanceReadExchange` all run for these tests
// rather than being mocked away. A test that stubbed the read itself would
// prove nothing about who is allowed to make it.
const financeMock = vi.hoisted(() => ({
  resolve: vi.fn<() => unknown>(() => null),
}));
vi.mock("@/lib/mcp/finance", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveFinanceArchive: () => financeMock.resolve(),
}));

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");

type Fixture = {
  userA: {
    userId: string;
    cookie: string;
    spaceId: string;
    sharedSpaceId: string;
  };
  userB: { userId: string; cookie: string; spaceId: string };
  /** A `reader` member of userA's shared space, for the ADM-2 admin loaders. */
  readerC: { userId: string; cookie: string; spaceId: string };
};

describeWithDatabase("i5 page loaders on PostgreSQL", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let fixture: Fixture;
  let transactionLog: string[] = [];

  async function onAdmin<T>(
    work: (admin: pg.Client) => Promise<T>,
  ): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await work(admin);
    } finally {
      await admin.end();
    }
  }

  function inTransaction<T>(
    work: (ctx: IdentityCtx) => Promise<T>,
  ): Promise<T> {
    return withKithTransaction(pool, (client) => work(identityCtx(client)));
  }

  /** The pool the app sees, with every `BEGIN` recorded. */
  function recordingPool(inner: pg.Pool): pg.Pool {
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property !== "connect")
          return Reflect.get(target, property, receiver);
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client);
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty !== "query") {
                return Reflect.get(
                  clientTarget,
                  clientProperty,
                  clientReceiver,
                );
              }
              return (...args: unknown[]) => {
                const text = args[0];
                if (typeof text === "string" && text.startsWith("BEGIN")) {
                  transactionLog.push(text);
                }
                return (query as (...rest: unknown[]) => unknown)(...args);
              };
            },
          });
        };
      },
    });
  }

  function metadata(
    summary: string,
    type: memory.ThoughtType,
    topics: string[] = [],
  ): memory.ThoughtMetadata {
    return { type, topics, people: [], actionItems: [], summary };
  }

  async function signedInUser(): Promise<{
    userId: string;
    cookie: string;
    spaceId: string;
  }> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `i5-page-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret, secure: false },
        session.token,
        session.expiresAt,
      );
      return {
        userId: session.userId,
        cookie: setCookie.split(";")[0]!,
        spaceId,
      };
    });
  }

  beforeAll(async () => {
    databaseName = `kith_i5_pages_test_${randomBytes(8).toString("hex")}`;
    await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;

    const migrator = new pg.Client({ connectionString: url.toString() });
    migrator.on("error", () => {});
    await migrator.connect();
    await applyKithSchema(migrator);
    await migrator.end();

    pool = createKithPool(url.toString());
    pool.on("error", () => {});
    restorePool = setKithPool(recordingPool(pool));

    vi.stubEnv("KITH_SESSION_SECRET", secret);
    process.env.KITH_SESSION_SECRET = secret;

    const userA = await signedInUser();
    const userB = await signedInUser();
    const shared = await inTransaction((ctx) =>
      createSharedSpace(ctx, {
        userId: userA.userId,
        name: "A's shared space",
      }),
    );

    await inTransaction(async (ctx) => {
      await memory.captureThought(ctx, userA.userId, userA.spaceId, {
        content: "userA's personal thought, only visible to userA.",
        metadata: metadata("A's note", "idea", ["a-only"]),
        sourceType: "user_stated",
      });
      await memory.rememberFact(ctx, userA.userId, userA.spaceId, {
        subject: { kind: "person", name: "Alex" },
        predicate: "home_city",
        value: { type: "text", value: "Oakland" },
        sourceType: "user_stated",
      });
      await memory.captureThought(ctx, userB.userId, userB.spaceId, {
        content: "userB's personal thought, must never appear for userA.",
        metadata: metadata("B's note", "idea", ["b-only"]),
        sourceType: "user_stated",
      });
      await memory.rememberFact(ctx, userB.userId, userB.spaceId, {
        subject: { kind: "person", name: "Blair" },
        predicate: "home_city",
        value: { type: "text", value: "Berkeley" },
        sourceType: "user_stated",
      });
    });

    // ADM-2: a member of userA's shared space who may only read it. The
    // admin loaders must show them nothing at all, which is what the panel's
    // layout turns into a 404.
    const readerC = await signedInUser();
    await inTransaction((ctx) =>
      ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
         VALUES ($1, $2, $3, 'reader')`,
        [newKithId(), shared.spaceId, readerC.userId],
      ),
    );

    fixture = {
      userA: { ...userA, sharedSpaceId: shared.spaceId },
      userB,
      readerC,
    };
  }, 120_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  function resetLog() {
    transactionLog = [];
  }

  test("loadDashboard denies an unauthenticated request without touching a row", async () => {
    resetLog();
    const { loadDashboard } = await import("./dashboard");
    expect(await loadDashboard(null)).toBeNull();
    expect(await loadDashboard("__Host-kith_session=v1.bad.bad")).toBeNull();
  });

  test("loadDashboard scopes stats and recent thoughts to the caller's own space, in one read-only transaction", async () => {
    resetLog();
    const { loadDashboard } = await import("./dashboard");
    const data = await loadDashboard(fixture.userA.cookie);
    expect(data).not.toBeNull();
    expect(data!.stats.totalThoughts).toBe(1);
    expect(data!.stats.totalFacts).toBe(1);
    expect(data!.recent.map((thought) => thought.content)).toEqual([
      "userA's personal thought, only visible to userA.",
    ]);
    expect(
      data!.recent.some((thought) => thought.content.includes("userB")),
    ).toBe(false);
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("loadBrowse: facts and thoughts are both scoped to the caller's space", async () => {
    resetLog();
    const { loadBrowse } = await import("./browse");
    const facts = await loadBrowse(fixture.userA.cookie, {
      view: "facts",
      includeHistorical: false,
    });
    expect(facts).not.toBeNull();
    if (facts?.view !== "facts") throw new Error("expected facts view");
    expect(facts.facts.map((fact) => fact.subject.name)).toEqual(["Alex"]);
    expect(facts.stats).toMatchObject({ totalFacts: 1, totalThoughts: 1 });

    resetLog();
    const thoughts = await loadBrowse(fixture.userA.cookie, {
      view: "thoughts",
      includeHistorical: false,
    });
    if (thoughts?.view !== "thoughts")
      throw new Error("expected thoughts view");
    expect(thoughts.stats).toMatchObject({ totalFacts: 1, totalThoughts: 1 });
    expect(thoughts.thoughts.map((t) => t.content)).toEqual([
      "userA's personal thought, only visible to userA.",
    ]);
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("loadBrowse denies an unauthenticated request", async () => {
    const { loadBrowse } = await import("./browse");
    expect(
      await loadBrowse(null, { view: "facts", includeHistorical: false }),
    ).toBeNull();
  });

  test("POST /api/kith/thoughts/search keeps the query out of the URL and scopes results to the caller's space", async () => {
    resetLog();
    const { POST } = await import("../../app/api/kith/thoughts/search/route");
    const response = await POST(
      new Request("https://kith.example.test/api/kith/thoughts/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://kith.example.test",
          cookie: fixture.userA.cookie,
        },
        body: JSON.stringify({ query: "personal thought" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thoughts: Array<{ content: string }>;
      vectorStatus: "ready" | "unavailable";
    };
    expect(body.thoughts.map((t) => t.content)).toEqual([
      "userA's personal thought, only visible to userA.",
    ]);
    // No injected `embedQuery`, so the vector leg never runs -- see
    // `lib/kith/browse.ts`'s module comment.
    expect(body.vectorStatus).toBe("unavailable");
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("loadSettings lists only the caller's own spaces and source accounts, in one transaction", async () => {
    resetLog();
    const { loadSettings } = await import("./settings-data");
    const data = await loadSettings(fixture.userA.cookie);
    expect(data).not.toBeNull();
    const spaceIds = data!.spaces.map((space) => space.spaceId);
    expect(spaceIds).toContain(fixture.userA.spaceId);
    expect(spaceIds).toContain(fixture.userA.sharedSpaceId);
    expect(spaceIds).not.toContain(fixture.userB.spaceId);
    expect(data!.apiKeys.page).toEqual([]);
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("loadSettings denies an unauthenticated request", async () => {
    const { loadSettings } = await import("./settings-data");
    expect(await loadSettings(null)).toBeNull();
  });

  test("loadFamilyOverview lists the caller's spaces and, for a shared space they own, its detail", async () => {
    resetLog();
    const { loadFamilyOverview } = await import("./family-data");
    const data = await loadFamilyOverview(
      fixture.userA.cookie,
      fixture.userA.sharedSpaceId,
    );
    expect(data).not.toBeNull();
    expect(data!.spaces.map((space) => space.spaceId)).toContain(
      fixture.userA.sharedSpaceId,
    );
    expect(data!.selected?.space.spaceId).toBe(fixture.userA.sharedSpaceId);
    expect(data!.selected?.viewer.role).toBe("owner");
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("loadFamilyOverview never returns another user's space detail", async () => {
    resetLog();
    const { loadFamilyOverview } = await import("./family-data");
    // userB does not belong to userA's shared space; naming it falls back to
    // no detail rather than leaking who owns it or who its members are.
    const data = await loadFamilyOverview(
      fixture.userB.cookie,
      fixture.userA.sharedSpaceId,
    );
    expect(data).not.toBeNull();
    expect(data!.spaces.map((space) => space.spaceId)).not.toContain(
      fixture.userA.sharedSpaceId,
    );
    expect(data!.selected).toBeNull();
  });

  test("loadFamilyOverview denies an unauthenticated request", async () => {
    const { loadFamilyOverview } = await import("./family-data");
    expect(await loadFamilyOverview(null, undefined)).toBeNull();
  });

  // --- ADM-2: the health, institutions and coverage loaders ----------------

  test("loadHealth reports every check, with no archive configured saying so", async () => {
    resetLog();
    const { loadHealth } = await import("./admin-data");
    const data = await loadHealth(fixture.userA.cookie);
    expect(data).not.toBeNull();
    const byId = new Map(data!.checks.map((check) => [check.id, check]));
    expect([...byId.keys()]).toEqual([
      "documents_watcher",
      "search_index",
      "background_jobs",
      "review_queue",
      "finance_archive",
      "database_backup",
    ]);
    // No source account in the fixture, so nothing is being watched, and that
    // is `not_configured` rather than a failure.
    expect(byId.get("documents_watcher")!.status).toBe("not_configured");
    // No FINANCE_ARCHIVE_* environment in this suite: an unconfigured archive
    // must never read as an empty one.
    expect(byId.get("finance_archive")!.status).toBe("not_configured");
    expect(byId.get("finance_archive")!.detail).toBe("not configured");
    // The backup lives on the owner's machine; the row exists and reports no
    // data rather than claiming the backup is fine.
    expect(byId.get("database_backup")!.status).toBe("unknown");
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("loadCoverage lists every life area, all empty, in one read-only transaction", async () => {
    resetLog();
    const { loadCoverage } = await import("./admin-data");
    const data = await loadCoverage(fixture.userA.cookie);
    expect(data).not.toBeNull();
    expect(data!.areas.map((area) => area.area)).toContain("taxes");
    // userA has a thought and a fact, so memory is the one area with anything.
    const memoryArea = data!.areas.find(
      (area) => area.area === "notes and facts",
    );
    expect(memoryArea!.records).toBe(2);
    expect(memoryArea!.status).toBe("covered");
    expect(
      data!.areas
        .filter((area) => area.area !== "notes and facts")
        .every((area) => area.status === "empty"),
    ).toBe(true);
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("another space's memory never reaches the caller's coverage", async () => {
    const { loadCoverage } = await import("./admin-data");
    // userB has exactly one thought and one fact of their own, and userA has
    // exactly one of each. Neither sees three.
    const forA = await loadCoverage(fixture.userA.cookie);
    const forB = await loadCoverage(fixture.userB.cookie);
    const memoryOf = (data: Awaited<ReturnType<typeof loadCoverage>>) =>
      data!.areas.find((area) => area.area === "notes and facts")!.records;
    expect(memoryOf(forA)).toBe(2);
    expect(memoryOf(forB)).toBe(2);
  });

  test("a reader-role member administers nothing, so every admin loader is empty", async () => {
    const { loadCoverage, loadHealth, loadInstitutions } =
      await import("./admin-data");
    const health = await loadHealth(fixture.readerC.cookie);
    expect(
      health!.checks.find((check) => check.id === "documents_watcher")!.status,
    ).toBe("not_configured");
    expect(
      health!.checks.find((check) => check.id === "search_index")!.detail,
    ).toBe("nothing eligible");

    const coverage = await loadCoverage(fixture.readerC.cookie);
    // The reader has a personal space of their own, which they own, so their
    // own memory is theirs to see; what they must never see is userA's shared
    // space, which they only read.
    expect(
      coverage!.areas.every(
        (area) => area.documents === 0 && area.sources === 0,
      ),
    ).toBe(true);

    const institutions = await loadInstitutions(fixture.readerC.cookie);
    expect(institutions!.institutions).toEqual([]);
    expect(institutions!.state).toBe("not_configured");
  });

  test("the admin loaders deny an unauthenticated request", async () => {
    const { loadCoverage, loadHealth, loadInstitutions } =
      await import("./admin-data");
    expect(await loadHealth(null)).toBeNull();
    expect(await loadInstitutions(null)).toBeNull();
    expect(await loadCoverage(null)).toBeNull();
    expect(await loadHealth("__Host-kith_session=v1.bad.bad")).toBeNull();
  });

  // --- ADM-2: who may read the finance archive ----------------------------
  //
  // Every test above runs with no FINANCE_ARCHIVE_* environment, so their
  // `not_configured` assertions would hold for anybody and prove nothing about
  // the gate. These bind a synthetic archive to userA's shared space and check
  // that the gate in `admin-data.ts` -- membership in the archive's own space,
  // narrowed to the spaces the caller administers -- is what decides.

  /** One account, as the archive's read contract requires it to be shaped. */
  function inventoryResponse(spaceId: string) {
    return {
      contractVersion: 1 as const,
      operation: "list_account_inventory" as const,
      spaceId,
      datasetRevision: "rev-synthetic-adm2",
      coverage: { status: "complete" as const, asOf: 1_788_800_000_000 },
      completeness: "complete" as const,
      truncated: false,
      issues: [],
      items: [
        {
          account: {
            accountId: "account-synthetic-adm2",
            sourceId: "source-synthetic-adm2",
            institutionName: "Example Broker",
            accountLast4: "1234",
            displayLabel: "Income",
            accountType: "brokerage",
            baseCurrency: "USD",
            disclosures: [],
          },
          statementCount: 4,
          recordCount: 40,
          activityFrom: "2025-01-02",
          activityTo: "2026-08-31",
          latestSnapshotAsOf: "2026-08-31",
          openReviewCount: 2,
        },
      ],
    };
  }

  /** Binds the mocked archive to `spaceId`, and counts every read of it. */
  function archiveOn(spaceId: string) {
    const read = vi.fn(async () => Promise.resolve(inventoryResponse(spaceId)));
    financeMock.resolve.mockReturnValue({ spaceId, read });
    return read;
  }

  afterEach(() => {
    financeMock.resolve.mockReset();
    financeMock.resolve.mockReturnValue(null);
  });

  test("an owner of the archive's space sees its inventory", async () => {
    const read = archiveOn(fixture.userA.sharedSpaceId);
    const { loadInstitutions } = await import("./admin-data");
    const data = await loadInstitutions(fixture.userA.cookie);
    expect(data!.state).toBe("read");
    expect(data!.truncated).toBe(false);
    expect(data!.institutions.map((group) => group.name)).toEqual([
      "Example Broker",
    ]);
    expect(data!.institutions[0]!.openReviews).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("an editor of another space is refused, and the archive is never read", async () => {
    // userB owns their own personal space, so they administer one and reach
    // the archive gate; they are not a member of the space the archive holds.
    const read = archiveOn(fixture.userA.sharedSpaceId);
    const { loadCoverage, loadHealth, loadInstitutions } =
      await import("./admin-data");
    const institutions = await loadInstitutions(fixture.userB.cookie);
    expect(institutions!.institutions).toEqual([]);
    expect(institutions!.state).toBe("not_configured");

    const health = await loadHealth(fixture.userB.cookie);
    expect(
      health!.checks.find((check) => check.id === "finance_archive")!.status,
    ).toBe("not_configured");

    // And the brokerage row gets no contribution it was not entitled to.
    const coverage = await loadCoverage(fixture.userB.cookie);
    expect(
      coverage!.areas.find((area) => area.area === "brokerage")!.sources,
    ).toBe(0);

    // Refused before the archive is touched: not filtered out afterwards.
    expect(read).not.toHaveBeenCalled();
  });

  test("a reader of the archive's own space is refused too", async () => {
    // readerC *is* a member of the space the archive holds, and may only read
    // it. `getAdminSpaceIds` drops it, so the gate never sees it.
    const read = archiveOn(fixture.userA.sharedSpaceId);
    const { loadInstitutions } = await import("./admin-data");
    const data = await loadInstitutions(fixture.readerC.cookie);
    expect(data!.institutions).toEqual([]);
    expect(data!.state).toBe("not_configured");
    expect(read).not.toHaveBeenCalled();
  });

  test("an archive that answers for a different space than it claims is refused", async () => {
    // The contract's own exchange check, reached through the real
    // `readFinanceArchive`: a backend cannot answer for a space the request
    // did not name, and the screen reports unavailable rather than showing it.
    financeMock.resolve.mockReturnValue({
      spaceId: fixture.userA.sharedSpaceId,
      read: async () =>
        Promise.resolve(inventoryResponse(fixture.userB.spaceId)),
    });
    const { loadInstitutions } = await import("./admin-data");
    const data = await loadInstitutions(fixture.userA.cookie);
    expect(data!.state).toBe("unavailable");
    expect(data!.institutions).toEqual([]);
  });

  // --- Home's medical row: the Epic feed's own inventory ------------------

  test("loadCoverage folds the Epic feed's inventory into the medical row, owner-global", async () => {
    resetLog();
    const personId = newKithId();
    const sourceId = newKithId();
    const recordId = newKithId();
    await inTransaction(async (ctx) => {
      await ctx.client.query(
        `INSERT INTO kith.entities
           (id, space_id, created_at, user_id, key, kind, canonical_name,
            normalized_name, aliases, normalized_aliases)
         VALUES ($1,$2,transaction_timestamp(),$3,$4,'person','Alex','alex',
                 '[]'::jsonb,'[]'::jsonb)`,
        [
          personId,
          fixture.userA.spaceId,
          fixture.userA.userId,
          `person:alex:${personId}`,
        ],
      );
      await ctx.client.query(
        `INSERT INTO kith.health_sources
           (id, person_id, space_id, org_name, fhir_base, patient_fhir_id,
            keychain_service, scopes)
         VALUES ($1,$2,$3,'Synthetic Health','https://epic.example.test/fhir',
                 'patient-synthetic','com.kithmind.epic.token.synthetic',
                 'patient/*.read')`,
        [sourceId, personId, fixture.userA.spaceId],
      );
      await ctx.client.query(
        `INSERT INTO kith.health_records
           (id, source_id, person_id, resource_type, fhir_id, effective_at, raw)
         VALUES ($1,$2,$3,'Observation','obs-synthetic-1',
                 '2026-01-15T00:00:00Z','{}'::jsonb)`,
        [recordId, sourceId, personId],
      );
      await ctx.client.query(
        `INSERT INTO kith.health_documents
           (id, record_id, person_id, content_type, byte_length)
         VALUES ($1,$2,$3,'application/pdf',1024)`,
        [newKithId(), recordId, personId],
      );
    });

    const { loadCoverage } = await import("./admin-data");
    const forA = await loadCoverage(fixture.userA.cookie);
    const medicalForA = forA!.areas.find((area) => area.area === "medical")!;
    expect(medicalForA.documents).toBe(1);
    expect(medicalForA.records).toBe(1);
    expect(medicalForA.status).not.toBe("empty");

    // Owner-global, exactly like `listHealthOverview`: neither
    // `health_records` nor `health_documents` carries a space to narrow
    // this to, so a different user administering their own, unrelated space
    // still sees the same feed inventory folded into their medical row.
    const forB = await loadCoverage(fixture.userB.cookie);
    const medicalForB = forB!.areas.find((area) => area.area === "medical")!;
    expect(medicalForB.documents).toBe(1);
    expect(medicalForB.records).toBe(1);
  });

  // --- Home's banking row, and the Banking & Cards screen -----------------

  const BANKING_NOW = Date.parse("2026-09-25T12:00:00Z");

  /** A `kith.fin_accounts` row. Plaid-linked unless `archiveAccountId` is
   * given, matching the schema's "at least one id" CHECK. */
  async function makeFinAccount(
    ctx: IdentityCtx,
    fields: {
      institutionName?: string;
      name?: string;
      type?: string | null;
      subtype?: string | null;
      archiveAccountId?: string;
    } = {},
  ): Promise<string> {
    const id = newKithId();
    const archiveAccountId = fields.archiveAccountId ?? null;
    await ctx.client.query(
      `INSERT INTO kith.fin_accounts
         (id, institution_name, name, type, subtype, archive_account_id,
          plaid_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        fields.institutionName ?? "Synthetic Bank",
        fields.name ?? "Account",
        fields.type ?? null,
        fields.subtype ?? null,
        archiveAccountId,
        archiveAccountId === null ? `plaid-${id}` : null,
      ],
    );
    return id;
  }

  async function makeFinTransaction(
    ctx: IdentityCtx,
    accountId: string,
    fields: { date?: string; amount?: number; description?: string } = {},
  ): Promise<void> {
    await ctx.client.query(
      `INSERT INTO kith.fin_transactions
         (id, account_id, date, kind, description, amount, currency, source,
          source_ref)
       VALUES ($1,$2,$3,'other',$4,$5,'USD','plaid',$6)`,
      [
        newKithId(),
        accountId,
        fields.date ?? "2026-08-01",
        fields.description ?? "Synthetic transaction",
        fields.amount ?? -10,
        `ref-${newKithId()}`,
      ],
    );
  }

  test("loadCoverage folds kith.fin_accounts' banking and card accounts into the banking and cards row", async () => {
    resetLog();
    const { loadCoverage } = await import("./admin-data");
    // A delta, not an absolute count: `kith.fin_accounts` is owner-global
    // and unscoped, so another test in this file may have already added a
    // row to it by the time this one runs.
    const before = await loadCoverage(fixture.userA.cookie);
    const bankingBefore = before!.areas.find(
      (area) => area.area === "banking and cards",
    )!;

    const checking = await inTransaction((ctx) =>
      makeFinAccount(ctx, { type: "depository" }),
    );
    await inTransaction((ctx) =>
      makeFinTransaction(ctx, checking, { date: "2026-08-01" }),
    );
    // An investment account, which must not be counted here.
    const brokerage = await inTransaction((ctx) =>
      makeFinAccount(ctx, { type: "investment" }),
    );
    await inTransaction((ctx) =>
      makeFinTransaction(ctx, brokerage, { date: "2026-08-01" }),
    );

    const after = await loadCoverage(fixture.userA.cookie);
    const bankingAfter = after!.areas.find(
      (area) => area.area === "banking and cards",
    )!;
    expect(bankingAfter.sources).toBe(bankingBefore.sources + 1);
    expect(bankingAfter.records).toBe(bankingBefore.records + 1);
    expect(bankingAfter.documents).toBe(0);
    expect(bankingAfter.status).not.toBe("empty");

    // Owner-global, exactly like the medical row above: a different user
    // administering their own, unrelated space still sees the same delta.
    const forB = await loadCoverage(fixture.userB.cookie);
    const bankingForB = forB!.areas.find(
      (area) => area.area === "banking and cards",
    )!;
    expect(bankingForB.records).toBe(bankingAfter.records);
  });

  test("financeContribution no longer counts a bank or mortgage archive account as Investment Accounts", async () => {
    financeMock.resolve.mockReturnValue({
      spaceId: fixture.userA.sharedSpaceId,
      read: async () =>
        Promise.resolve({
          ...inventoryResponse(fixture.userA.sharedSpaceId),
          items: [
            {
              ...inventoryResponse(fixture.userA.sharedSpaceId).items[0]!,
              account: {
                ...inventoryResponse(fixture.userA.sharedSpaceId).items[0]!
                  .account,
                accountId: "account-synthetic-mortgage",
                accountType: "Mortgage",
              },
            },
          ],
        }),
    });
    const { loadCoverage } = await import("./admin-data");
    const data = await loadCoverage(fixture.userA.cookie);
    const brokerage = data!.areas.find((area) => area.area === "brokerage")!;
    // Before this change, every archive account's statementCount/recordCount
    // landed here regardless of type; a mortgage-typed one no longer does.
    expect(brokerage.sources).toBe(0);
    expect(brokerage.documents).toBe(0);
    expect(brokerage.records).toBe(0);
  });

  test("loadBanking lists depository/credit/loan accounts and the default 90-day transaction window", async () => {
    resetLog();
    const checking = await inTransaction((ctx) =>
      makeFinAccount(ctx, {
        institutionName: "Chase",
        name: "Checking",
        type: "depository",
      }),
    );
    const brokerage = await inTransaction((ctx) =>
      makeFinAccount(ctx, { type: "investment" }),
    );
    // Unique to this test run, so another test's rows in this owner-global,
    // unscoped table can never be mistaken for these.
    const recentDescription = `recent-${checking}`;
    const oldDescription = `old-${checking}`;
    await inTransaction(async (ctx) => {
      // Inside the default 90-day window (BANKING_NOW - ~55 days).
      await makeFinTransaction(ctx, checking, {
        date: "2026-08-01",
        description: recentDescription,
      });
      // Outside it (BANKING_NOW - ~178 days).
      await makeFinTransaction(ctx, checking, {
        date: "2026-03-30",
        description: oldDescription,
      });
      await makeFinTransaction(ctx, brokerage, { date: "2026-08-01" });
    });

    const { loadBanking } = await import("./admin-data");
    const data = await loadBanking(fixture.userA.cookie, BANKING_NOW);
    expect(data).not.toBeNull();
    expect(data!.windowDays).toBe(90);
    expect(data!.accounts.some((row) => row.accountId === checking)).toBe(true);
    expect(data!.accounts.every((row) => row.accountId !== brokerage)).toBe(
      true,
    );
    expect(
      data!.transactions.some((row) => row.description === recentDescription),
    ).toBe(true);
    expect(
      data!.transactions.every((row) => row.description !== oldDescription),
    ).toBe(true);

    expect(await loadBanking(null)).toBeNull();
  });
});
