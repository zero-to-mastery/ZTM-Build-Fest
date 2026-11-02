# Design Spec: Finalize Anti-Entropy Registry Sweep
<!-- @shared-law (Sovereign Law) -->

## 1. Problem Statement
The `vde-lang` build fails because the custom build commands reference scripts in `/vde/scripts/`, which are not currently included in the Docker image during the build process.

## 2. Proposed Solution
Update `configs/docker/vde-lang.Dockerfile` to copy the `scripts/` directory into the image before the custom build command is executed.

## 3. Architecture Changes
- **Dockerfile**: `configs/docker/vde-lang.Dockerfile` will be updated to include a `COPY` instruction.

## 4. TDD Strategy
- **Failing Test**: A reproduction script that attempts to rebuild the `csharp` VM. This is expected to fail currently because the `csharp-init.zsh` script is missing within the build context's `/vde/scripts` directory inside the container.
- **Success Criteria**: `bin/vde rebuild csharp` completes successfully, and `bin/vde enter csharp dotnet --version` returns a valid version string.

## 5. Implementation Plan
1. Update `configs/docker/vde-lang.Dockerfile`.
2. Execute `bin/vde rebuild csharp`.
3. Execute `bin/vde start csharp`.
4. Verify the installation.
5. Cleanup.
