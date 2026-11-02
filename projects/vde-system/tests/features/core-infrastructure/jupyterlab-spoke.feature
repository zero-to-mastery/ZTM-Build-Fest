# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @jupyterlab @service @system-spine
Feature: JupyterLab Data Science Spoke
  The VDE provides a specialized JupyterLab VM with a pre-configured Data Science stack
  and persistent host-mounted workspace.

  Background:
    Given the VDE registry is loaded

  @registry @identity
  Scenario: Verify JupyterLab VM Registry Identity
    Then the VM "vde-jupyterlab" must be registered as a "service"
    And the VM "vde-jupyterlab" must have service ports "8888"
    And the VM "vde-jupyterlab" must have SSH port "2401"
    And the VM "vde-jupyterlab" must support alias "jupyterlab"

  @usp @hydration
  Scenario: Verify JupyterLab Hydration Script
    Then the setup script for "jupyterlab" must exist
    And the setup script for "jupyterlab" must be USP compliant

  @mounting @persistence
  Scenario: Verify JupyterLab Workspace Mounting
    Then the workspace mount for "vde-jupyterlab" must point to "projects/python/jupyterlabs"

  @runtime @connectivity @user-guide-more-languages
  Scenario: Verify JupyterLab Runtime Connectivity
    When I start the VM "jupyterlab"
    Then the VM "vde-jupyterlab" must be running
    And the service on port "8888" must be responsive
