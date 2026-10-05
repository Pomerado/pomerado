# Workspace reference

`AGENTS.md` holds the always-on rules and the workspace map. This README indexes the reference
sections; read one with `read_source` only when its topic comes up.

Author the operation as a Kernel script in `src/tool.mjs`. From `src/`, `explore/` or `test/`,
import Effect Schema from `effect` and the SDK from `../../runtime/index.js`, the path the
executor resolves (`runtime/index.js` in this workspace is the same file, for reading):

```js
import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
```

The skill references import the SDK through the repository's paths, such as
`../../src/runtime/index.js`; in the workspace the same modules are `../../runtime/index.js`,
`../../testing/…` and so on.
The operation's browser work is its own `kernel.browsers.playwright.execute` calls, as
.agents/core/SKILL.md describes.

<!-- pomerado:hosted:start
| Section                         | Read it when                                                    |
| ------------------------------- | --------------------------------------------------------------- |
| `reference/offline-commands.md` | you run `exec_command`, or a `pureFiles` execution              |
| `reference/captures.md`         | you read evidence after a live probe, or retain a response body |
| `reference/fixtures.md`         | you test a parser or script offline against saved captures      |
| `reference/maintenance.md`      | the build is maintenance of a published tool                    |

pomerado:hosted:end --><!-- pomerado:standalone:start

## Standalone references

Read the installed core, auth, forms, writes, pagination and caller-input skills as relevant. The ordinary browser syntax and example source are the same in both compositions. Files use logical `/workspace` paths; installed runtime and skill directories are read-only. Use bounded live observations and `pureFiles` checks on caller-supplied fixtures.

From `src/`, `explore/` or `test/`, import `Schema` from `effect` and `defineOperation` from `../../runtime/index.js`. All website access uses the generated `kernel.browsers.playwright.execute` call.

pomerado:standalone:end -->
