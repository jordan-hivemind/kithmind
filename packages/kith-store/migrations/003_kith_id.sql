-- The id convention every ported table's primary key is declared over.
--
-- A domain rather than a CHECK repeated per table, so one definition covers
-- every one of the 77 tables the port brings over and a later migration cannot
-- forget it. See src/ids.ts for the generator and the same rule in TypeScript,
-- and section 2.2 of docs/plans/2026-09-12-postgres-consolidation.md for why
-- keys are preserved text rather than renumbered to uuid.
--
-- The bound is a length and a character class, nothing more: a Convex id is
-- kept verbatim, so this must accept every id already minted (32 characters of
-- the backend's own base32 alphabet) as well as every id this package mints
-- (26 characters, lowercase base32 of 16 random bytes). It is deliberately not
-- a fixed length -- that would make one of the two unrepresentable -- and
-- deliberately not `text` with no constraint at all, which would let a path,
-- an email or an empty string become a primary key.
CREATE DOMAIN kith.kith_id AS text
  CHECK (VALUE ~ '^[a-z0-9]{20,64}$');
