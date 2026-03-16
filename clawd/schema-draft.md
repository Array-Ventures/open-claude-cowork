# Joyce Context Graph — Schema Draft v5

Pre-seed VC fund context graph. Captures the full physics of deal flow — from intelligence to decision to execution to outcome.

**Pointer nodes** (mutable) + **Claims/Events** (append-only). Every node carries `slug @key` and `markdown: String?`. Everything is an Artifact with type-specific data in a `metadata: String?` JSON field.

---

## Decision Spine

```
Artifact ──Mentions──> Person
    │      ──MentionsCompany──> Company
    │
    ▼ (SourcedFrom)
Signal
    │
    ▼ (InformedBy)
Decision ──MadeBy──> Person
    │      ──Targets──> Deal
    │
    ▼ (ResultedIn)
Action ──TouchedDeal──> Deal
    │   ──Produced──> Artifact
    │
    ▼ (GeneratedBy)
Signal (loop closes)
```

---

## Node Types (8)

### Pointer Nodes (Mutable)

All carry: `slug @key`, `createdAt`, `updatedAt`, `markdown`

#### Person

| Property | Type | Notes |
|----------|------|-------|
| slug | String @key | `per-shruti-gandhi` |
| name | String @unique | |
| role | String? | GP, founder, LP, advisor |
| email | String? | |
| phone | String? | |
| whatsapp | String? | |
| twitter | String? | |
| linkedin | String? | |
| title | String? | Job title |
| expertise | [String]? | |
| aliases | [String]? | |
| tags | [String]? | team, lp, founder, operator |
| createdAt | DateTime | |
| updatedAt | DateTime | |
| markdown | String? | Background, notes, opinions |

#### Company

| Property | Type | Notes |
|----------|------|-------|
| slug | String @key | `com-chipperbot` |
| name | String @unique | |
| sector | String? | |
| stage | String? | pre-seed, seed, series-a |
| status | enum(active, acquired, dead, inactive) | |
| website | String? | |
| founded | String? | |
| location | String? | |
| domain | String? | What they do |
| aliases | [String]? | |
| tags | [String]? | |
| createdAt | DateTime | |
| updatedAt | DateTime | |
| markdown | String? | Overview, product, traction, market, notes |

#### Deal

| Property | Type | Notes |
|----------|------|-------|
| slug | String @key | `deal-chipperbot` |
| name | String @unique | |
| stage | enum(closed, cold_intro, deep_dive, first_meeting, partner_meeting, term_sheet, warm_intro) | |
| decision | enum(invest, pass, pending) | |
| whoseTurn | enum(them, us)? | |
| nextStep | String? | |
| stageDate | Date? | When current stage was entered |
| introDate | Date? | When the deal first came in |
| passReason | String? | |
| tags | [String]? | |
| createdAt | DateTime | |
| updatedAt | DateTime | |
| markdown | String? | Quick take, thesis fit, key questions, decision log |

#### Portfolio

| Property | Type | Notes |
|----------|------|-------|
| slug | String @key | `port-hotdata` |
| name | String @unique | |
| round | String? | |
| checkSize | String? | |
| valuation | String? | |
| investDate | Date? | |
| status | enum(active, exited, written_off) | |
| nextRaise | String? | |
| boardSeat | Bool? | |
| coInvestors | [String]? | |
| tags | [String]? | |
| createdAt | DateTime | |
| updatedAt | DateTime | |
| markdown | String? | Thesis, founders, metrics, support, board notes |

#### Artifact

Everything is an artifact. Meetings, emails, decks, sessions, tweets, data rooms, events, daily logs. Type-specific structured data lives in `metadata` JSON. Who authored/sent is in `markdown`.

| Property | Type | Notes |
|----------|------|-------|
| slug | String @key | `art-chipperbot-intro-email` |
| name | String | "ChipperBot intro email from Adam" |
| artifactType | enum(daily, data_room, deck, demo, diligence_docs, email, event, meeting, memo, other, report, session, social_post, term_sheet, transcript, website) | |
| uri | String? | DocSend link, URL, thread ID |
| tags | [String]? | |
| createdAt | DateTime | |
| updatedAt | DateTime | |
| markdown | String? | Content, key takeaways, notes |
| metadata | String? | JSON blob for type-specific fields |

**metadata examples by type:**

```json
// social_post
{"platform": "x", "status": "posted", "likes": 42, "comments": 5, "impressions": 15000, "postedAt": "2026-03-02T09:00:00Z", "link": "twitter.com/atShruti/status/123"}

// meeting
{"meetingDate": "2026-03-03T10:30:00Z", "meetingType": "intro_call"}

// event
{"eventDate": "2026-03-05", "location": "Scottsdale Resort", "eventType": "LP conference"}

// daily
{"date": "2026-03-05"}

// email
{"threadId": "abc123", "subject": "Intro: ChipperBot <> Array"}

// deck
{"pageCount": 23, "sharedBy": "Josh Benhamou"}

// session
{"channel": "whatsapp", "participants": ["Shruti", "Joyce"]}
```

### Claims & Events Nodes (Append-Only)

All carry: `slug @key`, `createdAt` (no `updatedAt`), `markdown`

#### Signal

Intelligence extracted from artifacts.

| Property | Type | Notes |
|----------|------|-------|
| slug | String @key | `sig-chipperbot-intro` |
| observedAt | DateTime | |
| summary | String | "Warm intro from Adam — ChipperBot, ML for life sciences" |
| signalType | enum(cold_pitch, content_intel, demo_day, intro, market_intel, observation, portfolio_referral) | |
| sentiment | enum(mixed, negative, neutral, positive)? | |
| urgency | enum(critical, high, low, medium)? | |
| createdAt | DateTime | |
| markdown | String? | |

#### Decision

Choices made at stage gates, content approvals, outbound calls, invest/pass.

| Property | Type | Notes |
|----------|------|-------|
| slug | String @key | `dec-chipperbot-accept-intro` |
| decidedAt | DateTime | |
| intent | String | "Accept intro, take first meeting" |
| outcome | enum(advance, approve, hold, invest, pass, reject, table) | |
| domain | enum(content, deal, fundraise, operations, portfolio) | |
| confidence | enum(high, low, medium)? | |
| createdAt | DateTime | |
| markdown | String? | Full reasoning |

#### Action

Executions by humans or Joyce.

| Property | Type | Notes |
|----------|------|-------|
| slug | String @key | `act-chipperbot-intro-reply` |
| executedAt | DateTime | |
| operation | enum(create, forward, intro, reply, schedule, send, share, update) | |
| channel | enum(email, imessage, in_person, linkedin, phone, slack, twitter, whatsapp)? | |
| success | Bool | |
| summary | String? | "Replied to intro email, confirmed meeting" |
| createdAt | DateTime | |
| markdown | String? | |

---

## Edges (19)

### Decision Spine (9)

| Edge | From -> To | Properties | Notes |
|------|-----------|------------|-------|
| SourcedFrom | Signal -> Artifact | | Signal extracted from this artifact |
| InformedBy | Decision -> Signal | influence: enum(minor, primary, supporting)? | Decision informed by this signal |
| MadeBy | Decision -> Person | | Who made the decision |
| Targets | Decision -> Deal | | Decision about this deal |
| TargetsCompany | Decision -> Company | | Decision about a company (no deal) |
| ResultedIn | Decision -> Action | | Decision caused this action |
| TouchedDeal | Action -> Deal | | Action affected this deal |
| Produced | Action -> Artifact | | Action created/sent this artifact |
| GeneratedBy | Signal -> Action | | Signal generated by this action (reply loop) |

### Artifact (2)

| Edge | From -> To | Properties | Notes |
|------|-----------|------------|-------|
| Mentions | Artifact -> Person | | Anyone referenced in the artifact |
| MentionsCompany | Artifact -> Company | | Any company referenced |

### People & Organizations (2)

| Edge | From -> To | Properties | Notes |
|------|-----------|------------|-------|
| WorksAt | Person -> Company | role: String? | |
| Founded | Person -> Company | | |

### Deal Pipeline (3)

| Edge | From -> To | Properties | Notes |
|------|-----------|------------|-------|
| DealFor | Deal -> Company | | |
| DealOwner | Deal -> Person | | Team member running it |
| DealLead | Deal -> Person | | Partner making the call |

### Portfolio (3)

| Edge | From -> To | Properties | Notes |
|------|-----------|------------|-------|
| InvestedIn | Portfolio -> Company | | |
| PortfolioLead | Portfolio -> Person | | |
| ReferredBy | Signal -> Portfolio | | Portfolio company referred this signal |

---

## Totals

- **8 node types** (5 pointer + 3 claims/events)
- **19 edge types**

Compared to revops: 10 nodes, 21 edges. We're leaner.

---

## Deal Flow Traces

### Trace 1: Warm intro (ChipperBot)

```
Artifact(email): "Adam Besvinick intro email"
  ──Mentions──> Person (Adam, Shruti, Josh, Tristan)
  ──MentionsCompany──> Company (ChipperBot, LookingGlass VC)

Signal: "Warm intro from Adam — ChipperBot, ML for life sciences"
  ──SourcedFrom──> Artifact (intro email)

Decision: "Accept intro, take first meeting"
  ──MadeBy──> Person (Shruti)
  ──InformedBy──> Signal (the intro)
  ──Targets──> Deal (ChipperBot)

Deal: stage=warm_intro
  ──DealFor──> Company (ChipperBot)
  ──DealOwner──> Person (Rajas)
  ──DealLead──> Person (Shruti)

Action: "Replied to intro email, confirmed meeting"
  ──ResultedIn── Decision
  ──TouchedDeal──> Deal (ChipperBot)

Artifact(meeting): "ChipperBot intro call Mar 3"
  metadata: {"meetingDate": "2026-03-03T10:30:00Z", "meetingType": "intro_call"}
  ──Mentions──> Person (Josh, Kyle, Shruti, Parth, Rajas)
  ──MentionsCompany──> Company (ChipperBot)

Signal: "Kyle's ops background — $25-40M CapEx at Invitae"
  ──SourcedFrom──> Artifact (meeting)

Signal: "Competitive gap — Apprentice.io not in deck"
  ──SourcedFrom──> Artifact (meeting)

Artifact(deck): "ChipperBot Pitch Deck"
  metadata: {"pageCount": 23}
  ──MentionsCompany──> Company (ChipperBot, Elemental Machines, Ganymede)

Decision: "Proceed to deep dive"
  ──MadeBy──> Person (Shruti)
  ──InformedBy──> Signal (Kyle ops), Signal (competitive gap)
  ──Targets──> Deal (ChipperBot)

Deal updated: stage=deep_dive
```

### Trace 2: Outbound from social signal

```
Artifact(social_post): "Tweet from @xyz about AI infra"
  ──Mentions──> Person (founder)
  ──MentionsCompany──> Company (XYZ)

Signal: "Interesting founder building in our thesis area"
  ──SourcedFrom──> Artifact (tweet)

Decision: "Outbound to this founder"
  ──MadeBy──> Person (Shruti)
  ──InformedBy──> Signal

Action: "DM sent on Twitter"
  ──ResultedIn── Decision

Action: "Follow-up email sent"
  ──ResultedIn── Decision (same)

Artifact(email): "Reply from founder — interested"
  ──Mentions──> Person (founder)

Signal: "Founder replied positively"
  ──SourcedFrom──> Artifact (reply)
  ──GeneratedBy──> Action (follow-up email)

Decision: "Create deal"
  ──InformedBy──> Signal (reply)

Deal: stage=cold_intro
  ──DealFor──> Company (XYZ)
```

### Trace 3: Cold inbound from content

```
Artifact(social_post): "Our Cal AI post on X"
  metadata: {"platform": "x", "status": "posted", "likes": 200}

Artifact(email): "Cold pitch from Paula"
  ──Mentions──> Person (Paula Rodriguez Jou)
  ──MentionsCompany──> Company (AIVA Tech)

Signal: "Cold pitch — saw our X post, building vertical AI for hotel ops"
  ──SourcedFrom──> Artifact (email)

Decision: "Review cold pitch"
  ──MadeBy──> Person (Rajas)
  ──InformedBy──> Signal

Deal: stage=cold_intro
  ──DealFor──> Company (AIVA Tech)
```

### Trace 4: Portfolio referral

```
Artifact(meeting): "Portfolio sync with Hotdata"
  ──Mentions──> Person (Divya, Eddie, Shruti)
  ──MentionsCompany──> Company (Hotdata)

Signal: "Hotdata founder mentioned AI compliance team"
  signalType: portfolio_referral
  ──SourcedFrom──> Artifact (meeting)
  ──ReferredBy──> Portfolio (Hotdata)

Decision: "Take the intro"
  ──MadeBy──> Person (Shruti)
  ──InformedBy──> Signal

Deal created
```

### Trace 5: Session ingestion

```
Artifact(session): "WhatsApp session Mar 5"
  metadata: {"channel": "whatsapp", "participants": ["Shruti", "Joyce"]}
  ──Mentions──> Person (Shruti)

Signal: "Shruti says she's seen the Noveum founder — pitched MagicAPI before"
  ──SourcedFrom──> Artifact (session)

Decision: "Pass on Noveum"
  outcome: pass
  ──MadeBy──> Person (Shruti)
  ──InformedBy──> Signal
  ──Targets──> Deal (Noveum)

Deal updated: decision=pass
```

---

## Example Queries

```gq
// Why is ChipperBot in our pipeline?
query deal_provenance($deal: String) {
    match {
        $d: Deal { slug: $deal }
        $dec targets $d
        $dec madeBy $who
        $dec informedBy $sig
        $sig sourcedFrom $art
    }
    return { $d.name, $dec.intent, $who.name, $sig.summary, $art.name }
}

// What deals has Adam Besvinick been involved in?
query person_deals($person: String) {
    match {
        $p: Person { slug: $person }
        $art mentions $p
        $sig sourcedFrom $art
        $dec informedBy $sig
        $dec targets $d
    }
    return { $p.name, $sig.summary, $d.name, $d.stage }
}

// All pending deals, whose turn, next step
query pipeline_board() {
    match {
        $d: Deal { decision: "pending" }
        $d dealFor $c
    }
    return { $d.name, $d.stage, $d.whoseTurn, $d.nextStep, $c.name }
    order { $d.stageDate asc }
}

// What signals came from a meeting?
query meeting_signals($art: String) {
    match {
        $a: Artifact { slug: $art }
        $sig sourcedFrom $a
    }
    return { $a.name, $sig.summary, $sig.signalType, $sig.urgency }
}

// Outbound reply rate — actions that generated signals
query outbound_results() {
    match {
        $act: Action { operation: "send" }
        $sig generatedBy $act
    }
    return { $act.summary, $act.channel, $sig.summary }
}

// Portfolio referral quality
query referral_deals() {
    match {
        $sig: Signal { signalType: "portfolio_referral" }
        $sig referredBy $port
        $dec informedBy $sig
        $dec targets $d
    }
    return { $port.name, $sig.summary, $d.name, $d.decision }
}

// Decisions made by Shruti this month
query recent_decisions($who: String) {
    match {
        $dec: Decision
        $dec madeBy $p
        $p: Person { slug: $who }
        $dec.decidedAt >= datetime("2026-03-01T00:00:00Z")
    }
    return { $dec.intent, $dec.outcome, $dec.domain, $dec.decidedAt }
    order { $dec.decidedAt desc }
}
```

---

## Resolved Decisions

1. **Decision granularity** — every stage advance creates a Decision node, not just major gates.

2. **Slug convention** — `per-`, `com-`, `deal-`, `port-`, `art-`, `sig-`, `dec-`, `act-`

3. **organization.md / strategy.md** — Array Ventures is a `Company` node. Strategy, thesis, fund focus, investment criteria all live in its `markdown` field. No separate Artifact needed.

4. **Embeddings** — required. Add `Vector(1536) @embed(markdown) @index` on `Signal`, `Company`, `Deal`, and `Artifact`.

5. **Content provenance** — implicit via Decision chain. `Signal ←InformedBy─ Decision ─ResultedIn→ Action ─Produced→ Artifact(social_post)`. No explicit Signal→Post edge needed.
