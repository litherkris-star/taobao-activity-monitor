# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Wayfinding labels

`/wayfinder` additionally uses one label per ticket type, plus one for the map itself:

| Label                  | Used on                                            |
| ---------------------- | -------------------------------------------------- |
| `wayfinder:map`        | The map (one issue holding Notes / Decisions / Fog) |
| `wayfinder:research`   | A child ticket that answers a question by reading   |
| `wayfinder:prototype`  | A child ticket that answers a question by building  |
| `wayfinder:grilling`   | A child ticket that answers a question by asking the user |
| `wayfinder:task`       | A child ticket that is known work, not a question   |
