---
name: patchbay:review
description: Review a verified candidate with Claude Code (read-only) and produce structured findings.
---

# $patchbay:review

**Status: implemented.** Backing MCP tools: `patchbay_review`, `patchbay_submit_finding_dispositions`, and `patchbay_repair`.

Claude reviews verified candidates in one of four modes (`standard`, `adversarial`, `security`, `design`) and returns
schema-constrained findings. Dispositions are recorded with `patchbay_submit_finding_dispositions`; confirmed findings can
drive bounded repair jobs via `patchbay_repair`.
