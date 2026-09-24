# Repository review policy

The instance approval mode defaults to `human`. Set `ACR_APPROVAL_MODE=bot` to
allow the reviewer bot to grant approval after a passing review. The operator
gates `ACR_REVIEW_ADMISSION_ENABLED` and
`ACR_REVIEW_TERMINAL_SUCCESS_ENABLED` accept only `true` or `false` and default
to `true`. Configure the provider's required check and approval rule before
enabling bot approval.

To override the mode for one repository, copy [`.acr.yml.example`](../.acr.yml.example)
to `.acr.yml` at the repository root:

```yaml
version: 2
review:
  approval: human
```

`review.approval` accepts `human` or `bot`. The file can omit `approval` to use
the instance default. Version 2 and the `review` section are required. The
schema accepts no builder, job, maintenance, command, or review enrichment
settings.

The controller must read `.acr.yml` from the exact target branch head for the
change being reviewed. Source branch edits and issue or comment content cannot
change policy. An absent file uses the instance default. An invalid or
incompletely read file has no effective policy, so review work must stop and
the existing exact-head approval must be reconciled away before publishing a
non-passing policy check. The file is limited to 16 KiB; unknown or duplicate
keys, aliases, anchors, invalid YAML, and unsupported versions are rejected.
