# Security Policy

## Supported Versions

Only the latest release of Koi receives security updates. If you are using an older version, please upgrade before reporting.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues via the GitHub Security Advisories feature:
[Report a vulnerability](../../security/advisories/new)

Include:
- A description of the vulnerability and its impact
- Steps to reproduce
- Affected versions
- Any suggested mitigations (optional)

## Response SLA

| Severity | Acknowledgement | Patch Target |
|---|---|---|
| Critical | 24 hours | 72 hours |
| High | 48 hours | 7 days |
| Medium | 5 business days | 30 days |
| Low | 10 business days | Next release |

## Audit Trail

Koi's `@koi/middleware-audit` package produces tamper-evident audit logs for all agent actions. See `docs/L2/middleware-audit.md` for details.
