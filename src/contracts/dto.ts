/**
 * Public HTTP contract of the Digital UP Board Stage 1 API.
 *
 * Dependency-free on purpose: the React frontend may import (or copy) this
 * module without pulling in database or server code. Field names and machine
 * values follow "Prototype Design.md" (Public DTOs and state values),
 * "Backend Requirements.md" section 6 and "Assignment Rotation Revision.md".
 * All times are ISO 8601 UTC strings, all IDs are opaque UUID strings,
 * optional values are explicit null.
 */

/**
 * Contract version; see docs/CONTRACT_CHANGES.md.
 * 3 = per-associate confirmation gate: at most one pending offer per
 *     associate (several associates may hold one at once); the queue moves
 *     when an offer is created, not on acceptance. Same fields as version 2.
 * 4 = Reject UP: POST /api/assignments/{id}/reject, completionReason
 *     'Rejected', activity 'AssignmentRejected'; a visit may have several
 *     rejected offers in assignments[] (at most one non-rejected).
 * 5 = a visit is never offered to the associate who rejected it last;
 *     VisitView.waitingReason explains why a Waiting visitor has no offer.
 * 6 = CV arrival accepts detection time and omits initial attributes; board shape unchanged.
 */
export const CONTRACT_VERSION = 6

/* ------------------------------------------------------------ enum values */

/**
 * Associate availability. Assignment work (pending offer, accepted turns) is
 * reported separately and never changes availability.
 */
export const PARTICIPANT_STATES = ['Available', 'OffFloor'] as const
export type ParticipantState = (typeof PARTICIPANT_STATES)[number]

/** States an operator may request (same values as ParticipantState). */
export const AVAILABILITY_STATES = PARTICIPANT_STATES
export type AvailabilityState = ParticipantState

export const ASSIGNMENT_PHASES = ['PendingAcceptance', 'Accepted', 'Completed'] as const
export type AssignmentPhase = (typeof ASSIGNMENT_PHASES)[number]

export const COMPLETION_REASONS = ['OutcomeRecorded', 'Departure', 'Rejected'] as const
export type CompletionReason = (typeof COMPLETION_REASONS)[number]

export const OUTCOMES = ['Sale', 'NoSale'] as const
export type Outcome = (typeof OUTCOMES)[number]

export const VISIT_STATUSES = ['Waiting', 'Assigned', 'Accepted', 'Completed'] as const
export type VisitStatus = (typeof VISIT_STATUSES)[number]

export const VISIT_SOURCES = ['CV', 'Manual'] as const
export type VisitSource = (typeof VISIT_SOURCES)[number]

export const AGE_GROUPS = ['Under20', 'From20To39', 'From40To59', 'Age60Plus', 'Unknown'] as const
export type AgeGroup = (typeof AGE_GROUPS)[number]

export const GENDERS = ['Female', 'Male', 'Unknown'] as const
export type Gender = (typeof GENDERS)[number]

export const ATTRIBUTES_SOURCES = ['Manual', 'CV', 'Unknown'] as const
export type AttributesSource = (typeof ATTRIBUTES_SOURCES)[number]

export const ENRICHMENT_STATUSES = ['Pending', 'Complete', 'Failed', 'NotRequested'] as const
export type EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number]

/**
 * Why a Waiting visitor inside has no offer:
 * - NoAvailableAssociates: nobody is Available.
 * - AwaitingConfirmation: every Available associate holds their own pending offer.
 * - AwaitingOtherAssociate: the only eligible associate(s) rejected this visit
 *   last; it waits for someone else (they still receive other visitors).
 */
export const WAITING_REASONS = ['NoAvailableAssociates', 'AwaitingConfirmation', 'AwaitingOtherAssociate'] as const
export type WaitingReason = (typeof WAITING_REASONS)[number]

export const ACTIVITY_KINDS = [
  'ArrivalRecorded',
  'AssignmentCreated',
  'AssignmentAccepted',
  'AssignmentRejected',
  'TurnCompleted',
  'AvailabilityChanged',
  'VisitorAttributesUpdated',
  'VisitorDeparted',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** Maximum length (Unicode code points) of each description field. */
export const DESCRIPTION_MAX_LENGTH = 200

/* ------------------------------------------------------------- read model */

export interface SessionContext {
  sessionId: string
  startedAt: string
}

export interface AssociateView {
  participantId: string
  associateId: string
  displayName: string
  state: ParticipantState
  /**
   * Dense 1-based rank among currently Available participants (1 = Next UP),
   * recomputed on every board read; null unless Available. It is not a stored
   * or monotonic token: ranks compact when someone goes Off Floor, and a
   * returning participant takes the new last rank.
   */
  queuePosition: number | null
  /**
   * This associate's own pending (unaccepted) offer; at most one per associate,
   * several associates may hold one at the same time. While set, the
   * associate receives no new offer and cannot be marked Off Floor.
   */
  pendingAssignmentId: string | null
  /** Accepted, unfinished assignments (any number), in visit registration order. */
  activeAssignmentIds: string[]
  /** activeAssignmentIds.length */
  activeTurns: number
  /** All offers created for this participant, including ones closed by early departure. */
  assignedTurns: number
  acceptedTurns: number
}

export interface VisitorAttributes {
  /** Trimmed; empty string means "not known". */
  upperDescription: string
  lowerDescription: string
  /** Trimmed; null when absent (empty input is normalized to null). */
  accessoryDescription: string | null
  ageGroup: AgeGroup
  gender: Gender
}

export interface VisitView {
  visitId: string
  /** Server registration (entry) time. */
  arrivedAt: string
  /** Separate CV observation time; always null in Stage 1. */
  detectedAt: string | null
  /** Registered exit time; presence is Inside while null, Left otherwise. */
  departedAt: string | null
  source: VisitSource
  status: VisitStatus
  attributes: VisitorAttributes
  attributesSource: AttributesSource
  enrichmentStatus: EnrichmentStatus
  outcome: Outcome | null
  outcomeRecordedAt: string | null
  /** 1-based FIFO rank among Waiting visitors still inside; otherwise null. */
  waitingPosition: number | null
  /** Non-null only while Waiting and inside; see WaitingReason. */
  waitingReason: WaitingReason | null
  /**
   * The visit's current (non-rejected) assignment: pending, accepted or
   * completed. Always null while Waiting, even if earlier offers were
   * rejected (those remain visible in BoardSnapshot.assignments).
   */
  assignmentId: string | null
}

export interface AssignmentView {
  assignmentId: string
  visitId: string
  participantId: string
  /** Derived: completedAt -> Completed, acceptedAt -> Accepted, else PendingAcceptance. */
  phase: AssignmentPhase
  assignedAt: string
  acceptedAt: string | null
  completedAt: string | null
  completionReason: CompletionReason | null
}

export interface MetricsView {
  visitors: number
  assignedTurns: number
  acceptedTurns: number
  closedSales: number
  /** Sale visits / all visits * 100 (0 when there are no visits); not rounded. */
  conversionRate: number
}

export interface ActivityView {
  activityId: string
  occurredAt: string
  kind: ActivityKind
  description: string
  visitId: string | null
  participantId: string | null
  assignmentId: string | null
}

/**
 * GET /api/board. Associates are in stable initial roster order, visits and
 * assignments in server registration order of their visits, activity newest
 * first (at most 100 entries; metrics cover the whole run).
 */
export interface BoardSnapshot {
  session: SessionContext
  associates: AssociateView[]
  visits: VisitView[]
  assignments: AssignmentView[]
  metrics: MetricsView
  activity: ActivityView[]
  serverTime: string
}

/* ----------------------------------------------------------- command bodies */

/** POST /api/arrivals */
export interface ArrivalRequest {
  sessionId: string
  /** Created once per intended visitor; reused unchanged on retry. */
  eventId: string
  source: 'Manual'
  /** Must be null or omitted in Stage 1. */
  detectedAt?: null
  attributes: VisitorAttributes
}

/** POST /api/availability */
export interface AvailabilityRequest {
  sessionId: string
  participantId: string
  /** Created once per intended change; reused unchanged on retry. */
  commandId: string
  state: AvailabilityState
}

/** POST /api/assignments/{assignmentId}/accept */
export interface AcceptanceRequest {
  sessionId: string
}

/** POST /api/assignments/{assignmentId}/reject */
export interface RejectionRequest {
  sessionId: string
}

/** POST /api/assignments/{assignmentId}/outcome */
export interface OutcomeRequest {
  sessionId: string
  outcome: Outcome
}

/** PATCH /api/visits/{visitId}/attributes - full profile replacement. */
export interface AttributesRequest {
  sessionId: string
  source: 'Manual'
  attributes: VisitorAttributes
  enrichmentStatus: 'NotRequested'
}

/** POST /api/visits/{visitId}/departure */
export interface DepartureRequest {
  sessionId: string
  /** Required when the visit has no stored outcome; must match a stored one. */
  outcome?: Outcome | null
}

/** POST /api/demo/reset */
export interface ResetRequest {
  sessionId: string
}

/* --------------------------------------------------------- command results */

/** 201 when created, 200 with duplicate true for an identical replay. */
export interface ArrivalResult {
  sessionId: string
  visitId: string
  duplicate: boolean
  /** Current Visit status (after automatic dispatch). */
  status: VisitStatus
}

export interface AvailabilityResult {
  sessionId: string
  participantId: string
  replayed: boolean
}

export interface AcceptanceResult {
  sessionId: string
  assignmentId: string
  phase: AssignmentPhase
  replayed: boolean
}

export interface RejectionResult {
  sessionId: string
  assignmentId: string
  visitId: string
  /**
   * Visit status after the immediate re-dispatch: Assigned to another eligible
   * associate, or Waiting. Never re-offered to the associate who just rejected it.
   */
  status: VisitStatus
  replayed: boolean
}

export interface OutcomeResult {
  sessionId: string
  visitId: string
  assignmentId: string
  outcome: Outcome
  replayed: boolean
}

export interface AttributesResult {
  sessionId: string
  visitId: string
  attributes: VisitorAttributes
  attributesSource: AttributesSource
  enrichmentStatus: EnrichmentStatus
  /** Reserved for future CV writes blocked by a manual override; false in Stage 1. */
  ignored: boolean
}

export interface DepartureResult {
  sessionId: string
  visitId: string
  departedAt: string
  outcome: Outcome
  replayed: boolean
}

export interface ResetResult {
  /** Identity of the new run. */
  sessionId: string
  startedAt: string
}
