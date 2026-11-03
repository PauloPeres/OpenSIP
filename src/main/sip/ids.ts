import { randomBytes } from 'node:crypto';

/** Randomness a SIP stack needs, isolated so everything else stays deterministic. */
export interface IdFactory {
  newBranch(): string;
  newTag(): string;
  newCallId(host: string): string;
  newCnonce(): string;
}

const BRANCH_MAGIC = 'z9hG4bK';
const token = (bytes: number): string => randomBytes(bytes).toString('hex');

export const defaultIdFactory: IdFactory = {
  newBranch: () => `${BRANCH_MAGIC}${token(8)}`,
  newTag: () => token(6),
  newCallId: (host) => `${token(10)}@${host}`,
  newCnonce: () => token(8)
};
