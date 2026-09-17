-- P2-39m: the first hosted rehearsal (2026-09-17) found one Convex field with
-- no `kith` column: `cardExtractionQueueStates.cursorRewoundAt` (P2-85), the
-- timestamp of the queue's one automatic cursor rewind per cycle. Migration
-- 004 built `card_extraction_queue_states` from the transform spec of its day,
-- before that field existed on the Convex side. The transform refuses any
-- unmapped field rather than dropping it, which is the right default: this
-- column gives the value a home so the load carries it across, and the card
-- queue port (`card_queue_tick` is still unregistered) finds the rewind state
-- it expects instead of a queue that believes it has never rewound.
ALTER TABLE kith.card_extraction_queue_states ADD COLUMN cursor_rewound_at timestamptz;
