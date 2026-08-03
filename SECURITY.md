# Security policy

## Reporting a vulnerability

Do not publish credentials, private board data, or an exploitable vulnerability
in a public issue. Contact the repository maintainers privately through the
security contact configured for the GitHub organization. Include the affected
version, impact, and a minimal reproduction with all secrets and personal data
removed.

## Credential handling

The room token is a shared bearer credential with full access to one board.

- Store it in an environment variable, client secret field, GCP Secret Manager,
  or another dedicated secret manager.
- Send it in an `Authorization: Bearer` header. Query-string authentication is
  retained for legacy compatibility and should not be used for new clients.
- Never commit room state, `.env` files, MCP client configuration, private keys,
  service-account JSON, or terminal output containing credentials.
- Use HTTPS whenever traffic leaves a trusted local environment.
- Give each relay a separate, randomly generated token.

## If a secret or private board is exposed

1. Revoke or rotate the credential immediately.
2. Remove the value from the current tree and deployment logs.
3. Audit access and rotate any downstream credential contained in board data.
4. Rewrite Git history only after coordinating a force-push with maintainers;
   every clone and open branch must then be cleaned or replaced.
5. Notify affected collaborators privately.

Deleting a file in a new commit does not remove it from Git history. Treat any
credential that was ever committed as compromised even after history cleanup.

## Repository checks

`npm test` rejects tracked runtime state, secret-bearing file types, common key
and token formats, private-network addresses, personal filesystem paths, and
known deployment-specific identifiers. Maintainers should also run a dedicated
secret scanner such as Gitleaks before publishing a branch or release.
