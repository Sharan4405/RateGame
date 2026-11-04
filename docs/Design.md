# Game Review Platform — High-Level & Low-Level Design

Oct 2026 · @Yash

## 1. Requirements

**Functional**

- Browse and search games
- Add ratings and reviews
- Basic user profiles
- Get recommendations (hybrid: content-based + lightweight collaborative filtering)
- Admin panel (separate service) for game catalog CRUD, with moderation to follow later

> Follow-other-users is dropped from scope for the baseline build (fewer moving parts). Recommendations do not depend on a follow graph — they're built from the `reviews` collection instead.

**Non-functional** (pretend-scale, chosen deliberately so the architecture requires sharding, replication, caching, async messaging, and load balancing rather than just resembling them)

- 500M registered users, ~50M daily active
- Peak ~50,000 read QPS / ~5,000 write QPS (90:10 split)
- 10M games in catalog, multi-TB of review/rating data
- Multi-region user base (US, EU, APAC)
- Eventual consistency acceptable
- 99.99% availability target
- <300ms latency per call

## 2. Capacity Estimation

- Target scale: 500M registered users, ~50M DAU, 10M games
- Peak load target: ~50,000 read QPS / ~5,000 write QPS (90:10 split)
- Storage: user profiles ~500GB (500M × ~1KB), game catalog ~50GB (10M × ~5KB), reviews/ratings growing into multi-TB as volume accumulates
- Conclusion: this load and data volume rules out a single-node database, which is what justifies sharding and replication rather than them being default choices

## 3. Tech Stack

| Layer | Choice | Reasoning |
| --- | --- | --- |
| Frontend | Next.js | SSR for SEO, good fit for a content-browsing site |
| Backend | Node.js + Express | Lightweight API layer; workload is I/O-bound (90% reads), which fits Node's event-loop model |
| Database | Self-managed MongoDB (sharded cluster, replica sets) | Document model fits flexible game metadata; self-managed (vs. GCP-managed Firestore/Atlas) so sharding and replication are configured and observed directly, matching the learning goal |
| Cache | Redis | Cache-aside pattern for hot reads |
| Messaging | Message queue (Kafka or RabbitMQ — finalize once consumer patterns are clearer) | Overload buffering and async propagation of write side-effects |
| Search | MongoDB `$text` index for now; Elasticsearch deferred | Self-managed Mongo has no Atlas Search (Lucene); `$text` is enough until load numbers force a dedicated search service |
| Deployment | GCP (GCE/GKE) | Target cloud platform |

Rejected: Firestore (GCP-managed NoSQL) — auto-shards and auto-replicates invisibly, which would hide the exact mechanics this project is meant to teach.

## 4. High-Level Design

### 4.1 Architecture Overview

Client → Load Balancer (hand-rolled round-robin/least-connections, not a managed LB — the point is to learn the mechanism) → App Servers (stateless, horizontally scaled Node/Express) → fans out to:

- Redis Cache (TTL 10 min + invalidate on write)
- Message Queue (backpressure + async events) → Background Workers → back to Redis Cache / `recommendations` collection
- MongoDB Router / mongos (routes query by shard key) → Shard 1 (Primary + Replicas), Shard 2 (Primary + Replicas), ...

Diagram: https://claude.ai/code/artifact/64b28cba-143f-43c7-9163-e1adb0adb6d8

### 4.2 Read Path: Search for a Game

1. Client sends a GET request to the load balancer; rate limit check passes
2. Load balancer routes to an available (stateless) app server
3. App server computes the cache key (`game:<gameId>`) and checks Redis
4. **Cache hit** — return the cached JSON directly (fast path)
5. **Cache miss** — app server computes the shard key (`hash(gameId) % numShards`), queries that shard through the mongos router; the query is served by a replica, not the primary
6. App server writes the fetched result back into Redis with a TTL
7. Response returned to client

### 4.3 Write Path: Submit a Review

1. Client sends a POST request to the load balancer → routed to an app server
2. App server computes the shard key (`hash(gameId) % numShards`) and writes synchronously to that shard's **primary** — needs to be durable before confirming, so the client is never told "success" for a write that's then lost
3. Primary confirms the durable write → app server returns 201 Created to the client
4. App server publishes a `review_added` event to the message queue
5. Two consumer groups process it independently (see §5.2)
6. Independently, MongoDB's own replica-set protocol propagates the write from primary to replicas in the background — this replication lag is the actual eventual-consistency window: a reader hitting a replica right after the write might briefly see stale data

### 4.4 Sharding Strategy

- Shard key: `hash(userId) % numShards` for the `users` collection, `hash(gameId) % numShards` for `games` and `reviews` (MongoDB hashed sharding)
- Rejected: alphabet-of-username and raw sequential IDs — both create hotspots. Username-first-letter distribution is uneven across real usernames, overloading some shards and leaving others nearly empty; sequential IDs funnel all new writes onto whichever shard holds the newest ID range
- A good shard key needs: high cardinality, even distribution of both data and write load, and no monotonically increasing raw value used directly — hashing solves all three
- Bonus: since most queries already include `gameId` or `userId`, a hashed key still lets most queries target a single shard rather than scattering across all of them

### 4.5 Caching Strategy

- Pattern: cache-aside (lazy loading) — app checks Redis first, falls back to MongoDB on a miss, then populates the cache
- Cache key: `game:<gameId>`
- TTL: 10 minutes, as a safety net
- Invalidation: explicit invalidate-on-write, triggered by a background worker whenever a review changes a game's aggregate rating
- TTL and invalidation together cover both cases: invalidation handles the common path fast, TTL self-heals the rare case where an invalidation event is ever missed

### 4.6 Async Messaging / Queue Strategy

The queue serves two distinct purposes:

1. **Backpressure / overload buffering** — absorbing request spikes so the app tier degrades gracefully instead of falling over
2. **Eventual-consistency propagation** — carrying side effects (cache invalidation, rating recomputation, recommendation updates) after a write is durably confirmed on the primary

Durability requirement: messages must persist and require consumer acknowledgment (at-least-once delivery) — a worker crashing mid-task must not silently drop the event.

## 5. Low-Level Design

### 5.1 Data Model

```
users: { user_id, username, email, password_hash, review_count }
games: { game_id, name, genre: [], release_year, cover_image, avg_rating, review_count }
reviews: { review_id, user_id, game_id, rating (number), comment, created_at }
recommendations: { user_id (key), recommended_game_ids: [game_id], computed_at, review_count_at_last_update }
```

Key decisions:

- `rating` stored as a number (not string) on both `reviews` and as the aggregate on `games`, so averaging needs no type conversion
- `games.avg_rating` + `games.review_count` stored together so the aggregate can be updated incrementally (`newAvg = (oldAvg × oldCount + newRating) / (oldCount + 1)`) instead of rescanning every review per update
- No `reviews` array on `users` — avoids a denormalization-sync problem; "reviews by user X" is just a query on `reviews` filtered by `user_id`
- `recommendations` stores only `game_id`s, not duplicated game metadata — deliberate normalize-over-denormalize choice (avoids stale duplicated titles/images); the read path re-fetches metadata in one batched query (`games.find({game_id: {$in: [...]}})`) rather than N separate queries
- Dates stored/serialized as ISO 8601 (`YYYY-MM-DD`) — avoids regional day/month ambiguity

### 5.2 Worker & Queue Design

Two consumer groups on the same `review_added` event topic, isolated so a slow path never blocks a fast one:

- **Worker A (fast path):** cache invalidation for the game's Redis entry + incremental aggregate rating recompute on `games`
- **Worker B (recommendations path):** increments the user's review counter, checks against a threshold (e.g. 10 new reviews since last computation); if exceeded, enqueues a recompute job for that user
- **Scheduled job (nightly cron):** full batch recomputation of recommendations for all users, independent of the threshold path — this is the lambda-architecture pattern (batch layer + event-triggered speed layer)

### 5.3 API Contracts

```
GET  /api/games/search?q=&genre=&page=&limit=     (no auth; MongoDB $text index)
     → 200 OK  { results: [{ game_id, name, avg_rating, release_year, cover_image }], page, limit, total }

GET  /api/games/:game_id                           (no auth)
     → 200 OK  { game_id, name, genre: [], release_year: "2005-03-01", avg_rating, review_count, cover_image }

POST /api/reviews                                   (auth required; user_id derived from JWT, never from body)
     body: { game_id, rating, comment }
     → 201 Created  { review_id }

GET  /api/recommendations                           (auth required; user_id from JWT)
     → 200 OK  { results: [{ game_id, name, avg_rating, cover_image }] }
     (handler: recommendations.findOne({user_id}) → games.find({game_id: {$in: [...]}}) → merge)
```

## 6. Implementation Roadmap

0. **Baseline CRUD app** (Next.js + Express + single MongoDB) — no cache/queue/LB/replication/sharding yet
1. Caching (Redis, cache-aside)
2. Async queue (durable, ack-based consumer)
3. Load balancing (hand-rolled round-robin/least-connections across multiple local app instances)
4. Replication (MongoDB replica set — primary election, failover)
5. Sharding (shard the replica sets, routing via mongos)

All of 0–5 run locally via Docker Compose on one machine; cloud (GCE/GKE) is a later stretch exercise for simulating true multi-region replication, not required for the core mechanics.

## 7. Open Questions

- [ ] Finalize message queue tech (Kafka vs. RabbitMQ) once consumer patterns are clearer
- [ ] Decide replica count per shard and number of shards for the local Docker implementation slice
- [ ] Admin panel API contracts (deferred until baseline CRUD ships)
