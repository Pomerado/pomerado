# Security

Report vulnerabilities privately through GitHub's private vulnerability reporting. Never open a public issue, discussion or pull request for a security problem.

1. Open the [Security tab](https://github.com/Pomerado/pomerado/security) and choose **Report a vulnerability**.
2. Describe the problem, the affected version or commit, and the steps to reproduce it.
3. Use synthetic data. Leave out real credentials and personal data.

## What to expect

- We acknowledge your report within 3 business days.
- We send an initial assessment within 10 business days.
- We keep you updated until a fix ships and credit you in the advisory unless you prefer otherwise.
- We fix the latest npm release and `main`. Older versions do not receive patches.

## Scope

These are in scope.

- Code in this repository and the `pomerado` npm package.
- Ways for website content, model output or generated code to get past Guardian review.
- Leaks of supplied secrets or credentials beyond what the README documents.
- Writes outside the configured integrations root or a job's workspace.

These are out of scope.

- Limits the README already states. Authored operations run with your operating system user's privileges, and answers sent through `provide_input` are visible to your MCP client and model provider.
- Vulnerabilities in dependencies that do not depend on how Pomerado uses them. Report those upstream.
- The websites that integrations act on.
- Denial of service by volume, social engineering and scanner output without a working exploit.

Report problems in the hosted service at [pomerado.ai](https://pomerado.ai) through the same private form, and say that the report concerns the hosted service.
