# Skill System

Skills live as Markdown rulebooks under `skills/<skill-name>/skill.md`:

- `skills/pdf-layout/skill.md`: Layout disambiguation rules for labels, values, cards, timelines, and image fallback.
- `skills/rdlc-tablix/skill.md`: Tablix band decomposition, repeating detail groups, and cell span rules.
- `skills/vb-report/skill.md`: Separation of Data Access, Business Calculations, Formatting, and RDLC expressions.
- `skills/finance-calculation/skill.md`: Excel oracle interpretation, rounding rules, and ambiguity flagging.
- `skills/project-convention/skill.md`: Preserving existing DataSets, namespaces, and overwrite safety.

## Selective Skill Loading
`SkillManager.retrieveRelevantSkills(query)` inspects task metadata (`hasFinancialTerms`, `hasExistingProject`, `hasComplexGraphics`, `taskType`) and loads only matching skills into AI context rather than dumping every skill into every prompt.
