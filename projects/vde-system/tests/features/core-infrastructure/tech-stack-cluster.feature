# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @tech-stack @cluster @system-spine @pristine
Feature: Integrated Tech Stack (Python, PostgreSQL, Redis)
  The VDE provides a pre-verified tech stack for students, ensuring that
  language VMs and service VMs can be ignited and utilized as a single unit.

  @user-guide-cluster
  Scenario: Verify the Sovereign Tech Stack Cluster
    Given the VDE system is healthy
    When I run the one true way to start the VMs "python postgres redis"

    Then the container "vde-python" should be started via direct Docker orchestration
    And the container "vde-postgres" should be started via direct Docker orchestration
    And the container "vde-redis" should be started via direct Docker orchestration

    
    # Deterministic Readiness (Standard DNS Names)
    And the VM "python" must be responsive on port "2217"
    And the VM "postgres" must be responsive on port "5432"
    And the VM "redis" must be responsive on port "6379"
    
    # 2. Functional Handshake (Inside the cluster)
    When I execute "pg_isready -h postgres" inside "vde-python" as "devuser"
    Then the exit code should be 0
    
    When I execute "redis-cli -h redis ping" inside "vde-python" as "devuser"
    Then the exit code should be 0
    And the output should contain "PONG"
    
    And the stack should be gracefully terminated
