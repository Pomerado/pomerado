# Security policy

## Report a vulnerability

Report a security weakness privately, never in a public issue.

- Email security@pomerado.ai. Every report reaches both maintainers.
- Or use **Report a vulnerability** on this repository's [Security tab](https://github.com/Pomerado/pomerado/security).

Tell us what you found, how to reproduce it and what it lets someone do.

## What happens next

- We acknowledge every report within 3 business days.
- We rate it and fix it within these deadlines: critical within 7 days, high within 30 days and medium within 90 days. Low findings are fixed in normal work.
- We tell you when it's fixed.
- We don't pay bug bounties.

## Safe harbor

We won't take legal action against you, or ask anyone else to, for research done in good faith. We treat that research as authorized.

Good faith means:

- You test only your own accounts and data.
- You don't access, change or keep anyone else's data.
- You don't disrupt the service.
- You give us reasonable time to fix the weakness before you tell anyone else.

## Scope

In scope are this repository, the `pomerado` package on npm, and Pomerado's hosted service: pomerado.ai, app.pomerado.ai and the hosted API and MCP endpoints.

Out of scope are denial of service, social engineering, physical attacks, spam, our vendors' own platforms, and scanner output with no shown impact.

## Supported versions

Fixes land on `main` and ship in the next release of the `pomerado` package. Use the latest release.
