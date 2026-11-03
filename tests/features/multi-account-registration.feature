Feature: Multi-account registration
  A user can configure several SIP accounts and each one registers independently.

  Scenario: Two distinct accounts both register
    Given no SIP accounts are configured
    When I add the account "Work" for "alice" on "sip.example.com"
    And I add the account "Home" for "bob" on "sip.example.com"
    And I register every account
    And the server accepts every registration
    Then the account "Work" is "registered"
    And the account "Home" is "registered"
    And 2 accounts are configured

  Scenario: A duplicate account is rejected
    Given the account "Work" for "alice" on "sip.example.com" is configured
    When I add the account "Work copy" for "ALICE" on "SIP.example.com"
    Then the operation is rejected with "accounts.validation.duplicate"
    And 1 accounts are configured

  Scenario: A failed registration is retried
    Given the account "Work" for "alice" on "sip.example.com" is configured
    And I register every account
    When the server rejects the registration of "Work" with "403 Forbidden"
    Then the account "Work" is "failed"
    And the account "Work" can be retried within 3 attempts
    When I retry the registration of "Work"
    And the server accepts the registration of "Work"
    Then the account "Work" is "registered"
    And the account "Work" can not be retried within 3 attempts
