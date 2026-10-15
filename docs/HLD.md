# Game Review Platform — High-Level Design

Oct 13, 2026 · @Yash

## Requirements

**Functional**

- Browse and search games
- Add ratings and reviews
- Follow other users
- Basic user profiles
- Get recommendations
- Admin panel (separate service) for game catalog CRUD, with moderation to follow later

**Non-functional** (pretend-scale, chosen deliberately so the architecture requires sharding, replication, caching, async messaging, and load balancing rather than just resembling them)

- 500M registered users, ~50M daily active
- Peak ~50,000 read QPS / ~5,000 write QPS (90:10 split)
- 10M games in catalog, multi-TB of review/rating data
- Multi-region user base (US, EU, APAC)
- Eventual consistency acceptable
- 99.99% availability target
- <300ms latency per call

## Capacity Estimation

- Target scale: 500M registered users, ~50M DAU, 10M games
- Peak load target: ~50,000 read QPS / ~5,000 write QPS (90:10 split)
- Storage: user profiles ~500GB (500M x ~1KB), game catalog ~50GB (10M x ~5KB), reviews/ratings growing into multi-TB as volume accumulates
- Conclusion: this load and data volume rules out a single-node database, which is what justifies sharding and replication rather than them being default choices

## Tech Stack

| Layer | Choice | Reasoning |
| --- | --- | --- |
| Frontend | Next.js | SSR for SEO, good fit for a content-browsing site |
| Backend | Node.js + Express | Lightweight API layer; workload is I/O-bound (90% reads), which fits Node's event-loop model |
| Database | Self-managed MongoDB (sharded cluster, replica sets) | Document model fits flexible game metadata; self-managed (vs. GCP-managed Firestore) so sharding and replication are configured and observed directly, matching the learning goal |
| Cache | Redis | Cache-aside pattern for hot reads |
| Messaging | Message queue (to be chosen: Kafka or RabbitMQ) | Overload buffering and async propagation of write side-effects |
| Deployment | GCP (GCE/GKE) | Target cloud platform |

Rejected: Firestore (GCP-managed NoSQL) — auto-shards and auto-replicates invisibly, which would hide the exact mechanics this project is meant to teach.

## High-Level Architecture

See the architecture diagram in the HLD doc: https://claude.ai/code/artifact/64b28cba-143f-43c7-9163-e1adb0adb6d8

A client request passes through the load balancer to a stateless app-server tier. Reads branch to Redis (cache-aside) or the MongoDB router; writes go to the primary via the router. Side-effects (cache invalidation, rating recomputation) run asynchronously off the queue, independent of MongoDB's own replica-set replication.

Components: Client → Load Balancer (nginx, rate limiting + HTTP cache) → App Servers (stateless, horizontally scaled Node/Express) → fans out to:
- Redis Cache (TTL 10 min + invalidate on write)
- Message Queue (backpressure + async events) → Background Workers (cache invalidation, rating recompute) → back to Redis Cache
- MongoDB Router / mongos (routes query by shard key) → Shard 1 (Primary + Replicas), Shard 2 (Primary + Replicas)

## Read Path: Search for a Game

1. Client sends a GET request to the load balancer; rate limit check passes
2. Load balancer routes to an available (stateless) app server
3. App server computes the cache key (`game:<gameId>`) and checks Redis
4. **Cache hit** — return the cached JSON directly (fast path)
5. **Cache miss** — app server computes the shard key (`hash(gameId) % numShards`), queries that shard through the mongos router; the query is served by a replica, not the primary
6. App server writes the fetched result back into Redis with a TTL (this is the cache-population step that was missing from the first draft)
7. Response returned to client

## Write Path: Submit a Review

1. Client sends a POST request to the load balancer → routed to an app server
2. App server computes the shard key (`hash(gameId) % numShards`) and writes synchronously to that shard's **primary** — needs to be durable before confirming, so the client is never told "success" for a write that's then lost
3. Primary confirms the durable write → app server returns 200 OK to the client
4. App server publishes a `review_added` event to the message queue
5. A background worker consumes the event → invalidates/updates the Redis cache entry for that game, recomputes the aggregate rating, updates recommendation data
6. Independently, MongoDB's own replica-set protocol propagates the write from primary to replicas in the background — this replication lag is the actual eventual-consistency window: a reader hitting a replica right after the write might briefly see stale data

## Sharding Strategy

- Shard key: `hash(userId) % numShards` for the users collection, `hash(gameId) % numShards` for games and reviews (MongoDB hashed sharding)
- Rejected: alphabet-of-username and raw sequential IDs — both create hotspots. Username-first-letter distribution is uneven across real usernames, overloading some shards and leaving others nearly empty; sequential IDs funnel all new writes onto whichever shard holds the newest ID range
- A good shard key needs: high cardinality, even distribution of both data and write load, and no monotonically increasing raw value used directly — hashing solves all three
- Bonus: since most queries already include `gameId` or `userId`, a hashed key still lets most queries target a single shard rather than scattering across all of them

## Caching Strategy

- Pattern: cache-aside (lazy loading) — app checks Redis first, falls back to MongoDB on a miss, then populates the cache
- Cache key: `game:<gameId>`
- TTL: 10 minutes, as a safety net
- Invalidation: explicit invalidate-on-write, triggered by the background worker whenever a review changes a game's aggregate rating
- TTL and invalidation together cover both cases: invalidation handles the common path fast, TTL self-heals the rare case where an invalidation event is ever missed

## Async Messaging / Queue Strategy

The queue serves two distinct purposes:

1. **Backpressure / overload buffering** — absorbing request spikes so the app tier degrades gracefully instead of falling over
2. **Eventual-consistency propagation** — carrying side effects (cache invalidation, rating recomputation, recommendation updates, notifications) after a write is durably confirmed on the primary

Tech choice (Kafka vs. RabbitMQ) is deferred to LLD: Kafka fits better if we want durable event replay and multiple independent consumer groups (e.g., cache-invalidation worker and recommendation-indexing worker reading the same event stream separately); RabbitMQ fits better if the need is simpler task-queue semantics with less operational overhead.

## Open Questions / Next Steps (toward LLD)

- [ ] Finalize message queue tech (Kafka vs. RabbitMQ) once consumer patterns are clearer
- [ ] Design MongoDB schemas for users, games, reviews, and follows — follows especially, since document stores have no native joins
- [ ] Define API contracts (REST or GraphQL) for each flow above
- [ ] Decide replica count per shard and number of shards for the local Docker implementation slice
- [ ] Decide which piece (sharding, replication, caching, queue, load balancing) gets implemented for real first, now that the full picture exists
