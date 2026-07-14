/**
 * A monotonic id allocator.
 *
 * One instance mints every id for a given kind ("pa" for pending actions, "au"
 * for audit records). Because a single counter hands out every id and only ever
 * moves forward, ids are unique by construction and are never reused — even after
 * an item is approved or rejected. Combined with our append-only / no-delete
 * stores, that is what keeps ids stable and collision-free.
 *
 * Trade-off (see README): the counter lives in process memory, so it resets to 1
 * on restart and is not safe across multiple server instances. A production Hub
 * would use a database sequence or a time-ordered id like ULID/UUID.
 */
export function createIdSequence(prefix: string): () => string {
  let count = 0;
  return () => `${prefix}_${++count}`;
}
