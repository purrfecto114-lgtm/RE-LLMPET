# Windows installation and verification

Use a signed NSIS artifact produced by the release workflow. Verify the published SHA-256 file and artifact attestation before installation. After launch, check tray visibility, details panel, hook installation ownership, one real permission allow/deny flow, terminal focus, clean exit, and absence of orphan processes.

The source archive is not an installer and does not include an Electron runtime.
