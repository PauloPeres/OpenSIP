Feature: Place an outbound call
  A registered account can dial out; the call is bounded by the same line limit as incoming calls.

  Background:
    Given the outbound account "Work" serves the domain "sip.example.com"

  Scenario: An outbound call is answered and becomes active
    When I place the outbound call "o1" to "sip:carol@example.com" from "Work"
    Then the outbound call "o1" is "connecting"
    And the outbound call "o1" goes to "sip:carol@example.com"
    When the far end answers the outbound call "o1"
    Then the outbound call "o1" is "active"
    When I end the outbound call "o1"
    Then the outbound call "o1" is "ended"
    And no outbound calls are active

  Scenario: A bare extension is normalised against the account domain
    When I place the outbound call "o1" to "1001" from "Work"
    Then the outbound call "o1" goes to "sip:1001@sip.example.com"

  Scenario: A phone number typed with spaces and dashes is cleaned up
    When I place the outbound call "o1" to "+55 11 99999-0000" from "Work"
    Then the outbound call "o1" goes to "sip:+5511999990000@sip.example.com"

  Scenario: A blank target is refused
    When I place the outbound call "o1" to "   " from "Work"
    Then the dial is refused because the target is invalid
    And no outbound calls are active

  Scenario: The far end rejects the call
    When I place the outbound call "o1" to "sip:carol@example.com" from "Work"
    And the far end hangs up the outbound call "o1"
    Then the outbound call "o1" is "ended"
    And no outbound calls are active

  Scenario: A fifth call is refused when every line is busy
    Given 4 outbound calls are in progress on "Work"
    When I place the outbound call "extra" to "sip:dave@example.com" from "Work"
    Then the dial is refused because 4 concurrent calls are already in progress
    When I end the outbound call "out-1"
    And I place the outbound call "extra" to "sip:dave@example.com" from "Work"
    Then the outbound call "extra" is "connecting"
