Feature: Turn a SIP account on or off
  A user can keep an account configured without it being registered.

  Scenario: A new account is on by default
    Given a switchboard holding a new account "alice" at "sip.example.com"
    Then the account "alice" is switched on
    And the switchboard counts 1 listed and 1 switched-on accounts

  Scenario: Turning an account off keeps it listed but out of the switched-on set
    Given a switchboard holding a new account "alice" at "sip.example.com"
    When the user flips the "alice" switch off
    Then the account "alice" is switched off
    And the switchboard counts 1 listed and 0 switched-on accounts

  Scenario: Turning an account back on restores it
    Given a switchboard holding a new account "alice" at "sip.example.com"
    When the user flips the "alice" switch off
    And the user flips the "alice" switch on
    Then the account "alice" is switched on
    And the switchboard counts 1 listed and 1 switched-on accounts

  Scenario: An account saved before the switch existed loads as on
    Given a switchboard restored from an old record for "bob" at "sip.example.com" without a switch
    Then the account "bob" is switched on
    And the switchboard counts 1 listed and 1 switched-on accounts
