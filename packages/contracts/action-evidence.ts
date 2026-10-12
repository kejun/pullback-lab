// Type-only dependency: the manifest validator and Node crypto stay on the server.
import type { ActionManifest } from "../market-data/action-evidence.js";

export interface EvidenceVersion {
  sequence: number;
  version: string;
  recordedAt: number;
  source: string;
  coverage: ActionManifest["coverage"];
  actionCount: number;
  documentCount: number;
}
export interface EvidenceHistory {
  instrumentId: string;
  versions: EvidenceVersion[];
  nextBefore: number | null;
  liveEligible: false;
}
export type EvidenceDocument = Omit<
  ActionManifest["documents"][number],
  "content"
> & {
  bytes: number;
};
export type EvidenceAction = ActionManifest["actions"][number];
export interface EvidenceChange<T> {
  id: string;
  before: T | null;
  after: T | null;
}
export interface EvidenceDetail extends EvidenceVersion {
  instrumentId: string;
  currentVersion: string;
  review: ActionManifest["review"];
  actions: EvidenceAction[];
  documents: EvidenceDocument[];
  removedActionIds: string[];
  liveEligible: false;
  comparison: null | {
    previous: EvidenceVersion & { review: ActionManifest["review"] };
    sourceChanged: boolean;
    coverageChanged: boolean;
    reviewChanged: boolean;
    actions: EvidenceChange<EvidenceAction>[];
    documents: EvidenceChange<EvidenceDocument>[];
  };
}
export interface EvidenceDocumentContent extends EvidenceDocument {
  instrumentId: string;
  version: string;
  content: string;
}
