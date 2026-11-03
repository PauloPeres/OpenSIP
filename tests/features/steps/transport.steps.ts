import assert from 'node:assert/strict';
import { Before, Given, Then, When } from '@cucumber/cucumber';
import {
  NoReachableTransportError,
  buildCandidates,
  candidateKey,
  selectBestCandidate
} from '../../../src/core/sip/transport';
import type {
  ProbeOutcome,
  SipTransport,
  SrvRecord,
  TransportCandidate
} from '../../../src/core/sip/transport';

interface World {
  domain: string;
  srvRecords: SrvRecord[];
  manualUri: string | undefined;
  candidates: readonly TransportCandidate[];
  best: TransportCandidate | undefined;
  error: unknown;
}

const world: World = {
  domain: 'example.com',
  srvRecords: [],
  manualUri: undefined,
  candidates: [],
  best: undefined,
  error: undefined
};

Before(() => {
  world.domain = 'example.com';
  world.srvRecords = [];
  world.manualUri = undefined;
  world.candidates = [];
  world.best = undefined;
  world.error = undefined;
});

const build = (): void => {
  world.candidates = buildCandidates({
    domain: world.domain,
    srvRecords: world.srvRecords,
    ...(world.manualUri === undefined ? {} : { manualUri: world.manualUri })
  });
};

const probe = (responding: readonly string[]): void => {
  const outcomes = world.candidates.map(
    (candidate, index): ProbeOutcome =>
      responding.includes(candidateKey(candidate))
        ? { candidate, ok: true, latencyMs: 10 + index }
        : { candidate, ok: false, errorKey: 'transport.error.timeout' }
  );
  try {
    world.best = selectBestCandidate(outcomes);
  } catch (error) {
    world.error = error;
  }
};

Given(
  'the domain {string} publishes an SRV record for {string} at {string} port {int}',
  (domain: string, transport: string, name: string, port: number) => {
    world.domain = domain;
    world.srvRecords.push({
      transport: transport as SipTransport,
      name,
      port,
      priority: 10,
      weight: 50
    });
  }
);

Given('the manual address {string} is entered', (uri: string) => {
  world.manualUri = uri;
});

When('the candidates for the domain are built', build);

When('the candidates for the domain {string} are built', (domain: string) => {
  world.domain = domain;
  build();
});

When('only {string} and {string} respond', (a: string, b: string) => probe([a, b]));

When('every candidate responds', () => probe(world.candidates.map(candidateKey)));

When('no candidate responds', () => probe([]));

Then('the first candidate is {string}', (key: string) => {
  assert.equal(candidateKey(world.candidates[0] as TransportCandidate), key);
});

Then('the first candidate comes from {string}', (source: string) => {
  assert.equal(world.candidates[0]?.source, source);
});

Then('the best candidate is {string}', (key: string) => {
  assert.equal(candidateKey(world.best as TransportCandidate), key);
});

Then('the candidates in order are:', (table: { raw: () => string[][] }) => {
  assert.deepEqual(
    world.candidates.map(candidateKey),
    table.raw().map((row) => row[0])
  );
});

Then('no reachable transport is reported', () => {
  assert.ok(world.error instanceof NoReachableTransportError);
});
