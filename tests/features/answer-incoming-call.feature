Feature: Answer an incoming call
  Incoming calls on a registered account can be answered, rejected and are bounded.

  Background:
    Given the account "Work" for "alice" on "sip.example.com" is registered

  Scenario: An incoming call is answered, becomes active and is hung up
    When a call "c1" arrives on "Work" from "sip:carol@example.com"
    Then the call "c1" is "ringing"
    When I answer the call "c1"
    And the media of the call "c1" connects
    Then the call "c1" is "active"
    When I hang up the call "c1"
    Then the call "c1" is "ended"
    And 0 calls are active

  Scenario: A ringing call is rejected
    When a call "c1" arrives on "Work" from "sip:carol@example.com"
    And I reject the call "c1"
    Then the call "c1" is "ended"
    And 0 calls are active

  Scenario: The concurrent call limit is enforced
    Given 4 calls are ringing on "Work"
    When a call "extra" arrives on "Work" from "sip:dave@example.com"
    Then the call is refused because 4 concurrent calls are already in progress
    When I reject the call "call-1"
    And a call "extra" arrives on "Work" from "sip:dave@example.com"
    Then the call "extra" is "ringing"
