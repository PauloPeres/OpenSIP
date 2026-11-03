Feature: Discover the best SIP transport
  The app probes how to reach a SIP domain so the user only types a username,
  a password and a domain.

  Scenario: A TCP-only PBX found through SRV records beats the guessed defaults
    Given the domain "example.com" publishes an SRV record for "tcp" at "pbx1.example.com" port 5060
    When the candidates for the domain are built
    Then the first candidate is "tcp://pbx1.example.com:5060"
    And the first candidate comes from "srv"
    When only "tcp://pbx1.example.com:5060" and "udp://example.com:5060" respond
    Then the best candidate is "tcp://pbx1.example.com:5060"

  Scenario: A manual tcp URI overrides everything
    Given the domain "example.com" publishes an SRV record for "tls" at "secure.example.com" port 5061
    And the manual address "tcp://10.0.0.5:5060" is entered
    When the candidates for the domain are built
    Then the first candidate is "tcp://10.0.0.5:5060"
    And the first candidate comes from "manual"
    When every candidate responds
    Then the best candidate is "tcp://10.0.0.5:5060"

  Scenario: A domain without SRV records falls back to the default ladder
    When the candidates for the domain "example.com" are built
    Then the candidates in order are:
      | tls://example.com:5061 |
      | wss://example.com:443  |
      | tcp://example.com:5060 |
      | ws://example.com:80    |
      | udp://example.com:5060 |

  Scenario: No candidate responds
    When the candidates for the domain "example.com" are built
    And no candidate responds
    Then no reachable transport is reported
